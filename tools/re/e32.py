#!/usr/bin/env python3
"""Read an EKA1 E32 image (a game's .app, .exe or .dll) for reverse engineering.

    python3 -I tools/re/e32.py info FILE             header, sections, the emulator's hash of the code
    python3 -I tools/re/e32.py imports FILE          imported libraries, ordinals and their thunks
    python3 -I tools/re/e32.py dis FILE AT [LENGTH]  disassemble from an offset (default 0x100 bytes)
    python3 -I tools/re/e32.py func FILE AT          disassemble the function around an offset
    python3 -I tools/re/e32.py callers FILE AT       the BL instructions that call an offset
    python3 -I tools/re/e32.py refs FILE AT          literal words that point at an offset
    python3 -I tools/re/e32.py find FILE --hex 00e0a0e1 | --word 0xB0D0 | --text Draw

Every offset this tool prints or takes is from the start of the code section,
which is what an enhancement profile's `at` and a debug hook's `at` mean too.
The image links its code at `codeBase` (0x10000000 for an application), so an
absolute pointer inside the file is codeBase + offset; at run time the code is
somewhere else (`GET /v1/debug/codesegs` says where).

A FILE may be a path, or SLUG:NAME to take the file called NAME (any letter
case) from that game's dump, e.g. `stuntcar-extreme:sce.app`.

Nothing this prints may be committed: addresses, hashes and what a function
does in your own words are fine, listings are not.
"""
import argparse
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def main_checkout():
    """The checkout that holds the dumps and the toolchain (see tools/env.sh)."""
    explicit = os.environ.get('ARCADE_MAIN')
    if explicit:
        return Path(explicit)
    git = ROOT / '.git'
    if git.is_file():
        # A worktree: .git is a file naming <main>/.git/worktrees/<name>.
        target = git.read_text().split(':', 1)[1].strip()
        return Path(target).parents[2]
    return ROOT


def xxh32(data, seed):
    """XXH32, as the emulator hashes a code segment (kernel/src/codeseg.cpp)."""
    p1, p2, p3, p4, p5 = 2654435761, 2246822519, 3266489917, 668265263, 374761393
    mask = 0xFFFFFFFF

    def rotl(x, r):
        return ((x << r) | (x >> (32 - r))) & mask

    n = len(data)
    i = 0
    if n >= 16:
        v = [(seed + p1 + p2) & mask, (seed + p2) & mask, seed & mask, (seed - p1) & mask]
        words = struct.unpack_from('<%dI' % (n // 16 * 4), data, 0)
        for w in range(0, len(words), 4):
            for k in range(4):
                v[k] = (rotl((v[k] + words[w + k] * p2) & mask, 13) * p1) & mask
        i = n // 16 * 16
        h = (rotl(v[0], 1) + rotl(v[1], 7) + rotl(v[2], 12) + rotl(v[3], 18)) & mask
    else:
        h = (seed + p5) & mask
    h = (h + n) & mask
    while i + 4 <= n:
        h = (rotl((h + struct.unpack_from('<I', data, i)[0] * p3) & mask, 17) * p4) & mask
        i += 4
    while i < n:
        h = (rotl((h + data[i] * p5) & mask, 11) * p1) & mask
        i += 1
    h ^= h >> 15
    h = (h * p2) & mask
    h ^= h >> 13
    h = (h * p3) & mask
    h ^= h >> 16
    return h


HEADER = ('uid1 uid2 uid3 check signature cpu checksum_code checksum_data version time_lo time_hi flags '
          'code_size data_size heap_min heap_max stack_size bss_size entry_point code_base data_base '
          'dll_count export_offset export_count text_size code_offset data_offset import_offset '
          'code_reloc_offset data_reloc_offset').split()


class Image:
    """An uncompressed EKA1 image. Every dump in this catalogue is one."""

    def __init__(self, path):
        self.path = Path(path)
        self.raw = self.path.read_bytes()
        if len(self.raw) < 0x7C or self.raw[0x10:0x14] != b'EPOC':
            raise SystemExit(f'{path}: not an E32 image')
        self.h = dict(zip(HEADER, struct.unpack_from('<30I', self.raw, 0)))
        if self.h['cpu'] not in (0x1000, 0x2000):
            raise SystemExit(f'{path}: not an EKA1 ARM image (cpu {self.h["cpu"]:#x})')
        if self.h['flags'] & 0x0F000000 and self.raw[0x1C:0x20] != b'\0\0\0\0':
            raise SystemExit(f'{path}: compressed images are not supported')
        start = self.h['code_offset']
        self.code = self.raw[start:start + self.h['code_size']]
        self.base = self.h['code_base']
        self.text_size = self.h['text_size']

    @property
    def hash(self):
        return xxh32(self.code, 0x5B001101)

    def word(self, offset):
        return struct.unpack_from('<I', self.code, offset)[0]

    def imports(self):
        """[(library, [(ordinal, slot offset)])]: the import address table follows the text."""
        out = []
        at = self.h['import_offset']
        if not self.h['dll_count']:
            return out
        position = at + 4
        slot = self.text_size
        for _ in range(self.h['dll_count']):
            name_offset, count = struct.unpack_from('<II', self.raw, position)
            name = self.raw[at + name_offset:at + name_offset + 96].split(b'\0')[0].decode('latin1')
            ordinals = struct.unpack_from('<%dI' % count, self.raw, position + 8)
            out.append((name, [(ordinal, slot + 4 * n) for n, ordinal in enumerate(ordinals)]))
            slot += 4 * count
            position += 8 + 4 * count
        return out

    def exports(self):
        return list(struct.unpack_from('<%dI' % self.h['export_count'], self.raw, self.h['export_offset']))

    def relocations(self):
        """Offsets in the code section of words the loader adds the load address to."""
        at = self.h['code_reloc_offset']
        out = []
        if not at:
            return out
        size, count = struct.unpack_from('<II', self.raw, at)
        position, end = at + 8, at + 8 + size
        while position + 8 <= end and position + 8 <= len(self.raw):
            page, block = struct.unpack_from('<II', self.raw, position)
            if block < 8:
                break
            for entry in struct.unpack_from('<%dH' % ((block - 8) // 2), self.raw, position + 8):
                if entry >> 12:
                    out.append(page + (entry & 0xFFF))
            position += block
        return out

    def thunks(self):
        """{offset of an import thunk: 'LIBRARY@ordinal'}.

        A call to another library goes through a three-word stub in the text
        whose last word is the address of the import's slot.
        """
        slots = {}
        for name, entries in self.imports():
            short = name.split('[')[0].split('.')[0].upper()
            for ordinal, slot in entries:
                slots[self.base + slot] = f'{short}@{ordinal}'
        found = {}
        for offset in range(0, self.text_size - 3, 4):
            target = slots.get(self.word(offset))
            if target and offset >= 8:
                found[offset - 8] = target
        return found


def locate(spec):
    """A path, or SLUG:NAME looked up in that game's dump."""
    if os.path.exists(spec) or ':' not in spec:
        return spec
    slug, name = spec.split(':', 1)
    main = main_checkout()
    entry = json.loads((ROOT / 'catalog' / 'games' / f'{slug}.json').read_text())
    for games in (main / 'private' / 'games', main / 'games'):
        dump = games / entry['dump']
        if dump.is_dir():
            matches = [p for p in dump.rglob('*') if p.is_file() and p.name.lower() == name.lower()]
            if matches:
                return str(matches[0])
    raise SystemExit(f'no file called {name} in the dump of {slug}')


def objdump_tool(name):
    path = main_checkout() / '.toolchain' / 'armcc' / 'bin' / name
    if not path.exists():
        raise SystemExit(f'{path} is missing: the ARM tools come with the toolchain (.toolchain/armcc)')
    return str(path)


LINE = re.compile(r'^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2,8}\s)+)\s*(.*)$')
NOISE = re.compile(r'\s*<_binary_[^>]*>')
TARGET = re.compile(r'\b(bl?[a-z]{0,2}|blx)\s+0x([0-9a-f]+)')


def disassemble(image, start, length, thumb=False):
    """[(offset, raw word, text)] for a stretch of the code section."""
    start &= ~1 if thumb else ~3
    length = max(4, min(length, len(image.code) - start))
    with tempfile.TemporaryDirectory(prefix='e32-') as scratch:
        # Short fixed names: llvm-objcopy makes symbols out of the path.
        raw, obj = os.path.join(scratch, 'c'), os.path.join(scratch, 'o')
        with open(raw, 'wb') as out:
            out.write(image.code[start:start + length])
        subprocess.run([objdump_tool('llvm-objcopy'), '-I', 'binary', '-O', 'elf32-littlearm',
                        '--rename-section', '.data=.text,code', raw, obj], check=True)
        text = subprocess.run([objdump_tool('llvm-objdump'), '-d', '--triple=' + ('thumbv5te' if thumb else 'armv5te'), obj],
                              check=True, capture_output=True, text=True).stdout
    thunks = image.thunks()
    out = []
    for line in text.splitlines():
        match = LINE.match(line)
        if not match:
            continue
        offset = start + int(match.group(1), 16)
        body = NOISE.sub('', match.group(3)).replace('\t', ' ')
        body = re.sub(r'\s*@ imm = #-?0x[0-9a-f]+', '', body)

        def absolute(m):
            target = start + int(m.group(2), 16)
            label = f' <{thunks[target]}>' if target in thunks else ''
            return f'{m.group(1)} {target:#x}{label}'

        body = TARGET.sub(absolute, body)
        if '[pc, #' in body:
            literal = re.search(r'@ (0x[0-9a-f]+)', body)
            if literal:
                where = start + int(literal.group(1), 16)
                body = re.sub(r'\s*@ 0x[0-9a-f]+.*$', '', body)
                if 0 <= where <= len(image.code) - 4:
                    value = image.word(where)
                    inside = image.base <= value < image.base + len(image.code)
                    body += f'   ; [{where:#x}] = {value:#x}' + (f' (code+{value - image.base:#x})' if inside else '')
        out.append((offset, match.group(2).split()[0], body))
    return out


PUSH = re.compile(r'^(push|stmdb\s+sp!|stmfd\s+sp!)')


def function_bounds(image, at):
    """A guess at the function around an offset: back to the nearest push of lr, on to the next one."""
    at &= ~3
    start = at
    while start > 0:
        word = image.word(start)
        # stmdb sp!, {..., lr}: the usual first instruction of an ARM function.
        if word & 0xFFFF4000 == 0xE92D4000:
            break
        start -= 4
    end = at + 4
    while end < image.text_size:
        if image.word(end) & 0xFFFF4000 == 0xE92D4000:
            break
        end += 4
    return start, end


def callers(image, at):
    """Offsets of ARM `bl` instructions whose target is this offset."""
    at &= ~3
    out = []
    for offset in range(0, image.text_size - 3, 4):
        word = image.word(offset)
        if word & 0x0F000000 == 0x0B000000:
            displacement = word & 0x00FFFFFF
            if displacement & 0x00800000:
                displacement -= 0x01000000
            if offset + 8 + displacement * 4 == at:
                out.append(offset)
    return out


def refs(image, at):
    """Offsets of words that hold the linked address of this offset (function pointers, vtables)."""
    wanted = image.base + at
    return [offset for offset in range(0, len(image.code) - 3, 4) if image.word(offset) == wanted]


def number(text):
    return int(text, 0)


def show(lines):
    for offset, raw, body in lines:
        print(f'{offset:8x}:  {raw:>8}  {body}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('info', 'imports'):
        sub.add_parser(name).add_argument('file')
    dis = sub.add_parser('dis')
    dis.add_argument('file')
    dis.add_argument('at', type=number)
    dis.add_argument('length', type=number, nargs='?', default=0x100)
    dis.add_argument('--thumb', action='store_true')
    for name in ('func', 'callers', 'refs'):
        one = sub.add_parser(name)
        one.add_argument('file')
        one.add_argument('at', type=number)
    find = sub.add_parser('find')
    find.add_argument('file')
    find.add_argument('--hex')
    find.add_argument('--word', type=number)
    find.add_argument('--text')
    args = parser.parse_args()

    image = Image(locate(args.file))
    if args.command == 'info':
        print(f'file        {image.path.name}  ({len(image.raw)} bytes)')
        print(f'uid3        {image.h["uid3"]:#010x}')
        print(f'hash        {image.hash:#010x}   (the `hash` of an enhancement profile image)')
        print(f'code        {len(image.code):#x} bytes, text {image.text_size:#x}, linked at {image.base:#x}')
        print(f'data        {image.h["data_size"]:#x} bytes, bss {image.h["bss_size"]:#x}, linked at {image.h["data_base"]:#x}')
        print(f'entry       {image.h["entry_point"]:#x}')
        print(f'exports     {image.h["export_count"]}')
        print(f'imports     {sum(len(e) for _, e in image.imports())} from {image.h["dll_count"]} libraries')
        print(f'relocations {len(image.relocations())} in the code')
    elif args.command == 'imports':
        thunk_of = {target: offset for offset, target in image.thunks().items()}
        for name, entries in image.imports():
            short = name.split('[')[0].split('.')[0].upper()
            print(name)
            for ordinal, slot in entries:
                thunk = thunk_of.get(f'{short}@{ordinal}')
                print(f'  @{ordinal:<5} slot {slot:#x}' + (f'  thunk {thunk:#x}' if thunk is not None else ''))
    elif args.command == 'dis':
        show(disassemble(image, args.at, args.length, args.thumb))
    elif args.command == 'func':
        start, end = function_bounds(image, args.at)
        print(f'; {start:#x} to {end:#x} ({(end - start) // 4} words), called from {len(callers(image, start))} places')
        show(disassemble(image, start, end - start))
    elif args.command == 'callers':
        for offset in callers(image, args.at):
            start, _ = function_bounds(image, offset)
            print(f'{offset:#x}  in the function at {start:#x}')
    elif args.command == 'refs':
        for offset in refs(image, args.at):
            print(f'{offset:#x}')
    elif args.command == 'find':
        if args.hex:
            needle = bytes.fromhex(args.hex)
        elif args.word is not None:
            needle = struct.pack('<I', args.word)
        elif args.text:
            needle = args.text.encode('latin1')
        else:
            raise SystemExit('find needs --hex, --word or --text')
        position = image.code.find(needle)
        while position >= 0:
            print(f'{position:#x}')
            position = image.code.find(needle, position + 1)


if __name__ == '__main__':
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
