#!/usr/bin/env bash
# Export the Godot client for the web (docs/PLAN.md §10.2).
#
#   tools/export_web.sh            # release build into build/web
#   GODOT=/path/to/Godot tools/export_web.sh
#
# Requires the 4.7.2 export templates (§10.1):
#   ~/Library/Application Support/Godot/export_templates/4.7.2.stable/
set -euo pipefail

GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/build/web"

if [ ! -d "$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable" ]; then
	echo "ERROR: export templates for 4.7.2.stable are not installed — see PLAN §10.1" >&2
	exit 1
fi

echo "==> exporting Web build to $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
"$GODOT" --headless --path "$ROOT/client" --export-release "Web" "$OUT/index.html"

# Pre-compress for transfer: brotli typically cuts the wasm/pck by 3-4x (§10.2).
if command -v brotli >/dev/null 2>&1; then
	echo "==> brotli pre-compressing"
	find "$OUT" -type f \( -name '*.wasm' -o -name '*.pck' -o -name '*.js' -o -name '*.html' \) \
		-exec brotli --force --best {} \;
else
	echo "==> brotli not installed; skipping pre-compression (brew install brotli)"
fi

echo "==> artifacts"
ls -lh "$OUT"
