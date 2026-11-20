const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function bridgeRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "bridge");
  return path.resolve(__dirname, "..");
}

function resolvePackagedNode() {
  const bundledNode = path.join(process.resourcesPath, "node", "node.exe");
  if (!fs.existsSync(bundledNode)) {
    throw new Error("The bundled Node runtime is missing from this build.");
  }
  return bundledNode;
}
const SERVER_URL = "http://127.0.0.1:4789/?native=1";
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 340;

let notchWindow = null;
let tray = null;
let serverProcess = null;
let cursorTimer = null;
let ignoringMouse = true;

const overlayState = {
  hitRect: { x: 170, y: 0, width: 60, height: 60 },
  dragRect: { x: 186, y: 42, width: 26, height: 14 },
  isOpen: false,
  isTyping: false,
  callPhase: "idle",
  botName: "Grok Bot",
  bots: [],
  selectedBotId: ""
};

function resolveSystemNode() {
  if (app.isPackaged) return resolvePackagedNode();
  if (process.env.GROKBOT_NODE && fs.existsSync(process.env.GROKBOT_NODE)) {
    return process.env.GROKBOT_NODE;
  }
  try {
    const listed = require("node:child_process")
      .execFileSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.toLowerCase().includes("electron"));
    if (listed[0]) return listed[0];
  } catch {
    // fall through to PATH
  }
  return "node";
}

function grokBotExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
  const candidate = path.join(localAppData, "Programs", "Grok Bot", "Grok Bot.exe");
  return fs.existsSync(candidate) ? candidate : null;
}

function portIsOpen() {
  return new Promise((resolve) => {
    const request = http.get("http://127.0.0.1:4789/", { timeout: 800 }, (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      if (await portIsOpen()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (attempts > 40) {
        clearInterval(timer);
        reject(new Error("The local bridge did not start on 127.0.0.1:4789"));
      }
    }, 250);
  });
}

function bridgeLogStream() {
  const roaming = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  const logDirectory = path.join(roaming, "GrokBot Notch");
  fs.mkdirSync(logDirectory, { recursive: true });
  return fs.openSync(path.join(logDirectory, "bridge.log"), "a");
}

function stopBridgeProcess() {
  if (!serverProcess || !serverProcess.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(serverProcess.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  serverProcess.kill();
}

async function ensureServer() {
  if (await portIsOpen()) return;
  const nodeBinary = resolveSystemNode();
  const bridgeDirectory = bridgeRoot();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const serverStdio = app.isPackaged ? ["ignore", bridgeLogStream(), bridgeLogStream()] : "inherit";
  serverProcess = spawn(nodeBinary, [path.join(bridgeDirectory, "server.mjs")], {
    cwd: bridgeDirectory,
    env,
    stdio: serverStdio,
    windowsHide: true
  });
  serverProcess.on("exit", () => {
    serverProcess = null;
  });
  await waitForServer();
}

function sendCommand(command) {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  const payload = JSON.stringify(command);
  notchWindow.webContents
    .executeJavaScript(`window.__notchCommand && window.__notchCommand(${payload})`)
    .catch(() => {});
}

function positionFilePath() {
  const roaming = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  return path.join(roaming, "GrokBot Notch", "window-position.json");
}

function readSavedPosition() {
  try {
    const saved = JSON.parse(fs.readFileSync(positionFilePath(), "utf8"));
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  } catch {
    return null;
  }
}

function secondaryOrPrimaryDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((display) => display.id !== primary.id) || primary;
}

function positionStaysOnScreen(originX, originY) {
  const anchorX = originX + 24;
  const anchorY = originY + 24;
  return screen.getAllDisplays().some((display) => {
    const area = display.bounds;
    return anchorX >= area.x && anchorX <= area.x + area.width && anchorY >= area.y && anchorY <= area.y + area.height;
  });
}

function defaultWindowOrigin() {
  const area = secondaryOrPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - PANEL_WIDTH) / 2),
    y: area.y + 16
  };
}

function placeWindow() {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  const saved = readSavedPosition();
  const origin = saved && positionStaysOnScreen(saved.x, saved.y) ? saved : defaultWindowOrigin();
  notchWindow.setBounds({ x: origin.x, y: origin.y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
}

let draggingWindow = false;
let dragTimer = null;
let dragOrigin = null;
let sawMouseButtonDown = false;
let mouseButtonState = "unknown";
let mouseWatcher = null;
let pointerSample = null;

function nativeWindowHandleString() {
  const handleBuffer = notchWindow.getNativeWindowHandle();
  const handleValue =
    handleBuffer.length >= 8 ? handleBuffer.readBigUInt64LE(0) : BigInt(handleBuffer.readUInt32LE(0));
  return handleValue.toString();
}

function pointInsideRect(pointX, pointY, rect, pad) {
  return (
    pointX >= rect.x - pad &&
    pointX <= rect.x + rect.width + pad &&
    pointY >= rect.y - pad &&
    pointY <= rect.y + rect.height + pad
  );
}

function physicalRectForLocal(localRect) {
  if (!pointerSample || pointerSample.windowWidth <= 0 || pointerSample.windowHeight <= 0) return null;
  if (!notchWindow || notchWindow.isDestroyed()) return null;
  const dipBounds = notchWindow.getBounds();
  if (dipBounds.width <= 0 || dipBounds.height <= 0) return null;
  const scaleX = pointerSample.windowWidth / dipBounds.width;
  const scaleY = pointerSample.windowHeight / dipBounds.height;
  return {
    x: pointerSample.windowLeft + localRect.x * scaleX,
    y: pointerSample.windowTop + localRect.y * scaleY,
    width: Math.max(1, localRect.width * scaleX),
    height: Math.max(1, localRect.height * scaleY)
  };
}

function cursorHitsLocalRect(localRect, pad) {
  if (!localRect || localRect.width <= 0 || localRect.height <= 0) return false;
  const physicalRect = physicalRectForLocal(localRect);
  if (physicalRect && pointerSample) {
    const scale = physicalRect.width / localRect.width;
    return pointInsideRect(pointerSample.cursorX, pointerSample.cursorY, physicalRect, pad * scale);
  }
  if (!notchWindow || notchWindow.isDestroyed()) return false;
  const cursor = screen.getCursorScreenPoint();
  const bounds = notchWindow.getBounds();
  return pointInsideRect(cursor.x, cursor.y, {
    x: bounds.x + localRect.x,
    y: bounds.y + localRect.y,
    width: localRect.width,
    height: localRect.height
  }, pad);
}

function dipPointFromPhysical(physicalX, physicalY) {
  if (typeof screen.screenToDipPoint === "function") {
    try {
      return screen.screenToDipPoint({ x: Math.round(physicalX), y: Math.round(physicalY) });
    } catch {
      // Fall through to the display scale when a monitor is mid-change.
    }
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = display.scaleFactor || 1;
  return { x: physicalX / scale, y: physicalY / scale };
}

function clampWindowOrigin(originX, originY, width, height) {
  const windowWidth = width || (notchWindow && !notchWindow.isDestroyed() ? notchWindow.getBounds().width : PANEL_WIDTH);
  const windowHeight = height || (notchWindow && !notchWindow.isDestroyed() ? notchWindow.getBounds().height : PANEL_HEIGHT);
  const centerX = originX + windowWidth / 2;
  const centerY = originY + Math.min(windowHeight / 2, 36);
  const displays = screen.getAllDisplays();
  const alreadyVisible = displays.some((display) => {
    const area = display.bounds;
    return (
      centerX >= area.x + 12 &&
      centerX <= area.x + area.width - 12 &&
      centerY >= area.y + 8 &&
      centerY <= area.y + area.height - 12
    );
  });
  if (alreadyVisible) return { x: Math.round(originX), y: Math.round(originY) };

  const display = screen.getDisplayNearestPoint({ x: Math.round(centerX), y: Math.round(centerY) });
  const area = display.workArea;
  if (windowWidth >= area.width - 16) {
    return {
      x: Math.round(area.x + 8),
      y: Math.round(Math.min(Math.max(originY, area.y + 8), area.y + area.height - Math.min(windowHeight, area.height) - 8))
    };
  }
  const clampedCenterX = Math.min(Math.max(centerX, area.x + windowWidth / 2), area.x + area.width - windowWidth / 2);
  const clampedCenterY = Math.min(Math.max(centerY, area.y + 24), area.y + area.height - 24);
  return {
    x: Math.round(originX + (clampedCenterX - centerX)),
    y: Math.round(originY + (clampedCenterY - centerY))
  };
}

// A DIP length only lands on a whole device pixel when it is a multiple of this step.
// At 125% the step is 4, so a size that is exact on a 100% screen can be 1 device
// pixel too wide or too narrow after setBounds rounding.
function dipGridStep(scaleFactor) {
  const scaleThousandths = Math.round((scaleFactor || 1) * 1000);
  let dividend = Math.abs(scaleThousandths);
  let divisor = 1000;
  while (divisor !== 0) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return 1000 / (dividend || 1);
}

function displayForBounds(bounds) {
  return screen.getDisplayMatching({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  });
}

function snapLengthToDevicePixels(length, step) {
  if (step <= 1) return Math.max(1, Math.round(length));
  const units = Math.ceil((length - 0.01) / step);
  return Math.max(step, units * step);
}

function snapOriginToDevicePixels(origin, displayOrigin, step) {
  if (step <= 1) return Math.round(origin);
  const relative = origin - displayOrigin;
  return displayOrigin + Math.round(relative / step) * step;
}

function widgetBoundsFromHit(currentBounds) {
  const hit = overlayState.hitRect;
  if (!hit || hit.width < 8 || hit.height < 8) return null;
  const clamped = clampWindowOrigin(currentBounds.x + hit.x, currentBounds.y + hit.y, hit.width, hit.height);
  const display = displayForBounds({
    x: clamped.x,
    y: clamped.y,
    width: hit.width,
    height: hit.height
  });
  const step = dipGridStep(display.scaleFactor || 1);
  return {
    x: snapOriginToDevicePixels(clamped.x, display.bounds.x, step),
    y: snapOriginToDevicePixels(clamped.y, display.bounds.y, step),
    width: snapLengthToDevicePixels(hit.width, step),
    height: snapLengthToDevicePixels(hit.height, step)
  };
}

let fitTimer = null;
let pendingFit = null;

function scheduleWidgetFit(width, height) {
  pendingFit = { width, height };
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    fitTimer = null;
    if (!pendingFit) return;
    if (draggingWindow) {
      scheduleWidgetFit(pendingFit.width, pendingFit.height);
      return;
    }
    sendCommand({ action: "fitWidget", width: pendingFit.width, height: pendingFit.height });
  }, 120);
}

function applyWidgetBounds() {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  const bounds = notchWindow.getBounds();
  const snapped = widgetBoundsFromHit(bounds);
  if (!snapped) return;
  const sameSize = snapped.width === bounds.width && snapped.height === bounds.height;
  const sameOrigin = Math.abs(snapped.x - bounds.x) < 1 && Math.abs(snapped.y - bounds.y) < 1;
  if (!sameSize || !sameOrigin) {
    notchWindow.setBounds(snapped);
  }
  scheduleWidgetFit(snapped.width, snapped.height);
}

function syncWindowToWidget() {
  if (!notchWindow || notchWindow.isDestroyed() || draggingWindow || mouseButtonState === "down") return;
  applyWidgetBounds();
}

function rebaseDragToLandedWindow() {
  if (!dragOrigin || !notchWindow || notchWindow.isDestroyed()) return;
  const landed = notchWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  dragOrigin.originX = landed.x;
  dragOrigin.originY = landed.y;
  dragOrigin.landedX = landed.x;
  dragOrigin.landedY = landed.y;
  dragOrigin.cursorX = cursor.x;
  dragOrigin.cursorY = cursor.y;
  dragOrigin.seenCursorX = cursor.x;
  dragOrigin.seenCursorY = cursor.y;
}

function applySnappedSizeDuringDrag() {
  if (!draggingWindow || !notchWindow || notchWindow.isDestroyed()) return;
  const bounds = notchWindow.getBounds();
  const snapped = widgetBoundsFromHit(bounds);
  if (!snapped || (snapped.width === bounds.width && snapped.height === bounds.height)) return;
  notchWindow.setBounds({ x: bounds.x, y: bounds.y, width: snapped.width, height: snapped.height });
  rebaseDragToLandedWindow();
}

function ensureMouseButtonWatcher() {
  if (mouseWatcher || !notchWindow || notchWindow.isDestroyed()) return;
  const scriptPath = app.isPackaged
    ? path.join(bridgeRoot(), "windows", "mouse-button.ps1")
    : path.join(__dirname, "mouse-button.ps1");
  mouseWatcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"]
  });
  mouseWatcher.stdin.write(`${nativeWindowHandleString()}\n`);
  let pendingOutput = "";
  mouseWatcher.stdout.on("data", (chunk) => {
    pendingOutput += chunk.toString();
    const lines = pendingOutput.split(/\r?\n/);
    pendingOutput = lines.pop() || "";
    for (const sampleLine of lines) {
      const parts = sampleLine.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const buttonState = parts[0];
      if (buttonState !== "down" && buttonState !== "up") continue;
      const numbers = parts.slice(1, 7).map((part) => Number(part));
      if (numbers.some((value) => !Number.isFinite(value))) continue;
      mouseButtonState = buttonState;
      pointerSample = {
        cursorX: numbers[0],
        cursorY: numbers[1],
        windowLeft: numbers[2],
        windowTop: numbers[3],
        windowWidth: numbers[4] - numbers[2],
        windowHeight: numbers[5] - numbers[3]
      };
    }
  });
  mouseWatcher.on("exit", () => {
    mouseWatcher = null;
    mouseButtonState = "unknown";
    pointerSample = null;
    if (draggingWindow) finishWindowDrag();
  });
}

function applyDragPosition() {
  if (!dragOrigin || !notchWindow || notchWindow.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const bounds = notchWindow.getBounds();
  const scaleFactor = displayForBounds(bounds).scaleFactor || 1;
  if (dragOrigin.scaleFactor == null) dragOrigin.scaleFactor = scaleFactor;
  if (scaleFactor !== dragOrigin.scaleFactor) {
    dragOrigin.scaleFactor = scaleFactor;
    const snapped = widgetBoundsFromHit(bounds);
    if (snapped) {
      notchWindow.setBounds(snapped);
      rebaseDragToLandedWindow();
    }
    return;
  }

  if (dragOrigin.seenCursorX != null) {
    const cursorShiftX = point.x - dragOrigin.seenCursorX;
    const cursorShiftY = point.y - dragOrigin.seenCursorY;
    const windowShiftX = bounds.x - dragOrigin.landedX;
    const windowShiftY = bounds.y - dragOrigin.landedY;
    const cursorFollowedTheWindow =
      Math.abs(cursorShiftX - windowShiftX) <= 1 && Math.abs(cursorShiftY - windowShiftY) <= 1;
    if ((windowShiftX !== 0 || windowShiftY !== 0) && cursorFollowedTheWindow) {
      dragOrigin.cursorX += cursorShiftX;
      dragOrigin.cursorY += cursorShiftY;
      dragOrigin.originX += windowShiftX;
      dragOrigin.originY += windowShiftY;
    }
  }
  dragOrigin.seenCursorX = point.x;
  dragOrigin.seenCursorY = point.y;

  const travelX = point.x - dragOrigin.cursorX;
  const travelY = point.y - dragOrigin.cursorY;
  if (!dragOrigin.moved && Math.abs(travelX) + Math.abs(travelY) < 4) {
    dragOrigin.landedX = bounds.x;
    dragOrigin.landedY = bounds.y;
    return;
  }

  const nextOrigin = clampWindowOrigin(
    dragOrigin.originX + travelX,
    dragOrigin.originY + travelY,
    bounds.width,
    bounds.height
  );
  if (nextOrigin.x === bounds.x && nextOrigin.y === bounds.y) {
    dragOrigin.landedX = bounds.x;
    dragOrigin.landedY = bounds.y;
    return;
  }

  dragOrigin.moved = true;
  notchWindow.setPosition(nextOrigin.x, nextOrigin.y);
  const landed = notchWindow.getBounds();
  dragOrigin.originX += landed.x - nextOrigin.x;
  dragOrigin.originY += landed.y - nextOrigin.y;
  dragOrigin.landedX = landed.x;
  dragOrigin.landedY = landed.y;
}

function finishWindowDrag() {
  if (!dragOrigin && !dragTimer) return;
  applyDragPosition();
  const didMove = Boolean(dragOrigin && dragOrigin.moved);
  dragOrigin = null;
  draggingWindow = false;
  sawMouseButtonDown = false;
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  applyWidgetBounds();
  if (didMove) saveWindowPosition();
}

function beginWindowDrag() {
  if (!notchWindow || notchWindow.isDestroyed() || dragOrigin) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = notchWindow.getBounds();
  dragOrigin = {
    cursorX: cursor.x,
    cursorY: cursor.y,
    originX: bounds.x,
    originY: bounds.y,
    seenCursorX: cursor.x,
    seenCursorY: cursor.y,
    landedX: bounds.x,
    landedY: bounds.y,
    scaleFactor: displayForBounds(bounds).scaleFactor || 1,
    moved: false
  };
  draggingWindow = true;
  sawMouseButtonDown = false;
  ignoringMouse = false;
  notchWindow.setIgnoreMouseEvents(false);
  ensureMouseButtonWatcher();
  dragTimer = setInterval(() => {
    if (!dragOrigin || !notchWindow || notchWindow.isDestroyed()) return;
    if (mouseButtonState === "down") sawMouseButtonDown = true;
    if (sawMouseButtonDown && mouseButtonState === "up") {
      finishWindowDrag();
      return;
    }
    applyDragPosition();
  }, 16);
}

function saveWindowPosition() {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  const bounds = notchWindow.getBounds();
  try {
    fs.mkdirSync(path.dirname(positionFilePath()), { recursive: true });
    fs.writeFileSync(positionFilePath(), JSON.stringify({ x: bounds.x, y: bounds.y }), "utf8");
  } catch (error) {
    console.error("[gb-notch] Could not save window position:", error.message);
  }
}

function windowsSymbolPath() {
  const candidates = [
    path.join(process.resourcesPath, "icon-16.png"),
    path.join(__dirname, "..", "build", "icon-16.png")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function createTrayIcon() {
  const symbolPath = windowsSymbolPath();
  if (symbolPath) {
    const symbol = nativeImage.createFromPath(symbolPath);
    if (!symbol.isEmpty()) return symbol;
  }
  return nativeImage.createEmpty();
}

function windowsOpensAtLogin() {
  if (!app.isPackaged || process.platform !== "win32") return false;
  return app.getLoginItemSettings().openAtLogin;
}

function setWindowsOpensAtLogin(enabled) {
  if (!app.isPackaged || process.platform !== "win32") return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  });
}

function rememberWindowsStartupChoice() {
  if (!app.isPackaged || process.platform !== "win32") return;
  const choiceFile = path.join(app.getPath("userData"), "startup-chosen.json");
  if (fs.existsSync(choiceFile)) return;
  setWindowsOpensAtLogin(true);
  fs.mkdirSync(path.dirname(choiceFile), { recursive: true });
  fs.writeFileSync(choiceFile, JSON.stringify({ openAtLogin: true }));
}

function rebuildTrayMenu() {
  if (!tray) return;
  const botItems = overlayState.bots.slice(0, 20).map((bot) => ({
    label: bot.name || "Grok Bot",
    type: "radio",
    checked: bot.id === overlayState.selectedBotId,
    click: () => sendCommand({ action: "selectBot", botId: bot.id })
  }));

  const template = [
    { label: "Abrir o cerrar\tCtrl+Alt+Espacio", click: () => sendCommand({ action: "toggleExpand" }) },
    {
      label: overlayState.callPhase === "idle" ? "Iniciar llamada\tCtrl+Mayús+G" : "Colgar\tCtrl+Mayús+G",
      click: () => sendCommand({ action: "toggleVoiceCall" })
    },
    { type: "separator" }
  ];
  if (botItems.length > 0) {
    template.push({ label: "Bots", enabled: false }, ...botItems, { type: "separator" });
  }
  template.push(
    {
      label: "Abrir Grok Bot",
      click: () => {
        const executable = grokBotExecutable();
        if (executable) shell.openPath(executable);
      }
    },
    {
      label: "Abrir con Windows",
      type: "checkbox",
      checked: windowsOpensAtLogin(),
      visible: app.isPackaged,
      click: (menuItem) => setWindowsOpensAtLogin(menuItem.checked)
    },
    { type: "separator" },
    { label: "Salir", click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(overlayState.callPhase === "idle" ? `GrokBot-Notch · ${overlayState.botName}` : `GrokBot-Notch · en llamada con ${overlayState.botName}`);
}

function syncExpandedShortcuts() {
  const askBeforeSwitch = overlayState.isOpen && overlayState.callPhase !== "idle" && !overlayState.isTyping;
  for (const accelerator of ["Left", "Right"]) {
    if (askBeforeSwitch) {
      if (!globalShortcut.isRegistered(accelerator)) {
        const action = accelerator === "Left" ? "prevBot" : "nextBot";
        globalShortcut.register(accelerator, () => sendCommand({ action }));
      }
    } else if (globalShortcut.isRegistered(accelerator)) {
      globalShortcut.unregister(accelerator);
    }
  }

  const hangupEscape = overlayState.isOpen && overlayState.callPhase !== "idle";
  if (hangupEscape) {
    if (!globalShortcut.isRegistered("Escape")) {
      globalShortcut.register("Escape", () => sendCommand({ action: "escape" }));
    }
  } else if (globalShortcut.isRegistered("Escape")) {
    globalShortcut.unregister("Escape");
  }
}

let lastGazeX = null;
let lastGazeY = null;

function updateMousePassthrough() {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  if (ignoringMouse) {
    notchWindow.setIgnoreMouseEvents(false);
    ignoringMouse = false;
  }
  if (!draggingWindow && mouseButtonState === "down" && cursorHitsLocalRect(overlayState.dragRect, 12)) {
    beginWindowDrag();
    return;
  }
  if (draggingWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = notchWindow.getBounds();

  if (overlayState.isOpen) {
    const localX = cursor.x - bounds.x;
    const localY = cursor.y - bounds.y;
    if (localX < 0 || localY < 0 || localX > bounds.width || localY > bounds.height) return;
    const roundedX = Math.round(localX);
    const roundedY = Math.round(localY);
    if (roundedX !== lastGazeX || roundedY !== lastGazeY) {
      lastGazeX = roundedX;
      lastGazeY = roundedY;
      notchWindow.webContents
        .executeJavaScript(`window.__onNativeCursorMove && window.__onNativeCursorMove(${roundedX}, ${roundedY})`)
        .catch(() => {});
    }
  }
}

function createNotchWindow() {
  notchWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    title: "GrokBot-Notch",
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  notchWindow.setAlwaysOnTop(true, "screen-saver");
  notchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  placeWindow();

  notchWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("[gb-notch] Window failed to load:", errorCode, errorDescription);
  });
  notchWindow.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("[gb-notch] page:", event.message);
  });
  notchWindow.webContents.on("did-finish-load", () => {
    sendCommand({ action: "setNotchGeometry", notchWidth: 185, notchHeight: 32 });
  });

  notchWindow.once("ready-to-show", () => {
    placeWindow();
    notchWindow.show();
    notchWindow.setIgnoreMouseEvents(false);
    ignoringMouse = false;
  });

  notchWindow.loadURL(SERVER_URL);
}

function registerGlobalHotkeys() {
  const toggleOk = globalShortcut.register("Control+Alt+Space", () => {
    if (!notchWindow || notchWindow.isDestroyed()) return;
    notchWindow.show();
    notchWindow.focus();
    sendCommand({ action: "toggleExpand" });
  });
  const voiceOk = globalShortcut.register("Control+Shift+G", () => {
    if (!notchWindow || notchWindow.isDestroyed()) return;
    notchWindow.show();
    notchWindow.focus();
    sendCommand({ action: "toggleVoiceCall" });
  });
  if (!toggleOk) {
    console.error("[gb-notch] Could not register Ctrl+Alt+Space. Another app already owns that shortcut.");
  }
  if (!voiceOk) {
    console.error("[gb-notch] Could not register Ctrl+Shift+G.");
  }
}

app.setAppUserModelId("com.grokbot.notch.windows");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!notchWindow || notchWindow.isDestroyed()) return;
    notchWindow.show();
    notchWindow.focus();
    sendCommand({ action: "toggleExpand" });
  });

  app.whenReady().then(async () => {
    rememberWindowsStartupChoice();
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "media" || permission === "microphone" || permission === "audioCapture");
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === "media" || permission === "microphone" || permission === "audioCapture";
    });

    ipcMain.on("notch-drag-start", () => {
      beginWindowDrag();
    });
    ipcMain.on("notch-drag-end", () => {
      finishWindowDrag();
    });

    ipcMain.on("notch-host", (_event, payload) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "hitRect") {
        overlayState.hitRect = {
          x: Number(payload.x) || 0,
          y: Number(payload.y) || 0,
          width: Number(payload.width) || 60,
          height: Number(payload.height) || 60
        };
        overlayState.dragRect = {
          x: Number(payload.dragX) || 0,
          y: Number(payload.dragY) || 0,
          width: Number(payload.dragWidth) || 0,
          height: Number(payload.dragHeight) || 0
        };
        if (draggingWindow) applySnappedSizeDuringDrag();
        else syncWindowToWidget();
        overlayState.isOpen = Boolean(payload.isOpen);
        overlayState.isTyping = Boolean(payload.isTyping);
        overlayState.callPhase = typeof payload.callPhase === "string" ? payload.callPhase : "idle";
        if (typeof payload.botName === "string" && payload.botName) overlayState.botName = payload.botName;
        syncExpandedShortcuts();
        rebuildTrayMenu();
      } else if (payload.type === "rosterLoaded" && Array.isArray(payload.bots)) {
        overlayState.bots = payload.bots
          .filter((bot) => bot && typeof bot.id === "string")
          .map((bot) => ({ id: bot.id, name: String(bot.name || "Grok Bot") }));
        if (typeof payload.selectedBotId === "string") overlayState.selectedBotId = payload.selectedBotId;
        rebuildTrayMenu();
      }
    });

    try {
      await ensureServer();
    } catch (error) {
      console.error("[gb-notch]", error.message);
      app.quit();
      return;
    }

    screen.on("display-metrics-changed", () => {
      setTimeout(() => {
        if (draggingWindow) return;
        sendCommand({ action: "remeasure" });
      }, 50);
    });

    tray = new Tray(createTrayIcon());
    tray.on("click", () => {
      if (!notchWindow || notchWindow.isDestroyed()) return;
      notchWindow.show();
      notchWindow.focus();
      sendCommand({ action: "toggleExpand" });
    });
    rebuildTrayMenu();
    createNotchWindow();
    ensureMouseButtonWatcher();
    registerGlobalHotkeys();
    cursorTimer = setInterval(updateMousePassthrough, 32);
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  if (dragTimer) clearInterval(dragTimer);
  if (mouseWatcher && !mouseWatcher.killed) mouseWatcher.kill();
  stopBridgeProcess();
});

app.on("window-all-closed", () => {
  // The tray keeps the process alive. Quit comes from the tray menu.
});
