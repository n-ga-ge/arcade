#!/usr/bin/env python3
"""Check every catalogue entry against catalog/schema.json and a few rules the
schema cannot express, and every enhancement profile in catalog/enhance/
against catalog/enhance.schema.json.

  python3 -I tools/games/validate.py [slug ...]        exit 1 when anything is wrong

Uses only the standard library, so it implements the part of JSON Schema the
catalogue schema uses (type, enum, pattern, required, properties,
additionalProperties, propertyNames, items, min/maxItems, uniqueItems, minimum,
maximum, maxLength, $ref).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TYPES = {"object": dict, "array": list, "string": str, "integer": int, "number": (int, float), "boolean": bool, "null": type(None)}


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
    if isinstance(value, str) and "maxLength" in schema and len(value) > schema["maxLength"]:
        errors.append(f"{where}: {len(value)} characters, at most {schema['maxLength']} are allowed")
    if isinstance(value, int) and not isinstance(value, bool) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{where}: {value} is below {schema['minimum']}")
    if isinstance(value, int) and not isinstance(value, bool) and "maximum" in schema and value > schema["maximum"]:
        errors.append(f"{where}: {value} is above {schema['maximum']}")
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
        if schema.get("uniqueItems"):
            for i, item in enumerate(value):
                if item in value[:i]:
                    errors.append(f"{where}[{i}]: {item!r} is listed more than once")
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
        multiplayer = game.get("multiplayer")
        if isinstance(multiplayer, dict):
            played = multiplayer.get("status")
            if played == "broken" and not multiplayer.get("statusNote"):
                mine.append(f"{slug}.multiplayer: status broken needs a statusNote saying what happens")
            # status and players are about Bluetooth play, so only a game with that mode has them.
            modes = multiplayer.get("modes")
            if isinstance(modes, list) and "bluetooth" not in modes:
                if played in ("broken", "connects", "plays"):
                    mine.append(f"{slug}.multiplayer: status {played} is about Bluetooth play, but modes has no bluetooth")
                if "players" in multiplayer:
                    mine.append(f"{slug}.multiplayer: players is the most over Bluetooth, but modes has no bluetooth")
        # A card dump and a .n-gage file are packed differently (tools/games/pack.py).
        pack = game.get("pack") if isinstance(game.get("pack"), dict) else {}
        if game.get("platform") == "ngage2":
            for name in sorted(set(pack) - {"file"}):
                mine.append(f"{slug}.pack.{name}: is for a card dump; an N-Gage 2.0 entry packs a .n-gage file and takes only pack.file")
        elif "file" in pack:
            mine.append(f"{slug}.pack.file: is for an N-Gage 2.0 entry (\"platform\": \"ngage2\")")
        test = game.get("test") if isinstance(game.get("test"), dict) else None
        if test and status != "untested":
            order = ["broken", "boots", "menu", "ingame"]
            if status in order and test.get("expect") in order and order.index(test["expect"]) > order.index(status):
                mine.append(f"{slug}: test expects {test['expect']} but status is {status}")
        # The player cuts longer texts (LIMITS in the fork's shell/games.js).
        controls = game.get("controls") or {}
        texts = [("title", game.get("title"), 80), ("statusNote", game.get("statusNote"), 600), ("controls.source", controls.get("source"), 500)]
        texts += [(f"notes[{i}]", note, 600) for i, note in enumerate(game.get("notes") or [])]
        texts += [(f"controls.notes[{i}]", note, 600) for i, note in enumerate(controls.get("notes") or [])]
        texts += [(f"controls.actions.{key}", action, 120) for key, action in (controls.get("actions") or {}).items()]
        if isinstance(game.get("enhance"), dict):
            texts.append(("enhance.note", game["enhance"].get("note"), 400))
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
        base = game.get("variantOf")
        if not isinstance(base, str) or not base:
            continue
        if base not in all_slugs:
            errors.append(f"{slug}: variantOf names an unknown game {base}")
            continue
        # A variant is the same program, so what is known of its multiplayer is the base game's.
        other = games.get(base)
        if other is None:
            try:
                with open(os.path.join(folder, base + ".json")) as fh:
                    other = json.load(fh)
            except (OSError, ValueError):
                continue  # reported when that entry is checked
        missing = object()
        if isinstance(other, dict) and game.get("multiplayer", missing) != other.get("multiplayer", missing):
            errors.append(f"{slug}: multiplayer differs from that of {base}, the game it is a variant of")
        if isinstance(other, dict) and game.get("platform", "ngage") != other.get("platform", "ngage"):
            errors.append(f"{slug}: platform differs from that of {base}, the game it is a variant of")
    # Enhancement profiles: each against its schema, and each entry's engine must have one.
    profiles_folder = os.path.join(ROOT, "catalog", "enhance")
    profile_names = sorted(name[:-5] for name in os.listdir(profiles_folder) if name.endswith(".json")) if os.path.isdir(profiles_folder) else []
    for slug, game in games.items():
        enhance = game.get("enhance")
        if isinstance(enhance, dict) and isinstance(enhance.get("engine"), str) and enhance["engine"] not in profile_names:
            errors.append(f"{slug}.enhance: there is no catalog/enhance/{enhance['engine']}.json")
    profiles = 0
    if not sys.argv[1:] and profile_names:
        with open(os.path.join(ROOT, "catalog", "enhance.schema.json")) as fh:
            profile_schema = json.load(fh)
        for name in profile_names:
            where = f"enhance/{name}"
            try:
                with open(os.path.join(profiles_folder, name + ".json")) as fh:
                    profile = json.load(fh)
            except (OSError, ValueError) as error:
                errors.append(f"{where}: {error}")
                continue
            profiles += 1
            check(profile, profile_schema, profile_schema, where, errors)
            if not isinstance(profile, dict):
                continue
            if profile.get("engine") != name:
                errors.append(f"{where}: engine does not match the file name")
            for image in profile.get("images") or []:
                if not isinstance(image, dict):
                    continue
                game = image.get("game")
                if isinstance(game, str) and game not in all_slugs:
                    errors.append(f"{where}: {image.get('name')} names an unknown game {game}")
                for hook in image.get("hooks") or []:
                    if not isinstance(hook, dict):
                        continue
                    at = f"{where}: {image.get('name')} at {hook.get('at')}"
                    # What each kind of hook needs, which the schema cannot say per kind.
                    kind = hook.get("do")
                    if kind == "draw" and "fields" not in hook:
                        errors.append(f"{at}: a draw needs fields")
                    if kind == "set" and "vars" not in hook:
                        errors.append(f"{at}: a set needs vars")
                    allowed = {"begin": {"target"}, "end": set(), "set": {"vars"},
                               "draw": {"mode", "count", "vertex", "fields", "texture", "blend", "depth"}}.get(kind, set())
                    for field in set(hook) - allowed - {"at", "do", "note", "when", "skip", "return"}:
                        errors.append(f"{at}: {field} means nothing on a {kind} hook")
                    texture = hook.get("texture")
                    if isinstance(texture, dict) and texture.get("format") in ("p8", "p4") and not ("palette" in texture and "paletteFormat" in texture):
                        errors.append(f"{at}: a {texture['format']} texture needs palette and paletteFormat")
                    if isinstance(texture, dict) and "paletteStride" in texture:
                        sizes = {"rgb444": 2, "argb4444": 2, "rgb565": 2, "rgb555": 2, "argb1555": 2,
                                 "rgb888": 3, "argb8888": 4, "xrgb8888": 4, "a8": 1, "l8": 1}
                        stride, size = texture["paletteStride"], sizes.get(texture.get("paletteFormat"))
                        if texture.get("format") not in ("p8", "p4") or size is None:
                            errors.append(f"{at}: paletteStride belongs to a p8 or p4 texture with a paletteFormat")
                        elif isinstance(stride, int) and stride < size:
                            errors.append(f"{at}: paletteStride {stride} is less than a {texture['paletteFormat']} entry ({size} bytes)")
                    rows = texture.get("paletteRows") if isinstance(texture, dict) else None
                    if isinstance(texture, dict) and texture.get("format") not in ("p8", "p4") and (
                            "paletteRows" in texture or "paletteRowStride" in texture):
                        errors.append(f"{at}: paletteRows and paletteRowStride belong to a p8 or p4 texture")
                    if isinstance(texture, dict) and "paletteRowStride" in texture and "paletteRows" not in texture:
                        errors.append(f"{at}: paletteRowStride needs paletteRows")
                    fields = hook.get("fields")
                    if isinstance(fields, dict) and "row" in fields and not rows:
                        errors.append(f"{at}: fields.row needs a texture with paletteRows")
    for error in errors:
        print(error, file=sys.stderr)
    print(f"{len(games)} entries" + (f" and {profiles} enhancement profiles" if profiles else "") + f" checked, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
