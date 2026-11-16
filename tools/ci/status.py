#!/usr/bin/env python3
"""Turn the per-game test results into the status the front page shows.

  python3 -I tools/ci/status.py <results dir> --out <dir> [--commit SHA] [--summary FILE] [--allow-empty]

Reads every <slug>.json that tools/web/gametest.mjs wrote, in <results dir> or
in a folder below it (downloaded CI artifacts arrive in one folder per game),
and writes

  <dir>/status.json        { "generated": <ISO time>, "commit": <sha or null>,
                             "games": { "<slug>": { "pass", "expect", "reached",
                             "seconds", "shot", "error"?, "better"? } } }
  <dir>/shots/<slug>.png   the emulator's last screenshot of each game

which is what tools/site/build.py --status <dir> publishes under /catalog/.

  "reached"  how far the game got: broken, boots, menu, ingame; null when the
             test could not be carried out (then "pass" is false and "error"
             says why)
  "expect"   the level it had to reach; null when it was only looked at
  "shot"     "shots/<slug>.png", or null when no screenshot was taken
  "better"   true when the game got further than the catalogue says

Games in the catalogue with no result are left out, and so are results for
games the catalogue does not have. It prints one line per game and then a
markdown table; --summary FILE also appends the table to FILE (the CI job
summary). The exit code is 0 whether games passed or not (each game's own job
reports that), and 1 when there is no result at all, unless --allow-empty.

  --commit   the commit the results are for (default: $GITHUB_SHA, else the
             commit the results themselves name when they agree)
"""
import argparse
import datetime
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LEVELS = ("broken", "boots", "menu", "ingame")


def catalogue():
    """slug -> title for every game in the catalogue."""
    games = {}
    folder = os.path.join(ROOT, "catalog", "games")
    for name in sorted(os.listdir(folder)):
        if name.endswith(".json"):
            with open(os.path.join(folder, name)) as fh:
                entry = json.load(fh)
            games[entry["slug"]] = entry.get("title", entry["slug"])
    return games


def read_results(folder, skip):
    """Every result file under `folder`, newest last, as (path, result)."""
    found = []
    for parent, dirs, names in os.walk(folder):
        # The output may be inside the results folder; its files are not results.
        dirs[:] = sorted(d for d in dirs if os.path.abspath(os.path.join(parent, d)) != skip)
        for name in sorted(names):
            if not name.endswith(".json"):
                continue
            path = os.path.join(parent, name)
            try:
                with open(path) as fh:
                    result = json.load(fh)
            except (OSError, ValueError) as error:
                print(f"skipped {path}: {error}", file=sys.stderr)
                continue
            # A result names its game after its file and says whether it passed.
            if not isinstance(result, dict) or result.get("slug") != name[:-len(".json")] or not isinstance(result.get("pass"), bool):
                continue
            found.append((path, result))
    found.sort(key=lambda item: os.path.getmtime(item[0]))
    return found


def cell(text):
    """Text that cannot break a markdown table row."""
    return " ".join(str(text).split()).replace("|", "\\|")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("results", help="folder with <slug>.json and <slug>.png, directly or one folder per game")
    parser.add_argument("--out", required=True, help="folder to write status.json and shots/ to")
    parser.add_argument("--commit", help="the commit the results are for")
    parser.add_argument("--summary", help="file to append the markdown table to")
    parser.add_argument("--allow-empty", action="store_true", help="write an empty status instead of failing when there are no results")
    args = parser.parse_args()
    if not os.path.isdir(args.results):
        sys.exit(f"no results folder at {args.results}")
    out = os.path.abspath(args.out)

    titles = catalogue()
    games = {}
    shots = {}
    commits = set()
    for path, result in read_results(args.results, out):
        slug = result["slug"]
        if slug not in titles:
            print(f"skipped {path}: {slug} is not in the catalogue", file=sys.stderr)
            continue
        if slug in games:
            print(f"{slug} has more than one result; using the newest, {path}", file=sys.stderr)
        reached = result.get("reached") if result.get("reached") in LEVELS else None
        expect = result.get("expect") if result.get("expect") in LEVELS else None
        shot = os.path.join(os.path.dirname(path), slug + ".png")
        shots[slug] = shot if os.path.isfile(shot) else None
        game = {
            # A result without a level is a test that did not run; it cannot pass.
            "pass": result["pass"] and reached is not None,
            "expect": expect,
            "reached": reached,
            "seconds": result.get("seconds"),
            "shot": f"shots/{slug}.png" if shots[slug] else None,
        }
        if result.get("error"):
            game["error"] = str(result["error"])
        elif not game["pass"]:
            game["error"] = "the test did not run" if reached is None else f"expected {expect}, reached {reached}"
        if result.get("better"):
            game["better"] = True
        games[slug] = game
        if result.get("commit"):
            commits.add(result["commit"])

    if not games and not args.allow_empty:
        sys.exit(f"no test results under {args.results}")

    commit = args.commit or os.environ.get("GITHUB_SHA") or (commits.pop() if len(commits) == 1 else None)
    status = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": commit,
        "games": {slug: games[slug] for slug in sorted(games)},
    }

    # Start the shots folder afresh: a game that has no picture this time must
    # not keep one from an earlier run.
    shots_out = os.path.join(out, "shots")
    if os.path.isdir(shots_out):
        shutil.rmtree(shots_out)
    os.makedirs(shots_out)
    for slug, source in shots.items():
        if source and slug in games:
            shutil.copyfile(source, os.path.join(shots_out, slug + ".png"))
    with open(os.path.join(out, "status.json"), "w") as fh:
        json.dump(status, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    passed = sum(1 for game in games.values() if game["pass"])
    table = [
        f"### Games: {passed} of {len(games)} passed" + (f" ({len(titles) - len(games)} not tested)" if len(games) < len(titles) else ""),
        "",
        "| Game | Result | Expected | Reached | Seconds | Note |",
        "|---|---|---|---|---|---|",
    ]
    for slug in sorted(games, key=lambda s: titles[s].lower()):
        game = games[slug]
        word = "PASS" if game["pass"] else "FAIL"
        reached = game["reached"] or "not run"
        note = game.get("error", "")
        if game.get("better"):
            note = f"better than listed ({game['expect']}); update the catalogue entry" + (f". {note}" if note else "")
        seconds = "" if game["seconds"] is None else game["seconds"]
        print(f"{word}  {slug}  {reached}" + (f" (expected {game['expect']})" if game["expect"] else "") + (f"  {note}" if note else ""))
        table.append(f"| {cell(titles[slug])} | {word.lower() if game['pass'] else '**FAIL**'} | {game['expect'] or '–'} | {reached} | {seconds} | {cell(note)[:300]} |")
    text = "\n".join(table) + "\n"
    print()
    print(text, end="")
    if args.summary:
        with open(args.summary, "a") as fh:
            fh.write(text)
    print(f"\nwrote {os.path.join(out, 'status.json')}: {len(games)} games, commit {commit or 'unknown'}", file=sys.stderr)


if __name__ == "__main__":
    main()
