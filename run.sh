#!/usr/bin/env bash
# Supervisor: keep the handsfree server alive. The voice agent edits server.js
# and sometimes kills the server it runs inside; this restarts it with the new
# code. Logs (including [exit] diagnostics) go to .server.log.
cd "$(dirname "$0")"
echo "[supervisor] started pid=$$ at $(date -Is)" >> .server.log
while true; do
  node server.js "$@" >> .server.log 2>&1
  echo "[supervisor] server exited status=$? at $(date -Is); restarting in 2s" >> .server.log
  sleep 2
done
