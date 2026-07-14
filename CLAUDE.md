# Handsfree Project Notes

## Shipping changes — ALWAYS use ./deploy.sh

To ship any change, run exactly one command:

```bash
./deploy.sh "commit message"
```

It commits everything, rebuilds the APK, and restarts the server, in that
order. NEVER run git commit, build-apk.sh, or a server restart as separate
steps — partial deploys caused version drift and an update loop where the
app reinstalled a stale APK forever.

The restart at the end kills the server your session runs inside, ending
your turn. Speak your summary FIRST, then run ./deploy.sh as the final
action. If your turn dies there, the deploy still completed.

## Batch queued requests into ONE deploy

Every deploy makes the user manually update the app on their phone, which is
annoying. If user messages are queued behind the current turn (agentd logs
show the queue; the queued bubbles do too), do NOT deploy after each one.
Make the code changes for as many queued requests as possible, deploying
only when a queued task actually requires the new build to proceed (e.g.
testing behavior that needs the new APK), or once the queue is drained.
Commits can happen along the way; the rebuild+restart is the expensive part.

## APK Build Process

The Android APK bundles a copy of `public/index.html` inside the app at build time. Changes to the HTML require rebuilding the APK.

**Use the build script:**

```bash
./build-apk.sh
```

This script:
1. Gets the current git SHA and embeds it in public/index.html as APP_VERSION
2. Copies index.html to the Android assets
3. Builds the APK
4. Copies it to public/handsfree.apk
5. Restarts the server so it reports the same git SHA

This ensures the APK and server are always in sync. When the app connects, if its embedded SHA differs from the server's current SHA, it prompts the user to update.

**Important:** Commit your changes before running the build script. The APK embeds the current git SHA, so if you build before committing, the APK will have the old SHA and won't trigger updates.

Simply restarting the server is NOT enough for HTML changes to take effect in the app.

## Server process management — READ BEFORE RESTARTING ANYTHING

Two processes, both supervised by `run.sh` (single instance via `.run.lock`).
The supervisor normally runs under the systemd user service `handsfree`
(installed by `install-service.sh`, auto-started at boot via lingering):

- `server.js` — web layer: HTTPS, phone WebSocket, transcription, TTS relay.
- `agentd.js` — agent daemon: runs YOUR turns via the Agent SDK on
  ws://127.0.0.1:9878. You are a child of agentd, NOT of the web server.

What this means for you:

- You may restart the web server anytime with `fuser -k 8443/tcp` — it does
  NOT end your turn. The phone reconnects in ~2s and keeps streaming.
- `./deploy.sh` restarts agentd via SIGHUP, which waits for your current
  turn to finish before restarting. Your deploy turn survives; agentd picks
  up new code before the NEXT turn.
- NEVER kill agentd directly (`.agentd.pid`, port 9878) — that kills you
  mid-turn. Let deploy.sh's SIGHUP drain handle it.
- NEVER run `node server.js`, `node agentd.js`, or `./run.sh` yourself —
  duplicate copies fight over ports and crash-loop (caused thousands of
  EADDRINUSE restarts on 2026-07-13).
- NEVER use `pkill -f` with a pattern containing "server.js", "agentd.js",
  or "run.sh" — it kills your own shell wrapper. Kill by port or PID file.
- NEVER run `systemctl --user stop/restart handsfree` mid-turn — it kills
  the whole cgroup, including agentd and you. If a task truly requires it,
  run it detached with a delay as the very last action, like deploy.sh.
- Keys live in the git-ignored `.env`; don't move them to shell env.
