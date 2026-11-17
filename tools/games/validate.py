#!/usr/bin/env python3
"""Check every catalogue entry against catalog/schema.json and a few rules the
schema cannot express.

  python3 -I tools/games/validate.py [slug ...]        exit 1 when anything is wrong

Uses only the standard library, so it implements the part of JSON Schema the
catalogue schema uses (type, enum, pattern, required, properties,
additionalProperties, propertyNames, items, min/maxItems, minimum, $ref).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TYPES = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool, "null": type(None)}


def check(value, schema, root, where, errors):
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            target = target[part]
        return check(value, target, root, where, errors)
    if "type" in schema:
        allowed = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(isinstance(value, TYPES[t]) and not (t == "integer" and isinstance(value, bool)) for t in allowed):
            errors.append(f"{where}: expected {' or '.join(allowed)}")
            return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {value!r} is not one of {', '.join(map(str, schema['enum']))}")
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        errors.append(f"{where}: {value!r} does not match {schema['pattern']}")
    if isinstance(value, int) and not isinstance(value, bool) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{where}: {value} is below {schema['minimum']}")
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{where}: missing {name}")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if "propertyNames" in schema:
                check(name, schema["propertyNames"], root, f"{where} key", errors)
            if name in properties:
                check(item, properties[name], root, f"{where}.{name}", errors)
            elif extra is False:
                errors.append(f"{where}: unknown field {name}")
            elif isinstance(extra, dict):
                check(item, extra, root, f"{where}.{name}", errors)
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{where}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{where}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                check(item, schema["items"], root, f"{where}[{i}]", errors)


def main():
    with open(os.path.join(ROOT, "catalog", "schema.json")) as fh:
        schema = json.load(fh)
    folder = os.path.join(ROOT, "catalog", "games")
    slugs = sys.argv[1:] or sorted(name[:-5] for name in os.listdir(folder) if name.endswith(".json"))
    games = {}
    errors = []
    for slug in slugs:
        try:
            with open(os.path.join(folder, slug + ".json")) as fh:
                game = json.load(fh)
        except (OSError, ValueError) as error:
            errors.append(f"{slug}: {error}")
            continue
        games[slug] = game
        mine = []
        check(game, schema, schema, slug, mine)
        if game.get("slug") != slug:
            mine.append(f"{slug}: slug does not match the file name")
        status = game.get("status")
        if status in ("broken", "boots", "menu") and not game.get("statusNote"):
            mine.append(f"{slug}: status {status} needs a statusNote saying what happens")
        test = game.get("test")
        if test and status != "untested":
            order = ["broken", "boots", "menu", "ingame"]
            if status in order and order.index(test["expect"]) > order.index(status):
                mine.append(f"{slug}: test expects {test['expect']} but status is {status}")
        # The player cuts longer texts (LIMITS in the fork's shell/games.js).
        controls = game.get("controls") or {}
        texts = [("title", game.get("title"), 80), ("statusNote", game.get("statusNote"), 600), ("controls.source", controls.get("source"), 500)]
        texts += [(f"notes[{i}]", note, 600) for i, note in enumerate(game.get("notes") or [])]
        texts += [(f"controls.notes[{i}]", note, 600) for i, note in enumerate(controls.get("notes") or [])]
        texts += [(f"controls.actions.{key}", action, 120) for key, action in (controls.get("actions") or {}).items()]
        for name, value, limit in texts:
            if isinstance(value, str) and len(value) > limit:
                mine.append(f"{slug}.{name}: {len(value)} characters, the player shows {limit}")
        if test:
            for i, step in enumerate(test.get("script", [])):
                if isinstance(step, dict) and "key" not in step and "wait" not in step:
                    mine.append(f"{slug}.test.script[{i}]: a step needs a key or a wait")
        errors += mine
    all_slugs = {name[:-5] for name in os.listdir(folder) if name.endswith(".json")}
    for slug, game in games.items():
        if game.get("variantOf") and game["variantOf"] not in all_slugs:
            errors.append(f"{slug}: variantOf names an unknown game {game['variantOf']}")
    for error in errors:
        print(error, file=sys.stderr)
    print(f"{len(games)} entries checked, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
