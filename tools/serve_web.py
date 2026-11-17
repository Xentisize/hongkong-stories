#!/usr/bin/env python3
"""Static server for build/web with caching disabled.

`python3 -m http.server` sends no Cache-Control, so Chrome applies heuristic caching and will
happily keep serving a stale `index.pck` — which looks exactly like a rendering bug ("my font fix
did nothing"). This serves `no-store` so a plain reload always gets the current build.

Usage: python3 tools/serve_web.py [port] [dir]
"""
import functools
import http.server
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "build" / "web"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Quieter than the default, but still shows which build was requested.
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    directory = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DIR
    if not (directory / "index.html").is_file():
        print(f"no build at {directory} — run tools/export_web.sh first")
        return 1
    handler = functools.partial(NoCacheHandler, directory=str(directory))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {directory} on http://127.0.0.1:{port}/ (no-store)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
