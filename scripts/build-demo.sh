#!/usr/bin/env bash
# Builds the static live demo: the real frontend + an in-browser API (js/demo-backend.js).
# Usage: scripts/build-demo.sh [out-dir]   (default: demo-dist)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-demo-dist}"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r frontend/. "$OUT"/
rm -f "$OUT"/Dockerfile "$OUT"/nginx.conf
for f in "$OUT"/*.html; do
  # load the demo API before api.js, drop the socket.io CDN client (the demo ships its own)
  sed -i \
    -e 's#<script src="js/api.js"#<script src="js/demo-seed.js"></script>\n<script src="js/demo-backend.js"></script>\n<script src="js/api.js"#' \
    -e '/cdn.socket.io/d' "$f"
  # pages without the API client (landing) still get the demo ribbon
  grep -q 'demo-backend.js' "$f" || sed -i 's#</body>#<script src="js/demo-seed.js"></script>\n<script src="js/demo-backend.js"></script>\n</body>#' "$f"
done
touch "$OUT/.nojekyll"
echo "demo built in $OUT"
