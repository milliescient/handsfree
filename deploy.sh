#!/bin/bash
# One-shot deploy: commit everything, rebuild the APK, restart the server.
# This is the ONLY supported way to ship changes — running the steps
# separately is how version drift and update loops happened.
#
# Usage: ./deploy.sh "commit message"
#
# NOTE for the voice agent: the restart at the end kills the node server you
# are running inside of, which ends your current turn. Call this as the very
# last action of a task, after summarizing what you did.
set -e
cd "$(dirname "$0")"

MSG="$1"
if [ -z "$MSG" ]; then
  echo "Usage: ./deploy.sh \"commit message\"" >&2
  exit 1
fi

if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to commit; rebuilding at current HEAD."
else
  git add -A
  git commit -m "$MSG"
fi

# build-apk.sh requires the clean tree we just ensured, stamps the APK with
# HEAD's SHA, builds, and restarts the web server via the supervisor.
./build-apk.sh

# Restart agentd gracefully: SIGHUP means "finish the current turn and queue,
# then exit"; the supervisor restarts it with the new code. An in-flight turn
# (e.g. the voice agent running this very deploy) is never killed.
if [ -f .agentd.pid ] && kill -0 "$(cat .agentd.pid)" 2>/dev/null; then
  kill -HUP "$(cat .agentd.pid)"
  echo "agentd will restart with new code after its current turn."
fi
