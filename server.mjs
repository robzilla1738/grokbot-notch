import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4789);

const HOME = os.homedir();
const CURSOR_STATE_DB = path.join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
const GROKBOT_SUPPORT_DIR = path.join(HOME, "Library/Application Support/Grok Bot");
const GROKBOT_SECRETS_FILE = path.join(GROKBOT_SUPPORT_DIR, "sand-secrets.json");
const GROKBOT_DOT_SETTINGS = path.join(HOME, ".grokbot/settings.json");
const PERSISTENCE_DIR = path.join(GROKBOT_SUPPORT_DIR, "sand-client-persistence");
const ROSTER_AVATARS_DIR = path.join(GROKBOT_SUPPORT_DIR, "roster-avatars");
const LOCAL_STATE_FILE = path.join(HOME, ".grokbot-notch-state.json");
const NOTCH_SUPPORT_DIR = path.join(HOME, "Library/Application Support/GrokBot Notch");
const AUTH_TOKEN_FILE = path.join(NOTCH_SUPPORT_DIR, "launch-auth-token");
const BACKEND_BASE = process.env.SAND_BACKEND_URL || "https://api2.cursor.sh";

const ALLOWED_HOSTS = new Set(["127.0.0.1:4789", "localhost:4789"]);
const ALLOWED_ORIGINS = new Set(["http://127.0.0.1:4789", "http://localhost:4789"]);

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const VOICES = [
  { id: "liora", label: "Liora", tag: "Warm & Natural (Default)" },
  { id: "ara", label: "Ara", tag: "Upbeat & Clear" },
  { id: "eve", label: "Eve", tag: "Expressive & Rich" },
  { id: "rex", label: "Rex", tag: "Confident & Crisp" },
  { id: "sal", label: "Sal", tag: "Smooth & Balanced" },
  { id: "leo", label: "Leo", tag: "Deep & Grounded" },
  { id: "helios", label: "Helios", tag: "Bright & Energetic" },
  { id: "helix", label: "Helix", tag: "Sharp & Analytical" },
  { id: "carina", label: "Carina", tag: "Gentle & Articulate" },
  { id: "luna", label: "Luna", tag: "Calm & Melodic" },
  { id: "orion", label: "Orion", tag: "Steady & Direct" },
  { id: "zagan", label: "Zagan", tag: "Bold & Textured" },
  { id: "kepler", label: "Kepler", tag: "Thoughtful & Measured" },
  { id: "rigel", label: "Rigel", tag: "Crisp & Fast" },
  { id: "atlas", label: "Atlas", tag: "Strong & Reassuring" },
  { id: "altair", label: "Altair", tag: "Light & Conversational" },
  { id: "aurora", label: "Aurora", tag: "Radiant & Friendly" },
  { id: "castor", label: "Castor", tag: "Focused & Clear" },
  { id: "celeste", label: "Celeste", tag: "Airy & Poised" },
  { id: "cosmo", label: "Cosmo", tag: "Playful & Curious" },
  { id: "iris", label: "Iris", tag: "Warm & Attentive" },
  { id: "lumen", label: "Lumen", tag: "Clean & Modern" },
  { id: "lux", label: "Lux", tag: "Polished & Studio" },
  { id: "naksh", label: "Naksh", tag: "Calm & Cadenced" },
  { id: "perseus", label: "Perseus", tag: "Direct & Executive" },
  { id: "sirius", label: "Sirius", tag: "Vibrant & Quick" },
  { id: "ursa", label: "Ursa", tag: "Grounded & Cozy" },
  { id: "zenith", label: "Zenith", tag: "Crisp & Precision" }
];

const SPEEDS = [
  { value: 0.75, label: "0.75×" },
  { value: 1, label: "1.0×" },
  { value: 1.25, label: "1.25×" },
  { value: 1.5, label: "1.5×" },
  { value: 2, label: "2.0×" }
];

const DEFAULT_COLORS = ["brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"];
const DEFAULT_SHAPES = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"];

function sha256Hex(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function defaultColorForAgentId(id) {
  const seed = ((fnv1a(id) ^ Math.imul(1, 2654435769)) >>> 0) ^ Math.imul(1, 2654435769);
  let t = ((seed >>> 0) + 1831565813) | 0;
  let n = Math.imul(t ^ (t >>> 15), 1 | t);
  n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
  const rnd = ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  return DEFAULT_COLORS[Math.floor(rnd * DEFAULT_COLORS.length)] || "violet";
}

function defaultShapeForAgentId(id) {
  let t = fnv1a(id) | 0;
  t = Math.imul(t ^ (t >>> 16), 73244475);
  t = Math.imul(t ^ (t >>> 13), 3266489909);
  const idx = ((t ^ (t >>> 16)) >>> 0) % DEFAULT_SHAPES.length;
  return DEFAULT_SHAPES[idx] || "blob";
}

function decodePersistenceFilename(filename) {
  if (!filename.endsWith(".blob")) return null;
  const stem = filename.slice(0, -5);
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of stem) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val < 0) return null;
    acc = (acc << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function createCursorChecksum(machineId) {
  const t = Math.floor(Date.now() / 1e6);
  const bytes = new Uint8Array([
    (t >> 40) & 255,
    (t >> 32) & 255,
    (t >> 24) & 255,
    (t >> 16) & 255,
    (t >> 8) & 255,
    t & 255
  ]);
  let prev = 165;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ prev) + (i % 256)) & 255;
    prev = bytes[i];
  }
  return `${Buffer.from(bytes).toString("base64url")}${machineId}`;
}

function parseJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function readLocalNotchState() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeLocalNotchState(patch) {
  const { safeStorageKeyBase64: _drop, ...safePatch } = patch || {};
  const next = { ...readLocalNotchState(), ...safePatch, updatedAt: Date.now() };
  delete next.safeStorageKeyBase64;
  try {
    fs.writeFileSync(LOCAL_STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    // ignore write errors
  }
  return next;
}

function scrubSafeStorageKeyFromPersistedState() {
  try {
    if (!fs.existsSync(LOCAL_STATE_FILE)) return;
    const saved = readLocalNotchState();
    if (!saved.safeStorageKeyBase64) return;
    delete saved.safeStorageKeyBase64;
    fs.writeFileSync(LOCAL_STATE_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  } catch {
    // ignore
  }
}

function ensureNotchSupportDir() {
  fs.mkdirSync(NOTCH_SUPPORT_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(NOTCH_SUPPORT_DIR, 0o700);
  } catch {
    // ignore
  }
}

function initLaunchAuthToken() {
  const fromEnv = process.env.GROKBOT_NOTCH_AUTH_TOKEN;
  const token =
    typeof fromEnv === "string" && fromEnv.length >= 32
      ? fromEnv
      : crypto.randomBytes(32).toString("base64url");
  ensureNotchSupportDir();
  try {
    fs.writeFileSync(AUTH_TOKEN_FILE, token, { mode: 0o600, encoding: "utf8" });
  } catch (err) {
    console.error("[gb-notch] Failed to write launch auth token file:", err.message);
  }
  return token;
}

const LAUNCH_AUTH_TOKEN = initLaunchAuthToken();

function authTokenMatches(provided) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(LAUNCH_AUTH_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractLaunchAuthToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  const custom = req.headers["x-grokbot-notch-token"];
  if (typeof custom === "string") return custom;
  return null;
}

function validateHostAndOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, status: 403, error: "Invalid Host" };
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return { ok: false, status: 403, error: "Invalid Origin" };
  }
  return { ok: true, origin: origin || null };
}

function corsHeadersForOrigin(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GrokBot-Notch-Token",
    Vary: "Origin"
  };
}

scrubSafeStorageKeyFromPersistedState();

let cachedSafeStorageKey = undefined;
function getSafeStorageKey() {
  if (cachedSafeStorageKey !== undefined) return cachedSafeStorageKey;
  try {
    const pw = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Grok Bot Safe Storage"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    cachedSafeStorageKey = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
    return cachedSafeStorageKey;
  } catch {
    cachedSafeStorageKey = null;
    return null;
  }
}

function decryptSafeStorageValue(storedValue) {
  if (!storedValue || typeof storedValue !== "string") return null;
  if (storedValue.startsWith("plaintext:v1:")) {
    return Buffer.from(storedValue.slice("plaintext:v1:".length), "base64").toString("utf8");
  }
  let base64Ciphertext = storedValue;
  if (storedValue.startsWith("scoped:v1:")) {
    const idx = storedValue.indexOf(":", "scoped:v1:".length);
    if (idx < 0) return null;
    base64Ciphertext = storedValue.slice(idx + 1);
  }
  try {
    const raw = Buffer.from(base64Ciphertext, "base64");
    if (raw.length <= 3 || raw.subarray(0, 3).toString("latin1") !== "v10") return null;
    const key = getSafeStorageKey();
    if (!key) return null;
    const iv = Buffer.alloc(16, 32);
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

function readActiveAccountScopeFromDisk() {
  // Check sand-secrets.json cursor-accounts.active first (authoritative when switching accounts in Grok Bot)
  if (fs.existsSync(GROKBOT_SECRETS_FILE)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(GROKBOT_SECRETS_FILE, "utf8"));
      if (secrets["cursor-accounts"]) {
        const parsed = JSON.parse(secrets["cursor-accounts"]);
        if (typeof parsed.active === "string" && parsed.active.length > 0) {
          return parsed.active;
        }
      }
    } catch {}
  }
  // Fallback to ~/.grokbot/settings.json
  if (fs.existsSync(GROKBOT_DOT_SETTINGS)) {
    try {
      const settings = JSON.parse(fs.readFileSync(GROKBOT_DOT_SETTINGS, "utf8"));
      if (typeof settings.activeAccountScope === "string" && settings.activeAccountScope.length > 0) {
        return settings.activeAccountScope;
      }
    } catch {}
  }
  return null;
}

function readLocalPersistenceSnapshot() {
  const result = {
    activeAccountSlot: null,
    activeAccountScope: readActiveAccountScopeFromDisk(),
    selectedTeamIdByScope: new Map(),
    pinnedAgentIdsByScope: new Map(),
    lastSelectedAgentIdByScope: new Map(),
    sectionsByScope: new Map(),
    localBotsById: new Map(),
    avatarDataUrlsById: new Map(),
    transcriptPreviewById: new Map(),
    localTranscriptEntriesById: new Map()
  };

  if (!fs.existsSync(PERSISTENCE_DIR)) return result;

  const files = fs.readdirSync(PERSISTENCE_DIR);
  const parsedBlobs = [];

  for (const f of files) {
    const key = decodePersistenceFilename(f);
    if (!key) continue;
    try {
      const raw = fs.readFileSync(path.join(PERSISTENCE_DIR, f), "utf8");
      const nl = raw.indexOf("\n");
      const jsonText = nl >= 0 && raw.startsWith('"sand.client.') ? raw.slice(nl + 1) : raw;
      const parsed = JSON.parse(jsonText);
      parsedBlobs.push({ key, value: parsed.value });
    } catch {
      // ignore unreadable blob
    }
  }

  for (const { key, value } of parsedBlobs) {
    if (key === "sand.client.slice.client-meta.account-slot" && typeof value === "string") {
      result.activeAccountSlot = value;
      if (!result.activeAccountScope) {
        result.activeAccountScope = sha256Hex(value);
      }
    }
  }

  for (const { key, value } of parsedBlobs) {
    if (!value) continue;
    const accMatch = /sand\.client\.slice\.account\.([^.]+)\./.exec(key);
    const slot = accMatch ? decodeURIComponent(accMatch[1]) : null;
    const scope = slot ? sha256Hex(slot) : null;

    if (scope && key.endsWith(".weekly-usage.cache") && typeof value.selectedTeamId === "number") {
      result.selectedTeamIdByScope.set(scope, value.selectedTeamId);
    } else if (scope && key.endsWith(".ui-agent-refs") && Array.isArray(value.pinnedAgentIds)) {
      result.pinnedAgentIdsByScope.set(scope, value.pinnedAgentIds);
    } else if (scope && key.endsWith(".selection.last-agent") && typeof value.agentId === "string") {
      result.lastSelectedAgentIdByScope.set(scope, value.agentId);
    } else if (scope && key.endsWith(".sidebar.last-sections") && Array.isArray(value.sections)) {
      result.sectionsByScope.set(scope, value.sections);
    } else if (key.endsWith(".roster.agent-avatars") && Array.isArray(value.entries)) {
      for (const entry of value.entries) {
        if (entry?.id && typeof entry.dataUrl === "string") {
          result.avatarDataUrlsById.set(entry.id, entry.dataUrl);
        }
      }
    } else if (scope && key.endsWith(".roster.last-roster") && Array.isArray(value.rows)) {
      const isCurrentActive = result.activeAccountScope ? scope === result.activeAccountScope : true;
      for (const row of value.rows) {
        if (!row?.id) continue;
        const existing = result.localBotsById.get(row.id);
        if (!existing || isCurrentActive) {
          result.localBotsById.set(row.id, {
            ...row,
            accountSlot: slot,
            accountScope: scope,
            isPrimaryAccount: isCurrentActive
          });
        }
      }
    } else if (key.includes(".transcript.replicas.") && Array.isArray(value.entries)) {
      const agentId = key.split(".transcript.replicas.")[1];
      if (!agentId) continue;
      const entries = value.entries;
      result.localTranscriptEntriesById.set(agentId, entries);
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.kind === "send-message" && e.message?.type === "text" && e.message.content) {
          result.transcriptPreviewById.set(agentId, {
            role: "assistant",
            text: String(e.message.content).replace(/\s+/g, " ").trim().slice(0, 180),
            timestampMs: e.timestampMs || null
          });
          break;
        }
        if (e?.kind === "message" && e.content) {
          result.transcriptPreviewById.set(agentId, {
            role: e.role || "user",
            text: String(e.content).replace(/\s+/g, " ").trim().slice(0, 180),
            timestampMs: e.timestampMs || null
          });
          break;
        }
      }
    }
  }

  return result;
}

// Cache resolved registered Sand machineId per accountScope
const sandMachineIdByScope = new Map();

function readAuthContext(localSnap = null, targetAccountScope = null) {
  const snap = localSnap || readLocalPersistenceSnapshot();
  const desiredScope = targetAccountScope || snap.activeAccountScope || null;

  let accessToken = process.env.CURSOR_ACCESS_TOKEN || null;
  let machineId = process.env.CURSOR_MACHINE_ID || null;
  let cachedEmail = "";
  let teamId = process.env.GROKBOT_TEAM_ID
    ? Number(process.env.GROKBOT_TEAM_ID)
    : (desiredScope ? snap.selectedTeamIdByScope.get(desiredScope) ?? null : null);
  let teamName = "";
  let userName = os.userInfo().username || "User";
  let matchedScope = null;

  // 1. Check Cursor state.vscdb — use its token ONLY if it matches desiredScope (or if no desiredScope is known)
  if (fs.existsSync(CURSOR_STATE_DB)) {
    const db = new DatabaseSync(CURSOR_STATE_DB, { open: true, readOnly: true });
    try {
      const getVal = (key) => {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
        return row?.value != null ? String(row.value) : null;
      };
      const vscToken = getVal("cursorAuth/accessToken");
      const vscMachineId = getVal("storage.serviceMachineId");
      if (vscMachineId && !machineId) {
        machineId = vscMachineId;
      }
      if (vscToken) {
        const jwt = parseJwtPayload(vscToken);
        const vscScope = jwt?.sub ? sha256Hex(jwt.sub) : null;
        if (!desiredScope || vscScope === desiredScope) {
          accessToken = accessToken || vscToken;
          matchedScope = vscScope;
          cachedEmail = getVal("cursorAuth/cachedEmail") || "";
          try {
            const teamObj = JSON.parse(getVal("cursorAuth/cachedTeam") || "{}");
            if (teamObj.teamId && teamId === null) teamId = Number(teamObj.teamId);
            if (teamObj.name) teamName = teamObj.name;
          } catch {}
          try {
            const profile = JSON.parse(getVal("cursorAuth/cachedScopedProfile") || "{}");
            if (profile.name) userName = profile.name.split(/\s+/)[0] || userName;
          } catch {}
        }
      }
    } finally {
      db.close();
    }
  }

  // 2. If desiredScope wasn't in state.vscdb (e.g. user switched accounts in Grok Bot!), read from sand-secrets.json
  if (!accessToken && fs.existsSync(GROKBOT_SECRETS_FILE)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(GROKBOT_SECRETS_FILE, "utf8"));
      if (secrets["cursor-machine-id"]) {
        const decMachine = decryptSafeStorageValue(secrets["cursor-machine-id"]);
        if (decMachine) machineId = decMachine;
      }
      const accountsObj = JSON.parse(secrets["cursor-accounts"] || "{}");
      const scopeKey = desiredScope || accountsObj.active || Object.keys(accountsObj.accounts || {})[0];
      const acc = scopeKey ? accountsObj.accounts?.[scopeKey] : null;
      if (acc?.["cursor-access-token"]) {
        accessToken = decryptSafeStorageValue(acc["cursor-access-token"]);
        matchedScope = scopeKey;
      }
      if (acc?.["cursor-account-profile"]) {
        try {
          const prof = JSON.parse(decryptSafeStorageValue(acc["cursor-account-profile"]) || "{}");
          if (prof.email) cachedEmail = prof.email;
          if (prof.name) userName = prof.name.split(/\s+/)[0] || userName;
        } catch {}
      }
      if (teamId === null && acc?.["cursor-selected-team-id"]) {
        const decTeam = decryptSafeStorageValue(acc["cursor-selected-team-id"]);
        if (decTeam && Number.isSafeInteger(Number(decTeam)) && Number(decTeam) > 0) {
          teamId = Number(decTeam);
        }
      }
    } catch {}
  }

  const finalScope = matchedScope || desiredScope || "default";
  const resolvedSandMachineId = sandMachineIdByScope.get(finalScope) || machineId || crypto.randomUUID();

  return {
    accountScope: finalScope,
    accessToken,
    machineId: resolvedSandMachineId,
    teamId: Number.isSafeInteger(teamId) && teamId > 0 ? teamId : null,
    teamName,
    cachedEmail,
    userName
  };
}

function buildBackendHeaders(auth) {
  const headers = {
    "authorization": `Bearer ${auth.accessToken}`,
    "x-cursor-checksum": createCursorChecksum(auth.machineId),
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": "0.71.2",
    "x-sand-box-namespace": "prod",
    "x-cursor-client-os": "darwin",
    "x-cursor-client-source": "sand-desktop",
    "x-ghost-mode": "true",
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-request-id": crypto.randomUUID(),
    "content-type": "application/json",
    "connect-protocol-version": "1",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.71.2 Safari/537.36"
  };
  if (auth.teamId != null) {
    headers["x-cursor-team-id"] = String(auth.teamId);
  }
  return headers;
}

async function resolveRegisteredSandMachineId(auth) {
  if (sandMachineIdByScope.has(auth.accountScope)) {
    return sandMachineIdByScope.get(auth.accountScope);
  }
  try {
    const res = await fetch(`${BACKEND_BASE}/aiserver.v1.DashboardService/ListSandMachines`, {
      method: "POST",
      headers: buildBackendHeaders(auth),
      body: JSON.stringify({})
    });
    if (res.ok) {
      const data = await res.json();
      const machines = Array.isArray(data?.machines) ? data.machines : [];
      const host = os.hostname().toLowerCase();
      const match =
        machines.find((m) => (m.label || "").toLowerCase() === host) ||
        machines.find((m) => m.connected && m.kind === "desktop") ||
        machines[0];
      if (match?.machineId) {
        sandMachineIdByScope.set(auth.accountScope, match.machineId);
        return match.machineId;
      }
    }
  } catch {}
  return auth.machineId;
}

function scopeForAgentId(agentId, localSnap = null) {
  if (!agentId) return null;
  const snap = localSnap || readLocalPersistenceSnapshot();
  const bot = snap.localBotsById.get(agentId);
  return bot?.accountScope || snap.activeAccountScope || null;
}

async function callGrokBotRpc(method, body = {}, { accountScope = null, localSnap = null } = {}) {
  const targetScope = accountScope || (body?.agentId ? scopeForAgentId(body.agentId, localSnap) : null);
  const auth = readAuthContext(localSnap, targetScope);
  if (!auth.accessToken) {
    throw new Error("Sign in to Grok Bot (or allow Keychain access) so GrokBot Notch can authenticate this account.");
  }
  const url = `${BACKEND_BASE}/aiserver.v1.GrokBotService/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildBackendHeaders(auth),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const refusal = res.headers.get("x-grok-bot-refusal");
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(refusal ? `${msg} (${refusal})` : msg);
    err.status = res.status;
    err.refusal = refusal;
    err.details = json;
    throw err;
  }
  return json;
}

function readRosterAvatarPhotoDataUrl(photoKey) {
  if (!photoKey) return null;
  const filePath = path.join(ROSTER_AVATARS_DIR, photoKey);
  if (!fs.existsSync(filePath)) return null;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return `data:image/png;base64,${buf.toString("base64")}`;
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    }
    const raw = buf.toString("utf8");
    const firstLine = raw.split("\n")[0] || "";
    if (firstLine.startsWith("data:image/")) return firstLine;
  } catch {
    // ignore
  }
  return null;
}

function normalizeBot(rawBot, localSnap, savedVoiceOverrides = {}, activeScope = null) {
  const id = rawBot.agentId || rawBot.id;
  const localRow = localSnap.localBotsById.get(id) || {};
  const override = savedVoiceOverrides[id] || {};
  const scope = localRow.accountScope || activeScope || localSnap.activeAccountScope || "default";
  const pinnedIds = localSnap.pinnedAgentIdsByScope.get(scope) || [];

  const rawShape = (rawBot.avatarShape ?? localRow.avatarShape ?? "").trim();
  const rawColor = (rawBot.avatarColor ?? localRow.avatarColor ?? "").trim();

  const avatarShape = rawShape || defaultShapeForAgentId(id);
  const avatarColor = rawColor || defaultColorForAgentId(id);

  let avatarPhotoUrl = rawBot.avatarDataUrl || localSnap.avatarDataUrlsById.get(id) || null;
  if (!avatarPhotoUrl && localRow.avatarPhoto?.key) {
    avatarPhotoUrl = readRosterAvatarPhotoDataUrl(localRow.avatarPhoto.key);
  }

  const voiceId =
    override.voiceId !== undefined
      ? override.voiceId
      : (rawBot.voiceId || localRow.voiceId || "liora");
  const voiceSpeed =
    override.voiceSpeed !== undefined
      ? Number(override.voiceSpeed)
      : Number(rawBot.voiceSpeed || localRow.voiceSpeed || 1);
  const voiceLanguage =
    override.voiceLanguage !== undefined
      ? override.voiceLanguage
      : (rawBot.voiceLanguage || localRow.voiceLanguage || "auto");

  const preview = localSnap.transcriptPreviewById.get(id) || null;

  return {
    id,
    name: rawBot.name || localRow.name || "Grok Bot",
    title: rawBot.title || localRow.title || "",
    description: rawBot.description || localRow.description || "",
    avatarShape,
    avatarColor,
    hasCustomShape: Boolean(rawShape),
    hasCustomColor: Boolean(rawColor),
    avatarPhotoUrl,
    voiceId,
    voiceSpeed: Number.isFinite(voiceSpeed) && voiceSpeed > 0 ? voiceSpeed : 1,
    voiceLanguage,
    hasUnread: Boolean(rawBot.hasUnread ?? localRow.hasUnread),
    unreadCount: Number(rawBot.unreadCount ?? localRow.unreadCount ?? 0),
    isPinned: pinnedIds.includes(id),
    isPrimaryAccount: activeScope ? scope === activeScope : localRow.isPrimaryAccount !== false,
    accountScope: scope,
    harness: rawBot.harness || localRow.harness || "temporal",
    updatedAtMs: Number(rawBot.updatedAtMs || localRow.updatedAt || localRow.lastActivityAt || 0),
    lastPreview: preview
  };
}

async function getBootstrapData() {
  const localSnap = readLocalPersistenceSnapshot();
  const notchState = readLocalNotchState();
  const voiceOverrides = notchState.voiceOverrides || {};
  const activeScope = localSnap.activeAccountScope;
  const auth = readAuthContext(localSnap, activeScope);

  // Warm the registered Sand machineId for this account in the background
  if (auth.accessToken) {
    resolveRegisteredSandMachineId(auth).catch(() => {});
  }

  let serverAgents = [];
  let liveConnected = false;
  if (auth.accessToken) {
    try {
      const res = await callGrokBotRpc("ListGrokBotAgents", {}, { accountScope: auth.accountScope, localSnap });
      if (Array.isArray(res?.agents)) {
        serverAgents = res.agents;
        liveConnected = true;
      }
    } catch (err) {
      console.warn("[gb-notch] ListGrokBotAgents fallback to local cache:", err.message);
    }
  }

  const botsById = new Map();
  for (const agent of serverAgents) {
    const id = agent.agentId || agent.id;
    if (!id) continue;
    botsById.set(id, normalizeBot(agent, localSnap, voiceOverrides, auth.accountScope));
  }

  for (const [id, localRow] of localSnap.localBotsById.entries()) {
    if (auth.accountScope && localRow.accountScope && localRow.accountScope !== auth.accountScope) {
      continue;
    }
    if (!botsById.has(id)) {
      botsById.set(id, normalizeBot(localRow, localSnap, voiceOverrides, auth.accountScope));
    }
  }

  const activeSections = localSnap.sectionsByScope.get(auth.accountScope) || [];
  const activePinnedIds = localSnap.pinnedAgentIdsByScope.get(auth.accountScope) || [];
  const lastSelectedForScope = localSnap.lastSelectedAgentIdByScope.get(auth.accountScope) || null;

  const sectionByBotId = new Map();
  for (const sec of activeSections) {
    if (sec?.name && Array.isArray(sec.agentIds)) {
      for (const aid of sec.agentIds) {
        sectionByBotId.set(aid, sec.name);
      }
    }
  }

  const rosterOrderIds = [...localSnap.localBotsById.keys()];

  const bots = [...botsById.values()].map((b) => ({
    ...b,
    section: b.isPinned ? "Pinned" : (sectionByBotId.get(b.id) || "Workspace")
  }));

  bots.sort((a, b) => {
    const pinA = activePinnedIds.indexOf(a.id);
    const pinB = activePinnedIds.indexOf(b.id);
    if (pinA !== -1 && pinB !== -1) return pinA - pinB;
    if (pinA !== -1) return -1;
    if (pinB !== -1) return 1;
    const idxA = rosterOrderIds.indexOf(a.id);
    const idxB = rosterOrderIds.indexOf(b.id);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    return b.updatedAtMs - a.updatedAtMs;
  });

  const savedSelectedByScope = notchState.selectedBotByScope?.[auth.accountScope] || notchState.selectedBotId;
  const preferredId =
    (bots.some((b) => b.id === savedSelectedByScope) ? savedSelectedByScope : null) ||
    (bots.some((b) => b.id === lastSelectedForScope) ? lastSelectedForScope : null) ||
    bots[0]?.id ||
    null;

  return {
    ok: true,
    liveConnected,
    activeAccountScope: auth.accountScope,
    user: {
      name: auth.userName,
      email: auth.cachedEmail,
      teamId: auth.teamId,
      teamName: auth.teamName
    },
    selectedBotId: preferredId,
    pinnedIds: activePinnedIds,
    sections: activeSections,
    bots,
    voices: VOICES,
    speeds: SPEEDS
  };
}

function parseServerTranscriptEntry(rawEntry) {
  if (!rawEntry?.body) return null;
  try {
    const decoded = JSON.parse(Buffer.from(rawEntry.body, "base64").toString("utf8"));
    return {
      seq: rawEntry.seq,
      entryKind: rawEntry.entryKind,
      ...decoded
    };
  } catch {
    return null;
  }
}

async function getBotTranscript(agentId, callId = null) {
  const entries = [];
  const voiceUpdates = [];
  const localSnap = readLocalPersistenceSnapshot();
  const targetScope = scopeForAgentId(agentId, localSnap);

  try {
    const res = await callGrokBotRpc(
      "ListGrokBotTranscriptEntries",
      { agentId, limit: 30 },
      { accountScope: targetScope, localSnap }
    );
    if (Array.isArray(res?.entries)) {
      for (const raw of res.entries) {
        const parsed = parseServerTranscriptEntry(raw);
        if (!parsed) continue;
        if (parsed.kind === "send-message" && parsed.message?.type === "text") {
          const channel = parsed.message.channel || null;
          if (callId && channel === `voice:${callId}`) {
            voiceUpdates.push({
              id: parsed.id,
              seq: parsed.seq,
              text: String(parsed.message.content || "").trim(),
              timestampMs: parsed.timestampMs || Date.now()
            });
          }
          entries.push({
            id: parsed.id,
            seq: parsed.seq,
            role: "assistant",
            text: String(parsed.message.content || "").trim(),
            channel,
            timestampMs: parsed.timestampMs || null
          });
        } else if (parsed.kind === "message" && typeof parsed.content === "string") {
          entries.push({
            id: parsed.id,
            seq: parsed.seq,
            role: parsed.role || "user",
            text: parsed.content.trim(),
            channel: parsed.channel || null,
            timestampMs: parsed.timestampMs || null
          });
        }
      }
    }
  } catch {
    const localEntries = localSnap.localTranscriptEntriesById.get(agentId) || [];
    for (const parsed of localEntries.slice(-25)) {
      if (parsed.kind === "send-message" && parsed.message?.type === "text") {
        entries.push({
          id: parsed.id,
          role: "assistant",
          text: String(parsed.message.content || "").trim(),
          timestampMs: parsed.timestampMs || null
        });
      } else if (parsed.kind === "message" && typeof parsed.content === "string") {
        entries.push({
          id: parsed.id,
          role: parsed.role || "user",
          text: parsed.content.trim(),
          timestampMs: parsed.timestampMs || null
        });
      }
    }
  }

  return {
    ok: true,
    agentId,
    entries: entries.slice(-20),
    voiceUpdates
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(body);
}

function injectAuthTokenIntoHtml(html) {
  const escaped = LAUNCH_AUTH_TOKEN.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const snippet = `<script>window.__GROKBOT_NOTCH_AUTH_TOKEN='${escaped}';</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${snippet}</head>`);
  }
  return `${snippet}${html}`;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg"
};

const server = http.createServer(async (req, res) => {
  const security = validateHostAndOrigin(req);
  const cors = corsHeadersForOrigin(security.origin);

  if (!security.ok) {
    return sendJson(res, security.status, { ok: false, error: security.error });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = parsedUrl.pathname;
  const isApiRoute = pathname === "/api" || pathname.startsWith("/api/");

  if (isApiRoute) {
    const token = extractLaunchAuthToken(req);
    if (!authTokenMatches(token)) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized" }, cors);
    }
  }

  try {
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      const data = await getBootstrapData();
      return sendJson(res, 200, data, cors);
    }

    if (req.method === "POST" && pathname === "/api/select-bot") {
      const body = await readJsonBody(req);
      if (!body.botId) return sendJson(res, 400, { ok: false, error: "Missing botId" }, cors);
      const localSnap = readLocalPersistenceSnapshot();
      const scope = scopeForAgentId(body.botId, localSnap) || localSnap.activeAccountScope || "default";
      const curState = readLocalNotchState();
      const selectedBotByScope = { ...(curState.selectedBotByScope || {}), [scope]: body.botId };
      writeLocalNotchState({ selectedBotId: body.botId, selectedBotByScope });
      return sendJson(res, 200, { ok: true, selectedBotId: body.botId }, cors);
    }

    if (req.method === "POST" && pathname === "/api/voice/start") {
      const body = await readJsonBody(req);
      const bootstrap = await getBootstrapData();
      const bot = bootstrap.bots.find((b) => b.id === body.agentId) || bootstrap.bots[0];
      if (!bot) {
        return sendJson(res, 404, { ok: false, error: "No Grok Bot found" }, cors);
      }

      const callId = `call-${crypto.randomUUID()}`;
      const spokenLanguage = body.voiceLanguage && body.voiceLanguage !== "auto" ? body.voiceLanguage : undefined;
      const targetScope = bot.accountScope || bootstrap.activeAccountScope;

      const [mintRes, planRes] = await Promise.all([
        callGrokBotRpc("MintSandVoiceCallSecret", {}, { accountScope: targetScope }),
        callGrokBotRpc(
          "VoiceCallHarnessSession",
          {
            agentId: bot.id,
            agentName: bot.name,
            userName: bootstrap.user.name || "User",
            ...(bot.description ? { description: bot.description } : {}),
            ...(spokenLanguage ? { spokenLanguage } : {})
          },
          { accountScope: targetScope }
        )
      ]);

      return sendJson(res, 200, {
        ok: true,
        callId,
        bot,
        credential: {
          clientSecret: mintRes.clientSecret,
          expiresAtUnixSeconds: Number(mintRes.expiresAtUnixSeconds),
          model: mintRes.model || "grok-voice-synapse",
          websocketUrl: mintRes.websocketUrl || "wss://api.x.ai/v1/realtime"
        },
        plan: {
          instructions: planRes.instructions,
          tools: planRes.tools || [],
          hasOverheard: Boolean(planRes.hasOverheard),
          greeting: planRes.greeting || {
            direction: `You are ${bot.name}. Open the call in one short spoken line.`,
            withLandedWork: `You are ${bot.name}. Open the call in one short spoken line.`
          },
          receipt: planRes.receipt || {
            output: { receipt: "under way" },
            instructions: "The job is under way. Keep talking naturally."
          }
        }
      }, cors);
    }

    if (req.method === "POST" && pathname === "/api/voice/tool") {
      const body = await readJsonBody(req);
      const { agentId, callId, name, input, line } = body;
      const rpcRes = await callGrokBotRpc("VoiceCallHarnessTool", {
        agentId,
        callId,
        name,
        input: input || {},
        line: line || {
          theyJustTalked: true,
          newsOwed: false,
          receiptOwed: false,
          alreadySpokeThisTurn: false
        }
      });
      return sendJson(res, 200, {
        ok: true,
        kind: rpcRes.kind,
        output: rpcRes.output ?? {}
      }, cors);
    }

    if (req.method === "POST" && pathname === "/api/voice/settings") {
      const body = await readJsonBody(req);
      const { agentId, voiceId, voiceSpeed, voiceLanguage } = body;
      if (!agentId) return sendJson(res, 400, { ok: false, error: "Missing agentId" }, cors);

      const state = readLocalNotchState();
      const voiceOverrides = state.voiceOverrides || {};
      voiceOverrides[agentId] = {
        ...(voiceOverrides[agentId] || {}),
        ...(voiceId !== undefined ? { voiceId } : {}),
        ...(voiceSpeed !== undefined ? { voiceSpeed: Number(voiceSpeed) } : {}),
        ...(voiceLanguage !== undefined ? { voiceLanguage } : {})
      };
      writeLocalNotchState({ voiceOverrides });

      try {
        await callGrokBotRpc("SetGrokBotAgentVoice", {
          id: agentId,
          ...(voiceId !== undefined ? { voiceId } : {}),
          ...(voiceSpeed !== undefined ? { voiceSpeed: Number(voiceSpeed) } : {}),
          ...(voiceLanguage !== undefined ? { voiceLanguage } : {})
        });
      } catch (err) {
        console.warn("[gb-notch] SetGrokBotAgentVoice warning:", err.message);
      }

      return sendJson(res, 200, { ok: true, voiceSettings: voiceOverrides[agentId] }, cors);
    }

    const transcriptMatch = /^\/api\/bot\/([^/]+)\/transcript$/.exec(pathname);
    if (req.method === "GET" && transcriptMatch) {
      const agentId = decodeURIComponent(transcriptMatch[1]);
      const callId = parsedUrl.searchParams.get("callId");
      const data = await getBotTranscript(agentId, callId);
      return sendJson(res, 200, data, cors);
    }

    const messageMatch = /^\/api\/bot\/([^/]+)\/message$/.exec(pathname);
    if (req.method === "POST" && messageMatch) {
      const agentId = decodeURIComponent(messageMatch[1]);
      const body = await readJsonBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "Empty message" }, cors);

      const localSnap = readLocalPersistenceSnapshot();
      const targetScope = scopeForAgentId(agentId, localSnap);
      const auth = readAuthContext(localSnap, targetScope);
      const sandMachineId = await resolveRegisteredSandMachineId(auth);

      const nowStr = String(Date.now());
      const messageId = crypto.randomUUID();
      const rpcRes = await callGrokBotRpc(
        "SendGrokBotUserMessage",
        {
          agentId,
          messageId,
          text,
          sentAtMs: nowStr,
          enterEpochMs: nowStr,
          composedAtMs: nowStr,
          isFork: false,
          source: "GROK_BOT_CLIENT_SURFACE_DESKTOP",
          initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_USER",
          sendSource: "GROK_BOT_SEND_SOURCE_CHAT",
          machineId: sandMachineId
        },
        { accountScope: targetScope, localSnap }
      );

      if (rpcRes?.delivery === "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED" || rpcRes?.delivery === 4) {
        return sendJson(res, 400, {
          ok: false,
          error: rpcRes?.refusal?.message || "Message refused by Grok Bot",
          response: rpcRes
        }, cors);
      }

      return sendJson(res, 200, { ok: true, messageId, response: rpcRes }, cors);
    }

    const openMatch = /^\/api\/bot\/([^/]+)\/open-desktop$/.exec(pathname);
    if (req.method === "POST" && openMatch) {
      execFile("/usr/bin/open", ["-a", "/Applications/Grok Bot.app"], () => {});
      return sendJson(res, 200, { ok: true }, cors);
    }

    // Serve static files from public/
    const relPath = pathname === "/" ? "index.html" : pathname.slice(1);
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.join(PUBLIC_DIR, safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const baseHeaders = {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
        ...cors
      };
      if (ext === ".html") {
        const html = fs.readFileSync(fullPath, "utf8");
        const body = injectAuthTokenIntoHtml(html);
        res.writeHead(200, baseHeaders);
        res.end(body);
        return;
      }
      res.writeHead(200, baseHeaders);
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" }, cors);
  } catch (err) {
    console.error("[gb-notch] API error:", err);
    sendJson(res, err.status || 500, {
      ok: false,
      error: err.message || "Internal error",
      refusal: err.refusal || null
    }, cors);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gb-notch] GrokBot Notch server listening on http://127.0.0.1:${PORT}`);
});
