import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grokBotLooksInstalled, launchWindowsHost } from "./start.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform === "darwin") {
  const child = spawn("bash", [path.join(rootDir, "scripts", "setup.sh"), ...process.argv.slice(2)], {
    cwd: rootDir,
    stdio: "inherit"
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (process.platform === "win32") {
  const [major, minor] = process.versions.node.split(".").map((part) => Number(part));
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`[gb-notch] Node.js 22.5+ is required (found ${process.version}).`);
    process.exit(1);
  }
  if (!grokBotLooksInstalled()) {
    console.warn("[gb-notch] Desktop Grok Bot was not found. Sign in to Grok Bot, then start the notch again.");
  } else {
    console.log("[gb-notch] Found Desktop Grok Bot.");
  }
  console.log("[gb-notch] Starting the Windows notch. Toggle with Ctrl+Alt+Space. Voice with Ctrl+Shift+G.");
  launchWindowsHost();
} else {
  console.error("[gb-notch] GrokBot Notch runs on macOS and Windows.");
  process.exit(1);
}
