# handsfree

A fully hands-free voice interface for Claude Code. Talk to an agent from your
phone (or any browser); it works in your project directory with all permission
prompts bypassed, and reads its replies back to you out loud. Queue follow-up
requests while it works, barge in mid-sentence to interrupt, and watch a live
feed of every command and file edit it makes.

Built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/typescript) —
two small Node processes, one HTML page, no build step (the optional Android
app is the only thing that compiles).

## Quick start

```bash
./setup.sh    # install dependencies, check configuration, start the service
```

On machines with systemd, setup installs and starts a **user service**
(`handsfree`) that survives logouts and reboots. Without systemd, start
everything manually with `./run.sh`.

Each session has its own working directory, chosen in the app when you start
a new session (defaults to your home directory; `WORKDIR` in `.env` changes
that default).

The server prints URLs (in `.server.log` when running as a service) like:

```
Open on this machine:  https://localhost:8443/
Open on your phone:    https://192.168.1.20:8443/
```

Open the phone URL (same Wi-Fi network), tap through the self-signed
certificate warning once, allow microphone access, and talk. A certificate is
generated automatically on first run (requires `openssl`).

Auth note: the SDK spawns the Claude Code CLI under the hood, so if this
machine is already logged in to Claude Code it will generally just work;
otherwise set `ANTHROPIC_API_KEY`.

## Running as a service

`./install-service.sh` (run automatically by setup on systemd machines)
installs a systemd **user** service that wraps the `run.sh` supervisor and
enables lingering so it starts at boot without a login:

```bash
systemctl --user status handsfree     # is it up?
systemctl --user restart handsfree    # full restart (kills in-flight turns)
journalctl --user -u handsfree        # supervisor output; app logs stay in
                                      # .server.log and .agentd.log
```

If a manually-started `./run.sh` is already running, the installer leaves it
alone unless invoked as `./install-service.sh --takeover`, which stops the
manual processes and hands everything to the service.

## Architecture

`run.sh` supervises two processes that restart independently:

- **`server.js`** — serves the UI over self-signed HTTPS on port 8443
  (browsers require a secure context for mic access on non-localhost hosts),
  relays speech-to-text and text-to-speech, and bridges browser WebSockets to
  the agent daemon. Safe to restart at any time; no agent work is lost.
- **`agentd.js`** — a loopback-only daemon (port 9878) that owns the actual
  Claude sessions via `query()` from the Agent SDK. Turns survive web-server
  restarts and client disconnects. Messages that arrive while a turn is
  running are queued and run in order. On SIGHUP it finishes the queue, then
  exits so the supervisor restarts it with fresh code.

The agent runs with `permissionMode: "bypassPermissions"` and a system-prompt
append that keeps spoken replies short and conversational.

## Speech engines (both optional, with fallbacks)

| Role | Local server | Fallback |
| --- | --- | --- |
| Transcription (Whisper) | `WHISPER_URL` (default `http://127.0.0.1:9876/transcribe`), e.g. [faster-whisper](https://github.com/SYSTRAN/faster-whisper) behind a tiny HTTP wrapper | OpenAI Whisper API if `OPENAI_API_KEY` is set; otherwise use the text box |
| Speech synthesis | `TTS_URL` (default `http://127.0.0.1:9877/synthesize`), e.g. [Piper](https://github.com/rhasspy/piper) — POST `{"text": ...}`, returns a WAV | The browser/phone's built-in text-to-speech |

Voice activity detection runs in the page itself
([Silero VAD](https://github.com/snakers4/silero-vad) via
[vad-web](https://github.com/ricky0123/vad), loaded from a CDN), so nothing
extra is needed for the mic to work.

## The Android app (optional)

The plain browser page works fine on Android Chrome. The Capacitor app in
`android/` adds the things a browser can't do: a foreground service that keeps
the mic and audio alive with the screen off, and reconnect behavior tuned for
walking around the house.

Building it needs an Android SDK and Java toolchain:

```bash
./build-apk.sh   # stamps the git SHA into the page, gradle assembleDebug
```

The APK lands at `public/handsfree.apk`, so once built it is served by the
web server itself — open the page on your phone and tap the version footer to
download and install the update. The APK is not checked into git (75 MB);
without an Android SDK, just use the browser.

## Development loop

```bash
./deploy.sh "what changed"
```

Commits nothing by itself — it rebuilds the APK at HEAD, restarts the web
server (free), and SIGHUPs the agent daemon so it restarts with new code once
its queue drains. Client (`public/index.html`) changes require reinstalling
the APK on the phone; server changes take effect immediately.

## Options

| What | How |
| --- | --- |
| Default working directory for new sessions | `WORKDIR` in `.env` (or first CLI arg to a manual `run.sh`); default: home directory. Each session remembers its own |
| Port | `PORT` env var (default 8443) |
| Local Whisper | `WHISPER_URL` env var (default `http://127.0.0.1:9876/transcribe`) |
| Local TTS | `TTS_URL` env var (default `http://127.0.0.1:9877/synthesize`) |
| Agent daemon address | `AGENTD_URL` env var (default `ws://127.0.0.1:9878`) |

## Off your home network

The LAN URL only works on the same Wi-Fi. For phone access from anywhere, use
[Tailscale](https://tailscale.com) and open `https://<tailscale-ip>:8443/`.
Avoid exposing the port to the public internet.

## Security

This grants **unattended agent control of the machine** (no permission
prompts) to anyone who can reach port 8443 — there is currently **no
authentication at all**. The only protections are network-level: keep the
port firewalled off the LAN and reach it exclusively over Tailscale (or
another private overlay). Never port-forward it or run it on a network you
don't control.

## If you don't hear anything

Server-side TTS needs the local synthesis server above; without it, replies
use the browser's built-in voices. Tap **🔊** in the header — it replays the
last reply, or speaks a test phrase. If the test phrase is silent:

- **Desktop Linux**: Chromium and Firefox ship with no TTS voices. Install
  `speech-dispatcher` and `espeak-ng` and restart the browser, or use Chrome
  (which bundles Google voices).
- **iPhone**: the hardware mute switch silences TTS — flip it, and raise the
  volume.
- **Any browser**: audio must start from a tap; the page unlocks it on your
  first button press, so use the buttons rather than only the keyboard the
  first time.

## Browser support

- **Android**: the app, or Chrome (full support).
- **iOS Safari 14.5+**: supported; speech recognition can be less reliable.
  The text box always works as a fallback.
- **Desktop Chrome/Edge**: full support.
