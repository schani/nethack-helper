#!/usr/bin/env bash
# Start/stop/restart the server in the background (nohup), logging to .cache/server.log.
#   scripts/server-bg.sh start|stop|restart|status
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/.cache/server.pid"
LOG="$ROOT/.cache/server.log"
mkdir -p "$ROOT/.cache"

running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

stop() {
  if running; then
    local pid; pid="$(cat "$PIDFILE")"
    # SIGTERM -> server sends SIGHUP to nethack, which saves the game
    kill -TERM "$pid"
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then echo "server did not stop; killing" >&2; kill -KILL "$pid"; fi
    echo "stopped $pid"
  fi
  rm -f "$PIDFILE"
}

start() {
  if running; then echo "already running (pid $(cat "$PIDFILE"))"; return; fi
  cd "$ROOT"
  nohup node server/src/main.ts >>"$LOG" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:${PORT:-8787}/api/session" >/dev/null; then
      echo "started pid $(cat "$PIDFILE") on port ${PORT:-8787}; log: $LOG"; return
    fi
    sleep 0.2
  done
  echo "server failed to come up; see $LOG" >&2; exit 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if running; then echo "running pid $(cat "$PIDFILE")"; else echo "not running"; fi ;;
  *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
