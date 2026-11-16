const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SERVER_URL = "http://127.0.0.1:4789/?native=1";
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 340;

let notchWindow = null;
let tray = null;
let serverProcess = null;
let cursorTimer = null;
let ignoringMouse = true;

const overlayState = {
  hitRect: { x: 94, y: 0, width: 212, height: 56 },
  isOpen: false,
  isTyping: false,
  callPhase: "idle",
  botName: "Grok Bot",
  bots: [],
  selectedBotId: ""
};

function resolveSystemNode() {
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

async function ensureServer() {
  if (await portIsOpen()) return;
  const nodeBinary = resolveSystemNode();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  serverProcess = spawn(nodeBinary, [path.join(ROOT_DIR, "server.mjs")], {
    cwd: ROOT_DIR,
    env,
    stdio: "inherit",
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

function placeWindow() {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const originX = Math.round(display.bounds.x + (display.bounds.width - PANEL_WIDTH) / 2);
  const originY = display.bounds.y;
  notchWindow.setBounds({ x: originX, y: originY, width: PANEL_WIDTH, height: PANEL_HEIGHT });
}

function createTrayIcon() {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const deltaX = column - 7.5;
      const deltaY = row - 7.5;
      const inside = deltaX * deltaX + deltaY * deltaY <= 36;
      const offset = (row * size + column) * 4;
      bitmap[offset] = inside ? 0xf8 : 0;
      bitmap[offset + 1] = inside ? 0x59 : 0;
      bitmap[offset + 2] = inside ? 0x8e : 0;
      bitmap[offset + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
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
    { label: "Toggle notch\tCtrl+Alt+Space", click: () => sendCommand({ action: "toggleExpand" }) },
    {
      label: overlayState.callPhase === "idle" ? "Start voice call\tCtrl+Shift+G" : "End voice call\tCtrl+Shift+G",
      click: () => sendCommand({ action: "toggleVoiceCall" })
    },
    { type: "separator" }
  ];
  if (botItems.length > 0) {
    template.push({ label: "Bots", enabled: false }, ...botItems, { type: "separator" });
  }
  template.push(
    {
      label: "Open Grok Bot",
      click: () => {
        const executable = grokBotExecutable();
        if (executable) shell.openPath(executable);
      }
    },
    { type: "separator" },
    { label: "Quit GrokBot Notch", click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
  const mark = overlayState.callPhase === "idle" ? "✦" : "🎙";
  tray.setToolTip(`${mark} ${overlayState.botName}`);
}

function syncExpandedShortcuts() {
  const arrowsActive = overlayState.isOpen && !overlayState.isTyping;
  for (const accelerator of ["Left", "Right"]) {
    if (arrowsActive) {
      if (!globalShortcut.isRegistered(accelerator)) {
        const action = accelerator === "Left" ? "prevBot" : "nextBot";
        globalShortcut.register(accelerator, () => sendCommand({ action }));
      }
    } else if (globalShortcut.isRegistered(accelerator)) {
      globalShortcut.unregister(accelerator);
    }
  }

  if (overlayState.isOpen) {
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
  const cursor = screen.getCursorScreenPoint();
  const bounds = notchWindow.getBounds();
  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  const hit = overlayState.hitRect;
  const pad = 10;
  const inside =
    localX >= hit.x - pad &&
    localX <= hit.x + hit.width + pad &&
    localY >= hit.y - pad &&
    localY <= hit.y + hit.height + pad;

  if (inside === ignoringMouse) {
    ignoringMouse = !inside;
    notchWindow.setIgnoreMouseEvents(!inside, { forward: true });
  }

  if (overlayState.isOpen) {
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
    ignoringMouse = false;
    notchWindow.setIgnoreMouseEvents(true, { forward: true });
    ignoringMouse = true;
  });

  notchWindow.loadURL(SERVER_URL);
}

function registerGlobalHotkeys() {
  const toggleOk = globalShortcut.register("Control+Alt+Space", () => {
    if (!notchWindow || notchWindow.isDestroyed()) return;
    placeWindow();
    notchWindow.show();
    notchWindow.focus();
    sendCommand({ action: "toggleExpand" });
  });
  const voiceOk = globalShortcut.register("Control+Shift+G", () => {
    if (!notchWindow || notchWindow.isDestroyed()) return;
    placeWindow();
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
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "media" || permission === "microphone" || permission === "audioCapture");
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === "media" || permission === "microphone" || permission === "audioCapture";
    });

    ipcMain.on("notch-host", (_event, payload) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "hitRect") {
        overlayState.hitRect = {
          x: Number(payload.x) || 0,
          y: Number(payload.y) || 0,
          width: Number(payload.width) || 212,
          height: Number(payload.height) || 56
        };
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

    tray = new Tray(createTrayIcon());
    tray.on("click", () => {
      if (!notchWindow || notchWindow.isDestroyed()) return;
      notchWindow.show();
      notchWindow.focus();
      sendCommand({ action: "toggleExpand" });
    });
    rebuildTrayMenu();
    createNotchWindow();
    registerGlobalHotkeys();
    cursorTimer = setInterval(updateMousePassthrough, 32);
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});

app.on("window-all-closed", () => {
  // The tray keeps the process alive. Quit comes from the tray menu.
});
