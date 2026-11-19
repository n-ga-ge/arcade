#!/usr/bin/env python3
"""Turn the per-game test results into the status the front page shows.

  python3 -I tools/ci/status.py <results dir> --out <dir> [--commit SHA] [--summary FILE] [--allow-empty]
  python3 -I tools/ci/status.py --self-test

Reads every <slug>.json that tools/web/gametest.mjs wrote, in <results dir> or
in a folder below it (downloaded CI artifacts arrive in one folder per game),
and writes

  <dir>/status.json        { "generated": <ISO time>, "commit": <sha or null>,
                             "games": { "<slug>": { "pass", "expect", "reached",
                             "seconds", "shot", "error"?, "better"?,
                             "attempts"?, "earlierAttempts"?, "perf"? } } }
  <dir>/shots/<slug>.png   the emulator's last screenshot of each game

which is what tools/site/build.py --status <dir> publishes under /catalog/.

  "reached"  how far the game got: broken, boots, menu, ingame; null when the
             test could not be carried out (then "pass" is false and "error"
             says why)
  "expect"   the level it had to reach; null when it was only looked at
  "shot"     "shots/<slug>.png", or null when no screenshot was taken
  "better"   true when the game got further than the catalogue says
  "attempts" how many times the game was started, when more than once (an
             entry with "test.attempts" whose game quit by itself); then
  "earlierAttempts"  why each attempt before the last failed, as short texts
  "perf"     what the player's diagnostics measured during the run, as the
             result has it ("measuredS", "fps", "fpsWorst", ..., "findings":
             the codes; docs/diagnostics.md), with the "browser" and the
             WebGL "renderer" it was measured in beside the numbers. Left out
             when the result has none (a player without diagnostics). It is
             a record: it has no part in "pass".

Games in the catalogue with no result are left out, and so are results for
games the catalogue does not have. It prints one line per game and then a
markdown table; --summary FILE also appends the table to FILE (the CI job
summary). --self-test checks how a "perf" block is taken over and needs no
results, and how the attempts of a result are taken over. The exit code is 0 whether games passed or not (each game's own job
reports that), and 1 when there is no result at all, unless --allow-empty.

  --commit   the commit the results are for (default: $GITHUB_SHA, else the
             commit the results themselves name when they agree)
"""
import argparse
import datetime
import json
import os
import re
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


# What a "perf" block may hold, so that a result file cannot put more into
# the published status than a few numbers and codes. A code and the number of
# codes are as in tools/web/gamecheck.mjs, which makes the block (PERF_CODE
# and PERF_FINDINGS there): change them together.
PERF_FIELDS = 24
PERF_FINDINGS = 32
PERF_CODE = re.compile(r"[a-z0-9-]{1,40}")
PERF_NAME = re.compile(r"[A-Za-z][A-Za-z0-9]{0,39}")
PERF_TEXT = 200
# Not numbers of the block: the codes, and what this script adds.
PERF_OWN = ("findings", "browser", "renderer")
# More attempts than this are not believed: a sanity limit well above what the
# catalogue allows (test.attempts in catalog/schema.json, MAX_ATTEMPTS in
# tools/web/gametest.mjs), so that raising that needs no change here. A reason
# is cut at ATTEMPT_TEXT characters.
ATTEMPTS = 10
ATTEMPT_TEXT = 300


def attempts_of(result):
    """(attempts, earlier reasons) of a result when it took more than one, else None."""
    count = result.get("attempts")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 < count <= ATTEMPTS:
        return None
    earlier = result.get("earlierAttempts")
    reasons = []
    for item in (earlier if isinstance(earlier, list) else [])[:count - 1]:
        error = item.get("error") if isinstance(item, dict) else None
        reasons.append(" ".join(error.split())[:ATTEMPT_TEXT] if isinstance(error, str) and error.strip() else "unknown")
    return count, reasons


def perf_block(result):
    """The "perf" block of a result as the status keeps it, or None.

    Every number of the block is passed on, whatever its name: which numbers
    there are is decided where they are read (perfFrom in
    tools/web/gamecheck.mjs). "findings" is kept as a list of codes, and the
    browser and renderer of the result are added, because the numbers say
    nothing without the machine they are from.
    """
    perf = result.get("perf")
    if not isinstance(perf, dict):
        return None
    block = {}
    for name, value in perf.items():
        if len(block) >= PERF_FIELDS:
            break
        # A bool is an int in Python; it is not a measurement. Neither is NaN,
        # an infinity or a number no JSON reader can hold.
        if name in PERF_OWN or not PERF_NAME.fullmatch(name) or isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if value == value and abs(value) <= 2 ** 53:
            block[name] = value
    findings = perf.get("findings")
    block["findings"] = [code for code in (findings if isinstance(findings, list) else []) if isinstance(code, str) and PERF_CODE.fullmatch(code)][:PERF_FINDINGS]
    for name in ("browser", "renderer"):
        if isinstance(result.get(name), str) and result[name]:
            block[name] = result[name][:PERF_TEXT]
    return block


def perf_words(perf):
    """A "perf" block in a few words, for the table."""
    if not perf:
        return ""
    words = []
    if "fps" in perf:
        words.append(f"{perf['fps']:g} fps" + (f" (worst {perf['fpsWorst']:g})" if "fpsWorst" in perf else ""))
    if perf["findings"]:
        words.append(", ".join(perf["findings"]))
    return "; ".join(words)


def self_test():
    perf = {"measuredS": 30, "fps": 18.4, "fpsWorst": 12, "heapMB": 201, "findings": ["software-rendering"]}
    result = {"slug": "x", "pass": True, "browser": "chrome-software", "renderer": "ANGLE (SwiftShader)", "perf": perf}
    kept = perf_block(result)
    assert kept == {**perf, "browser": "chrome-software", "renderer": "ANGLE (SwiftShader)"}, kept
    assert perf_words(kept) == "18.4 fps (worst 12); software-rendering", perf_words(kept)
    # A result without the block, or with something else in its place, has none.
    for other in ({}, {"perf": None}, {"perf": []}, {"perf": "fast"}, {"perf": 7}):
        assert perf_block(other) is None, other
    assert perf_words(None) == ""
    # Only numbers and codes pass; a renderer that is unknown is left out.
    odd = {"renderer": None, "browser": "", "perf": {"measuredS": 0, "fps": None, "ok": True, "note": "text", "nested": {"a": 1},
                                                    "huge": float("inf"), "nan": float("nan"), "long": 10 ** 400, "n" * 41: 1,
                                                    "not a name": 1, "browser": 7, "renderer": 7,
                                                    "findings": ["cpu-bound", 7, None, "x" * 41, {"code": "y"}, "<b>", "Not A Code", ""]}}
    assert perf_block(odd) == {"measuredS": 0, "findings": ["cpu-bound"]}, perf_block(odd)
    assert perf_words(perf_block(odd)) == "cpu-bound"
    assert perf_block({"perf": {"findings": "none"}}) == {"findings": []}
    assert perf_words({"findings": []}) == ""
    assert perf_words({"fps": 20.0, "findings": []}) == "20 fps"
    # Never more than a status file should carry.
    many = perf_block({"renderer": "r" * 1000, "perf": {**{f"n{i}": i for i in range(100)}, "findings": [f"code-{i}" for i in range(100)]}})
    assert len(many) == PERF_FIELDS + 2 and len(many["findings"]) == PERF_FINDINGS and len(many["renderer"]) == PERF_TEXT, many
    # What is kept survives strict JSON.
    json.dumps(kept, allow_nan=False)
    json.dumps(many, allow_nan=False)
    # Attempts: only a result that took more than one has them, and only texts pass.
    for one in ({}, {"attempts": 1}, {"attempts": True}, {"attempts": 0}, {"attempts": 11}, {"attempts": "2"}, {"attempts": 2.0}):
        assert attempts_of(one) is None, one
    two = {"attempts": 2, "earlierAttempts": [{"reached": "broken", "error": "the game ended (exited)\nwhile x", "seconds": 24}]}
    assert attempts_of(two) == (2, ["the game ended (exited) while x"]), attempts_of(two)
    odd_attempts = {"attempts": 3, "earlierAttempts": [{"error": 7}, "text", {"error": "e" * 1000}, {"error": "one too many"}]}
    assert attempts_of(odd_attempts) == (3, ["unknown", "unknown"]), attempts_of(odd_attempts)
    assert attempts_of({"attempts": 3, "earlierAttempts": [{"error": "e" * 1000}]}) == (3, ["e" * ATTEMPT_TEXT])
    assert attempts_of({"attempts": 2}) == (2, [])
    print("status.py self-test: ok")


def cell(text):
    """Text that cannot break a markdown table row."""
    return " ".join(str(text).split()).replace("|", "\\|")


def main():
    if "--self-test" in sys.argv[1:]:
        self_test()
        return
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0], epilog="--self-test checks how a perf block is taken over and needs no results")
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
        tries = attempts_of(result)
        if tries:
            game["attempts"], game["earlierAttempts"] = tries
        perf = perf_block(result)
        if perf is not None:
            game["perf"] = perf
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
        "| Game | Result | Expected | Reached | Seconds | Diagnostics | Note |",
        "|---|---|---|---|---|---|---|",
    ]
    for slug in sorted(games, key=lambda s: titles[s].lower()):
        game = games[slug]
        word = "PASS" if game["pass"] else "FAIL"
        reached = game["reached"] or "not run"
        note = game.get("error", "")
        if game.get("better"):
            note = f"better than listed ({game['expect']}); update the catalogue entry" + (f". {note}" if note else "")
        if game.get("attempts"):
            note = f"{game['attempts']} attempts" + (f" (before: {'; '.join(game['earlierAttempts'])})" if game["earlierAttempts"] else "") + (f". {note}" if note else "")
        seconds = "" if game["seconds"] is None else game["seconds"]
        print(f"{word}  {slug}  {reached}" + (f" (expected {game['expect']})" if game["expect"] else "") + (f"  {note}" if note else ""))
        table.append(f"| {cell(titles[slug])} | {word.lower() if game['pass'] else '**FAIL**'} | {game['expect'] or '–'} | {reached} | {seconds} | {cell(perf_words(game.get('perf')))[:300]} | {cell(note)[:300]} |")
    text = "\n".join(table) + "\n"
    print()
    print(text, end="")
    if args.summary:
        with open(args.summary, "a") as fh:
            fh.write(text)
    print(f"\nwrote {os.path.join(out, 'status.json')}: {len(games)} games, commit {commit or 'unknown'}", file=sys.stderr)


if __name__ == "__main__":
    main()
