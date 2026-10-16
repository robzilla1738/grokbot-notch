# Autonomous Setup Instructions for Grok Bot & AI Agents

If a user asked you (their **Grok Bot**, Cursor agent, Claude Code, or Codex) to set up **GrokBot Notch** on their Mac, execute the following steps end-to-end without asking unnecessary questions.

## 1. Prerequisites Check

Run a quick check to ensure the Mac has:
- **macOS 13+** (`uname -s` == `Darwin`)
- **Xcode Command Line Tools (`swiftc`)**: verify with `swiftc --version`
- **Node.js v22.5+** (required for built-in `node:sqlite`): verify with `node -v`. If Node is older than v22.5 or missing, install or upgrade it via Homebrew (`brew install node`) or NVM/fnm.
- **Desktop Grok Bot (`/Applications/Grok Bot.app`)**: verify the user has Desktop Grok Bot installed and signed in.

## 2. Clone & Build

If you are not already inside the repository directory, clone it and run the automated setup script:

```bash
git clone https://github.com/robzilla1738/grokbot-notch.git ~/grokbot-notch
cd ~/grokbot-notch
npm run setup
```

To also install `GrokBot Notch.app` directly into `/Applications`:

```bash
npm run install:app
```

## 3. Verify It Is Running

1. Verify the local bridge server is healthy and discovers the user's GrokBots:
   ```bash
   TOKEN="$(cat "$HOME/Library/Application Support/GrokBot Notch/launch-auth-token")"
   curl -s -H "Authorization: Bearer $TOKEN" -H "Host: 127.0.0.1:4789" \
     http://127.0.0.1:4789/api/bootstrap | head -c 400
   ```
   Confirm `"ok":true` and that `"bots"` is populated.
2. Verify the native macOS Notch app process (`GrokBotNotch`) is running:
   ```bash
   ps aux | grep GrokBotNotch | grep -v grep
   ```

## 4. Tell the User How to Use It

Once running, let the user know:
- **`⌥Space` (Option + Space)** expands or collapses the GrokBot Notch pouch from any app.
- **`←` / `→` (Left / Right Arrow keys)** when popped down cycles through their GrokBots.
- **Click the Bot Character** (or press **`⌘⇧G`**) to start or end a live **Voice Mode** call with the selected GrokBot.
- **Tap the Audio Waves** (or just start typing while expanded) to send a quick text message to the selected GrokBot.
