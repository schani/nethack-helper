#!/usr/bin/env bash
# (Re)start the server in the background on port 8788; logs to .cache/server.log, pid in .cache/server.pid.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache
if [ -f .cache/server.pid ] && kill -0 "$(cat .cache/server.pid)" 2>/dev/null; then
  kill "$(cat .cache/server.pid)"; sleep 0.5
fi
[ -d dist/web ] || npx vite build
setsid nohup node server/main.ts >> .cache/server.log 2>&1 < /dev/null &
echo $! > .cache/server.pid
for i in $(seq 1 30); do
  curl -sf "http://localhost:${PORT:-8788}/api/health" >/dev/null && { echo "server up on :${PORT:-8788} (pid $(cat .cache/server.pid))"; exit 0; }
  sleep 0.3
done
echo "server failed to start; see .cache/server.log" >&2; exit 1
