#!/usr/bin/env bash
# Export the Godot client for the web (docs/PLAN.md §10.2).
#
#   tools/export_web.sh            # release build into build/web
#   GODOT=/path/to/Godot tools/export_web.sh
#
# Requires the 4.7.2 export templates (§10.1), at either standard location:
#   macOS: ~/Library/Application Support/Godot/export_templates/4.7.2.stable/
#   Linux: ~/.local/share/godot/export_templates/4.7.2.stable/
set -euo pipefail

GODOT="${GODOT:-}"
if [ -z "$GODOT" ]; then
	if [ -x "/Applications/Godot.app/Contents/MacOS/Godot" ]; then
		GODOT="/Applications/Godot.app/Contents/MacOS/Godot"
	else
		GODOT="godot" # a godot binary on PATH (Linux/Windows installs)
	fi
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/build/web"

if [ ! -d "$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable" ] \
	&& [ ! -d "${XDG_DATA_HOME:-$HOME/.local/share}/godot/export_templates/4.7.2.stable" ] \
	&& ! ls /mnt/c/Users/*/AppData/Roaming/Godot/export_templates/4.7.2.stable >/dev/null 2>&1; then
	echo "ERROR: export templates for 4.7.2.stable are not installed — see PLAN §10.1" >&2
	exit 1
fi

echo "==> exporting Web build to $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
# A Windows Godot binary needs Windows paths: WSL interop converts the cwd, but the export
# target argument must be the UNC form itself (a POSIX path reads as inaccessible to it).
if [[ "$GODOT" == *.exe ]]; then
	"$GODOT" --headless --path "$(wslpath -w "$ROOT/client")" --export-release "Web" "$(wslpath -w "$OUT/index.html")"
else
	"$GODOT" --headless --path "$ROOT/client" --export-release "Web" "$OUT/index.html"
fi

# Pre-compress for transfer: brotli typically cuts the wasm/pck by 3-4x (§10.2).
if command -v brotli >/dev/null 2>&1; then
	echo "==> brotli pre-compressing"
	find "$OUT" -type f \( -name '*.wasm' -o -name '*.pck' -o -name '*.js' -o -name '*.html' \) \
		-exec brotli --force --best {} \;
else
	echo "==> brotli not installed; skipping pre-compression (install it: apt install brotli / brew install brotli)"
fi

# P6: the credits/privacy page ships alongside the build (deploy/web/*.html).
if ls "$ROOT"/deploy/web/*.html >/dev/null 2>&1; then
	cp "$ROOT"/deploy/web/*.html "$OUT"/
	echo "==> copied deploy/web pages (credits & privacy)"
fi

echo "==> artifacts"
ls -lh "$OUT"
