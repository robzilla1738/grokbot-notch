import {
  createMotionEngine,
  createStateMachine,
  buildFrameSvgTree,
  patchSvgDom,
  normalizeBodyShape,
  createAppearance,
  colorTokens,
  pointerToGaze,
  renderStillSvg
} from "/motion-lab.js";

const isNativeHost =
  Boolean(window.webkit?.messageHandlers?.notchHost) ||
  new URLSearchParams(location.search).get("native") === "1";

if (!isNativeHost) {
  document.body.classList.add("browser-preview");
}
if (window.grokbotNotchHost) {
  document.body.classList.add("windows-host");
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = window.__GROKBOT_NOTCH_AUTH_TOKEN;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}

function postNativeMessage(payload) {
  try {
    window.webkit?.messageHandlers?.notchHost?.postMessage(payload);
  } catch {}
  try {
    window.grokbotNotchHost?.postMessage?.(payload);
  } catch {}
}

function resampleToRate(samples, fromRate, toRate) {
  if (!samples || fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const resampled = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const blend = sourcePosition - leftIndex;
    resampled[index] = samples[leftIndex] * (1 - blend) + samples[rightIndex] * blend;
  }
  return resampled;
}

// UI Sound Effects
const SOUNDS = {
  open: new Audio("/sounds/open-blip.wav"),
  tick: new Audio("/sounds/tick.wav"),
  doubleTick: new Audio("/sounds/double-tick.wav"),
  chimeA: new Audio("/sounds/chime-a.wav"),
  chimeB: new Audio("/sounds/chime-b.wav")
};
for (const s of Object.values(SOUNDS)) {
  s.volume = 0.4;
}
function playUiSound(name) {
  try {
    const snd = SOUNDS[name];
    if (!snd) return;
    snd.currentTime = 0;
    snd.play().catch(() => {});
  } catch {}
}

// Authentic Grok Bot Voice Call Connect (E5->B5) & Hangup (B5->E5) Chimes
function playCallChime(kind = "connect") {
  try {
    const sampleRate = 24000;
    const notes =
      kind === "connect"
        ? [{ frequencyHz: 659.25, durationMs: 90 }, { frequencyHz: 987.77, durationMs: 150 }]
        : [{ frequencyHz: 987.77, durationMs: 90 }, { frequencyHz: 659.25, durationMs: 150 }];
    const counts = notes.map((n) => Math.max(1, Math.round((n.durationMs / 1000) * sampleRate)));
    const attack = Math.max(1, Math.round((6 / 1000) * sampleRate));
    const total = counts.reduce((a, b) => a + b, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < notes.length; i++) {
      const len = counts[i];
      const freq = notes[i].frequencyHz;
      for (let j = 0; j < len; j++) {
        const envIn = Math.min(1, j / attack);
        const envOut = (1 - j / len) ** 2;
        samples[offset + j] = 0.16 * envIn * envOut * Math.sin((2 * Math.PI * freq * j) / sampleRate);
      }
      offset += len;
    }
    const ctx = new AudioContext({ sampleRate });
    const buf = ctx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => ctx.close().catch(() => {});
    src.start();
  } catch {
    playUiSound(kind === "connect" ? "chimeA" : "chimeB");
  }
}

// State: starts collapsed ("start collapsed similar to how it is. then this on expand.")
const state = {
  expanded: false,
  typing: false,
  sendingText: false,
  activeAccountScope: null,
  bots: [],
  selectedBotId: null,
  statusCaption: "",
  call: {
    phase: "idle", // "idle" | "connecting" | "live"
    activity: "quiet", // "quiet" | "caller-speaking" | "agent-thinking" | "agent-speaking" | "working"
    callId: null,
    isMuted: false,
    energy: 0
  },
  settingsOpen: false,
  compact: false,
  voices: [],
  speeds: [],
  languages: [],
  switchConfirmDelta: null
};

const dom = {
  pouch: document.getElementById("notch-pouch"),
  dragHandle: document.getElementById("drag-handle"),
  collapsedBar: document.getElementById("collapsed-bar"),
  collapsedMark: document.getElementById("collapsed-mark"),
  collapsedName: document.getElementById("collapsed-name"),
  botCharacterBtn: document.getElementById("bot-character-btn"),
  botMarkMount: document.getElementById("bot-mark-mount"),
  mainStarBadge: document.getElementById("main-star-badge"),
  botNameLabel: document.getElementById("bot-name-label"),
  voiceSummary: document.getElementById("voice-summary"),
  botStatusCaption: document.getElementById("bot-status-caption"),
  voiceSettingsBtn: document.getElementById("voice-settings-btn"),
  sizeBtn: document.getElementById("size-btn"),
  voiceSettings: document.getElementById("voice-settings"),
  voiceIdSelect: document.getElementById("voice-id-select"),
  voiceSpeedSelect: document.getElementById("voice-speed-select"),
  voiceLanguageSelect: document.getElementById("voice-language-select"),
  prevBotBtn: document.getElementById("prev-bot-btn"),
  nextBotBtn: document.getElementById("next-bot-btn"),
  audioWavesBtn: document.getElementById("audio-waves-btn"),
  audioWavesBars: document.getElementById("audio-waves-bars"),
  typeForm: document.getElementById("type-form"),
  typeInput: document.getElementById("type-input"),
  switchConfirm: document.getElementById("switch-confirm"),
  switchConfirmText: document.getElementById("switch-confirm-text"),
  switchConfirmYes: document.getElementById("switch-confirm-yes"),
  switchConfirmNo: document.getElementById("switch-confirm-no")
};

if (window.grokbotNotchHost) {
  dom.collapsedBar.title = "Expand GrokBot Notch (Ctrl+Alt+Space)";
  dom.botCharacterBtn.title = "Click to start / stop Voice Mode (Ctrl+Shift+G)";
}

function getSelectedBot() {
  return state.bots.find((bot) => bot.id === state.selectedBotId) || state.bots[0] || null;
}

function clampVoiceSpeed(speed) {
  const numericSpeed = Number(speed);
  if (!Number.isFinite(numericSpeed)) return 1;
  return Math.min(1.5, Math.max(0.7, numericSpeed));
}

function voiceSummaryText(bot) {
  if (!bot) return "";
  const voice = state.voices.find((item) => item.id === bot.voiceId);
  const speed = state.speeds.find((item) => Number(item.value) === Number(bot.voiceSpeed));
  const language = state.languages.find((item) => item.id === bot.voiceLanguage);
  const voiceLabel = voice?.label || bot.voiceId || "Liora";
  const speedLabel = speed?.label || `${Number(bot.voiceSpeed) || 1}×`;
  const languageLabel = !bot.voiceLanguage || bot.voiceLanguage === "auto"
    ? "Auto"
    : (language?.label || bot.voiceLanguage);
  return `${voiceLabel} · ${speedLabel} · ${languageLabel}`;
}

function realtimeVoiceConfig(bot) {
  const transcription = { model: "grok-transcribe" };
  if (bot.voiceLanguage && bot.voiceLanguage !== "auto") {
    transcription.language_hint = bot.voiceLanguage;
  }
  return {
    ...(bot.voiceId ? { voice: bot.voiceId } : {}),
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription
      },
      output: {
        format: { type: "audio/pcm", rate: 24000 },
        speed: clampVoiceSpeed(bot.voiceSpeed)
      }
    }
  };
}

function pushLiveVoice(bot) {
  const socket = activeSession?.ws;
  if (!bot || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "session.update",
    session: realtimeVoiceConfig(bot)
  }));
}

function fillVoiceSelect(select, options, currentValue, valueKey, labelKey) {
  const known = options.some((option) => String(option[valueKey]) === String(currentValue));
  const entries = known || currentValue == null
    ? options
    : [{ [valueKey]: currentValue, [labelKey]: String(currentValue) }, ...options];
  select.replaceChildren();
  for (const option of entries) {
    const element = document.createElement("option");
    element.value = String(option[valueKey]);
    element.textContent = option[labelKey];
    if (String(option[valueKey]) === String(currentValue)) element.selected = true;
    select.append(element);
  }
}

function renderVoiceSettings(bot) {
  if (!bot) return;
  fillVoiceSelect(dom.voiceIdSelect, state.voices, bot.voiceId, "id", "label");
  fillVoiceSelect(dom.voiceSpeedSelect, state.speeds, bot.voiceSpeed, "value", "label");
  fillVoiceSelect(dom.voiceLanguageSelect, state.languages, bot.voiceLanguage || "auto", "id", "label");
}

function clearFittedSize() {
  dom.pouch.style.width = "";
  dom.pouch.style.height = "";
}

function setWidgetCompact(compact) {
  state.compact = Boolean(compact);
  clearFittedSize();
  dom.pouch.dataset.size = state.compact ? "compact" : "full";
  const label = state.compact ? "Agrandar" : "Achicar";
  dom.sizeBtn.title = label;
  dom.sizeBtn.setAttribute("aria-label", label);
  try {
    localStorage.setItem("grokbot-notch-size", state.compact ? "compact" : "full");
  } catch {
    // The choice still applies for this session.
  }
  reportHitRectToNative();
}

function setSettingsOpen(open) {
  state.settingsOpen = Boolean(open);
  clearFittedSize();
  dom.pouch.dataset.settings = String(state.settingsOpen);
  if (state.settingsOpen) {
    setTypingMode(false);
    renderVoiceSettings(getSelectedBot());
  }
  reportHitRectToNative();
}

// Exact flat color palette matching Grok Bot dark mode (with softer, less harsh blue)
const FLAT_BOT_PALETTE = {
  violet: "#8e59f8",
  red: "#f73643",
  brown: "#a16b39",
  yellow: "#f59312",
  orange: "#f4650e",
  green: "#13bb6b",
  cyan: "#12b39f",
  magenta: "#f63397",
  blue: "#3d8df5",
  black: "#ffffff",
  gray: "#a6a6a6"
};

function getFlatBotInk(colorId) {
  if (FLAT_BOT_PALETTE[colorId]) return FLAT_BOT_PALETTE[colorId];
  const tok = colorTokens[colorId] || colorTokens.violet;
  return tok.dark;
}

// ============================================================================
// FLAT GROK BOT CHARACTER ENGINE (Exact Flat Style from Image 1)
// ============================================================================
const botEngine = createMotionEngine({ body: "hex" });
const botStateMachine = createStateMachine(botEngine, "idle", {
  seed: 101,
  isCompact: false,
  isResting: false
});

let lastTick = performance.now();

function currentMotionState() {
  if (state.call.phase === "connecting") return "waking";
  if (state.call.phase === "live") {
    switch (state.call.activity) {
      case "caller-speaking":
        return "listening";
      case "agent-thinking":
        return "thinking";
      case "agent-speaking":
        return "streaming";
      case "working":
        return "working";
      default:
        return "listening";
    }
  }
  if (state.sendingText) return "thinking";
  return "idle";
}

function syncCharacterToBot(bot) {
  if (!bot) return;
  const bodyShape = normalizeBodyShape(bot.avatarShape || "blob");
  botEngine.setBody(bodyShape);
  const ink = getFlatBotInk(bot.avatarColor);
  document.documentElement.style.setProperty("--bot-ink", ink);

  // Collapsed bar mini flat mark
  dom.collapsedMark.innerHTML = renderStillSvg({
    body: bodyShape,
    ink,
    size: 16,
    id: "collapsed-still-mark"
  });
  dom.collapsedName.textContent = bot.name;
}

function tickAnimation(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  const bot = getSelectedBot();
  if (bot && state.expanded) {
    const desired = currentMotionState();
    botStateMachine.setState(desired);
    botStateMachine.advance(dt);
    botEngine.advance(dt);

    const ink = getFlatBotInk(bot.avatarColor);
    const flatAppearance = createAppearance(ink); // Pure flat silhouette with cutout eyes
    const tree = buildFrameSvgTree(botEngine.frame(), flatAppearance, 184, "pouch-bot-mark", {
      displaySize: 92,
      extent: "100%"
    });
    patchSvgDom(dom.botMarkMount, tree);

    // Animate bottom audio wave bars (||||..||l|..)
    renderAudioWaveBars(now);
  }

  requestAnimationFrame(tickAnimation);
}

// Idle wave pattern matching whiteboard sketch "||||..||l|.." + live audio reactivity
const IDLE_WAVE_PATTERN = [11, 14, 10, 15, 4, 4, 12, 16, 9, 13, 4, 4, 11, 15, 9];

function renderAudioWaveBars(now) {
  const bars = dom.audioWavesBars.querySelectorAll("span");
  const isLive = state.call.phase === "live";
  const isConnecting = state.call.phase === "connecting";
  const energy = Math.max(0, Math.min(1, state.call.energy));

  bars.forEach((bar, i) => {
    const base = IDLE_WAVE_PATTERN[i % IDLE_WAVE_PATTERN.length];
    if (isLive) {
      const activeMod = 0.45 + 0.55 * Math.abs(Math.sin(now * 0.014 + i * 0.75));
      const h = 4 + Math.round((base * 0.35 + energy * 18) * activeMod);
      bar.style.height = `${Math.max(3, Math.min(22, h))}px`;
    } else if (isConnecting) {
      const pulse = 4 + Math.round(8 * (0.5 + 0.5 * Math.sin(now * 0.008 + i * 0.45)));
      bar.style.height = `${pulse}px`;
    } else {
      const gentle = Math.round(base * (0.78 + 0.22 * Math.sin(now * 0.0025 + i * 0.6)));
      bar.style.height = `${Math.max(3, gentle)}px`;
    }
  });
}

function updateGaze(clientX, clientY) {
  if (!state.expanded) return;
  const rect = dom.botMarkMount.getBoundingClientRect();
  if (rect.width > 0) {
    botEngine.setGaze(pointerToGaze(rect, { x: clientX, y: clientY }, 2.5));
  }
}

window.addEventListener(
  "pointermove",
  (e) => {
    updateGaze(e.clientX, e.clientY);
  },
  { passive: true }
);

// ============================================================================
// NATIVE HIT-RECT SYNC
// ============================================================================
function reportHitRectToNative() {
  const pouch = dom.pouch;
  const fittedWidth = pouch.style.width;
  const fittedHeight = pouch.style.height;
  pouch.style.width = "";
  pouch.style.height = "";
  const naturalRect = pouch.getBoundingClientRect();
  pouch.style.width = fittedWidth;
  pouch.style.height = fittedHeight;
  const gripRect = dom.dragHandle.getBoundingClientRect();
  const bot = getSelectedBot();
  postNativeMessage({
    type: "hitRect",
    x: naturalRect.left,
    y: naturalRect.top,
    width: naturalRect.width,
    height: naturalRect.height,
    dragX: gripRect.left,
    dragY: gripRect.top,
    dragWidth: gripRect.width,
    dragHeight: gripRect.height,
    isOpen: state.expanded,
    isTyping: state.typing || state.settingsOpen,
    callPhase: state.call.phase,
    botName: bot?.name || "Grok Bot"
  });
}

const resizeObserver = new ResizeObserver(() => reportHitRectToNative());
resizeObserver.observe(dom.pouch);
if (dom.dragHandle) resizeObserver.observe(dom.dragHandle);

function watchDevicePixelRatio() {
  const resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  resolutionQuery.addEventListener(
    "change",
    () => {
      clearFittedSize();
      reportHitRectToNative();
      watchDevicePixelRatio();
    },
    { once: true }
  );
}
watchDevicePixelRatio();

function setExpanded(expanded) {
  const next = Boolean(expanded);
  if (state.expanded === next) return;
  state.expanded = next;
  clearFittedSize();
  dom.pouch.dataset.expanded = String(next);
  if (!next) setSettingsOpen(false);
  if (next) {
    playUiSound("open");
    refreshBootstrap();
  } else {
    setTypingMode(false);
    hideSwitchConfirm();
  }
  reportHitRectToNative();
  let steps = 0;
  const timer = setInterval(() => {
    reportHitRectToNative();
    if (++steps > 10) clearInterval(timer);
  }, 35);
}

function setTypingMode(typing, initialChar = "") {
  state.typing = Boolean(typing);
  dom.pouch.dataset.typing = String(state.typing);
  dom.audioWavesBtn.hidden = state.typing;
  dom.typeForm.hidden = !state.typing;
  if (state.typing) {
    if (initialChar) {
      dom.typeInput.value = initialChar;
    }
    setTimeout(() => {
      dom.typeInput.focus();
      const len = dom.typeInput.value.length;
      dom.typeInput.setSelectionRange(len, len);
    }, 20);
  } else {
    dom.typeInput.blur();
  }
  reportHitRectToNative();
}

// ============================================================================
// AUDIO PIPELINE (Native AVAudioEngine + WebAudio 24kHz Fallback)
// ============================================================================
class VoiceAudioPipeline {
  constructor({ onPcm16Base64, onSpeechEnded, onEnergy }) {
    this.onPcm16Base64 = onPcm16Base64;
    this.onSpeechEnded = onSpeechEnded;
    this.onEnergy = onEnergy;
    this.useNativeAudio = isNativeHost && Boolean(window.webkit?.messageHandlers?.notchHost);
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.silentGain = null;
    this.scheduledSources = new Set();
    this.speakingSpans = new Map();
    this.playbackCursor = 0;
    this.speechDrainedResolvers = [];
  }

  async start(existingStream = null) {
    if (this.useNativeAudio) {
      window.__onNativeMicFrame = (base64Pcm, rms) => {
        this.onEnergy?.(Math.min(1, rms * 4.5));
        this.onPcm16Base64(base64Pcm);
      };
      window.__onNativeSpeakerEnergy = (rms) => {
        this.onEnergy?.(Math.min(1, rms * 3.8));
      };
      window.__onNativeSpeechEnded = () => {
        for (const r of this.speechDrainedResolvers.splice(0)) r();
        this.onSpeechEnded?.();
      };
      postNativeMessage({ type: "audioStart" });
      return;
    }

    this.stream = existingStream || await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    try {
      this.ctx = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
    } catch {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      const inputSamples = ev.inputBuffer.getChannelData(0);
      const floatSamples = resampleToRate(inputSamples, this.ctx.sampleRate, 24000);
      let sum = 0;
      const int16 = new Int16Array(floatSamples.length);
      for (let index = 0; index < floatSamples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, floatSamples[index]));
        sum += sample * sample;
        int16[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      const rms = Math.sqrt(sum / floatSamples.length);
      if (this.scheduledSources.size === 0) {
        this.onEnergy?.(Math.min(1, rms * 5));
      }
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        binary += String.fromCharCode(bytes[byteIndex]);
      }
      this.onPcm16Base64(btoa(binary));
    };
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);
  }

  speakBase64Pcm16({ base64, itemId, contentIndex = 0 }) {
    if (this.useNativeAudio) {
      const nowSec = performance.now() / 1000;
      const byteLen = Math.floor((base64.length * 3) / 4);
      const durationSec = Math.floor(byteLen / 2) / 24000;
      const startSec = Math.max(nowSec, this.playbackCursor);
      this.playbackCursor = startSec + durationSec;
      if (itemId) {
        const key = `${itemId}:${contentIndex}`;
        const existing = this.speakingSpans.get(key);
        if (!existing) {
          this.speakingSpans.set(key, { itemId, contentIndex, startsAt: startSec, endsAt: this.playbackCursor });
        } else {
          existing.endsAt = this.playbackCursor;
        }
      }
      postNativeMessage({ type: "audioPlay", base64, itemId, contentIndex });
      return;
    }

    if (!this.ctx) return;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    let sum = 0;
    for (let i = 0; i < int16.length; i++) {
      const f = int16[i] / 32768;
      float32[i] = f;
      sum += f * f;
    }
    this.onEnergy?.(Math.min(1, Math.sqrt(sum / float32.length) * 3.8));

    const buffer = this.ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime, this.playbackCursor);
    src.start(startAt);
    this.scheduledSources.add(src);
    this.playbackCursor = startAt + buffer.duration;

    if (itemId) {
      const key = `${itemId}:${contentIndex}`;
      const span = this.speakingSpans.get(key);
      if (!span) {
        this.speakingSpans.set(key, { itemId, contentIndex, startsAt: startAt, endsAt: this.playbackCursor });
      } else {
        span.endsAt = this.playbackCursor;
      }
    }

    src.onended = () => {
      this.scheduledSources.delete(src);
      if (this.scheduledSources.size === 0) {
        this.speakingSpans.clear();
        this.onEnergy?.(0);
        for (const r of this.speechDrainedResolvers.splice(0)) r();
        this.onSpeechEnded?.();
      }
    };
  }

  dropScheduledSpeechForBargeIn() {
    const cuts = [];
    const nowSec = this.useNativeAudio ? performance.now() / 1000 : (this.ctx?.currentTime ?? 0);
    for (const span of this.speakingSpans.values()) {
      if (nowSec < span.endsAt) {
        cuts.push({
          itemId: span.itemId,
          contentIndex: span.contentIndex,
          audioEndMs: Math.max(0, Math.round((nowSec - span.startsAt) * 1000))
        });
      }
    }
    this.speakingSpans.clear();
    this.playbackCursor = 0;

    if (this.useNativeAudio) {
      postNativeMessage({ type: "audioStopPlayback" });
    } else {
      for (const s of this.scheduledSources) {
        s.onended = null;
        try { s.stop(); s.disconnect(); } catch {}
      }
      this.scheduledSources.clear();
    }
    this.onEnergy?.(0);
    return cuts;
  }

  whenScheduledSpeechEnds() {
    if (!this.useNativeAudio && this.scheduledSources.size === 0) return Promise.resolve();
    if (this.useNativeAudio && performance.now() / 1000 >= this.playbackCursor) return Promise.resolve();
    return new Promise((resolve) => {
      this.speechDrainedResolvers.push(resolve);
      setTimeout(resolve, 4000);
    });
  }

  stop() {
    this.dropScheduledSpeechForBargeIn();
    if (this.useNativeAudio) {
      postNativeMessage({ type: "audioStop" });
      return;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try { this.processor.disconnect(); } catch {}
    }
    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch {}
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
    }
  }
}

// ============================================================================
// VOICE CALL CONTROLLER
// ============================================================================
let activeSession = null;
let transcriptPollInterval = null;
let voiceCallGeneration = 0;
const openVoiceSessions = new Set();

function closeVoiceSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  openVoiceSessions.delete(session);
  if (session.greetingTimer) {
    clearTimeout(session.greetingTimer);
    session.greetingTimer = null;
  }
  try {
    session.audioPipeline?.stop();
  } catch {
    // The pipeline may already be stopped.
  }
  const socket = session.ws;
  try {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, "hang_up");
    }
  } catch {
    // Closing a socket that already died is fine.
  }
}

function closeEveryVoiceSession() {
  for (const session of [...openVoiceSessions]) {
    closeVoiceSession(session);
  }
  activeSession = null;
}

function voiceStartWasReplaced(generation) {
  return generation !== voiceCallGeneration;
}

function stopPrimedMicrophone(primedMicStream) {
  if (!primedMicStream) return;
  for (const track of primedMicStream.getTracks()) track.stop();
}

async function startVoiceCall() {
  const generation = ++voiceCallGeneration;
  closeEveryVoiceSession();
  if (transcriptPollInterval) {
    clearInterval(transcriptPollInterval);
    transcriptPollInterval = null;
  }
  setExpanded(true);
  await refreshBootstrap();
  if (voiceStartWasReplaced(generation)) return;
  const bot = getSelectedBot();
  if (!bot) {
    state.call.phase = "idle";
    state.call.activity = "quiet";
    state.statusCaption = "";
    renderPouch();
    return;
  }
  state.call = {
    phase: "connecting",
    activity: "quiet",
    callId: null,
    isMuted: false,
    energy: 0
  };
  state.statusCaption = "Connecting…";
  renderPouch();

  let primedMicStream = null;
  try {
    if (!window.webkit?.messageHandlers?.notchHost) {
      primedMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }
    const startRes = await apiFetch("/api/voice/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: bot.id,
        voiceId: bot.voiceId,
        voiceSpeed: bot.voiceSpeed,
        voiceLanguage: bot.voiceLanguage
      })
    }).then((r) => r.json());

    if (voiceStartWasReplaced(generation)) {
      stopPrimedMicrophone(primedMicStream);
      return;
    }

    if (!startRes.ok) {
      throw new Error(startRes.error || "Could not start voice call");
    }

    const { callId, credential, plan } = startRes;
    state.call.callId = callId;

    const wsUrl = new URL(credential.websocketUrl);
    wsUrl.searchParams.set("model", credential.model);

    const ws = new WebSocket(wsUrl.toString(), [`xai-client-secret.${credential.clientSecret}`]);
    ws.binaryType = "arraybuffer";

    const assistantDeltas = new Map();
    const seenVoiceUpdateIds = new Set();
    let invitedModel = false;
    let callerIsSpeaking = false;
    let theyTalkedOverThisResponse = false;

    const audioPipeline = new VoiceAudioPipeline({
      onPcm16Base64: (base64) => {
        if (session.closed || voiceStartWasReplaced(generation) || state.call.isMuted || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
      },
      onSpeechEnded: () => {
        if (state.call.phase === "live" && state.call.activity === "agent-speaking") {
          state.call.activity = "quiet";
          state.statusCaption = "Listening";
          renderPouch();
        }
      },
      onEnergy: (energy) => {
        state.call.energy = energy;
      }
    });

    const session = {
      ws,
      audioPipeline,
      greetingTimer: null,
      closed: false,
      generation,
      sendWrittenTurn(text) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        const eventId = `written-turn-${crypto.randomUUID()}`;
        ws.send(JSON.stringify({
          type: "async_update.add",
          event_id: eventId,
          async_update: {
            topic: "written_message",
            payload: [{ message: { type: "text", content: text.slice(0, 2000) }, timestampMs: Date.now() }]
          }
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
        return true;
      }
    };
    openVoiceSessions.add(session);

    ws.addEventListener("open", () => {
      if (session.closed || voiceStartWasReplaced(generation)) return;
      if (invitedModel || ws.readyState !== WebSocket.OPEN) return;
      invitedModel = true;
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          ...realtimeVoiceConfig(bot),
          resumption: { enabled: true },
          instructions: plan.instructions,
          turn_detection: { type: "server_vad" },
          tools: plan.tools
        }
      }));

      session.greetingTimer = setTimeout(() => {
        if (session.closed || callerIsSpeaking || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: "response.create",
          response: { instructions: plan.greeting.direction }
        }));
      }, 350);
    });

    ws.addEventListener("message", async (ev) => {
      if (session.closed || voiceStartWasReplaced(generation)) {
        closeVoiceSession(session);
        return;
      }
      if (typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "session.created":
        case "session.updated": {
          if (state.call.phase !== "live") {
            state.call.phase = "live";
            state.statusCaption = "Listening";
            playCallChime("connect");
            renderPouch();
          }
          break;
        }

        case "input_audio_buffer.speech_started": {
          callerIsSpeaking = true;
          theyTalkedOverThisResponse = true;
          if (session.greetingTimer) {
            clearTimeout(session.greetingTimer);
            session.greetingTimer = null;
          }
          const cuts = audioPipeline.dropScheduledSpeechForBargeIn();
          for (const cut of cuts) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "conversation.item.truncate",
                item_id: cut.itemId,
                content_index: cut.contentIndex,
                audio_end_ms: cut.audioEndMs
              }));
            }
          }
          state.call.activity = "caller-speaking";
          state.statusCaption = "Listening…";
          renderPouch();
          break;
        }

        case "input_audio_buffer.speech_stopped": {
          callerIsSpeaking = false;
          state.call.activity = "agent-thinking";
          state.statusCaption = "Thinking…";
          renderPouch();
          break;
        }

        case "response.created": {
          theyTalkedOverThisResponse = false;
          state.call.activity = "agent-speaking";
          renderPouch();
          break;
        }

        case "response.audio.delta":
        case "response.output_audio.delta": {
          if (!theyTalkedOverThisResponse && !callerIsSpeaking && typeof msg.delta === "string") {
            state.call.activity = "agent-speaking";
            audioPipeline.speakBase64Pcm16({
              base64: msg.delta,
              itemId: msg.item_id || "assistant",
              contentIndex: msg.content_index ?? 0
            });
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const itemId = msg.item_id || "assistant";
          const nextText = (assistantDeltas.get(itemId) || "") + (msg.delta || "");
          assistantDeltas.set(itemId, nextText);
          state.statusCaption = nextText.trim();
          renderPouch();
          break;
        }

        case "response.function_call_arguments.done": {
          const toolCallId = msg.call_id;
          const toolName = msg.name;
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(msg.arguments || "{}");
          } catch {}
          await handleVoiceToolCall({
            ws,
            audioPipeline,
            bot,
            callId,
            plan,
            toolCallId,
            toolName,
            parsedArgs,
            generation
          });
          break;
        }

        case "response.done":
        case "response.cancelled": {
          if (state.call.activity !== "caller-speaking") {
            state.call.activity = "quiet";
            renderPouch();
          }
          break;
        }
      }
    });

    ws.addEventListener("close", () => {
      if (session.closed) return;
      if (activeSession === session) {
        stopVoiceCall({ silentChime: false });
        return;
      }
      closeVoiceSession(session);
    });

    activeSession = session;
    await audioPipeline.start(primedMicStream);
    primedMicStream = null;
    if (session.closed || voiceStartWasReplaced(generation)) {
      if (!session.closed) closeVoiceSession(session);
      if (activeSession === session) activeSession = null;
      return;
    }

    if (transcriptPollInterval) clearInterval(transcriptPollInterval);
    transcriptPollInterval = setInterval(async () => {
      if (!activeSession || activeSession.closed || activeSession.generation !== voiceCallGeneration || state.call.phase !== "live") return;
      try {
        const res = await apiFetch(`/api/bot/${encodeURIComponent(bot.id)}/transcript?callId=${encodeURIComponent(callId)}`).then((r) => r.json());
        if (Array.isArray(res?.voiceUpdates)) {
          for (const upd of res.voiceUpdates) {
            if (seenVoiceUpdateIds.has(upd.id)) continue;
            seenVoiceUpdateIds.add(upd.id);
            if (ws.readyState === WebSocket.OPEN && upd.text) {
              const eventId = `seeded-nudge-${crypto.randomUUID()}`;
              ws.send(JSON.stringify({
                type: "async_update.add",
                event_id: eventId,
                async_update: {
                  topic: "check_work",
                  payload: [{ message: { type: "text", content: upd.text }, timestampMs: Date.now() }]
                }
              }));
              ws.send(JSON.stringify({ type: "response.create" }));
            }
          }
        }
      } catch {}
    }, 2800);
  } catch (err) {
    stopPrimedMicrophone(primedMicStream);
    if (voiceStartWasReplaced(generation)) return;
    await stopVoiceCall({ silentChime: true });
    state.statusCaption = err.message;
    renderPouch();
  }
}

async function handleVoiceToolCall({ ws, audioPipeline, bot, callId, plan, toolCallId, toolName, parsedArgs, generation }) {
  if (voiceStartWasReplaced(generation)) return;
  state.call.activity = "working";
  state.statusCaption = "Working…";
  renderPouch();

  if (toolName === "end_the_call") {
    apiFetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: bot.id, callId, name: toolName, input: parsedArgs })
    }).catch(() => {});
    await audioPipeline.whenScheduledSpeechEnds();
    if (voiceStartWasReplaced(generation)) return;
    await stopVoiceCall();
    return;
  }

  if (toolName === "send_task" && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(plan.receipt?.output || { receipt: "under way" })
      }
    }));
  }

  try {
    const toolRes = await apiFetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: bot.id,
        callId,
        name: toolName,
        input: parsedArgs,
        line: {
          theyJustTalked: true,
          newsOwed: false,
          receiptOwed: toolName === "send_task",
          alreadySpokeThisTurn: false
        }
      })
    }).then((r) => r.json());

    if (voiceStartWasReplaced(generation)) return;
    if (toolName !== "send_task" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify(toolRes.output || {})
        }
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  } catch (err) {
    if (voiceStartWasReplaced(generation)) return;
    if (toolName !== "send_task" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({ error: err.message })
        }
      }));
    }
  }
}

async function stopVoiceCall({ silentChime = false } = {}) {
  voiceCallGeneration += 1;
  const wasLive = state.call.phase === "live";
  if (transcriptPollInterval) {
    clearInterval(transcriptPollInterval);
    transcriptPollInterval = null;
  }

  closeEveryVoiceSession();

  if (wasLive && !silentChime) {
    playCallChime("hangup");
  }

  state.call.phase = "idle";
  state.call.activity = "quiet";
  state.call.energy = 0;
  state.statusCaption = "";
  hideSwitchConfirm();
  renderPouch();
  reportHitRectToNative();
}

// ============================================================================
// RENDER & BOT SELECTION
// ============================================================================
function renderPouch() {
  const bot = getSelectedBot();
  if (!bot) return;

  syncCharacterToBot(bot);

  dom.pouch.dataset.call = state.call.phase;
  dom.pouch.dataset.settings = String(state.settingsOpen);
  dom.botNameLabel.textContent = bot.name;
  dom.voiceSummary.textContent = voiceSummaryText(bot);
  dom.typeInput.placeholder = `Message ${bot.name}…`;

  // Show orange star badge on the primary/first pinned bot (or Chief)
  dom.mainStarBadge.hidden = !(bot.isPinned && state.bots.indexOf(bot) === 0);

  if (state.statusCaption) {
    dom.botStatusCaption.textContent = state.statusCaption;
    dom.botStatusCaption.hidden = false;
  } else {
    dom.botStatusCaption.hidden = true;
  }

  reportHitRectToNative();
}

async function selectBot(botId) {
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) return;
  const wasCallActive = state.call.phase !== "idle";
  state.selectedBotId = bot.id;
  state.statusCaption = "";
  botEngine.poke("spin");
  renderPouch();

  apiFetch("/api/select-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId: bot.id })
  }).catch(() => {});

  if (wasCallActive) {
    await startVoiceCall();
  }
}

function peekBot(delta) {
  if (state.bots.length < 2) return null;
  const currentIndex = state.bots.findIndex((bot) => bot.id === state.selectedBotId);
  const nextIndex = (currentIndex + delta + state.bots.length) % state.bots.length;
  return state.bots[nextIndex] || null;
}

function hideSwitchConfirm() {
  state.switchConfirmDelta = null;
  if (!dom.switchConfirm) return;
  dom.switchConfirm.hidden = true;
}

function showSwitchConfirm(delta) {
  const nextBot = peekBot(delta);
  if (!nextBot) return;
  state.switchConfirmDelta = delta;
  dom.switchConfirmText.textContent = `¿Colgar y pasar a ${nextBot.name}?`;
  dom.switchConfirm.hidden = false;
  reportHitRectToNative();
}

async function confirmSwitchBot() {
  const delta = state.switchConfirmDelta;
  const nextBot = delta == null ? null : peekBot(delta);
  hideSwitchConfirm();
  if (!nextBot) return;
  if (state.call.phase !== "idle") await stopVoiceCall();
  await selectBot(nextBot.id);
}

function requestBotCycle(delta) {
  if (state.call.phase !== "idle") {
    showSwitchConfirm(delta);
    return;
  }
  cycleBot(delta);
}

function cycleBot(delta) {
  const nextBot = peekBot(delta);
  if (!nextBot) return;
  playUiSound("tick");
  selectBot(nextBot.id);
}

// ============================================================================
// EVENTS & SHORTCUTS
// ============================================================================
function installWindowDrag() {
  const notchHost = window.grokbotNotchHost;
  if (!notchHost || typeof notchHost.dragHold !== "function" || !dom.dragHandle) return;

  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let windowDragStarted = false;
  let suppressClickAfterDrag = false;

  dom.dragHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragPointerId = event.pointerId;
    dragStartX = event.screenX;
    dragStartY = event.screenY;
    windowDragStarted = false;
    dom.dragHandle.setPointerCapture(event.pointerId);
    notchHost.dragHold();
  });

  dom.dragHandle.addEventListener("pointermove", (event) => {
    if (dragPointerId !== event.pointerId) return;
    const travelX = event.screenX - dragStartX;
    const travelY = event.screenY - dragStartY;
    if (windowDragStarted) return;
    if (Math.abs(travelX) + Math.abs(travelY) < 5) return;
    windowDragStarted = true;
    dom.pouch.classList.add("is-dragging");
  });

  function endWindowDrag(event) {
    if (dragPointerId === null || event.pointerId !== dragPointerId) return;
    const didDrag = windowDragStarted;
    dragPointerId = null;
    windowDragStarted = false;
    dom.pouch.classList.remove("is-dragging");
    notchHost.dragEnd();
    if (!didDrag) return;
    suppressClickAfterDrag = true;
  }

  dom.dragHandle.addEventListener("pointerup", endWindowDrag);
  dom.dragHandle.addEventListener("pointercancel", endWindowDrag);

  dom.dragHandle.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!suppressClickAfterDrag) return;
      suppressClickAfterDrag = false;
    },
    true
  );
}

installWindowDrag();

dom.collapsedBar.addEventListener("click", () => {
  setExpanded(true);
});

dom.botCharacterBtn.addEventListener("click", async () => {
  if (state.settingsOpen) return;
  if (state.call.phase === "idle") {
    await startVoiceCall();
  } else {
    await stopVoiceCall();
  }
});

dom.voiceSettings.addEventListener("submit", (event) => {
  event.preventDefault();
});

dom.sizeBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setWidgetCompact(!state.compact);
});

dom.voiceSettingsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsOpen(!state.settingsOpen);
});

async function saveVoiceSetting(patch) {
  const bot = getSelectedBot();
  if (!bot) return;
  Object.assign(bot, patch);
  dom.voiceSummary.textContent = voiceSummaryText(bot);
  pushLiveVoice(bot);
  try {
    await apiFetch("/api/voice/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: bot.id, ...patch })
    });
  } catch {
    // The in-call session already uses the new setting. The next bootstrap reconciles storage.
  }
}

dom.voiceIdSelect.addEventListener("change", () => {
  saveVoiceSetting({ voiceId: dom.voiceIdSelect.value });
});

dom.voiceSpeedSelect.addEventListener("change", () => {
  saveVoiceSetting({ voiceSpeed: Number(dom.voiceSpeedSelect.value) });
});

dom.voiceLanguageSelect.addEventListener("change", () => {
  saveVoiceSetting({ voiceLanguage: dom.voiceLanguageSelect.value });
});

dom.prevBotBtn.addEventListener("pointerdown", (e) => {
  if (state.typing) e.preventDefault();
});

dom.prevBotBtn.addEventListener("click", () => {
  requestBotCycle(-1);
});

dom.nextBotBtn.addEventListener("pointerdown", (e) => {
  if (state.typing) e.preventDefault();
});

dom.nextBotBtn.addEventListener("click", () => {
  requestBotCycle(1);
});

dom.switchConfirmNo.addEventListener("click", () => {
  hideSwitchConfirm();
  reportHitRectToNative();
});

dom.switchConfirmYes.addEventListener("click", () => {
  confirmSwitchBot();
});

dom.audioWavesBtn.addEventListener("click", () => {
  playUiSound("tick");
  setTypingMode(true);
});

dom.typeInput.addEventListener("blur", () => {
  if (dom.typeInput.value.trim().length === 0) {
    setTypingMode(false);
  }
});

let activeReplyPoll = null;

dom.typeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = dom.typeInput.value.trim();
  if (!text) {
    setTypingMode(false);
    return;
  }
  dom.typeInput.value = "";
  setTypingMode(false);
  playUiSound("doubleTick");

  const bot = getSelectedBot();
  if (!bot) return;

  if (activeSession && state.call.phase === "live") {
    activeSession.sendWrittenTurn(text);
    return;
  }

  if (activeReplyPoll) {
    clearInterval(activeReplyPoll);
    activeReplyPoll = null;
  }

  state.sendingText = true;
  state.statusCaption = "Sending…";
  renderPouch();

  let baselineIds = new Set();
  try {
    const before = await apiFetch(`/api/bot/${encodeURIComponent(bot.id)}/transcript`).then((r) => r.json());
    if (Array.isArray(before?.entries)) {
      baselineIds = new Set(before.entries.map((entry) => entry.id));
    }
  } catch {}

  try {
    const sendRes = await apiFetch(`/api/bot/${encodeURIComponent(bot.id)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }).then((r) => r.json());

    if (!sendRes.ok) {
      throw new Error(sendRes.error || "Failed to send");
    }

    state.statusCaption = "Working…";
    renderPouch();

    let attempts = 0;
    const targetBotId = bot.id;
    activeReplyPoll = setInterval(async () => {
      attempts++;
      if (attempts > 25 || state.selectedBotId !== targetBotId) {
        clearInterval(activeReplyPoll);
        activeReplyPoll = null;
        state.sendingText = false;
        if (state.statusCaption === "Working…" || state.statusCaption === "Sending…") {
          state.statusCaption = "Sent ✓";
          renderPouch();
        }
        return;
      }
      try {
        const res = await apiFetch(`/api/bot/${encodeURIComponent(targetBotId)}/transcript`).then((r) => r.json());
        if (Array.isArray(res?.entries)) {
          const fresh = res.entries.filter((entry) => entry.role === "assistant" && !baselineIds.has(entry.id));
          if (fresh.length > 0) {
            clearInterval(activeReplyPoll);
            activeReplyPoll = null;
            state.sendingText = false;
            state.statusCaption = fresh[fresh.length - 1].text;
            botEngine.poke("nod");
            renderPouch();
          }
        }
      } catch {}
    }, 1500);
  } catch (err) {
    state.sendingText = false;
    state.statusCaption = err.message || "Failed to send";
    renderPouch();
  }
});

window.addEventListener("keydown", (e) => {
  if (!state.expanded) return;

  if (e.key === "Escape") {
    if (state.settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (state.typing) {
      dom.typeInput.value = "";
      setTypingMode(false);
      return;
    }
    if (state.switchConfirmDelta != null) {
      hideSwitchConfirm();
      reportHitRectToNative();
      return;
    }
    if (state.call.phase !== "idle") {
      stopVoiceCall();
      return;
    }
    setExpanded(false);
    return;
  }

  if (state.typing || state.settingsOpen) return;

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    requestBotCycle(e.key === "ArrowLeft" ? -1 : 1);
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setTypingMode(true, e.key);
  }
});

// Native Host Commands (⌥Space toggle, ⌘⇧G voice call, Menu Bar bot selection)
window.__notchCommand = async (cmd) => {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "toggleExpand":
      setExpanded(!state.expanded);
      break;
    case "toggleVoiceCall":
      if (!state.expanded) setExpanded(true);
      if (state.call.phase === "idle") {
        await startVoiceCall();
      } else {
        await stopVoiceCall();
      }
      break;
    case "nextBot":
      requestBotCycle(1);
      break;
    case "prevBot":
      requestBotCycle(-1);
      break;
    case "escape":
      if (state.switchConfirmDelta != null) {
        hideSwitchConfirm();
        reportHitRectToNative();
        break;
      }
      if (state.settingsOpen) {
        setSettingsOpen(false);
        break;
      }
      if (state.typing) {
        dom.typeInput.value = "";
        setTypingMode(false);
      } else if (state.call.phase !== "idle") {
        await stopVoiceCall();
      } else if (state.expanded) {
        setExpanded(false);
      }
      break;
    case "selectBot":
      if (cmd.botId) {
        await selectBot(cmd.botId);
        setExpanded(true);
      }
      break;
    case "remeasure":
      clearFittedSize();
      reportHitRectToNative();
      break;
    case "fitWidget": {
      const fittedWidth = Number(cmd.width);
      const fittedHeight = Number(cmd.height);
      if (fittedWidth >= 8 && fittedHeight >= 8) {
        const nextWidth = `${Math.round(fittedWidth)}px`;
        const nextHeight = `${Math.round(fittedHeight)}px`;
        if (dom.pouch.style.width !== nextWidth) dom.pouch.style.width = nextWidth;
        if (dom.pouch.style.height !== nextHeight) dom.pouch.style.height = nextHeight;
      }
      break;
    }
    case "setNotchGeometry":
      if (cmd.notchWidth && cmd.notchWidth > 100) {
        document.documentElement.style.setProperty("--notch-width", `${cmd.notchWidth}px`);
      }
      if (cmd.notchHeight && cmd.notchHeight > 20) {
        document.documentElement.style.setProperty("--notch-height", `${cmd.notchHeight}px`);
      }
      reportHitRectToNative();
      break;
  }
};

window.__onNativeCursorMove = (localX, localY) => {
  updateGaze(localX, localY);
};

async function refreshBootstrap() {
  try {
    const data = await apiFetch("/api/bootstrap").then((r) => r.json());
    if (!data.ok || !Array.isArray(data.bots)) return;

    const accountChanged =
      state.activeAccountScope !== null &&
      data.activeAccountScope &&
      data.activeAccountScope !== state.activeAccountScope;

    const oldIds = state.bots.map((b) => b.id).join(",");
    const newIds = data.bots.map((b) => b.id).join(",");
    const rosterChanged = oldIds !== newIds;

    const selectedBefore = getSelectedBot();
    const voiceBefore = selectedBefore
      ? `${selectedBefore.id}|${selectedBefore.voiceId}|${selectedBefore.voiceSpeed}|${selectedBefore.voiceLanguage}`
      : "";

    state.activeAccountScope = data.activeAccountScope || state.activeAccountScope;
    state.bots = data.bots;
    if (Array.isArray(data.voices)) state.voices = data.voices;
    if (Array.isArray(data.speeds)) state.speeds = data.speeds;
    if (Array.isArray(data.languages)) state.languages = data.languages;

    if (accountChanged || !state.selectedBotId || !state.bots.some((bot) => bot.id === state.selectedBotId)) {
      state.selectedBotId = data.selectedBotId || state.bots[0]?.id || null;
      state.statusCaption = "";
    }

    const selectedAfter = getSelectedBot();
    const voiceAfter = selectedAfter
      ? `${selectedAfter.id}|${selectedAfter.voiceId}|${selectedAfter.voiceSpeed}|${selectedAfter.voiceLanguage}`
      : "";

    if (accountChanged || rosterChanged || (!state.settingsOpen && voiceBefore !== voiceAfter)) {
      renderPouch();
      postNativeMessage({
        type: "rosterLoaded",
        bots: state.bots.map((bot) => ({ id: bot.id, name: bot.name, section: bot.section })),
        selectedBotId: state.selectedBotId
      });
    }
  } catch {}
}

async function init() {
  try {
    state.compact = localStorage.getItem("grokbot-notch-size") === "compact";
  } catch {
    state.compact = false;
  }
  setWidgetCompact(state.compact);
  requestAnimationFrame(tickAnimation);
  await refreshBootstrap();
  renderPouch();
  reportHitRectToNative();
  // Periodically check for account or bot roster changes in Desktop Grok Bot
  setInterval(refreshBootstrap, 4000);
}

init();
