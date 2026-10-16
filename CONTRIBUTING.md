# Contributing to GrokBot Notch

Contributions, bug reports, and pull requests are welcome!

## Project Structure

- `macos/NotchApp.swift` — Native macOS AppKit + WebKit + AVAudioEngine + Carbon global hotkeys (`⌥Space`, `⌘⇧G`, `←`, `→`, `Esc`).
- `server.mjs` — Zero-dependency Node.js bridge server (`node:http`, `node:sqlite`, `node:crypto`) that reads local Grok Bot / Cursor authentication and roster state and proxies `GrokBotService` ConnectRPC calls (`ListGrokBotAgents`, `MintSandVoiceCallSecret`, `VoiceCallHarnessSession`, `VoiceCallHarnessTool`, `SetGrokBotAgentVoice`, `ListGrokBotTranscriptEntries`, `SendGrokBotUserMessage`).
- `public/` — Notch UI (`index.html`, `styles.css`, `app.js`) and the flat Motion Lab character engine (`motion-lab.js`).
- `scripts/` — Build (`build-mac-app.sh`), launch (`launch.sh`), and one-step setup (`setup.sh`) scripts.

## Development Workflow

1. Edit UI files in `public/` or server routes in `server.mjs`.
2. Rebuild and relaunch the native `.app` bundle:
   ```bash
   npm run build:mac && npm start
   ```
3. You can also preview the Notch UI in a standard browser at `http://127.0.0.1:4789` (the server injects the per-launch auth token into `index.html` for loopback requests; API calls from `app.js` use that token automatically).
