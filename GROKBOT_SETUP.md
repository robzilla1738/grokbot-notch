# Setting Up GrokBot Notch with Your Grok Bot

You can have your own **Grok Bot** install, compile, and launch **GrokBot Notch** on your Mac automatically.

## Copy-Paste Prompt for Your Grok Bot

Copy and paste this into any Grok Bot chat (with local shell/computer tools enabled):

```text
Please set up and launch GrokBot Notch on my Mac from https://github.com/robzilla1738/grokbot-notch — clone the repo to ~/grokbot-notch, read AGENTS.md, run `npm run install:app`, verify the local bridge is healthy (read ~/Library/Application Support/GrokBot Notch/launch-auth-token and curl http://127.0.0.1:4789/api/bootstrap with Authorization: Bearer), and confirm GrokBot Notch.app is running at the top of my screen.
```

## What Your Grok Bot Will Do

1. Clone `https://github.com/robzilla1738/grokbot-notch` to `~/grokbot-notch`.
2. Check that `swiftc` (Xcode Command Line Tools) and `node` (v22.5+ with `node:sqlite`) are available.
3. Compile the native Swift macOS app (`macos/NotchApp.swift`) into `GrokBot Notch.app`, sign it (automatically using your Developer ID / Apple Development certificate if present, or ad-hoc signing otherwise), and copy it to `/Applications/GrokBot Notch.app`.
4. Start the local Grok Bot bridge server (`http://127.0.0.1:4789`, loopback-only with a per-launch auth token in `~/Library/Application Support/GrokBot Notch/launch-auth-token`) and open `GrokBot Notch.app` at the top of your primary display.
