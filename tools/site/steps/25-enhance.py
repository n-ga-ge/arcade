#!/usr/bin/env python3
"""Site build step: publish the enhancement profiles as /catalog/enhance/<engine>.json.

  python3 -I 25-enhance.py <output folder>      (run by tools/site/build.py)

A game's catalogue entry names its profile ("enhance": { "engine": ... }); the
player fetches /catalog/enhance/<engine>.json and hands it to the emulator as
it is (docs/enhancements.md). Every profile in catalog/enhance/ is published,
named in an entry or not: a profile holds addresses, hashes and notes, and no
part of a game.

The build stops when a profile cannot be read, when its "engine" is not its
file name (the player refuses such a profile), or when an entry names an
engine that has no profile. tools/games/validate.py checks the profiles
against their schema; this step only makes sure the site is whole.
"""
import json
import os
import sys

ROOT = os.environ.get("ARCADE_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    out = sys.argv[1]
    source = os.path.join(ROOT, "catalog", "enhance")
    names = sorted(name for name in os.listdir(source) if name.endswith(".json")) if os.path.isdir(source) else []

    engines = set()
    for name in names:
        engine = name[:-len(".json")]
        try:
            profile = load(os.path.join(source, name))
        except (OSError, ValueError) as error:
            sys.exit(f"catalog/enhance/{name} cannot be read: {error}")
        if not isinstance(profile, dict) or profile.get("engine") != engine or not isinstance(profile.get("images"), list):
            sys.exit(f"catalog/enhance/{name}: not a profile of the engine \"{engine}\" (its \"engine\" must be the file's name, and it needs \"images\")")
        target = os.path.join(out, "catalog", "enhance")
        os.makedirs(target, exist_ok=True)
        with open(os.path.join(target, name), "w", encoding="utf-8") as fh:
            json.dump(profile, fh, separators=(",", ":"), ensure_ascii=False)
            fh.write("\n")
        engines.add(engine)

    games = os.path.join(ROOT, "catalog", "games")
    for name in sorted(os.listdir(games)):
        if not name.endswith(".json"):
            continue
        enhance = load(os.path.join(games, name)).get("enhance")
        if isinstance(enhance, dict) and enhance.get("engine") not in engines:
            sys.exit(f"catalog/games/{name} names the enhancement profile \"{enhance.get('engine')}\", and there is no catalog/enhance/{enhance.get('engine')}.json")


if __name__ == "__main__":
    main()
