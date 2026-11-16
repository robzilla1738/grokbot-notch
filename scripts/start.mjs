import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function launchMac(scriptName) {
  const child = spawn("bash", [path.join(rootDir, "scripts", scriptName)], {
    cwd: rootDir,
    stdio: "inherit"
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

function electronBinary() {
  return require("electron");
}

export function launchWindowsHost() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary(), [path.join(rootDir, "windows", "host.cjs")], {
    cwd: rootDir,
    stdio: "inherit",
    env
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

const command = path.basename(process.argv[1] || "");
if (command === "start.mjs") {
  if (process.platform === "darwin") {
    launchMac("launch.sh");
  } else if (process.platform === "win32") {
    launchWindowsHost();
  } else {
    console.error("[gb-notch] GrokBot Notch runs on macOS and Windows.");
    process.exit(1);
  }
}

export function grokBotLooksInstalled() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
    return fs.existsSync(path.join(localAppData, "Programs", "Grok Bot", "Grok Bot.exe"))
      || fs.existsSync(path.join(roaming, "Grok Bot"));
  }
  return fs.existsSync("/Applications/Grok Bot.app");
}
