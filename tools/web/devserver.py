#!/usr/bin/env python3
"""Local test server for the EKA2L1 web build.

Serves the build output with the cross-origin isolation headers the page needs
(SharedArrayBuffer for threads), and maps /local/ to the workspace's testdata
folder so firmware and game dumps can be loaded by URL without ever being
copied into the build or the repository. /noiso/ serves the same files without
the isolation headers, to test how the page reports an unsupported setup.

  devserver.py [port]            default 8080, bound to 127.0.0.1
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIST = os.path.join(ROOT, "eka2l1", "build", "web", "bin")
LOCAL = os.path.join(ROOT, "testdata")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/noiso/"):
            # Same files, served without the isolation headers (see end_headers).
            path = path[len("/noiso"):]
            clean = clean[len("/noiso"):]
        if clean.startswith("/local/"):
            self.directory = LOCAL
            return super().translate_path(clean[len("/local"):])
        self.directory = DIST
        return super().translate_path(path)

    def end_headers(self):
        if not self.path.startswith("/noiso/"):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=DIST))
    print(f"serving {DIST} on http://127.0.0.1:{port}/  (/local/ -> {LOCAL})", flush=True)
    server.serve_forever()
