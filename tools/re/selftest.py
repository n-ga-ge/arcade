#!/usr/bin/env python3
"""Checks of tools/re that need no game: python3 -I tools/re/selftest.py"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dbg  # noqa: E402
import e32  # noqa: E402
import render  # noqa: E402


def check(name, condition):
    print(('ok   ' if condition else 'FAIL ') + name)
    return bool(condition)


def main():
    ok = True

    # Published XXH32 test values.
    ok &= check('xxh32 of nothing', e32.xxh32(b'', 0) == 0x02CC5D05)
    ok &= check('xxh32 of "abc"', e32.xxh32(b'abc', 0) == 0x32D153FF)
    ok &= check('xxh32 over 16 bytes', e32.xxh32(b'Nobody inspects the spammish repetition', 0) == 0xE2293B2F)

    import tempfile
    pixels = bytes((x * 7 + y * 13 + c * 31) & 255 for y in range(9) for x in range(11) for c in range(4))
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / 'p.png'
        dbg.write_png(path, 11, 9, pixels)
        width, height, back = dbg.read_png(path.read_bytes())
    ok &= check('a PNG comes back as written', (width, height, bytes(back)) == (11, 9, pixels))

    def vertex(x, y, colour=0xFFFF0000, u=0, v=0, w=1, z=0):
        return [x, y, z, w, u, v, colour]

    frame = {'width': 8, 'height': 8, 'textures': [],
             'vertices': vertex(0, 0) + vertex(8, 0) + vertex(0, 8),
             'draws': [{'first': 0, 'count': 3, 'texture': -1, 'blend': 'none', 'depth': 'none'}]}
    width, height, rgba, coverage = render.render(frame, {}, 4)
    ok &= check('a triangle over half the square covers half of it', abs(sum(coverage) / len(coverage) - 0.5) < 0.04)
    ok &= check('and is drawn in its colour', rgba[0:4] == bytes((255, 0, 0, 255)) and rgba[-4:] == bytes((0, 0, 0, 255)))

    # The nearer triangle wins whatever the order, when depth is compared.
    far = vertex(0, 0, 0xFF00FF00, z=5) + vertex(8, 0, 0xFF00FF00, z=5) + vertex(0, 8, 0xFF00FF00, z=5)
    near = vertex(0, 0, 0xFF0000FF, z=1) + vertex(8, 0, 0xFF0000FF, z=1) + vertex(0, 8, 0xFF0000FF, z=1)
    frame = {'width': 8, 'height': 8, 'textures': [], 'vertices': near + far,
             'draws': [{'first': 0, 'count': 6, 'texture': -1, 'blend': 'none', 'depth': 'less'}]}
    _, _, rgba, _ = render.render(frame, {}, 1)
    ok &= check('depth keeps the nearer triangle', rgba[0:3] == bytes((0, 0, 255)))

    # A 2x2 texture over a square: each quarter takes one texel.
    texture = (2, 2, bytes((255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0)))
    square = (vertex(0, 0, 0xFFFFFFFF, 0, 0) + vertex(8, 0, 0xFFFFFFFF, 2, 0) + vertex(0, 8, 0xFFFFFFFF, 0, 2)
              + vertex(8, 0, 0xFFFFFFFF, 2, 0) + vertex(8, 8, 0xFFFFFFFF, 2, 2) + vertex(0, 8, 0xFFFFFFFF, 0, 2))
    frame = {'width': 8, 'height': 8, 'textures': [{}], 'vertices': square,
             'draws': [{'first': 0, 'count': 6, 'texture': 0, 'blend': 'key', 'depth': 'none'}]}
    _, _, rgba, coverage = render.render(frame, {0: texture}, 1)

    def at(x, y):
        return bytes(rgba[(y * 8 + x) * 4:(y * 8 + x) * 4 + 3])

    ok &= check('texels land in their quarters', at(1, 1) == b'\xff\0\0' and at(6, 1) == b'\0\xff\0' and at(1, 6) == b'\0\0\xff')
    ok &= check('a keyed texel is not drawn', at(6, 6) == b'\0\0\0' and coverage[6 * 8 + 6] == 0)

    width, height, rgba, coverage = render.render(frame, {0: texture}, 4)
    sw, sh, small, covered = render.shrink(width, height, rgba, coverage, 4)
    _, _, once, _ = render.render(frame, {0: texture}, 1)
    cover, diff = render.compare(small, once, covered)
    ok &= check('four times the size, scaled back, is the same picture', (sw, sh) == (8, 8) and diff < 1 and cover > 0.7)

    # The layer test's reference: away from the key colour the picture stays
    # as the game drew it, and on it the triangles show.
    import layertest
    frame, textures = layertest.scene()
    screen = layertest.picture(frame)
    shown = layertest.composite(frame, textures, screen, 1)
    keyed = [layertest.is_key(*screen[at:at + 3]) for at in range(0, len(screen), 4)]
    plain = [at * 4 for at, k in enumerate(keyed) if not k and layertest.key_share(*screen[at * 4:at * 4 + 3]) < 0.2]
    ok &= check('the layer\'s reference keeps the picture away from the key colour',
                all(shown[at:at + 3] == screen[at:at + 3] for at in plain))
    ok &= check('and shows no key colour', not any(layertest.is_key(*shown[at:at + 3]) for at in range(0, len(shown), 4)))

    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
