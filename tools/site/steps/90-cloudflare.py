#!/usr/bin/env python3
"""Add the Cloudflare Pages hosting files to the site and check that the
finished tree can be deployed.

  python3 -I tools/site/steps/90-cloudflare.py <dist> [--check]

Copies cloudflare/pages/_headers (and _redirects, if there is one) into <dist>.
Then it walks <dist> and stops the build when something in it must not or
cannot go to Pages:

  - a file over 25 MiB or more than 20,000 files (the Pages limits)
  - firmware, game dumps or parts of them: by file extension, by file
    signature (archives, ROM images, Symbian installers and executables,
    whatever they are named), and by size and SHA-256 against
    /catalog/assets.json when the build produced one
  - symbolic links (wrangler uploads what they point to, under their name)
  - names wrangler treats specially: _worker.js would turn the site into a
    Pages Functions project, where _headers no longer applies, and a few
    others are silently left out of the upload
  - a missing _headers, or a missing 404.html (site/404.html, which
    build.py copies with the front page)
  - an inline script in the player's pages, which its Content-Security-Policy
    in _headers would block

--check only checks, without copying: tools/ci/deploy.sh runs it right before
uploading, so a tree that was changed after the build is checked again.
"""
import hashlib
import json
import os
import re
import shutil
import sys
from html.parser import HTMLParser

# Always the checkout this file is in, so that the hosting files and the step
# that copies them cannot come from two different checkouts.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SOURCE = os.path.join(ROOT, "cloudflare", "pages")

# https://developers.cloudflare.com/pages/platform/limits/ (wrangler enforces
# the same numbers before it uploads). 20,000 files is the Free plan; paid
# plans allow 100,000.
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES = 20000
MAX_HEADER_RULES = 100
MAX_HEADER_LINE = 2000

# What firmware and card dumps come as, and what a Symbian application is made
# of. None of it belongs on the site: the player downloads games from /assets/.
FORBIDDEN_EXTENSIONS = {
    ".zip", ".7z", ".rar", ".tar", ".tgz", ".gz", ".bz2", ".xz",   # archives (packed dumps)
    ".rom", ".rpkg",                                                # firmware
    ".sis", ".sisx", ".jar", ".jad",                                # installers
    ".app", ".exe", ".aif", ".rsc", ".mbm", ".mif",                 # application, its info, resources and bitmaps
}
# The emulator's own replacement DLLs (built from eka2l1/src/patch, GPL like
# the rest of it) are Symbian executables too, and the web build ships them in
# this folder. Any other Symbian executable came out of a dump.
OWN_DLL_FOLDER = "play/patch"
# The site build keeps each build of the player in play/b/<id>/.
OWN_DLL_FOLDERS = re.compile(r"play/(?:b/[0-9a-f]+/)?patch")

# wrangler does not upload these (the list is in its Pages validator); a site
# that contained one would silently lose it. The first three only count at the
# top of the output folder, the others anywhere.
SKIPPED_AT_TOP = ("_routes.json", "functions", ".wrangler")
SKIPPED_ANYWHERE = ("node_modules", ".git")

# The path prefix whose pages get the Content-Security-Policy without
# 'unsafe-inline' in cloudflare/pages/_headers.
STRICT_SCRIPTS = "play/"
# A <script> whose type is none of these is a data block and never runs.
JAVASCRIPT_TYPES = {
    "", "module", "importmap", "speculationrules",
    "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
    "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
    "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
    "text/x-ecmascript", "text/x-javascript",
}
URL_ATTRIBUTES = ("href", "src", "action", "formaction", "xlink:href")

HEAD_BYTES = 512


def signature(head):
    """What the first bytes of a file say it is, or None."""
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "a zip archive"
    if head[:6] == b"7z\xbc\xaf\x27\x1c":
        return "a 7z archive"
    if head[:6] == b"Rar!\x1a\x07":
        return "a rar archive"
    if head[:3] == b"\x1f\x8b\x08" or head[:6] == b"\xfd7zXZ\x00" or (head[:3] == b"BZh" and head[4:10] == b"1AY&SY"):
        return "a compressed archive"
    if head[257:262] == b"ustar":
        return "a tar archive"
    # Symbian files start with three UIDs. An executable has the word EPOC
    # after them; an installer has the SIS UID third (0x10000419, before
    # Symbian 9) or first (0x10201A7A, since).
    if head[16:20] == b"EPOC":
        return "a Symbian executable"
    if head[8:12] == b"\x19\x04\x00\x10" or head[:4] == b"\x7a\x1a\x20\x10":
        return "a Symbian installer (SIS)"
    # A ROM image starts with the ARM exception vectors: eight branch
    # instructions, each a little-endian word whose top byte is 0xEA.
    if len(head) >= 32 and all(head[offset + 3] == 0xEA for offset in range(0, 32, 4)):
        return "an ARM ROM image (firmware)"
    return None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def known_assets(dist):
    """{bytes: {sha256: name}} of the firmware and the game zips, from the
    manifest the assets step publishes. Empty when the build has none."""
    path = os.path.join(dist, "catalog", "assets.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path) as fh:
            manifest = json.load(fh)
        entries = [(f"the firmware {name}", manifest.get(name)) for name in ("fw", "ngage2Device", "ngage2App")]
        entries += [(f"the game {slug}", entry) for slug, entry in (manifest.get("games") or {}).items()]
        known = {}
        for name, entry in entries:
            if isinstance(entry, dict) and "bytes" in entry and "sha256" in entry:
                known.setdefault(int(entry["bytes"]), {})[str(entry["sha256"]).lower()] = name
        return known
    except (ValueError, TypeError, AttributeError) as error:
        sys.exit(f"90-cloudflare: cannot read {path}: {error}")


class InlineScripts(HTMLParser):
    """Collects what a Content-Security-Policy without 'unsafe-inline' blocks."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found = []

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        names = {name: (value or "") for name, value in attrs}
        # The type may carry parameters ("text/javascript; charset=utf-8").
        kind = names.get("type", "").split(";")[0].strip().lower()
        if tag == "script" and "src" not in names and kind in JAVASCRIPT_TYPES:
            self.found.append(f"line {line}: inline <script>")
        for name, value in names.items():
            if name.startswith("on"):
                self.found.append(f"line {line}: inline event handler {name}= on <{tag}>")
            elif name in URL_ATTRIBUTES and value.strip().lower().startswith("javascript:"):
                self.found.append(f"line {line}: javascript: URL in {name}= on <{tag}>")

    handle_startendtag = handle_starttag


def check_headers(path, problems):
    if not os.path.isfile(path):
        problems.append("_headers is missing: without it the pages are not cross-origin isolated and the player cannot start")
        return
    rules = 0
    with open(path, encoding="utf-8") as fh:
        for number, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if len(line) > MAX_HEADER_LINE:
                problems.append(f"_headers line {number} is {len(line)} characters long; Pages ignores lines over {MAX_HEADER_LINE}")
            if line.startswith("/") or line.startswith("https://"):
                rules += 1
    if rules > MAX_HEADER_RULES:
        problems.append(f"_headers has {rules} rules; Pages ignores those after the first {MAX_HEADER_RULES}")


def check_file(path, relative, known, problems):
    """Checks one regular file and returns its size."""
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES:
        problems.append(f"{relative}: {size / (1 << 20):.1f} MiB; Pages accepts files up to 25 MiB (large downloads belong in R2, behind /assets/)")
    extension = os.path.splitext(relative)[1].lower()
    with open(path, "rb") as fh:
        kind = signature(fh.read(HEAD_BYTES))
    own_dll = extension == ".dll" and OWN_DLL_FOLDERS.fullmatch(os.path.dirname(relative)) is not None
    if extension in FORBIDDEN_EXTENSIONS:
        problems.append(f"{relative}: {extension} files are firmware or game material and must not be published")
    elif extension == ".dll" and not own_dll:
        problems.append(f"{relative}: a .dll outside the player's own patch folder ({OWN_DLL_FOLDER}/, or play/b/<id>/patch/) is game or firmware code and must not be published")
    elif kind and not (own_dll and kind == "a Symbian executable"):
        problems.append(f"{relative}: this is {kind}, whatever its name; firmware and game material must not be published")
    elif size in known:
        asset = known[size].get(sha256(path))
        if asset:
            problems.append(f"{relative}: this is {asset} (same SHA-256 as in catalog/assets.json) and must not be published")
    if relative.startswith(STRICT_SCRIPTS) and extension in (".html", ".htm"):
        parser = InlineScripts()
        with open(path, encoding="utf-8", errors="replace") as fh:
            parser.feed(fh.read())
        for found in parser.found:
            problems.append(f"{relative}, {found}: the Content-Security-Policy for /{STRICT_SCRIPTS} in cloudflare/pages/_headers blocks it; move the code into a .js file")
    return size


def check_tree(dist):
    problems = []
    known = known_assets(dist)
    count = largest = 0
    if os.path.lexists(os.path.join(dist, "_worker.js")):
        problems.append("_worker.js: Pages would run this as a Function instead of serving files, and _headers does not apply to Functions")
    for folder, folders, names in os.walk(dist):
        top = os.path.samefile(folder, dist)
        for name in sorted(folders + names):
            path = os.path.join(folder, name)
            relative = os.path.relpath(path, dist).replace(os.sep, "/")
            if os.path.islink(path):
                problems.append(f"{relative}: symbolic link to {os.readlink(path)}; the site must consist of real files")
            elif name in SKIPPED_ANYWHERE or (top and name in SKIPPED_AT_TOP):
                problems.append(f"{relative}: wrangler leaves this name out of the upload, so the deployed site would lack it; rename it")
                if name in folders:
                    folders.remove(name)   # one message, not one per file inside
            elif name in names:
                count += 1
                largest = max(largest, check_file(path, relative, known, problems))
    if count > MAX_FILES:
        problems.append(f"{count} files; Pages accepts {MAX_FILES} per deployment")
    check_headers(os.path.join(dist, "_headers"), problems)
    if not os.path.isfile(os.path.join(dist, "404.html")):
        problems.append("404.html is missing (it comes from site/404.html): without one at the top, Pages answers every unknown path with the front page and status 200")
    return count, largest, problems


def copy_hosting_files(dist):
    copied = []
    for name in ("_headers", "_redirects"):
        source = os.path.join(SOURCE, name)
        if not os.path.isfile(source):
            continue
        shutil.copyfile(source, os.path.join(dist, name))
        copied.append(name)
    return copied


def main():
    arguments = [argument for argument in sys.argv[1:] if argument != "--check"]
    check_only = len(arguments) != len(sys.argv) - 1
    if len(arguments) != 1 or arguments[0].startswith("-"):
        sys.exit(__doc__.strip())
    dist = os.path.abspath(arguments[0])
    if not os.path.isdir(dist):
        sys.exit(f"90-cloudflare: no site at {dist}: run python3 -I tools/site/build.py first")
    copied = [] if check_only else copy_hosting_files(dist)
    count, largest, problems = check_tree(dist)
    if problems:
        print(f"90-cloudflare: {dist} cannot be deployed to Cloudflare Pages:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        sys.exit(1)
    added = f", added {', '.join(copied)}" if copied else ""
    print(f"90-cloudflare: {count} files, the largest {largest / (1 << 20):.1f} MiB, nothing that must not be published{added}")


if __name__ == "__main__":
    main()
