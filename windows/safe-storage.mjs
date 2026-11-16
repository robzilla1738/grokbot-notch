import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let cachedAesKey = undefined;

function unprotectDpapi(protectedBytes) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$encoded = [Console]::In.ReadToEnd().Trim()",
    "$protectedBytes = [Convert]::FromBase64String($encoded)",
    "$clearBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($clearBytes))"
  ].join("\n");

  const clearBase64 = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      input: protectedBytes.toString("base64"),
      timeout: 15000,
      windowsHide: true
    }
  ).trim();

  return Buffer.from(clearBase64, "base64");
}

function readWindowsOsCryptKey() {
  if (cachedAesKey !== undefined) return cachedAesKey;
  try {
    const roamingDir = process.env.APPDATA || path.join(osHomedir(), "AppData", "Roaming");
    const localStatePath = path.join(roamingDir, "Grok Bot", "Local State");
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const encryptedKeyBase64 = localState?.os_crypt?.encrypted_key;
    if (!encryptedKeyBase64) {
      cachedAesKey = null;
      return null;
    }
    const encryptedKey = Buffer.from(encryptedKeyBase64, "base64");
    const dpapiPrefix = Buffer.from("DPAPI");
    if (encryptedKey.length <= dpapiPrefix.length || !encryptedKey.subarray(0, dpapiPrefix.length).equals(dpapiPrefix)) {
      cachedAesKey = null;
      return null;
    }
    const aesKey = unprotectDpapi(encryptedKey.subarray(dpapiPrefix.length));
    cachedAesKey = aesKey.length === 32 ? aesKey : null;
    return cachedAesKey;
  } catch (error) {
    console.error("[gb-notch] Could not unlock Grok Bot safe storage:", error.message);
    cachedAesKey = null;
    return null;
  }
}

function osHomedir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function decryptV10(payload, aesKey) {
  if (!aesKey || payload.length < 3 + 12 + 16) return null;
  if (payload.subarray(0, 3).toString("latin1") !== "v10") return null;
  const nonce = payload.subarray(3, 15);
  const authTag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(15, payload.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function decryptWindowsSafeStorageValue(storedValue) {
  if (!storedValue || typeof storedValue !== "string") return null;
  if (storedValue.startsWith("plaintext:v1:")) {
    return Buffer.from(storedValue.slice("plaintext:v1:".length), "base64").toString("utf8");
  }

  let encodedPayload = storedValue;
  if (storedValue.startsWith("scoped:v1:")) {
    const separator = storedValue.indexOf(":", "scoped:v1:".length);
    if (separator < 0) return null;
    encodedPayload = storedValue.slice(separator + 1);
  }

  const payload = Buffer.from(encodedPayload, "base64");
  const aesKey = readWindowsOsCryptKey();
  try {
    const clearText = decryptV10(payload, aesKey);
    if (clearText) return clearText;
  } catch {
    // Some older values are raw DPAPI blobs. Try that next.
  }

  try {
    const clearText = unprotectDpapi(payload).toString("utf8");
    return clearText || null;
  } catch {
    return null;
  }
}
