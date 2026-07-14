#!/usr/bin/env bash
# Supervisor: keep the handsfree server alive. Restarts node on any exit so
# code edits go live. flock guarantees a single supervisor — extra launches
# exit quietly instead of fighting over port 8443.
cd "$(dirname "$0")"
exec 9> .run.lock
if ! flock -n 9; then
  echo "[supervisor] another supervisor already holds .run.lock; exiting" >> .server.log
  exit 0
fi
echo "[supervisor] started pid=$$ at $(date -Is)" >> .server.log
while true; do
  node server.js "$@" >> .server.log 2>&1
  echo "[supervisor] server exited status=$? at $(date -Is); restarting in 2s" >> .server.log
  sleep 2
done
