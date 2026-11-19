#!/usr/bin/env python3
"""Find the same function in another executable, by the shape of its code.

    python3 -I tools/re/sig.py find REF AT [AT ...] --in FILE      where FILE has the function REF has at AT
    python3 -I tools/re/sig.py port PROFILE --from NAME --to FILE  a profile image for FILE, from the image NAME
                               [--game SLUG] [--write]

Games built on one engine each link their own copy of it, at other addresses.
A function's signature here is its instruction words with everything that
depends on where things were linked taken out: the distance of every branch
and call, and every word the loader relocates (addresses in literal pools).
What is left is the same in every executable that was built from the same
source with the same compiler.

`find` looks for an exact match of the whole function first. If there is none
it compares against every function of similar length and names the best ones
with their likeness (1.0 is identical); --min sets how alike counts (default
0.85). An offset inside a function is carried over by lining the two up.

`port` does that for every hook of a profile image and prints the image for
the other executable: the same hooks at the offsets found there, its own name
and hash. With --write it is added to the profile (or replaces the image with
that hash), which is written back one hook per line, the layout of
catalog/enhance/. A hook that was not found is left out and named.

A match is a candidate, not a proof: the structures behind the registers can
differ between versions of an engine although the code looks alike. Count the
hits with `dbg.py hook` and prove the profile with enhancetest.py.

A FILE is a path or SLUG:NAME, as in e32.py. Offsets are from the start of the
code section, as everywhere in these tools.
"""
import argparse
import difflib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import e32  # noqa: E402

RELOCATED = 0xFFFFFFFF   # stands for any word the loader relocates
PUSH_LR_MASK, PUSH_LR = 0xFFFF4000, 0xE92D4000


class Code:
    """An image's text as masked words, and where its functions start."""

    def __init__(self, image):
        self.image = image
        count = image.text_size // 4
        words = list(struct.unpack_from('<%dI' % count, image.code, 0))
        self.starts = [4 * n for n, word in enumerate(words) if word & PUSH_LR_MASK == PUSH_LR]
        for offset in image.relocations():
            if offset % 4 == 0 and offset // 4 < count:
                words[offset // 4] = RELOCATED
        for n, word in enumerate(words):
            # b and bl, any condition: keep the instruction, drop the distance.
            if word != RELOCATED and word & 0x0E000000 == 0x0A000000:
                words[n] = word & 0xFF000000
        self.words = words
        self.packed = struct.pack('<%dI' % count, *words)

    def bounds(self, at):
        """(start, end) of the function around an offset: from a push of lr to the next one."""
        return e32.function_bounds(self.image, at)

    def slice(self, start, end):
        return self.words[start // 4:end // 4]


def exact(reference, start, end, target):
    """Offsets in the target where the reference's function is found word for word."""
    pattern = reference.packed[start:end]
    out, at = [], target.packed.find(pattern)
    while at >= 0:
        if at % 4 == 0:
            out.append(at)
        at = target.packed.find(pattern, at + 1)
    return out


def alike(reference, start, end, target, keep=5):
    """[(likeness, start in the target, matcher)] for the target's functions most like the reference's."""
    wanted = reference.slice(start, end)
    matcher = difflib.SequenceMatcher(None, autojunk=False)
    matcher.set_seq2(wanted)
    candidates = []
    bounds = target.starts + [target.image.text_size & ~3]
    for n, first in enumerate(target.starts):
        length = (bounds[n + 1] - first) // 4
        if not 0.6 * len(wanted) <= length <= 1.6 * len(wanted):
            continue
        matcher.set_seq1(target.slice(first, bounds[n + 1]))
        if matcher.real_quick_ratio() < 0.6:
            continue
        candidates.append((matcher.quick_ratio(), first, bounds[n + 1]))
    out = []
    for _, first, last in sorted(candidates, reverse=True)[:4 * keep]:
        matcher = difflib.SequenceMatcher(None, target.slice(first, last), wanted, autojunk=False)
        out.append((matcher.ratio(), first, matcher))
    out.sort(key=lambda item: -item[0])
    return out[:keep]


def find(reference, at, target, least=0.85):
    """Where the target has what the reference has at an offset.

    Returns (offset or None, likeness, note). The offset may be inside a
    function; it is carried over through the matching stretch it lies in.
    """
    at &= ~3
    start, end = reference.bounds(at)
    places = exact(reference, start, end, target)
    if len(places) == 1:
        return places[0] + at - start, 1.0, 'exact'
    if len(places) > 1:
        return None, 1.0, 'found %d times: %s' % (len(places), ', '.join(hex(p) for p in places[:6]))
    best = alike(reference, start, end, target)
    if not best or best[0][0] < least:
        return None, best[0][0] if best else 0.0, 'nothing alike' if not best else 'best is %#x' % best[0][1]
    if len(best) > 1 and best[1][0] >= least and best[0][0] - best[1][0] < 0.02:
        return None, best[0][0], 'two alike: %#x and %#x' % (best[0][1], best[1][1])
    likeness, first, matcher = best[0]
    index = (at - start) // 4
    for a, b, size in matcher.get_matching_blocks():
        # a indexes the target's function, b the reference's.
        if b <= index < b + size:
            return first + 4 * (a + index - b), likeness, 'alike'
    return None, likeness, 'the function is at %#x but the instruction at this offset has no match in it' % first


def format_profile(profile):
    """A profile as text: its fields as usual, but each hook on one line."""
    lines = ['{']
    keys = [key for key in profile if key != 'images']
    for key in keys:
        lines.append('  %s: %s,' % (json.dumps(key), json.dumps(profile[key], ensure_ascii=False)))
    lines.append('  "images": [')
    for n, image in enumerate(profile['images']):
        head = ', '.join('%s: %s' % (json.dumps(key), json.dumps(value, ensure_ascii=False))
                         for key, value in image.items() if key != 'hooks')
        lines += ['    {', '      %s,' % head, '      "hooks": [']
        hooks = image['hooks']
        lines += ['        ' + json.dumps(hook, ensure_ascii=False) + (',' if k + 1 < len(hooks) else '')
                  for k, hook in enumerate(hooks)]
        lines += ['      ]', '    }' + (',' if n + 1 < len(profile['images']) else '')]
    lines += ['  ]', '}', '']
    return '\n'.join(lines)


def load(spec):
    return Code(e32.Image(e32.locate(spec)))


def cmd_find(args):
    reference, target = load(args.ref), load(args.target)
    failed = False
    for text in args.at:
        at = int(text, 0)
        offset, likeness, note = find(reference, at, target, args.min)
        failed |= offset is None
        print('%#x -> %s  (%s, %.3f)' % (at, hex(offset) if offset is not None else 'not found', note, likeness))
    return 1 if failed else 0


def cmd_port(args):
    path = Path(args.profile)
    profile = json.loads(path.read_text())
    sources = [image for image in profile['images'] if image['name'].lower() == args.source.lower()]
    if not sources:
        raise SystemExit(f'{path} has no image called {args.source}')
    source = sources[0]
    if not source.get('game'):
        raise SystemExit(f'the image {args.source} names no game, so its file cannot be found')
    reference = load(f'{source["game"]}:{source["name"]}')
    if '0x%08X' % reference.image.hash != source['hash'].upper().replace('0X', '0x'):
        raise SystemExit(f'{source["name"]} in the dump of {source["game"]} is not the file the profile was written for')
    file = e32.locate(args.to)
    target = Code(e32.Image(file))
    ported = {'name': Path(file).name, 'hash': '0x%08X' % target.image.hash}
    game = args.game or (args.to.split(':', 1)[0] if ':' in args.to and not Path(args.to).exists() else None)
    if game:
        ported['game'] = game
    ported['hooks'] = []
    missing = []
    for hook in source['hooks']:
        offset, likeness, note = find(reference, int(hook['at'], 16), target, args.min)
        label = '%s %s%s' % (hook['at'], hook['do'], ' (%s)' % hook['note'] if hook.get('note') else '')
        if offset is None:
            missing.append(label)
            print('%s: not found (%s, %.3f)' % (label, note, likeness), file=sys.stderr)
            continue
        if note != 'exact':
            print('%s: %#x is alike, not identical (%.3f)' % (label, offset, likeness), file=sys.stderr)
        ported['hooks'].append({**hook, 'at': '%#x' % offset})
    if not ported['hooks']:
        raise SystemExit('none of the hooks was found: this is another engine, or a very different version of it')
    if args.write:
        others = [image for image in profile['images'] if image['hash'].upper() != ported['hash'].upper()]
        profile['images'] = others + [ported]
        path.write_text(format_profile(profile))
        print(f'{path}: image {ported["name"]} written, {len(ported["hooks"])} of {len(source["hooks"])} hooks',
              file=sys.stderr)
    else:
        print(json.dumps(ported, indent=2))
    return 1 if missing else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    found = sub.add_parser('find')
    found.add_argument('ref')
    found.add_argument('at', nargs='+')
    found.add_argument('--in', dest='target', required=True)
    found.add_argument('--min', type=float, default=0.85)
    port = sub.add_parser('port')
    port.add_argument('profile')
    port.add_argument('--from', dest='source', required=True)
    port.add_argument('--to', required=True)
    port.add_argument('--game')
    port.add_argument('--min', type=float, default=0.85)
    port.add_argument('--write', action='store_true')
    args = parser.parse_args()
    return {'find': cmd_find, 'port': cmd_port}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
