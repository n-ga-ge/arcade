#!/usr/bin/env python3
"""Pack local game card dumps into the zips the site and the tests load.

  python3 -I tools/games/pack.py [--games DIR] [--out DIR] [--force] [slug ...]

Reads catalog/games/<slug>.json, finds the card inside games/<dump>/ and writes
<out>/<slug>.zip (default testdata/games/) plus <out>/manifest.json with each
zip's size and SHA-256. Without slugs, every game in the catalogue is packed;
games whose dump folder is missing are reported and skipped.

A dump is whatever came off the card or the net, so the card is normalised:
  - the card root is the folder that holds System/Apps (any case), however
    deeply it is wrapped; "pack.root" in the catalogue entry overrides this
  - "pack.move" renames misplaced folders ([from, to], relative to the root)
  - junk is left out: Thumbs.db, .nfo/.diz, and loose .sis files beside System
  - "pack.exclude" adds glob patterns to leave out

The zips are reproducible (sorted entries, fixed timestamps), so the same dump
always gives the same hash and an upload can skip what has not changed.

The dumps and the zips are copyrighted: both live in ignored folders and never
enter the repository.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
JUNK = ("thumbs.db", "*.nfo", "*.diz", ".ds_store", "desktop.ini")
# Loose installers and release-group files next to System/ are not part of the card.
JUNK_TOP = ("*.sis", "*.sisx", "*.txt.url", "*.url")


def main_checkout():
    """The checkout that holds games/ and testdata/: this one, or the main one of a worktree."""
    env = os.environ.get("ARCADE_MAIN")
    if env:
        return env
    git = os.path.join(ROOT, ".git")
    if os.path.isfile(git):  # a worktree: ".git" is a file pointing into <main>/.git/worktrees/<name>
        with open(git) as fh:
            target = fh.read().strip().removeprefix("gitdir:").strip()
        marker = os.sep + ".git" + os.sep
        if marker in target:
            return target.split(marker)[0]
    return ROOT


def child(folder, name):
    """Case-insensitive lookup of one path component."""
    for entry in os.listdir(folder):
        if entry.lower() == name.lower():
            return os.path.join(folder, entry)
    return None


def resolve(folder, relative):
    """Case-insensitive lookup of a relative path; None when it does not exist."""
    current = folder
    for part in [p for p in relative.replace("\\", "/").split("/") if p and p != "."]:
        current = child(current, part) if os.path.isdir(current) else None
        if current is None:
            return None
    return current


def find_card_root(dump):
    """The shallowest folder holding system/apps, searched breadth-first."""
    level = [dump]
    while level:
        found = [d for d in level if (s := child(d, "system")) and os.path.isdir(s) and child(s, "apps")]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            raise ValueError("more than one card found: " + ", ".join(os.path.relpath(f, dump) for f in found))
        level = [os.path.join(d, e) for d in level for e in sorted(os.listdir(d)) if os.path.isdir(os.path.join(d, e))]
    raise ValueError("no System/Apps folder found")


def collect(root, moves, excludes):
    """Map of path-in-zip -> file on disk."""
    renames = []
    for source, target in moves:
        actual = resolve(root, source)
        if actual is None:
            raise ValueError(f"pack.move source not found: {source}")
        renames.append((os.path.relpath(actual, root).replace(os.sep, "/"), target.strip("/")))
    files = {}
    for folder, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(folder, name)
            inside = os.path.relpath(path, root).replace(os.sep, "/")
            lower = name.lower()
            if any(fnmatch.fnmatch(lower, pattern) for pattern in JUNK):
                continue
            if "/" not in inside and any(fnmatch.fnmatch(lower, pattern) for pattern in JUNK_TOP):
                continue
            if any(fnmatch.fnmatch(inside.lower(), pattern.lower()) for pattern in excludes):
                continue
            for source, target in renames:
                if inside == source or inside.startswith(source + "/"):
                    inside = target + inside[len(source):]
                    break
            if inside.lower() in (existing.lower() for existing in files):
                raise ValueError(f"two files map to {inside}")
            files[inside] = path
    return files


def pack(game, games_dir, out_dir):
    dump = os.path.join(games_dir, game["dump"])
    if not os.path.isdir(dump):
        return None
    options = game.get("pack") or {}
    if options.get("root"):
        root = resolve(dump, options["root"])
        if root is None:
            raise ValueError(f"pack.root not found: {options['root']}")
    else:
        root = find_card_root(dump)
    files = collect(root, options.get("move", []), options.get("exclude", []))
    lowered = {name.lower() for name in files}
    if not any(name.startswith("system/apps/") for name in lowered):
        raise ValueError("the packed card has no System/Apps")
    target = os.path.join(out_dir, game["slug"] + ".zip")
    partial = target + ".part"
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for inside in sorted(files, key=str.lower):
            info = zipfile.ZipInfo(inside, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(files[inside], "rb") as source:
                archive.writestr(info, source.read(), compresslevel=6)
    os.replace(partial, target)
    return target, len(files)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    main_dir = main_checkout()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("slugs", nargs="*")
    parser.add_argument("--games", default=os.path.join(main_dir, "games"), help="folder of dumps (default: games/)")
    parser.add_argument("--out", default=os.path.join(main_dir, "testdata", "games"), help="output folder (default: testdata/games/)")
    parser.add_argument("--force", action="store_true", help="repack zips that already exist")
    args = parser.parse_args()

    catalog = os.path.join(ROOT, "catalog", "games")
    slugs = args.slugs or sorted(name[:-5] for name in os.listdir(catalog) if name.endswith(".json"))
    os.makedirs(args.out, exist_ok=True)
    manifest_path = os.path.join(args.out, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as fh:
            manifest = json.load(fh)

    failed = 0
    for slug in slugs:
        with open(os.path.join(catalog, slug + ".json")) as fh:
            game = json.load(fh)
        target = os.path.join(args.out, slug + ".zip")
        try:
            if os.path.exists(target) and not args.force:
                note = "kept"
            else:
                result = pack(game, args.games, args.out)
                if result is None:
                    print(f"{slug}: skipped, no dump at {os.path.join(args.games, game['dump'])}")
                    continue
                note = f"{result[1]} files"
            manifest[slug] = {"bytes": os.path.getsize(target), "sha256": sha256(target)}
            print(f"{slug}: {manifest[slug]['bytes'] / 1e6:.1f} MB ({note})")
        except (ValueError, OSError) as error:
            failed += 1
            print(f"{slug}: FAILED, {error}", file=sys.stderr)

    with open(manifest_path, "w") as fh:
        json.dump(dict(sorted(manifest.items())), fh, indent=2)
        fh.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
