#!/usr/bin/env bash
# Shallow-clones the pristine NetHack 5.0.0 source into .cache/nethack-src for the
# assistant's search_nethack_source / read_nethack_source tools.  (vendor/nethack-src
# is the build tree: patched, with build artefacts -- not what the assistant should search.)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="NetHack-5.0.0_Released"
DEST=".cache/nethack-src"
mkdir -p .cache
if [ -d "$DEST/.git" ]; then
  echo "NetHack source already present at $DEST"
else
  git -c advice.detachedHead=false clone --depth 1 --branch "$TAG" https://github.com/NetHack/NetHack.git "$DEST"
fi
