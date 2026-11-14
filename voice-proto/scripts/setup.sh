#!/usr/bin/env bash
# Shallow-clones the NetHack 5.0.0 source into .cache/nethack-src (used by the source tools).
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="NetHack-5.0.0_Released"
DEST=".cache/nethack-src"
mkdir -p .cache
if [ -d "$DEST/.git" ]; then
  echo "NetHack source already present at $DEST ($(git -C "$DEST" describe --tags 2>/dev/null || echo "$TAG"))"
else
  git clone --depth 1 --branch "$TAG" https://github.com/NetHack/NetHack.git "$DEST"
fi
[ -d node_modules ] || npm install
npm run build
