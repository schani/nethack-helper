#!/usr/bin/env bash
# Build NetHack 5.0.0 (tty + our "+feed" window-chain processor) from source
# and install it under <repo>/.nethack.
#
#   nethack/build.sh            full reproducible build (fresh checkout of the tag)
#   nethack/build.sh --quick    rebuild in the existing tree (after editing wc_feed.c)
#
# Inputs kept in this repo:
#   nethack/wc_feed.c           copied to win/chain/wc_feed.c
#   nethack/patches/*.patch     applied with `git apply` (kept minimal)
#   nethack/sysconf.append      appended to the installed sysconf
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/nethack-src"
PREFIX="$ROOT/.nethack"
REPO_URL="${NETHACK_REPO_URL:-https://github.com/NetHack/NetHack.git}"
TAG="NetHack-5.0.0_Released"
QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

log() { printf '\n==> %s\n' "$*"; }

# ---- prerequisites --------------------------------------------------------
missing=()
for tool in gcc make git curl; do command -v "$tool" >/dev/null || missing+=("$tool"); done
[[ -f /usr/include/term.h || -f /usr/include/ncurses/term.h ]] || missing+=("libncurses-dev (term.h)")
if ((${#missing[@]})); then
  echo "missing build prerequisites: ${missing[*]}" >&2
  if command -v apt-get >/dev/null && sudo -n true 2>/dev/null; then
    log "installing libncurses-dev uuid-dev via apt"
    sudo apt-get install -y libncurses-dev uuid-dev >/dev/null
  else
    echo "install them (Debian/Ubuntu: apt-get install build-essential libncurses-dev uuid-dev git curl)" >&2
    exit 1
  fi
fi

# ---- source checkout ------------------------------------------------------
if [[ ! -d "$SRC/.git" ]]; then
  log "cloning $REPO_URL @ $TAG"
  mkdir -p "$(dirname "$SRC")"
  git -c advice.detachedHead=false clone --depth 1 --branch "$TAG" "$REPO_URL" "$SRC"
fi

cd "$SRC"
if ((QUICK == 0)); then
  log "resetting source tree to pristine $TAG"
  git -c advice.detachedHead=false checkout -q -f "$TAG" 2>/dev/null || git checkout -q -f HEAD
  # keep the downloaded Lua tarball/tree (lib/) to avoid re-downloading
  git clean -fdxq -e lib/
fi

# ---- apply our changes ----------------------------------------------------
for p in "$ROOT"/nethack/patches/*.patch; do
  if git apply --reverse --check "$p" 2>/dev/null; then
    echo "patch already applied: $(basename "$p")"
  else
    log "applying $(basename "$p")"
    git apply "$p"
  fi
done
cp "$ROOT/nethack/wc_feed.c" win/chain/wc_feed.c

# ---- configure, fetch lua, build, install ---------------------------------
MAKEVARS=(WANT_WIN_CHAIN=1 WANT_WIN_TTY=1 PREFIX="$PREFIX")

if ((QUICK == 0)) || [[ ! -f Makefile ]]; then
  log "configuring with sys/unix/hints/linux.500"
  sh sys/unix/setup.sh sys/unix/hints/linux.500
fi

if ! ls -d lib/lua-*/src >/dev/null 2>&1; then
  log "fetching lua"
  make fetch-lua
fi

log "building (about a minute on 2 cores)"
# NB: top-level make is not parallel-safe (lua gets built twice concurrently)
make "${MAKEVARS[@]}" all

HACKDIR="$PREFIX/games/lib/nethackdir"
if pgrep -f "^$HACKDIR/nethack" >/dev/null 2>&1; then
  echo "a game is running from $HACKDIR; stop the server first (scripts/server-bg.sh stop)" >&2
  echo "(the built tree is ready; re-run this script to install)" >&2
  exit 1
fi
# `make install` does `rm -rf $(INSTDIR)`, which would wipe save files and
# the score file.  Preserve the variable game data across reinstalls.
KEEP=(save record logfile xlogfile livelog perm)
STASH="$PREFIX/.install-stash"
if [[ -d "$STASH" ]]; then
  # left over from an interrupted install: the stash is authoritative
  echo "found $STASH from an interrupted install; keeping it" >&2
elif [[ -d "$HACKDIR" ]]; then
  mkdir -p "$STASH"
  for f in "${KEEP[@]}"; do
    if [[ -e "$HACKDIR/$f" ]]; then mv "$HACKDIR/$f" "$STASH/"; fi
  done
fi

log "installing into $PREFIX"
mkdir -p "$PREFIX"
make "${MAKEVARS[@]}" install

for f in "${KEEP[@]}"; do
  if [[ -e "$STASH/$f" ]]; then rm -rf "${HACKDIR:?}/$f"; mv "$STASH/$f" "$HACKDIR/"; fi
done
rm -rf "$STASH"
log "configuring sysconf"
if ! grep -q '^# nethack-web' "$HACKDIR/sysconf"; then
  cat "$ROOT/nethack/sysconf.append" >> "$HACKDIR/sysconf"
fi

log "done: $HACKDIR/nethack"
"$HACKDIR/nethack" --version | head -1 || true
