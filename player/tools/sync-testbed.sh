#!/bin/sh
# Copy the player (without tests or tools) into the repo's testbed/player/ so the testbed runs this exact code.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HERE/../site/testbed/player"
rm -rf "$DEST"
mkdir -p "$DEST/vendor"
for f in "$HERE"/*.js; do cp "$f" "$DEST/"; done
cp "$HERE/vendor/mediabunny.min.mjs" "$HERE/vendor/MEDIABUNNY-LICENSE.txt" "$DEST/vendor/"
echo "synced $(ls "$DEST" | wc -l | tr -d ' ') entries to $DEST"
