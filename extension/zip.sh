#!/usr/bin/env bash
# Package the Hivemind Sidekick extension for distribution / Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")"

OUT="hivemind-sidekick.zip"
rm -f "$OUT"
zip -r "$OUT" \
  manifest.json \
  sidepanel.html \
  background.js \
  icons/icon16.png icons/icon48.png icons/icon128.png

echo "Wrote $(pwd)/$OUT"
