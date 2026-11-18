#!/usr/bin/env python3
"""Pack an installed phone firmware into the zip the player installs as a device.

  python3 -I tools/devices/pack.py --data DIR [--code CODE] [--out FILE]
  python3 -I tools/devices/pack.py --self-test

--data is the data folder tools/devices/install.py installed a firmware into;
--code is the firmware code, the name of its folders there (e.g. rm-409). Without --code, the one device in the
folder's devices.yml is packed. The zip (default testdata/devices/<code>.zip of
the main checkout) holds the layout the fork's archive install calls a data
dump (loader::install_archive, POST /v1/devices {"archive": path}):

  data/roms/<code>/...       SYM.ROM, the firmware's ROM image
  data/drives/z/<code>/...   drive Z, unpacked from the ROFS images
  data/drives/c/...          drive C, only when the install put files there and
                             devices.yml lists no other device (drive C is shared)

devices.yml is left out: the archive install reads the device's name from
drive Z, as the firmware install did. The player's install ignores drive C
today; it is kept so the zip carries everything the firmware installed.

The zip is reproducible: entries sorted by path, no folder entries, a fixed
timestamp (2009-01-01) and mode, deflate at level 6. The same data folder
gives the same bytes with the same zlib (another zlib may compress differently). The script prints the zip's size and SHA-256.

Firmware is copyrighted: the data folder and the zip stay in testdata/ or
private/ and never enter the repository.
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATE = (2009, 1, 1, 0, 0, 0)
LEVEL = 6


def main_checkout():
    """The checkout that holds testdata/: this one, or the main one of a worktree."""
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


def installed_codes(data):
    """The firmware codes devices.yml lists (its top-level keys), less those marked for deletion."""
    path = os.path.join(data, "devices.yml")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as fh:
        blocks = re.split(r"^(?=[^\s#])", fh.read(), flags=re.M)
    return [m.group(1).strip().strip("'\"") for block in blocks
            if (m := re.match(r"([^:]*):\s*$", block, re.M))
            and not re.search(r"^\s+pending-deletion:\s*true\b", block, re.M)]


def walk(folder, prefix):
    """Map of path-in-zip -> file on disk for every file under folder."""
    files = {}
    for current, dirs, names in os.walk(folder):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(current, name)
            if not os.path.isfile(path):
                continue
            files[prefix + os.path.relpath(path, folder).replace(os.sep, "/")] = path
    return files


def collect(data, code):
    """Map of path-in-zip -> file on disk, in the archive install's layout."""
    rom = os.path.join(data, "roms", code)
    drive_z = os.path.join(data, "drives", "z", code)
    drive_c = os.path.join(data, "drives", "c")
    if not os.path.isfile(os.path.join(rom, "SYM.ROM")):
        raise ValueError(f"no roms/{code}/SYM.ROM in {data}")
    if not os.path.isdir(drive_z):
        raise ValueError(f"no drives/z/{code}/ in {data}")
    files = walk(rom, f"data/roms/{code}/")
    z_files = walk(drive_z, f"data/drives/z/{code}/")
    if not z_files:
        raise ValueError(f"drives/z/{code}/ in {data} is empty")
    files.update(z_files)
    c_files = walk(drive_c, "data/drives/c/") if os.path.isdir(drive_c) else {}
    others = [other for other in installed_codes(data) if other.lower() != code]
    if c_files and others:
        # Drive C is shared by the folder's devices: it is not this firmware's alone.
        print(f"pack.py: drive C left out, it is shared with {', '.join(others)}", file=sys.stderr)
    else:
        files.update(c_files)
    return files


def write_zip(files, target):
    """Write the zip atomically; same files, same bytes."""
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    partial = target + ".part"
    try:
        add_files(files, partial)
    except BaseException:
        if os.path.exists(partial):
            os.remove(partial)
        raise
    os.replace(partial, target)


def add_files(files, path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=LEVEL) as archive:
        for inside in sorted(files):
            info = zipfile.ZipInfo(inside, date_time=DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.file_size = os.path.getsize(files[inside])
            # A streamed entry takes its level from the ZipInfo, not from the ZipFile.
            try:
                info.compress_level = LEVEL
            except AttributeError:  # Python before 3.13
                info._compresslevel = LEVEL
            with open(files[inside], "rb") as source, archive.open(info, "w") as sink:
                shutil.copyfileobj(source, sink, 1 << 20)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def pack(data, code, target):
    files = collect(data, code)
    write_zip(files, target)
    return len(files)


def self_test():
    """Pack a small fake data folder twice and check the bytes and the layout."""
    with tempfile.TemporaryDirectory(prefix="devices-pack-test-") as tmp:
        def make(root, with_c, order):
            entries = {
                "roms/ab-1/SYM.ROM": b"rom" * 1000,
                "drives/z/ab-1/sys/bin/euser.dll": b"dll" * 500,
                "drives/z/ab-1/resource/apps/b.rsc": b"b",
                "drives/z/ab-1/resource/apps/a.rsc": b"a",
                "drives/z/other/ignored.txt": b"another device",
                "roms/other/SYM.ROM": b"another rom",
                "devices.yml": b"AB-1:\n  firmcode: AB-1\n",
            }
            if with_c:
                entries["drives/c/data/settings.ini"] = b"x=1\n"
            os.makedirs(os.path.join(root, "drives", "c"), exist_ok=True)
            for i, name in enumerate(sorted(entries, reverse=order)):
                path = os.path.join(root, name)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(entries[name])
                os.utime(path, (1_000_000 + i * 7919, 1_000_000 + i * 7919))
                os.chmod(path, 0o600 if i % 2 else 0o755)

        first, second, empty_c = (os.path.join(tmp, n) for n in ("one", "two", "three"))
        make(first, True, False)
        make(second, True, True)
        make(empty_c, False, False)
        assert installed_codes(first) == ["AB-1"], installed_codes(first)
        with open(os.path.join(empty_c, "devices.yml"), "w") as fh:
            fh.write("AB-1:\n  firmcode: AB-1\nOLD:\n  firmcode: OLD\n  pending-deletion: true\n")
        assert installed_codes(empty_c) == ["AB-1"], installed_codes(empty_c)
        zips = [os.path.join(tmp, n + ".zip") for n in ("one", "two", "three")]
        pack(first, "ab-1", zips[0])
        pack(second, "ab-1", zips[1])
        pack(empty_c, "ab-1", zips[2])
        assert sha256(zips[0]) == sha256(zips[1]), "same files gave different zips"
        with zipfile.ZipFile(zips[0]) as archive:
            names = archive.namelist()
            assert names == [
                "data/drives/c/data/settings.ini",
                "data/drives/z/ab-1/resource/apps/a.rsc",
                "data/drives/z/ab-1/resource/apps/b.rsc",
                "data/drives/z/ab-1/sys/bin/euser.dll",
                "data/roms/ab-1/SYM.ROM",
            ], names
            assert archive.read("data/roms/ab-1/SYM.ROM") == b"rom" * 1000
            assert archive.testzip() is None
            for info in archive.infolist():
                assert info.date_time == DATE and info.external_attr == 0o644 << 16, info
                assert info.compress_type == zipfile.ZIP_DEFLATED, info
        with zipfile.ZipFile(zips[2]) as archive:
            assert not any(n.startswith("data/drives/c/") for n in archive.namelist()), archive.namelist()
        try:
            pack(first, "missing", os.path.join(tmp, "missing.zip"))
        except ValueError:
            pass
        else:
            raise AssertionError("a missing device was packed")
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", help="the data folder the firmware was installed into")
    parser.add_argument("--code", help="the firmware code (default: the one device in devices.yml)")
    parser.add_argument("--out", help="the zip to write (default: testdata/devices/<code>.zip)")
    parser.add_argument("--self-test", action="store_true", help="check the packer on a fake data folder")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.data:
        parser.error("--data is required")
    data = os.path.abspath(args.data)
    code = args.code
    if not code:
        codes = installed_codes(data)
        if len(codes) != 1:
            parser.error(f"devices.yml in {data} lists {len(codes)} devices ({', '.join(codes) or 'none'}): "
                         "name one with --code")
        code = codes[0]
    # The installer names the folders after the lowercased code.
    code = code.lower()
    target = args.out or os.path.join(main_checkout(), "testdata", "devices", code + ".zip")
    try:
        count = pack(data, code, target)
    except (ValueError, OSError) as error:
        print(f"pack.py: {error}", file=sys.stderr)
        sys.exit(1)
    print(f"{target}: {count} files, {os.path.getsize(target)} bytes, sha256 {sha256(target)}")


if __name__ == "__main__":
    main()
