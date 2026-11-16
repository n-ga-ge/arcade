#!/usr/bin/env python3
"""Put the firmware and the game zips into the private R2 bucket and keep them in sync.

  python3 -I tools/assets/upload.py [options]

  (no mode)          pack the zips that are missing, check them against
                     catalog/assets.json, create the bucket if there is none,
                     upload what differs from the bucket
  --dry-run          the same, but nothing in the bucket is created, uploaded
                     or removed (and --write-manifest only says what would change)
  --verify           check the bucket against catalog/assets.json: every object
                     present with the right size and recorded SHA-256. Needs no
                     local files. With --download each object is also fetched
                     and hashed (about 900 MB in all).
  --write-manifest   pack again from the dumps and hash, then rewrite
                     catalog/assets.json. Needs no credentials and does not
                     touch the bucket.

  --only NAME ...    limit the run to these games (catalogue slugs) and/or "fw"
  --prune            also remove objects that are not in the catalogue
  --force            upload even what the bucket already has
  --repack           pack the zips again even when they exist (an upload
                     otherwise trusts a zip that is already there; the workflow
                     always starts without any)
  --games DIR        folder of dumps (default: private/games/, else games/)
  --fw FILE          the firmware (default: private/firmware/NGAGE.ROM, else
                     testdata/NGAGE.ROM, else NGAGE.ROM)
  --out DIR          where the zips are packed (default: testdata/games/)
  --bucket NAME      default $R2_BUCKET, else n-ga-ge-assets
  --manifest FILE    default catalog/assets.json

Object keys are the paths below /assets/ on the site: NGAGE.ROM and
games/<slug>.zip. Each object carries its SHA-256 as metadata ("sha256"), which
is how a later run knows it is unchanged without downloading it.

The manifest is committed in this repository, but the upload usually runs from
the private repository's workflow, which cannot commit here. So the upload
refuses to start when what it packed differs from the manifest: whoever changes
a dump, a catalogue "pack" option or the firmware runs --write-manifest and
commits the result first.

Credentials come from the environment only (see s3.py): CLOUDFLARE_API_TOKEN
and CLOUDFLARE_ACCOUNT_ID, or R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.
Exits 1 on any failure. Prints file names, sizes and hashes, nothing else.
"""
import argparse
import os
import zlib
import subprocess
import sys

sys.dont_write_bytecode = True  # no __pycache__ in the checkout
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
import common  # noqa: E402
import s3  # noqa: E402

PACK = os.path.join(common.ROOT, "tools", "games", "pack.py")


def first_existing(*paths):
    return next((path for path in paths if os.path.exists(path)), paths[0])


def parse_args():
    main = common.main_checkout()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, usage="upload.py [options]")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--only", nargs="+", metavar="NAME")
    parser.add_argument("--prune", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--repack", action="store_true")
    parser.add_argument("--games", default=first_existing(os.path.join(main, "private", "games"), os.path.join(main, "games")))
    parser.add_argument("--fw", default=first_existing(os.path.join(main, "private", "firmware", "NGAGE.ROM"),
                                                       os.path.join(main, "testdata", "NGAGE.ROM"), os.path.join(main, "NGAGE.ROM")))
    parser.add_argument("--out", default=os.path.join(main, "testdata", "games"))
    parser.add_argument("--bucket", default=os.environ.get("R2_BUCKET") or "n-ga-ge-assets")
    parser.add_argument("--manifest", default=common.MANIFEST)
    args = parser.parse_args()
    if args.download and not args.verify:
        parser.error("--download goes with --verify")
    if args.prune and args.only:
        parser.error("--prune looks at the whole bucket: leave out --only")
    if args.prune and (args.verify or args.write_manifest):
        parser.error("--prune goes with an upload (or --dry-run)")
    return args


def pack(args, slugs):
    """Pack the selected games that have no zip yet. With --repack, and for a new manifest, every
    selected game is packed again, so that a zip left from an older dump is not taken for the
    current one (pack.py keeps the zip of a game whose dump is not here). True when pack.py succeeded."""
    again = args.repack or args.write_manifest
    wanted = [slug for slug in slugs if again or not os.path.exists(os.path.join(args.out, slug + ".zip"))]
    if not wanted:
        return True
    print(f"packing {len(wanted)} game(s) from {args.games}", flush=True)
    command = [sys.executable, "-I", PACK, "--games", args.games, "--out", args.out] + (["--force"] if again else []) + wanted
    return subprocess.run(command).returncode == 0


def local_files(args, names):
    """{name: {path, bytes, sha256, md5}} for the selected files, and the names whose file is missing."""
    found, missing = {}, []
    for name in names:
        path = args.fw if name == common.FW else os.path.join(args.out, name + ".zip")
        if not os.path.isfile(path):
            missing.append(f"{common.object_key(name)}: no file at {path}")
            continue
        size, sha256, md5 = common.digest(path, "sha256", "md5")
        found[name] = {"path": path, "bytes": size, "sha256": sha256, "md5": md5}
    return found, missing


def manifest_problems(manifest, names, slugs, whole, local=None):
    """What stops the manifest from describing the catalogue (and the local files, when given)."""
    problems = []
    for name in names:
        listed = common.entry(manifest, name)
        if listed is None:
            problems.append(f"{common.object_key(name)}: not in the manifest (an entry is {{\"bytes\": N, \"sha256\": \"<hex>\"}})")
        elif local and name in local and (listed.get("bytes"), listed.get("sha256")) != (local[name]["bytes"], local[name]["sha256"]):
            problems.append(f"{common.object_key(name)}: the manifest has {listed.get('bytes')} bytes sha256 {listed.get('sha256')},\n"
                            f"    this build has {local[name]['bytes']} bytes sha256 {local[name]['sha256']}")
    if whole:
        problems += [f"games/{slug}.zip: in the manifest but not in the catalogue" for slug in sorted(set(manifest.get("games", {})) - set(slugs))]
    return problems


def write_manifest(args, names, slugs, local):
    try:
        manifest = common.load_manifest(args.manifest)
    except (OSError, ValueError):
        manifest = {"fw": None, "games": {}}
    before = {name: common.entry(manifest, name) for name in [common.FW, *manifest["games"]]}
    for name, file in local.items():
        value = {"bytes": file["bytes"], "sha256": file["sha256"]}
        if name == common.FW:
            manifest["fw"] = value
        else:
            manifest["games"][name] = value
    if not args.only:  # a whole run also drops what left the catalogue
        manifest["games"] = {slug: value for slug, value in manifest["games"].items() if slug in slugs}
    if not manifest.get("fw"):
        print("the manifest has no firmware entry yet: run without --only, or with --only fw", file=sys.stderr)
        return 1
    after = {name: common.entry(manifest, name) for name in [common.FW, *manifest["games"]]}
    for name in sorted(set(before) | set(after)):
        if before.get(name) != after.get(name):
            state = "removed" if name not in after else "added" if not before.get(name) else "changed"
            print(f"{common.object_key(name):44} {state}")
    changed = sum(before.get(name) != after.get(name) for name in set(before) | set(after))
    if not args.dry_run:
        common.write_manifest(manifest, args.manifest)
    print(f"{'would write' if args.dry_run else 'wrote'} {args.manifest}: firmware and {len(manifest['games'])} games, {changed} changed")
    return 0


def report(key, size, text):
    print(f"{key:44} {common.megabytes(size) if size is not None else '':>9}  {text}", flush=True)


def extras(client, args, slugs, failures):
    """Report objects that belong to no catalogue entry, and remove them with --prune."""
    expected = {common.object_key(name) for name in [common.FW, *slugs]}
    removed = 0
    for key, size in sorted(client.list(args.bucket).items()):
        if key in expected:
            continue
        if not args.prune:
            report(key, size, "not in the catalogue (--prune removes it)")
        elif args.dry_run:
            report(key, size, "would remove")
            removed += 1
        else:
            try:
                client.delete(args.bucket, key)
                report(key, size, "removed")
                removed += 1
            except s3.S3Error as error:
                failures.append(f"{key}: remove failed, {error}")
                report(key, size, f"FAILED to remove: {error}")
    return removed


def verify(client, args, names, manifest, slugs):
    failures, wrong = [], 0
    if not client.bucket_exists(args.bucket):
        print(f"bucket {args.bucket} does not exist", file=sys.stderr)
        return 1
    for name in names:
        key, listed = common.object_key(name), common.entry(manifest, name)
        try:
            remote = client.head(args.bucket, key)
            if remote is None:
                problem = "MISSING from the bucket"
            elif remote["bytes"] != listed["bytes"]:
                problem = f"WRONG SIZE: {remote['bytes']} bytes in the bucket, {listed['bytes']} in the manifest"
            elif remote["sha256"] != listed["sha256"]:
                problem = f"WRONG HASH recorded: {remote['sha256'] or 'none'}, the manifest has {listed['sha256']}"
            elif args.download and (content := client.get_digest(args.bucket, key)) != (listed["bytes"], listed["sha256"]):
                problem = f"WRONG CONTENT: downloaded {content[0]} bytes sha256 {content[1]}"
            else:
                problem = None
        except s3.S3Error as error:
            problem = f"FAILED: {error}"
        wrong += bool(problem)
        report(key, listed["bytes"], problem or ("ok, content hashed" if args.download else "ok"))
    try:
        extras(client, args, slugs, failures)
    except s3.S3Error as error:
        failures.append(f"list: {error}")
        print(f"could not list the bucket: {error}", file=sys.stderr)
    print(f"{args.bucket}: {len(names) - wrong} of {len(names)} objects match the manifest" + (f", {wrong + len(failures)} PROBLEM(S)" if wrong or failures else ""))
    return 1 if wrong or failures else 0


def upload(client, args, names, local, slugs):
    counts = {"unchanged": 0, "uploaded": 0}
    failures = []
    would = "would upload" if args.dry_run else "uploaded"
    exists = client.bucket_exists(args.bucket)
    if not exists:
        print(f"bucket {args.bucket} does not exist: " + ("would create it" if args.dry_run else "creating it"), flush=True)
        if not args.dry_run:
            client.create_bucket(args.bucket)
            exists = True
    for name in names:
        key, file = common.object_key(name), local[name]
        try:
            remote = client.head(args.bucket, key) if exists else None
            same = remote and (remote["bytes"], remote["sha256"]) == (file["bytes"], file["sha256"])
            if same and not args.force:
                counts["unchanged"] += 1
                report(key, file["bytes"], "unchanged")
                continue
            if not args.dry_run:
                client.put(args.bucket, key, file["path"], file["sha256"], file["md5"], "application/zip" if key.endswith(".zip") else "application/octet-stream")
            counts["uploaded"] += 1
            report(key, file["bytes"], f"{would} ({'forced' if same else 'differs from the bucket' if remote else 'not in the bucket'})")
        except s3.S3Error as error:
            failures.append(f"{key}: {error}")
            report(key, file["bytes"], f"FAILED: {error}")
    removed = 0
    if exists:
        try:
            removed = extras(client, args, slugs, failures)
        except s3.S3Error as error:
            failures.append(f"list: {error}")
            print(f"could not list the bucket: {error}", file=sys.stderr)
    print(f"{args.bucket}: {counts['unchanged']} unchanged, {counts['uploaded']} {would}"
          + (f", {removed} {'would be removed' if args.dry_run else 'removed'}" if args.prune else "") + (f", {len(failures)} FAILED" if failures else ""))
    return 1 if failures else 0


def main():
    args = parse_args()
    slugs = common.catalogue_slugs()
    names = args.only or [common.FW, *slugs]
    unknown = [name for name in names if name != common.FW and name not in slugs]
    if unknown:
        print("not in the catalogue: " + ", ".join(unknown), file=sys.stderr)
        return 1
    names = [name for name in [common.FW, *slugs] if name in names]  # firmware first, then by slug

    if args.verify:
        try:
            manifest = common.load_manifest(args.manifest)
        except (OSError, ValueError) as error:
            print(f"no usable manifest: {error}", file=sys.stderr)
            return 1
        problems = manifest_problems(manifest, names, slugs, not args.only)
        if problems:
            print(f"{args.manifest} does not describe the catalogue:\n  " + "\n  ".join(problems), file=sys.stderr)
            return 1
        return verify(s3.Client.from_env(), args, names, manifest, slugs)

    os.makedirs(args.out, exist_ok=True)
    packed = pack(args, [name for name in names if name != common.FW])
    local, missing = local_files(args, names)
    if missing or not packed:
        print("cannot continue, files are missing or could not be packed:\n  " + "\n  ".join(missing or ["see the pack errors above"]), file=sys.stderr)
        return 1
    if args.write_manifest:
        return write_manifest(args, names, slugs, local)

    try:
        manifest = common.load_manifest(args.manifest)
    except (OSError, ValueError) as error:
        print(f"no usable manifest ({error}): run upload.py --write-manifest and commit it", file=sys.stderr)
        return 1
    problems = manifest_problems(manifest, names, slugs, not args.only, local)
    if problems:
        print(f"REFUSING TO UPLOAD: the files built here are not the ones {args.manifest} describes.\n  " + "\n  ".join(problems)
              + "\nThe site and CI trust that manifest. If the files are right, run\n"
                "  python3 -I tools/assets/upload.py --write-manifest\n"
                "in the arcade repository, commit catalog/assets.json there, and upload again.\n"
                f"(Zips were packed with zlib {zlib.ZLIB_RUNTIME_VERSION}. If every zip differs although no dump changed, the\n"
                "manifest was made with a zlib that compresses differently: see tools/assets/README.md.)", file=sys.stderr)
        return 1

    try:
        client = s3.Client.from_env()
    except s3.NoCredentials as error:  # a token that is set but refused still fails a dry run
        if not args.dry_run:
            raise
        for name in names:
            report(common.object_key(name), local[name]["bytes"], "matches the manifest")
        print(f"dry run without credentials ({error}): {len(names)} local files match the manifest, the bucket was not looked at")
        return 0
    return upload(client, args, names, local, slugs)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (s3.CredentialsError, s3.S3Error) as error:
        print(f"upload.py: {error}", file=sys.stderr)
        sys.exit(1)
