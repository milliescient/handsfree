# Handsfree Project Notes

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

The server runs under a supervisor (`run.sh`, single instance enforced by
`.run.lock`) that automatically restarts `node server.js` within 2 seconds of
any exit, picking up code changes.

- To restart the server (after editing server.js, or from build-apk.sh):
  run `fuser -k 8443/tcp` and NOTHING else. The supervisor brings it back.
- NEVER run `node server.js` or `./run.sh` yourself — a second copy fights
  over port 8443 and crash-loops (this caused thousands of EADDRINUSE
  restarts and constant phone reconnects on 2026-07-13).
- NEVER use `pkill -f` with a pattern containing "server.js" or "run.sh" —
  it kills your own shell wrapper (and you with it). Kill by port or PID.
- Keys/token live in the git-ignored `.env`; don't move them to shell env.
