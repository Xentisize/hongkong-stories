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

echo "=== shell (splash, title, credits) ==="
# Not `SHELL`: that variable is the login shell, and assigning to it does not un-export it, so
# every child process below would inherit a multi-line verdict instead of a path.
SHELL_OUT="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-shell.js" 2>&1 || true)"
echo "$SHELL_OUT"

OUTPUT="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-npc-gating.js" 2>&1 || true)"
echo "$OUTPUT"

# Both checks drive the same page, so they run in sequence and both must pass.
echo "=== dialogue panel ==="
DIALOGUE="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-dialogue.js" 2>&1 || true)"
echo "$DIALOGUE"

echo "=== world interaction ==="
WORLD="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-world.js" 2>&1 || true)"
echo "$WORLD"

echo "=== chapters ==="
CHAPTERS="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-chapters.js" 2>&1 || true)"
echo "$CHAPTERS"

echo "=== quests and cutscenes ==="
QUEST="$(playwright-cli --raw run-code --filename="$PWD/scripts/verify-quest.js" 2>&1 || true)"
echo "$QUEST"

SHELL_PASS=false
CHAPTERS_PASS=false
GATING_PASS=false
DIALOGUE_PASS=false
WORLD_PASS=false
QUEST_PASS=false
grep -q "VERDICT:PASS" <<<"$SHELL_OUT" && SHELL_PASS=true
grep -q "VERDICT:PASS" <<<"$CHAPTERS" && CHAPTERS_PASS=true
grep -q "VERDICT:PASS" <<<"$OUTPUT" && GATING_PASS=true
grep -q "VERDICT:PASS" <<<"$DIALOGUE" && DIALOGUE_PASS=true
grep -q "VERDICT:PASS" <<<"$WORLD" && WORLD_PASS=true
grep -q "VERDICT:PASS" <<<"$QUEST" && QUEST_PASS=true

if [ "$SHELL_PASS" = true ] && [ "$CHAPTERS_PASS" = true ] && [ "$GATING_PASS" = true ] && [ "$DIALOGUE_PASS" = true ] && [ "$WORLD_PASS" = true ] && [ "$QUEST_PASS" = true ]; then
  exit 0
fi

echo "browser verification FAILED (shell=$SHELL_PASS chapters=$CHAPTERS_PASS gating=$GATING_PASS dialogue=$DIALOGUE_PASS world=$WORLD_PASS quest=$QUEST_PASS)" >&2
exit 1
