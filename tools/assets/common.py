"""What upload.py and fetch.py share: where things are, the manifest, hashing.

The asset manifest (catalog/assets.json) lists the firmware and every game zip
with its size and SHA-256:

  { "fw": {"bytes": N, "sha256": "..."}, "games": { "<slug>": {"bytes": N, "sha256": "..."} } }

It holds no game data. The object keys in the bucket are the paths below
/assets/ on the site: NGAGE.ROM and games/<slug>.zip.
"""
import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MANIFEST = os.path.join(ROOT, "catalog", "assets.json")
FW = "fw"
FW_KEY = "NGAGE.ROM"


def main_checkout():
    """The checkout that holds private/, games/ and testdata/: this one, or the main one of a worktree."""
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


def catalogue_slugs():
    folder = os.path.join(ROOT, "catalog", "games")
    return sorted(name[:-5] for name in os.listdir(folder) if name.endswith(".json"))


def object_key(name):
    """Bucket key, and path below /assets/, of the firmware ("fw") or of a game."""
    return FW_KEY if name == FW else f"games/{name}.zip"


def valid_entry(value):
    return isinstance(value, dict) and type(value.get("bytes")) is int and bool(re.fullmatch("[0-9a-f]{64}", str(value.get("sha256"))))


def entry(manifest, name):
    """The manifest's {"bytes", "sha256"} for the firmware or a game; None when it is missing or malformed."""
    found = manifest.get("fw") if name == FW else manifest.get("games", {}).get(name)
    return found if valid_entry(found) else None


def load_manifest(path=MANIFEST):
    with open(path) as fh:
        manifest = json.load(fh)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("games"), dict):
        raise ValueError(f"{path} is not an asset manifest")
    return manifest


def write_manifest(manifest, path=MANIFEST):
    """One line per file, so a changed game is a one-line diff."""
    lines = ["{", f'  "fw": {json.dumps(manifest["fw"])},', '  "games": {']
    games = sorted(manifest["games"].items())
    for index, (slug, value) in enumerate(games):
        lines.append(f"    {json.dumps(slug)}: {json.dumps(value)}" + ("," if index + 1 < len(games) else ""))
    lines += ["  }", "}"]
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")


def digest(path, *algorithms):
    """Size and hex digests of a file, read once."""
    hashers = [hashlib.new(name) for name in algorithms]
    size = 0
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            size += len(block)
            for hasher in hashers:
                hasher.update(block)
    return (size, *(hasher.hexdigest() for hasher in hashers))


def megabytes(size):
    return f"{size / 1e6:6.1f} MB"
