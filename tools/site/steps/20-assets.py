#!/usr/bin/env python3
"""Site build step: publish the asset manifest as /catalog/assets.json.

  python3 -I 20-assets.py <output folder>      (run by tools/site/build.py)

catalog/assets.json lists the firmware and every game zip with its size and
SHA-256, and nothing of their content. The player uses the hashes as cache
keys. A catalogue game that is missing from the manifest is reported but does
not stop the build: the site still works, and that game's CI job fails at
tools/assets/fetch.py, which is where the fix (upload.py --write-manifest) is
described.
"""
import json
import os
import sys

ROOT = os.environ.get("ARCADE_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.dont_write_bytecode = True  # no __pycache__ in the checkout
sys.path.insert(0, os.path.join(ROOT, "tools", "assets"))  # the manifest's rules live with the scripts that write it
import common  # noqa: E402


def main():
    out = sys.argv[1]
    try:
        manifest = common.load_manifest()
    except (OSError, ValueError) as error:
        sys.exit(f"no usable catalog/assets.json ({error}): run python3 -I tools/assets/upload.py --write-manifest")
    if not common.entry(manifest, common.FW):
        sys.exit("catalog/assets.json has no firmware entry: run python3 -I tools/assets/upload.py --write-manifest")
    missing = [slug for slug in common.catalogue_slugs() if not common.entry(manifest, slug)]
    if missing:
        print("WARNING: catalog/assets.json has no entry for: " + ", ".join(missing)
              + "\n  run python3 -I tools/assets/upload.py --write-manifest and commit the result", file=sys.stderr)
    os.makedirs(os.path.join(out, "catalog"), exist_ok=True)
    with open(os.path.join(out, "catalog", "assets.json"), "w") as fh:
        json.dump(manifest, fh, separators=(",", ":"))
        fh.write("\n")


if __name__ == "__main__":
    main()
