#!/usr/bin/env python3
"""Local test server for the EKA2L1 web build and the assembled site.

Sends the cross-origin isolation headers the player needs (SharedArrayBuffer
for threads) and serves firmware and game files from a folder outside the
build, so they are loaded by URL without ever being copied into the build or
the repository.

  devserver.py [options] [port]      default port 8080, bound to 127.0.0.1

Two layouts:

  player only (default)   /         the web build (--bin, default
                                    eka2l1/build/web/bin of the main checkout)
  whole site (--site DIR) /         DIR as tools/site/build.py wrote it, with
                                    the player under /play/

In both, /local/ and /assets/ map to --assets (default testdata/ of the main
checkout): /assets/NGAGE.ROM and /assets/games/<slug>.zip are the paths the
deployed site uses. /noiso/ serves the same files without the isolation
headers, to test how the page reports an unsupported setup.

  --shell DIR   page sources (eka2l1/src/emu/web/shell of some checkout) that
                take precedence over the player's own files, so page changes
                can be tried against a wasm that was built elsewhere

Paths default to the main checkout because a git worktree has neither the
build nor testdata/.
"""
import argparse
import functools
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main_checkout():
    env = os.environ.get("ARCADE_MAIN")
    if env:
        return env
    git = os.path.join(ROOT, ".git")
    if os.path.isfile(git):  # a worktree: ".git" points into <main>/.git/worktrees/<name>
        with open(git) as fh:
            target = fh.read().strip().removeprefix("gitdir:").strip()
        marker = os.sep + ".git" + os.sep
        if marker in target:
            return target.split(marker)[0]
    return ROOT


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript", ".json": "application/json"}
    site = None      # folder served at /
    assets = None    # folder served at /local/ and /assets/
    shell = None     # optional overlay for the player's page files
    player = "/"     # URL prefix the player lives under

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/noiso/"):
            # Same files, served without the isolation headers (see end_headers).
            clean = clean[len("/noiso"):]
        for prefix in ("/local/", "/assets/"):
            if clean.startswith(prefix):
                self.directory = self.assets
                return super().translate_path(clean[len(prefix) - 1:])
        if self.shell and clean.startswith(self.player):
            self.directory = self.shell
            inside = clean[len(self.player):]
            # An assembled site keeps the player's files in b/<build id>/.
            parts = inside.split("/", 2)
            if len(parts) == 3 and parts[0] == "b":
                inside = parts[2]
            candidate = super().translate_path("/" + inside)
            if os.path.isfile(candidate):
                return candidate
        self.directory = self.site
        return super().translate_path(clean)

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
    main = main_checkout()
    parser = argparse.ArgumentParser(description="Local test server for the EKA2L1 web build and the assembled site.")
    parser.add_argument("port", nargs="?", type=int, default=8080)
    parser.add_argument("--site", help="serve an assembled site (tools/site/build.py output) instead of the bare player")
    parser.add_argument("--bin", default=os.path.join(main, "eka2l1", "build", "web", "bin"), help="web build to serve as the bare player")
    parser.add_argument("--assets", default=os.path.join(main, "testdata"), help="folder with NGAGE.ROM and games/<slug>.zip")
    parser.add_argument("--shell", help="page sources that take precedence over the player's files")
    args = parser.parse_args()

    Handler.site = os.path.abspath(args.site or args.bin)
    Handler.assets = os.path.abspath(args.assets)
    Handler.shell = os.path.abspath(args.shell) if args.shell else None
    Handler.player = "/play/" if args.site else "/"
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(Handler, directory=Handler.site))
    print(f"serving {Handler.site} on http://127.0.0.1:{args.port}/  (/assets/ and /local/ -> {Handler.assets})", flush=True)
    server.serve_forever()
