#!/usr/bin/env python3
"""Download the firmware and game zips from the deployed /assets/ and verify them.

  python3 -I tools/assets/fetch.py [--fw] [--all] [slug ...] --out DIR

  --fw             the firmware the named games need: <DIR>/NGAGE.ROM for an
                   original N-Gage game, <DIR>/devices/rm-409.zip and
                   <DIR>/ngage2/ngage-1.40.1557.sis for an N-Gage 2.0 one
                   (the entry's "platform"); without slugs, NGAGE.ROM
  slug ...         games, to <DIR>/games/<slug>.zip
  --all            every firmware file and every game in the manifest
  --out DIR        the folder the tests read (testdata)
  --manifest FILE  default catalog/assets.json
  --retries N      attempts after the first for a transient failure (default 4)

Environment:
  ASSETS_URL    required: the /assets/ base, e.g. https://n-ga.ge/assets/
  ASSETS_TOKEN  optional: sent as "Authorization: Bearer <token>"

Every file is checked against the size and SHA-256 in catalog/assets.json. A
file that is already there with the right hash is not downloaded again; a
download is written beside its target and only moved into place once it
verifies. Network errors, timeouts, 429 and 5xx are retried; a wrong hash or a
401/403/404 fails at once. Exits 1 when any file could not be fetched.
"""
import argparse
import hashlib
import http.client
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True  # no __pycache__ in the checkout
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
import common  # noqa: E402

RETRY_STATUS = (408, 425, 429, 500, 502, 503, 504)


class Failed(Exception):
    """A failure that another attempt will not fix."""


class SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects, but never carry the token to another host or from https to http."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl)[:2] != urllib.parse.urlsplit(req.full_url)[:2]:  # scheme and host
            new.headers.pop("Authorization", None)
            new.unredirected_hdrs.pop("Authorization", None)
        return new


def matches(path, listed):
    return os.path.isfile(path) and os.path.getsize(path) == listed["bytes"] and common.digest(path, "sha256")[1] == listed["sha256"]


def download(opener, url, token, target, listed):
    """One attempt: stream to <target>.part, verify, move into place."""
    headers = {"User-Agent": "arcade-assets-fetch", "Accept-Encoding": "identity"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    partial = target + ".part"
    hasher, size = hashlib.sha256(), 0
    with opener.open(urllib.request.Request(url, headers=headers), timeout=120) as response, open(partial, "wb") as out:
        for block in iter(lambda: response.read(1 << 20), b""):
            hasher.update(block)
            size += len(block)
            out.write(block)
            if size > listed["bytes"]:
                raise Failed(f"more than the {listed['bytes']} bytes the manifest lists")
    if size < listed["bytes"]:
        raise OSError(f"got {size} of {listed['bytes']} bytes")  # cut short: worth another attempt
    if hasher.hexdigest() != listed["sha256"]:
        raise Failed(f"SHA-256 mismatch: got {hasher.hexdigest()}, the manifest has {listed['sha256']}")
    os.replace(partial, target)


def fetch(opener, url, token, target, listed, retries):
    """Download with retries. Returns None on success, else what went wrong."""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    problem = None
    try:
        for attempt in range(retries + 1):
            if attempt:
                time.sleep(min(2 ** attempt, 30))
            try:
                download(opener, url, token, target, listed)
                return None
            except Failed as error:
                return str(error)
            except urllib.error.HTTPError as error:
                problem = f"HTTP {error.code} {error.reason}"
                if error.code in (401, 403):
                    return problem + (": ASSETS_TOKEN was refused" if token else ": ASSETS_TOKEN is not set")
                if error.code not in RETRY_STATUS:
                    return problem
            except (OSError, http.client.HTTPException) as error:
                problem = f"{type(error).__name__}: {error}"
            print(f"  {url}: {problem}" + (", trying again" if attempt < retries else ""), file=sys.stderr, flush=True)
        return f"{problem} (after {retries + 1} attempts)"
    finally:
        if os.path.exists(target + ".part"):
            os.remove(target + ".part")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("slugs", nargs="*")
    parser.add_argument("--fw", action="store_true")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest", default=common.MANIFEST)
    parser.add_argument("--retries", type=int, default=4)
    args = parser.parse_args()

    try:
        manifest = common.load_manifest(args.manifest)
    except (OSError, ValueError) as error:
        sys.exit(f"fetch.py: no usable manifest: {error}")
    slugs = sorted(manifest["games"]) if args.all else list(dict.fromkeys(args.slugs))
    firmware = []
    if args.all:
        firmware = [name for name in common.FIRMWARE if name in manifest]
    elif args.fw:
        try:
            firmware = common.firmware_for(slugs) if slugs else [common.FW]
        except (OSError, ValueError) as error:
            sys.exit(f"fetch.py: cannot tell which firmware the games need: {error}")
    names = firmware + slugs
    if not names:
        parser.error("nothing to fetch: give --fw, slugs or --all")
    unknown = [name for name in names if not common.entry(manifest, name)]
    if unknown:
        sys.exit(f"fetch.py: no usable entry in {args.manifest} for: " + ", ".join(unknown)
                 + "\n  the game is not in the manifest yet: python3 -I tools/assets/upload.py --write-manifest regenerates it")

    base = os.environ.get("ASSETS_URL", "").strip()
    if not base:
        sys.exit("fetch.py: ASSETS_URL is not set. It is the site's /assets/ base, for example\n"
                 "  ASSETS_URL=https://n-ga.ge/assets/   (locally: http://127.0.0.1:8080/assets/ with tools/web/devserver.py)")
    if urllib.parse.urlsplit(base).scheme not in ("http", "https"):
        sys.exit(f"fetch.py: ASSETS_URL is not an http(s) URL: {base}")
    base = base.rstrip("/") + "/"
    token = os.environ.get("ASSETS_TOKEN", "").strip()
    opener = urllib.request.build_opener(SameHostRedirects)

    failed = 0
    for name in names:
        key, listed = common.object_key(name), common.entry(manifest, name)
        target = os.path.join(args.out, *key.split("/"))
        if matches(target, listed):
            print(f"{key:44} {common.megabytes(listed['bytes'])}  already there", flush=True)
            continue
        problem = fetch(opener, base + urllib.parse.quote(key), token, target, listed, args.retries)
        failed += bool(problem)
        print(f"{key:44} {common.megabytes(listed['bytes'])}  {'FAILED: ' + problem if problem else 'downloaded'}", flush=True)
    if failed:
        print(f"fetch.py: {failed} of {len(names)} files could not be fetched from {base}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
