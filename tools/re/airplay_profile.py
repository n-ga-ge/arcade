#!/usr/bin/env python3
"""Write catalog/enhance/airplay.json from a table of addresses per image.

    python3 -I tools/re/airplay_profile.py [OUT]

The Airplay renderer needs about fifty hooks per image: five blend modes for
each kind of primitive and texel depth, told apart by `when`, because a hook's
blend and texture format are fixed. They are written once here; an image is a
row of IMAGES. `$G` is the renderer's state block, and the rest is found from
it. docs/enhancements.md (Engine notes, Airplay) explains every address.
"""
import json
import sys

# Offsets inside the state block.
TARGET, TEXTURE, CLUT, BATCH, COLOUR, MODE = 0x10, 0x14, 0x1c, 0x2c, 0x70, 0x90

IMAGES = [
    {
        'name': '6r63.exe', 'hash': '0x67301A62', 'game': 'system-rush',
        'walk': 0x346d8,            # the display list walk; the word 0x1c before it is the state block's address
        'walk_g': -0x1c,
        'walk_end': 0x34ef0,        # the instruction after the walk returns
        'flat': 0x5dc74,            # flat polygon, clipped: count r0, vertex pointers at r6
        'textured': 0x5e574,        # textured polygon, clipped and its state set: count r4
        'gouraud': 0x5f36c,         # Gouraud polygon, clipped: count r0, vertex pointers at r4
        'sprite': 0x97e48,          # rectangle, clipped: x r7, y r8, width r4, height r5, u r9, v r10
        'line': 0x1c43c,            # line(a, b, colour)
        'spans': 0xa003c,           # draws the queued spans
        'vertices': -0x7d310,       # the clipped polygon's vertex pointers, from the state block
        'shade': -0x54507c,         # the brightness tables, from the state block
    },
]

BLENDS = [
    # mode bits, name, blend for textured, blend for plain, alpha, colour scale
    (0x00, 'opaque', 'key', 'none', None, 1),
    (0x10, 'half of each', 'alpha', 'alpha', 128, 1),
    (0x20, 'added', 'add', 'add', None, 1),
    (0x30, 'subtracted', 'subtract', 'subtract', None, 1),
    (0x40, 'a quarter added', 'add', 'add', None, 0.25),
]


def hexa(value):
    return f'{value:#x}'


def off(base, value):
    return f'{base} + {value:#x}' if value >= 0 else f'{base} - {-value:#x}'


def scaled(expr, scale):
    return expr if scale == 1 else f'({expr}) * {scale}'


def plain_channel(byte, scale):
    """A flat or Gouraud colour byte through the brightness table: 0 to 63."""
    return scaled(f'u8($T + ({byte} >> 3)) * 255 / 63', scale)


def lit_channel(scale):
    """A textured primitive is lit by one byte: row 31 of the table is the texel unchanged."""
    return scaled(f'min(255, u8($T + (u8({off("$G", COLOUR)}) >> 3)) * 255 / 31)', scale)


def texture(depth):
    pixels = f'u32({off("$G", TEXTURE)})'
    if depth == 1:
        return {'pixels': pixels, 'width': 256, 'height': 256, 'pitch': 128, 'format': 'p4',
                'palette': f'u32({off("$G", CLUT)})', 'paletteFormat': 'bgr555k'}
    if depth == 2:
        # The palette's 256 entries lie in four pieces in the engine's video
        # memory; its copy behind the shaded palettes of the batch is whole.
        return {'pixels': pixels, 'width': 128, 'height': 256, 'pitch': 128, 'format': 'p8',
                'palette': f'u32(u32({off("$G", BATCH)}) + 4) + 0x4000', 'paletteFormat': 'bgr555k'}
    # 16-bit pages are kept in the screen's own 12-bit form: the fillers copy
    # (or add) a texel to the screen unchanged.
    return {'pixels': pixels, 'width': 64, 'height': 256, 'pitch': 128, 'format': 'rgb444'}


DEPTHS = {1: '16 colours', 2: '256 colours', 3: '16 bits a texel'}


def hooks(image):
    g = f'u32({off("pc", image["walk_g"])})'
    out = [
        {'at': hexa(image['walk']), 'do': 'begin',
         'note': 'Walks the frame\'s display list, far to near, and calls a handler per primitive.',
         'target': {'pixels': f'u32({g} + {TARGET:#x})', 'width': 176, 'height': 208, 'pitch': 352, 'format': 'rgb444'}},
        {'at': hexa(image['walk']), 'do': 'set',
         'note': 'G: the renderer\'s state block. T: the brightness table in use, 32 bytes of 0 to 63.',
         'vars': {'G': g, 'T': f'{off(g, image["shade"])} + (u32({off(g, image["shade"] - 4)}) << 5)'}},
        {'at': hexa(image['walk_end']), 'do': 'end', 'note': 'The walk has returned.'},
    ]

    position = {'x': 'fx(s16(p + 4), 3)', 'y': 'fx(s16(p + 6), 3)', 'w': 's32(p + 12)'}

    def colours(fields, r, g_, b, alpha):
        fields.update({'r': r, 'g': g_, 'b': b})
        if alpha is not None:
            fields['a'] = alpha
        return fields

    mode = f'u32({off("$G", MODE)})'

    for bits, name, _, blend, alpha, scale in BLENDS:
        out.append({
            'at': hexa(image['flat']), 'do': 'draw', 'when': f'({mode} & 0x7f) == {bits:#x}',
            'note': f'A flat polygon after clipping, {name}.',
            'mode': 'fan', 'count': 'r0', 'vertex': 'u32(r6 + 4 * i)',
            'fields': colours(dict(position), *(plain_channel(f'u8({off("$G", COLOUR + n)})', scale) for n in range(3)), alpha),
            'blend': blend})

    for bits, name, _, blend, alpha, scale in BLENDS:
        out.append({
            'at': hexa(image['gouraud']), 'do': 'draw', 'when': f'({mode} & 0x70) == {bits:#x}',
            'note': f'A Gouraud polygon after clipping, {name}.',
            'mode': 'fan', 'count': 'r0', 'vertex': 'u32(r4 + 4 * i)',
            'fields': colours(dict(position), *(plain_channel(f'u8(p + {n})' if n else 'u8(p)', scale) for n in range(3)), alpha),
            'blend': blend})

    for depth in (1, 2, 3):
        for bits, name, blend, _, alpha, scale in BLENDS:
            fields = dict(position)
            fields.update({'u': 'fx(u16(p + 8), 4)', 'v': 'fx(u16(p + 10), 4)'})
            lit = lit_channel(scale)
            out.append({
                'at': hexa(image['textured']), 'do': 'draw', 'when': f'({mode} & 0x77) == {bits | depth:#x}',
                'note': f'A textured polygon after clipping, {DEPTHS[depth]}, {name}.',
                'mode': 'fan', 'count': 'r4', 'vertex': f'u32({off("$G", image["vertices"])} + 4 * i)',
                'fields': colours(fields, lit, lit, lit, alpha),
                'texture': texture(depth), 'blend': blend})

    corner = {'x': 'r7 + sel(i == 1 || i == 2, r4, 0)', 'y': 'r8 + sel(i >= 2, r5, 0)'}
    for depth in (1, 2, 3):
        for bits, name, blend, _, alpha, scale in BLENDS:
            fields = dict(corner)
            fields.update({'u': 'r9 + sel(i == 1 || i == 2, r4, 0)', 'v': 'r10 + sel(i >= 2, r5, 0)'})
            lit = lit_channel(scale)
            out.append({
                'at': hexa(image['sprite']), 'do': 'draw', 'when': f'({mode} & 0x7f) == {bits | depth:#x}',
                'note': f'A textured rectangle after clipping, {DEPTHS[depth]}, {name}.',
                'mode': 'fan', 'count': 4,
                'fields': colours(fields, lit, lit, lit, alpha),
                'texture': texture(depth), 'blend': blend})
    for bits, name, _, blend, alpha, scale in BLENDS:
        out.append({
            'at': hexa(image['sprite']), 'do': 'draw', 'when': f'({mode} & 0x7f) == {bits | 8:#x}',
            'note': f'A plain rectangle after clipping, {name}.',
            'mode': 'fan', 'count': 4,
            'fields': colours(dict(corner), *(plain_channel(f'u8({off("$G", COLOUR + n)})', scale) for n in range(3)), alpha),
            'blend': blend})

    # A line one pixel wide, as the two triangles that cover the pixels the
    # engine's own line does: one pixel a column, or one a row when it is steep.
    steep = 'abs(sar(s16(r1 + 6), 3) - sar(s16(r0 + 6), 3)) > abs(sar(s16(r1 + 4), 3) - sar(s16(r0 + 4), 3))'
    for when, name, blend, alpha in (('(r2 & 0x2000000) == 0', 'opaque', 'none', None),
                                     ('(r2 & 0x2000000) != 0', 'half of each', 'alpha', 128)):
        fields = {'x': f'sar(s16(p + 4), 3) + sel(i >= 2 && ({steep}), 1, 0)',
                  'y': f'sar(s16(p + 6), 3) + sel(i >= 2 && !({steep}), 1, 0)'}
        out.append({
            'at': hexa(image['line']), 'do': 'draw', 'when': when,
            'note': f'A line, {name}: r0 and r1 point at the ends (x and y at +4 and +6, eighths of a pixel), r2 is the colour.',
            'mode': 'fan', 'count': 4, 'vertex': 'sel(i == 1 || i == 2, r1, r0)',
            'fields': colours(fields, '(r2 & 0xf0) * 17 / 16', '((r2 >> 8) & 0xf0) * 17 / 16', '((r2 >> 16) & 0xf0) * 17 / 16', alpha),
            'blend': blend, 'skip': True})

    out.append({'at': hexa(image['spans']), 'do': 'set', 'skip': True,
                'note': 'Draws the spans the polygons and rectangles queued. Skipping it leaves them undrawn; '
                        'the caller empties the queue either way.',
                'vars': {'spans': 'r0'}})
    return out


def main():
    profile = {
        'engine': 'airplay',
        'about': 'Ideaworks3D\'s renderer, as System Rush links it: a display list modelled on the PlayStation\'s '
                 'drawing commands (flat, textured and Gouraud triangles and quads, rectangles, lines), sorted far to near '
                 'and turned into spans. Polygons are read after the engine has clipped them.',
        'images': [{'name': image['name'], 'hash': image['hash'], 'game': image['game'], 'hooks': hooks(image)}
                   for image in IMAGES],
    }
    out = sys.argv[1] if len(sys.argv) > 1 else 'catalog/enhance/airplay.json'
    with open(out, 'w') as fh:
        json.dump(profile, fh, indent=2)
        fh.write('\n')
    print(out, len(profile['images'][0]['hooks']), 'hooks')


main()
