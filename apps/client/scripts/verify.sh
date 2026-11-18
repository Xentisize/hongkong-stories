#!/usr/bin/env bash
# Browser verification for the client spike.
#
# Compile-time checking is not enough here: `tsc` and `vite build` both passed a build whose
# update loop threw on the first frame, and they cannot see whether content `requires` actually
# gates what appears on screen. This drives a real browser and fails loudly.
#
# Requires `playwright-cli` plus a chromium build (`playwright-cli install-browser
# chrome-for-testing`). Kept out of the workspace dependencies on purpose: it is a verification
# tool, not something the game ships.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-4178}"
URL="http://localhost:${PORT}/"

cleanup() {
  playwright-cli close >/dev/null 2>&1 || true
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

bun run build >/dev/null

bun run preview -- --port "$PORT" --strictPort >/tmp/hks-client-preview.log 2>&1 &
SERVER_PID=$!

# Bounded readiness poll: the preview server binds in a few hundred ms.
for _ in $(seq 1 80); do
  if curl -sf "$URL" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

if ! curl -sf "$URL" >/dev/null 2>&1; then
  echo "preview server never came up on ${URL}" >&2
  cat /tmp/hks-client-preview.log >&2
  exit 1
fi

# The bundled chromium, not the system Chrome channel.
playwright-cli open --browser=chromium "$URL" >/dev/null 2>&1 || {
  echo "could not open a browser — run: playwright-cli install-browser chrome-for-testing" >&2
  exit 1
}

OUTPUT="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-npc-gating.js" 2>&1 || true)"
echo "$OUTPUT"

if grep -q "VERDICT:PASS" <<<"$OUTPUT"; then
  exit 0
fi

echo "browser verification FAILED" >&2
exit 1
