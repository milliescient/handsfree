#!/usr/bin/env bash
# Install handsfree as a systemd user service. Safe to re-run (idempotent).
#
# The service just runs run.sh, so the restart contract is unchanged:
# deploy.sh still restarts the web server by port and drains agentd via
# SIGHUP; the supervisor loops live inside the service's cgroup. Lingering
# is enabled so the service starts at boot without anyone logging in.
#
# --takeover: additionally stop a manually-started ./run.sh supervisor (and
# its node processes) so the service can grab .run.lock, then (re)start the
# service. NOTE for the voice agent: takeover kills agentd — you. Run it
# detached (setsid nohup ... &) with a delay, after your summary, as the very
# last action of a task. Same discipline as deploy.sh's restart.
set -e
cd "$(dirname "$0")"
REPO="$(pwd)"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "No systemd user manager available; start manually with ./run.sh" >&2
  exit 1
fi

# The user service gets a minimal PATH; node (often nvm-installed) and the
# claude CLI (SDK dependency) must be findable.
NODE_DIR="$(dirname "$(command -v node)")"
CLAUDE_DIR="$(command -v claude >/dev/null 2>&1 && dirname "$(command -v claude)" || echo "$HOME/.local/bin")"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/handsfree.service" <<EOF
[Unit]
Description=Handsfree voice coding server (web server + agent daemon)
StartLimitIntervalSec=0

[Service]
WorkingDirectory=$REPO
ExecStart=$REPO/run.sh
Restart=always
RestartSec=5
Environment=PATH=$NODE_DIR:$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable handsfree.service
echo "Installed and enabled ~/.config/systemd/user/handsfree.service"

# Start at boot even when nobody is logged in.
loginctl enable-linger "$USER" 2>/dev/null \
  || echo "note: could not enable lingering — the service starts on login only"

# Supervisors started outside the service (a manual ./run.sh) hold .run.lock
# and would make the service exit immediately. Find them by command line,
# excluding anything already inside the service's cgroup.
foreign_supervisors() {
  for pid in $(pgrep -f 'bash .*run\.sh' 2>/dev/null); do
    grep -q handsfree.service "/proc/$pid/cgroup" 2>/dev/null || echo "$pid"
  done
}

if [ "${1:-}" = "--takeover" ]; then
  PIDS="$(foreign_supervisors)"
  if [ -n "$PIDS" ]; then
    echo "Stopping manual supervisor(s): $PIDS"
    kill $PIDS 2>/dev/null || true
    # The web server is not killed by the supervisor's exit trap; agentd is,
    # but belt and braces — kill both by port/pidfile, never by name.
    fuser -k 8443/tcp 2>/dev/null || true
    [ -f .agentd.pid ] && kill "$(cat .agentd.pid)" 2>/dev/null || true
    sleep 2
  fi
  systemctl --user restart handsfree.service
  echo "Service restarted."
else
  if [ -n "$(foreign_supervisors)" ]; then
    echo "A manual ./run.sh supervisor is running; not starting the service."
    echo "Re-run with --takeover to migrate it to the service."
  else
    systemctl --user start handsfree.service
    echo "Service started."
  fi
fi

systemctl --user --no-pager --lines=0 status handsfree.service || true
