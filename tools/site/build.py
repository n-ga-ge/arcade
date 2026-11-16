#!/usr/bin/env python3
"""Assemble the deployable site into dist/.

  python3 -I tools/site/build.py [--out dist] [--bin DIR] [--shell DIR] [--status DIR]

  /                    site/ (the front page), copied as is
  /play/               the web build (eka2l1/build/web/bin), with a config.json
                       that points the player at the catalogue and the assets
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
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCAL_ONLY = ("dump", "pack")
SUMMARY = ("slug", "title", "publisher", "year", "genre", "uid", "variantOf", "status", "statusNote")
PLAYER_CONFIG = {"catalog": "/catalog/", "assets": "/assets/", "fw": "/assets/NGAGE.ROM"}


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
        summary = {key: game[key] for key in SUMMARY if game.get(key) is not None}
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

    games = build_catalog(out, args.status)

    steps = os.path.join(ROOT, "tools", "site", "steps")
    ran = []
    for name in sorted(os.listdir(steps)) if os.path.isdir(steps) else []:
        if name.endswith(".py") and name[:2].isdigit():
            subprocess.run([sys.executable, "-I", os.path.join(steps, name), out], check=True, env={**os.environ, "ARCADE_ROOT": ROOT})
            ran.append(name)
    print(f"built {out}: {games} games, player from {args.bin}" + (f", steps: {', '.join(ran)}" if ran else ""))


if __name__ == "__main__":
    main()
