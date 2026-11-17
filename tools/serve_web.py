#!/usr/bin/env python3
"""Static server for build/web with caching disabled.

`python3 -m http.server` sends no Cache-Control, so Chrome applies heuristic caching and will
happily keep serving a stale `index.pck` — which looks exactly like a rendering bug ("my font fix
did nothing"). This serves `no-store` so a plain reload always gets the current build.

When `tools/export_web.sh` has written `.br` sidecars, a GET for `index.wasm` with
`Accept-Encoding: br` returns `index.wasm.br` with `Content-Encoding: br`, so local testing
exercises the same transfer path as the pre-compressed static host (PLAN §10.2).

Usage: python3 tools/serve_web.py [port] [dir] [host]
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

    def send_head(self):
        # Pre-compressed sidecar (§10.2): when a `.br` sibling exists and the client
        # advertises br, serve the sidecar with Content-Encoding: br. A direct request for
        # the `.br` file itself is an opaque download, not an encoding, so it skips this.
        path = self.translate_path(self.path)
        if os.path.isdir(path) or path.endswith(".br") or not self._accepts_brotli():
            return super().send_head()
        sidecar = path + ".br"
        if not os.path.isfile(sidecar):
            return super().send_head()
        try:
            f = open(sidecar, "rb")
        except OSError:
            self.send_error(500, "pre-compressed sidecar unreadable")
            return None
        try:
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path) or "application/octet-stream")
            self.send_header("Content-Encoding", "br")
            self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
            self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
        except OSError:
            f.close()
            raise
        return f

    def _accepts_brotli(self) -> bool:
        accept = self.headers.get("Accept-Encoding", "")
        codings = {part.strip().split(";")[0].lower() for part in accept.split(",")}
        return "br" in codings or "*" in codings

    def log_message(self, fmt: str, *args) -> None:
        # Quieter than the default, but still shows which build was requested.
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    directory = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DIR
    # Optional host so a physical phone can reach the server over Wi-Fi (README "Tests");
    # loopback stays the default because a non-loopback bind exposes the build to the LAN.
    host = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
    if not (directory / "index.html").is_file():
        print(f"no build at {directory} — run tools/export_web.sh first")
        return 1
    handler = functools.partial(NoCacheHandler, directory=str(directory))
    with http.server.ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"serving {directory} on http://{host}:{port}/ (no-store)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
