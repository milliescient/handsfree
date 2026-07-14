#!/usr/bin/env bash
# Supervisor: keep the web server (server.js) and the agent daemon (agentd.js)
# alive, each in its own restart loop. flock guarantees a single supervisor.
#
# The two processes restart independently: web restarts are free (no turn is
# lost); agentd restarts gracefully via SIGHUP (drains the current turn first
# — see deploy.sh). Logs: .server.log and .agentd.log.
cd "$(dirname "$0")"
exec 9> .run.lock
if ! flock -n 9; then
  echo "[supervisor] another supervisor already holds .run.lock; exiting" >> .server.log
  exit 0
fi
echo "[supervisor] started pid=$$ at $(date -Is)" >> .server.log

(
  while true; do
    node agentd.js "$@" >> .agentd.log 2>&1
    echo "[supervisor] agentd exited status=$? at $(date -Is); restarting in 2s" >> .agentd.log
    sleep 2
  done
) &
AGENTD_LOOP=$!
trap 'kill $AGENTD_LOOP $(cat .agentd.pid 2>/dev/null) 2>/dev/null' EXIT

while true; do
  node server.js "$@" >> .server.log 2>&1
  echo "[supervisor] server exited status=$? at $(date -Is); restarting in 2s" >> .server.log
  sleep 2
done
