# handsfree

A fully hands-free voice interface for Claude Code. Talk to an agent from your
phone (or any browser); it works in your project directory with all permission
prompts bypassed, and reads its replies back to you out loud.

Built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/typescript) —
one Node server, one HTML page, no build step.

## How it works

- `server.js` serves the UI over self-signed HTTPS (browsers require a secure
  context for microphone access on non-localhost hosts) and bridges a
  WebSocket to `query()` from `@anthropic-ai/claude-agent-sdk`.
- Each browser connection is one continuous Claude session (`resume` carries
  context between turns). Messages spoken while the agent is working are queued.
- The agent runs with `permissionMode: "bypassPermissions"` and a system-prompt
  append that tells it to keep spoken replies short and never ask for
  confirmation.
- Voice input uses [Silero VAD](https://github.com/snakers4/silero-vad) for
  voice activity detection and Whisper for transcription. If you have a local
  [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server running,
  it uses that (fast, free, private); otherwise falls back to OpenAI's API.
  Tap the mic to talk; replies are spoken via the browser's TTS. Toggle
  **🎧 hands-free** and the mic automatically reopens every time Claude finishes
  speaking — a full voice loop with no touching.
- The transcript pane shows everything in full (including a live feed of tool
  calls: which commands and file edits the agent is making), so you can glance
  at your phone to see what it's actually doing. **■** interrupts the agent
  mid-task.

## Setup

```bash
./setup.sh                            # install dependencies, check config
export OPENAI_API_KEY=sk-...          # for Whisper voice transcription
node server.js /path/to/your/project  # the directory Claude will work in
```

Or manually:

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # if not already authenticated
export OPENAI_API_KEY=sk-...          # for Whisper voice transcription
node server.js /path/to/your/project  # the directory Claude will work in
```

The server prints URLs like:

```
Open on this machine:  https://localhost:8443/
Open on your phone:    https://192.168.1.20:8443/
```

Open the phone URL (same Wi-Fi network), tap through the self-signed
certificate warning once, allow microphone access, and talk.

Auth note: the SDK spawns the Claude Code CLI under the hood, so if this
machine is already logged in to Claude Code it will generally just work;
otherwise set `ANTHROPIC_API_KEY`.

### Options

| What | How |
| --- | --- |
| Working directory | first CLI arg, or `WORKDIR` env var (default: cwd) |
| Port | `PORT` env var (default 8443) |
| Local Whisper | `WHISPER_URL` env var (default `http://127.0.0.1:9876/transcribe`) |

### Off your home network

The LAN URL only works on the same Wi-Fi. For phone access from anywhere, use
[Tailscale](https://tailscale.com) and open `https://<tailscale-ip>:8443/`.
Avoid exposing the port to the public internet.

## Security

This grants **unattended agent control of the machine** (no permission
prompts) to anyone who can reach port 8443 — there is currently **no
authentication at all** (the earlier URL-token lock was removed when the
Android app was introduced). The only protections are network-level: keep
the port firewalled off the LAN and reach it exclusively over Tailscale
(or another private overlay). Never port-forward it or run it on a network
you don't control.

## If you don't hear anything

Replies are spoken with the browser's built-in text-to-speech. Tap **🔊** in
the header — it replays the last reply, or speaks a test phrase. If the test
phrase is silent:

- **Desktop Linux**: Chromium and Firefox ship with no TTS voices. Install
  `speech-dispatcher` and `espeak-ng` and restart the browser, or use Chrome
  (which bundles Google voices).
- **iPhone**: the hardware mute switch silences TTS — flip it, and raise the
  volume.
- **Any browser**: audio must start from a tap; the page unlocks it on your
  first button press, so use the buttons rather than only the keyboard the
  first time.

## Browser support

- **Android Chrome**: full support (best experience).
- **iOS Safari 14.5+**: supported; speech recognition can be less reliable.
  The text box always works as a fallback.
- **Desktop Chrome/Edge**: full support.
