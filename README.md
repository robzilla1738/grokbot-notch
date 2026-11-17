# ✦ GrokBot Notch

**A native macOS Notch companion for Desktop Grok Bot** — lives inside your MacBook's hardware notch, renders your GrokBots in their authentic flat character style, and lets you talk to any of your bots in real time with **xAI Realtime Voice Mode** or quick tap-to-type chat.

[![Platform: macOS 13+](https://img.shields.io/badge/platform-macOS%2013%2B-black?logo=apple)](https://github.com/robzilla1738/grokbot-notch)
[![Node.js: 22.5+](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-violet.svg)](LICENSE)

---

## 🤖 Let Your Grok Bot Set This Up For You

Want your **Grok Bot** to install and launch this for you automatically? Just paste this into your Grok Bot chat:

```text
Set up and launch GrokBot Notch on my Mac from https://github.com/robzilla1738/grokbot-notch — clone it to ~/grokbot-notch, follow AGENTS.md, run `npm run install:app`, and verify it's running at the top of my screen.
```

*(See [`GROKBOT_SETUP.md`](GROKBOT_SETUP.md) and [`AGENTS.md`](AGENTS.md) for the autonomous agent setup guide.)*

---

## ⚡ 1-Command Terminal Setup

If you prefer to run it yourself in Terminal:

```bash
git clone https://github.com/robzilla1738/grokbot-notch.git ~/grokbot-notch
cd ~/grokbot-notch
npm run setup
```

To also install `GrokBot Notch.app` into `/Applications`:

```bash
npm run install:app
```

### Windows

Windows has no camera notch, so this fork is a small floating widget you can park on any monitor. Closed, it is a circle. Open, it is a card with four rounded corners, not a bar hanging from the top of the screen. You drag it from the dotted grip, and it stays where you left it the next time you open it.

You need Windows 10 or 11, Node.js 22.5 or newer, and the Desktop Grok Bot app installed and signed in.

```powershell
git clone https://github.com/manuelcastrobarinas/grokbot-notch.git
cd grokbot-notch
npm install
npm start
```

Quit from the tray icon. That also stops the local bridge.

#### How to use it

The closed circle only shows the bot mark. Click it, or press **Ctrl+Alt+Space**, to open the card. The same shortcut closes it again.

The dotted grip is the only place that moves the card. The rest of the card is for talking, typing, and settings. A **− / +** button switches between a short card and a taller one. The gear sets that bot's voice, speed, and language. Those choices stick for that bot.

Click the character, or press **Ctrl+Shift+G**, to start or end a voice call. Allow the microphone if Windows asks. While you are on a call, the arrow keys do not switch bots by themselves. They ask first: hang up and move to the other bot, yes or no. **Yes** hangs up and leaves that bot selected. **No**, or **Escape**, drops the question and keeps the call. Choosing a bot from the tray menu is a deliberate click, so that one does switch immediately and starts the call with the bot you picked.

| What you want | How |
| :--- | :--- |
| Open or close the card | **Ctrl+Alt+Space**, or click the circle |
| Move it | Drag the dotted grip |
| Shorter or taller card | **− / +** |
| Voice, speed, language | Gear |
| Start or end a call | Click the character, or **Ctrl+Shift+G** |
| Previous or next bot | **Left / Right** while the card is focused and you are not on a call. The on-screen **< / >** do the same |
| Accidental arrow during a call | Confirm **Sí** or **No** on the card. **Escape** means no |
| Type | Click the waves, or type a letter while the card is focused, then **Enter** |
| Hang up from anywhere | **Escape** while a call is active, or **Ctrl+Shift+G** |
| Close settings, clear typing, hang up, or collapse | **Escape**, in that order, when the card is focused |
| Quit | Tray icon |

#### How it is built

The Mac app is unchanged. On Windows, `npm start` runs `scripts/start.mjs`, which launches Electron (`windows/host.cjs`) and the same `server.mjs` bridge on `127.0.0.1:4789`. Electron's own Node is not used for the bridge, because it may not have `node:sqlite`. The page talks to the shell through `window.grokbotNotchHost` in `windows/preload.cjs`. It does not pretend to be the Mac `webkit.messageHandlers.notchHost`, so voice stays in the page instead of calling a Swift audio engine that is not there.

The window is transparent, frameless, always on top, and absent from the taskbar. It is not dragged by the operating system (`movable: false`). The page reports the card's rectangle, and the shell resizes the window to that rectangle so clicks land on the widget. Mouse click-through is off. A hidden PowerShell helper (`windows/mouse-button.ps1`) only reports whether the left button is down and whether the cursor is on the grip. The actual move uses Electron's cursor, in DIP pixels, compared with where the drag started. Mixing PowerShell's DPI-unaware coordinates with `setPosition` walks the widget off the second monitor and makes it drift while the mouse is still. If Windows snaps the window by the same amount the cursor appears to move, that snap is absorbed instead of applied again.

The saved corner is `%APPDATA%\GrokBot Notch\window-position.json`. A saved point is kept only when that corner is on some display. Hotkeys do not snap the card back. If the open card is wider than the monitor, it is placed at the left of that monitor's work area.

The launch token for `/api/*` is `%APPDATA%\GrokBot Notch\launch-auth-token`. Grok Bot's saved secrets are decrypted with Windows DPAPI (CurrentUser) and then AES-256-GCM, the same `v10` safe-storage layout Chrome uses. The plaintext key is not printed and is not passed on the command line. Per-bot voice overrides live in `%USERPROFILE%\.grokbot-notch-state.json` under `voiceOverrides`. The gear writes that file and also calls `SetGrokBotAgentVoice`. Until an override matches a later change made inside Grok Bot, the override is what the call uses. Realtime speed is one of `0.75`, `1`, `1.25`, `1.5`. Language is sent as `language_hint` and omitted when the choice is auto.

A call is one WebSocket plus one microphone pipeline. Starting another call, or confirming a bot change, closes every open socket first. Arrow presses used to overlap those sockets, so several bots stayed on the line and all of them answered. Each attempt has a generation number. A late tool result from an old call cannot hang up the call that replaced it.

Compact or full size is remembered in `localStorage` under `grokbot-notch-size`. Left and Right are global hotkeys only while a call is active, and they only open the confirm question. They are not stolen from other apps while you are idle. Escape is global only during a call, so it can hang up without taking Escape away from every other window the rest of the time.

---

## ✨ Features & Design

- **Starts Collapsed in the Notch → Pops Down on `⌥Space`**
  - Tucks neatly beneath your MacBook's physical camera housing showing a mini flat mark, your active bot's name, and subtle audio wave bars.
  - Press **`⌥Space`** from any app (powered by Carbon `RegisterEventHotKey` — works globally across full-screen apps with zero Accessibility permission prompts) or click the notch to pop down the U-shaped black Notch pouch.
- **Authentic Flat GrokBot Characters**
  - Renders all **25 procedural Grok Bot shapes** (`hex`, `tablet`, `pebble`, `cloud`, `squircle`, `teardrop`, `star`, `wedge`, `blob`, etc.) in their exact flat dark-mode palette with cutout eyes, eyelid blinking, cursor gaze tracking, and state-driven animations (`idle`, `listening`, `thinking`, `streaming`, `working`).
  - Automatically syncs your live bots, pinned order, and sections from Desktop Grok Bot (`ListGrokBotAgents` + local `sand-client-persistence`).
- **Instant Bot Cycling (`←` / `→`)**
  - Whenever the Notch pouch is popped down, press **`←` Left Arrow** or **`→` Right Arrow** (or click `<` / `>`) to cycle through your GrokBots.
- **Live xAI Realtime Voice Mode (`wss://api.x.ai/v1/realtime`)**
  - Click the **Bot Character** (or press **`⌘⇧G`**) to start or end a live Voice Call with the selected GrokBot.
  - Mints a live `xai-client-secret` via `GrokBotService/MintSandVoiceCallSecret` and loads your bot's exact persona, greeting, and voice tools (`send_task`, `search_conversations`, `end_the_call`) via `GrokBotService/VoiceCallHarnessSession`.
  - Streams **24,000 Hz mono PCM16** audio over a native Swift `AVAudioEngine` + `AVAudioPlayerNode` pipeline with server VAD, instant barge-in truncation (`conversation.item.truncate`), live background task dispatching (`send_task`), and the authentic Grok Bot E5↔B5 two-tone chimes.
- **Tap Waves to Type (`||||..||l|..`)**
  - Tap the bottom audio waves (or just start typing any letter on your keyboard while the Notch is expanded) to morph the waves into a left-aligned text input. Press **`Enter`** to send a message (either directly into the active voice call or as a chat message via `SendGrokBotUserMessage`).

---

## ⌨️ Keyboard Shortcuts & Controls

| Action | Shortcut / Gesture |
| :--- | :--- |
| **Expand / Collapse Notch** | **`⌥Space`** *(Option + Space)* or click the collapsed notch |
| **Previous / Next GrokBot** | **`←` / `→`** *(Left / Right Arrows when popped down)* or click **`<` / `>`** |
| **Start / Stop Voice Call** | **Click the Bot Character** or press **`⌘⇧G`** |
| **Type a Message** | **Tap the Audio Waves** *(or start typing any letter when popped down)* → **`Enter`** |
| **Cancel Typing / Close** | **`Esc`** or click outside the Notch pouch |

---

## 🏗️ Architecture

```text
grokbot-notch/
├── macos/
│   ├── NotchApp.swift        # Native NSPanel + WKWebView hit-testing + AVAudioEngine (24kHz) + Carbon HotKeys
│   ├── Info.plist            # LSUIElement bundle metadata & NSMicrophoneUsageDescription
│   └── entitlements.plist    # Audio input & network entitlements
├── public/
│   ├── index.html            # Collapsed chin bar + Expanded U-shaped Notch pouch
│   ├── styles.css            # Pure black hardware-notch geometry, concave ears & spring transitions
│   ├── app.js                # Realtime WebSocket state machine, VoiceCallHarness tools & UI controller
│   ├── motion-lab.js         # Flat Grok Bot character engine (shapes, expressions, morphs, gaze)
│   └── sounds/               # Authentic UI ticks & call chimes
├── server.mjs                # Local Node.js bridge (auth discovery, ConnectRPC proxy, transcript sync)
├── scripts/
│   ├── setup.sh              # One-command prerequisite check, build & launch
│   ├── build-mac-app.sh      # Compiles Swift binary & signs GrokBot Notch.app
│   ├── launch.sh             # Starts local bridge server & opens GrokBot Notch.app
│   ├── setup.mjs             # Windows/macOS dispatcher for npm run setup
│   └── start.mjs             # Windows launches Electron; macOS still runs launch.sh
└── windows/                  # Windows only. The Mac shell does not use these.
    ├── host.cjs              # Electron window, hotkeys, drag, tray
    ├── preload.cjs           # grokbotNotchHost bridge
    └── mouse-button.ps1      # Left-button and grip hit test
```

---

## 🔒 Local bridge security

The Node bridge binds to **127.0.0.1 only** and rejects requests whose `Host` is not `127.0.0.1:4789` / `localhost:4789` or whose `Origin` (when present) is not the matching loopback URL. This blocks DNS rebinding and cross-site browser access.

Each server launch gets a random **32-byte auth token** (also writable via `GROKBOT_NOTCH_AUTH_TOKEN` when the Swift app spawns the process). The token is stored at:

`~/Library/Application Support/GrokBot Notch/launch-auth-token` (mode `0600`)

All `/api/*` routes require `Authorization: Bearer <token>` (or `X-GrokBot-Notch-Token`). The Notch web UI receives the token via injected HTML / a Swift `WKUserScript`; `public/app.js` sends it on every API call.

Manual health check:

```bash
TOKEN="$(cat "$HOME/Library/Application Support/GrokBot Notch/launch-auth-token")"
curl -s -H "Authorization: Bearer $TOKEN" -H "Host: 127.0.0.1:4789" \
  http://127.0.0.1:4789/api/bootstrap | head -c 400
```

Server logs from `npm start` go to `~/Library/Logs/grokbot-notch/server.log` (directory `0700`, log file `0600`).

---

## 🔧 Requirements

- **macOS 13.0+** (Apple Silicon or Intel)
- **Desktop Grok Bot** (`/Applications/Grok Bot.app`) installed and signed in
- **Node.js 22.5+** (uses Node's built-in `node:sqlite` — zero `npm install` dependencies required!)
- **Xcode Command Line Tools** (`swiftc`)

---

## 🙏 Contributors

Thanks to everyone who has helped make GrokBot Notch better:

- [@pymmog](https://github.com/pymmog): hardened the local bridge with a per-launch auth token, Host and Origin checks, no more saved Grok Bot storage key, and private log files ([#1](https://github.com/robzilla1738/grokbot-notch/pull/1))
- [@cirne](https://github.com/cirne): pinned the macOS deployment target so the app launches again ([#2](https://github.com/robzilla1738/grokbot-notch/pull/2)), and found and fixed the cross-site access hole in the local API ([#3](https://github.com/robzilla1738/grokbot-notch/pull/3))

---

## 📄 License

[MIT](LICENSE)
