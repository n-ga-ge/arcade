#!/usr/bin/env python3
"""Assemble the deployable site into dist/.

  python3 -I tools/site/build.py [--out dist] [--bin DIR] [--shell DIR] [--status DIR]

  /                    site/ (the front page); its style sheet and scripts go
                       into /s/<id>/, named after a hash of them like the
                       player's files below, and the pages are pointed there
  /play/               the player's page and a config.json that points it at the
                       catalogue and the assets
  /play/b/<id>/        every other file of the web build (eka2l1/build/web/bin).
                       <id> is a hash of those files, so each build has its own
                       address: a browser or a cache that still holds a script
                       of the last build can never pair it with this build's
                       wasm, and the files can be cached for good
  /catalog/index.json  one summary per game, merged with the CI status
  /catalog/games/      catalog/games/<slug>.json without the local-only fields
  /catalog/status.json, /catalog/shots/   from --status, when given
  then every tools/site/steps/NN-*.py runs in order with the output folder as
  its argument (docs, Cloudflare headers, ...), so a new part of the site adds
  a step instead of editing this file.

  --bin     web build to take the player from (default: eka2l1/build/web/bin of
            this checkout, else of the main checkout when this is a worktree)
  --shell   page sources to lay over the player (eka2l1/src/emu/web/shell of a
            checkout whose wasm was not rebuilt)
  --status  folder with status.json and shots/ as tools/ci/status.py writes them

Game files and the firmware are not part of the site: they are served from
/assets/ by the assets Worker in production and by the dev server locally.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCAL_ONLY = ("dump", "pack")
SUMMARY = ("slug", "title", "platform", "publisher", "year", "genre", "uid", "variantOf", "status", "statusNote", "multiplayer")
# "fw" is the original N-Gage's firmware; an N-Gage 2.0 game needs the phone's
# device zip and the N-Gage application instead (tools/assets/common.py names
# the same files).
PLAYER_CONFIG = {"catalog": "/catalog/", "assets": "/assets/", "fw": "/assets/NGAGE.ROM",
                 "ngage2Device": "/assets/devices/rm-409.zip", "ngage2App": "/assets/ngage2/ngage-1.40.1557.sis"}


def default_bin():
    candidates = [os.path.join(ROOT, "eka2l1", "build", "web", "bin")]
    if os.environ.get("ARCADE_MAIN"):
        candidates.append(os.path.join(os.environ["ARCADE_MAIN"], "eka2l1", "build", "web", "bin"))
    for candidate in candidates:
        if os.path.exists(os.path.join(candidate, "eka2l1_web.wasm")):
            return candidate
    return candidates[0]


def copy_tree(source, target, skip=()):
    for folder, _, names in os.walk(source):
        relative = os.path.relpath(folder, source)
        os.makedirs(os.path.join(target, relative), exist_ok=True)
        for name in names:
            if name.endswith(skip):
                continue
            shutil.copy2(os.path.join(folder, name), os.path.join(target, relative, name))


def version_player(play):
    """Move the player's files into play/b/<id>/ and point the page at them.

    The page (index.html) and config.json keep their addresses. Everything the
    page loads is addressed relative to the file that loads it, so rewriting
    the references in index.html is enough."""
    keep = {"index.html", "config.json"}
    files = []
    for folder, _, names in os.walk(play):
        for name in names:
            path = os.path.join(folder, name)
            relative = os.path.relpath(path, play).replace(os.sep, "/")
            if relative not in keep:
                files.append((relative, path))
    digest = hashlib.sha256()
    for relative, path in sorted(files):
        digest.update(relative.encode() + b"\0")
        with open(path, "rb") as fh:
            digest.update(hashlib.sha256(fh.read()).digest())
    build = digest.hexdigest()[:12]
    target = os.path.join(play, "b", build)
    os.makedirs(target)
    for entry in os.listdir(play):
        if entry not in keep and entry != "b":
            shutil.move(os.path.join(play, entry), os.path.join(target, entry))

    index = os.path.join(play, "index.html")
    with open(index, encoding="utf-8") as fh:
        page = fh.read()

    def point(match):
        attribute, address = match.group(1), match.group(2)
        if re.match(r"[a-z][a-z0-9+.-]*:|/|#", address, re.I) or not os.path.exists(os.path.join(target, address.split("?")[0].split("#")[0])):
            return match.group(0)
        return f'{attribute}="b/{build}/{address}"'

    page, changed = re.subn(r'\b(src|href)="([^"]+)"', point, page)
    if not changed or f"b/{build}/" not in page:
        sys.exit("the player's index.html refers to none of its files: cannot give the build its own folder")
    with open(index, "w", encoding="utf-8") as fh:
        fh.write(page)
    return build


def version_site(out):
    """Move the front page's style sheet and scripts into s/<id>/ and point the
    pages at the top of the site (index.html, 404.html) at them.

    The reason is the same as for the player: the zone keeps scripts and
    styles in browsers for hours, so a page must never name one by an address
    whose content changes. The scripts import each other by relative address,
    so only the pages need rewriting."""
    names = [name for name in ("style.css", "js") if os.path.exists(os.path.join(out, name))]
    if not names:
        return None
    digest = hashlib.sha256()
    for name in names:
        top = os.path.join(out, name)
        for path in sorted([top] if os.path.isfile(top) else [os.path.join(folder, leaf) for folder, _, leaves in os.walk(top) for leaf in leaves]):
            digest.update(os.path.relpath(path, out).replace(os.sep, "/").encode() + b"\0")
            with open(path, "rb") as fh:
                digest.update(hashlib.sha256(fh.read()).digest())
    build = digest.hexdigest()[:12]
    target = os.path.join(out, "s", build)
    os.makedirs(target)
    for name in names:
        shutil.move(os.path.join(out, name), os.path.join(target, name))
    pattern = re.compile(r'\b(src|href)="/(' + "|".join(re.escape(name) for name in names) + r')(?=["/?#])')
    for page in sorted(os.listdir(out)):
        if not page.endswith(".html"):
            continue
        path = os.path.join(out, page)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        text = pattern.sub(lambda match: f'{match.group(1)}="/s/{build}/{match.group(2)}', text)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return build


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(value, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


def build_catalog(out, status_dir):
    status = {}
    if status_dir:
        with open(os.path.join(status_dir, "status.json")) as fh:
            status = json.load(fh)
        write_json(os.path.join(out, "catalog", "status.json"), status)
        shots = os.path.join(status_dir, "shots")
        if os.path.isdir(shots):
            copy_tree(shots, os.path.join(out, "catalog", "shots"))
    results = status.get("games", {})
    source = os.path.join(ROOT, "catalog", "games")
    summaries = []
    for name in sorted(os.listdir(source)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(source, name)) as fh:
            game = json.load(fh)
        public = {key: value for key, value in game.items() if key not in LOCAL_ONLY}
        write_json(os.path.join(out, "catalog", "games", name), public)
        # "multiplayer": null (the game has none) is kept; a missing field means nobody knows.
        summary = {key: game[key] for key in SUMMARY if game.get(key) is not None or (key == "multiplayer" and key in game)}
        summary.setdefault("platform", "ngage")  # every summary says it, so the front page need not know the default
        summary["hasControls"] = bool(game.get("controls"))
        if game["slug"] in results:
            summary["ci"] = results[game["slug"]]
        summaries.append(summary)
    summaries.sort(key=lambda game: game["title"].lower())
    index = {"generated": status.get("generated"), "commit": status.get("commit"), "games": summaries}
    write_json(os.path.join(out, "catalog", "index.json"), index)
    return len(summaries)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=os.path.join(ROOT, "dist"))
    parser.add_argument("--bin", default=default_bin())
    parser.add_argument("--shell")
    parser.add_argument("--status")
    args = parser.parse_args()
    out = os.path.abspath(args.out)

    if not os.path.exists(os.path.join(args.bin, "eka2l1_web.wasm")):
        sys.exit(f"no web build at {args.bin}: run tools/ci/build-web.sh or pass --bin")
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)

    site = os.path.join(ROOT, "site")
    if os.path.isdir(site):
        copy_tree(site, out)
        version_site(out)

    play = os.path.join(out, "play")
    copy_tree(args.bin, play, skip=(".a", ".map"))
    if args.shell:
        copy_tree(args.shell, play)
    config_path = os.path.join(play, "config.json")
    config = {}
    if os.path.exists(config_path):
        with open(config_path) as fh:
            config = json.load(fh)
    write_json(config_path, {**PLAYER_CONFIG, **config})
    build = version_player(play)

    games = build_catalog(out, args.status)

    steps = os.path.join(ROOT, "tools", "site", "steps")
    ran = []
    for name in sorted(os.listdir(steps)) if os.path.isdir(steps) else []:
        if name.endswith(".py") and name[:2].isdigit():
            subprocess.run([sys.executable, "-I", os.path.join(steps, name), out], check=True, env={**os.environ, "ARCADE_ROOT": ROOT})
            ran.append(name)
    print(f"built {out}: {games} games, player {build} from {args.bin}" + (f", steps: {', '.join(ran)}" if ran else ""))


if __name__ == "__main__":
    main()
