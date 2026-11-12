#!/usr/bin/env bash
# Serves docs/ locally and screenshots each demo role with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8787}
CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser)
mkdir -p screens
python3 -m http.server "$PORT" --directory docs >/tmp/doorway-ops-preview.log 2>&1 &
SRV=$!; trap 'kill $SRV' EXIT
sleep 1
for role in Owner Admin Manager Rep; do
  lc=$(echo "$role" | tr 'A-Z' 'a-z')
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=430,${HEIGHT:-2400} --virtual-time-budget=4000 \
    --screenshot="screens/$lc.png" "http://localhost:$PORT/index.html?demo=1&role=$role" 2>/dev/null
  echo "screens/$lc.png"
done
"$CHROME" --headless=new --no-sandbox --disable-gpu --force-device-scale-factor=2 --window-size=430,800 \
  --virtual-time-budget=3000 --screenshot="screens/signin.png" "http://localhost:$PORT/index.html" 2>/dev/null
echo screens/signin.png
