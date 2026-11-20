import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const nodeVersion = "22.14.0";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeExecutable = path.join(rootDir, "build", "node", "node.exe");

if (fs.existsSync(nodeExecutable)) {
  console.log("[gb-notch] Using the Node runtime already downloaded.");
  process.exit(0);
}

const archiveName = `node-v${nodeVersion}-win-x64.zip`;
const archiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
const archivePath = path.join(rootDir, "build", archiveName);
const extractDir = path.join(rootDir, "build", "node-extract");

fs.mkdirSync(path.dirname(archivePath), { recursive: true });

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.rmSync(destination, { force: true });
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Could not download Node ${nodeVersion}: HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    request.on("error", reject);
  });
}

console.log(`[gb-notch] Downloading Node ${nodeVersion} for the Windows executable...`);
await downloadFile(archiveUrl, archivePath);
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
const extracted = spawnSync("tar", ["-xf", archivePath, "-C", extractDir], { stdio: "inherit" });
if (extracted.status !== 0) {
  process.exit(extracted.status ?? 1);
}

const unpackedNode = path.join(extractDir, `node-v${nodeVersion}-win-x64`, "node.exe");
fs.mkdirSync(path.dirname(nodeExecutable), { recursive: true });
fs.copyFileSync(unpackedNode, nodeExecutable);
console.log("[gb-notch] Node runtime ready for packaging.");
