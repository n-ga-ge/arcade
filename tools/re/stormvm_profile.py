#!/usr/bin/env python3
"""Write catalog/enhance/stormvm.json from a table of addresses per image.

    python3 -I tools/re/stormvm_profile.py [OUT]

StormBASIC's virtual machine (STORMVM.DLL, or a later build of it linked into
a game's own _lnk.DLL) draws its 3D with two rasterisers, one for quads and
one for triangles, that share one span filler. The filler's state (texture,
colour table, depth, colour key, blend) is read at each rasteriser's first
instruction. The hooks are the same for every copy of the code; an image is a
row of IMAGES, and the renderer object's layout a row of LAYOUTS.
docs/enhancements.md (Engine notes, StormBASIC) explains every address.
"""
import json
import sys

# The renderer object's fields. The _lnk.DLL build has a larger object with
# the same fields further on.
LAYOUTS = {
    'stormvm': {
        'picture': 0x2e4,   # the 176x208 picture the 3D is drawn into (12-bit colours in 16-bit words)
        'level': 0x2e8,     # the texture level chosen for this polygon (0 to 2)
        'texels': 0x2ec,    # three words: the pixels of each level
        'log2': 0x2f8,      # three halfwords: log2 of each level's width, then three of the heights
        'table': 0x680,     # the colour table (4096 16-bit colours), zero for none
        'plain': 0x67c,     # the first table, which the filler treats as none
    },
    'lnk': {
        'picture': 0x3e4, 'level': 0x3e8, 'texels': 0x3ec, 'log2': 0x3f8, 'table': 0x9c0, 'plain': 0x9bc,
    },
}
# Render states (SetRenderState n stores at +0x20c + 4n), the same in both builds.
DEPTH = 0x24c   # state 16: test and write the depth buffer (a larger value is nearer)
HALF = 0x250    # state 17: half the texel added to half the pixel (then through the table)
KEY = 0x254     # state 18: the texel 0x0F0F is not drawn

IMAGES = [
    # STORMVM.DLL as TechWars and Pool Friction ship it (byte for byte the same file;
    # Pool Friction loads its _lnk.DLL instead).
    {'name': 'stormvm.dll', 'hash': '0xF213F0D1', 'game': 'techwars', 'layout': 'stormvm',
     'renderer': 'u32(sp + 0x24)', 'scene': 0x19ce8, 'scene_end': 0x19f90, 'quad': 0x3cc1c, 'tri': 0x3d2e0},
    # Barakel's STORMVM.DLL: four bytes of data differ, the code is at the same addresses.
    {'name': 'stormvm.dll', 'hash': '0x1CFDA991', 'game': 'barakel', 'layout': 'stormvm',
     'renderer': 'u32(sp + 0x24)', 'scene': 0x19ce8, 'scene_end': 0x19f90, 'quad': 0x3cc1c, 'tri': 0x3d2e0},
    # The VM linked into the game: PFriction_lnk.DLL and FreeStyle_lnk.DLL are the same file.
    {'name': 'pfriction_lnk.dll', 'hash': '0x4F530D6E', 'game': 'pool-friction', 'layout': 'lnk',
     'renderer': 'r9', 'scene': 0x1d28c, 'scene_end': 0x1d514, 'quad': 0x420d0, 'tri': 0x42768},
    {'name': 'freestyle_lnk.dll', 'hash': '0x4F530D6E', 'game': 'freestyle', 'layout': 'lnk',
     'renderer': 'r9', 'scene': 0x1d28c, 'scene_end': 0x1d514, 'quad': 0x420d0, 'tri': 0x42768},
]


def signed(register):
    # A register is read as an unsigned number; the coordinates are signed.
    return f'sar({register}, 0)'


def state(layout):
    """`set` hooks for a rasteriser's first instruction: what every draw hook there reads,
    computed once a polygon. Each set may use only the variables of the sets before it."""
    lay = LAYOUTS[layout]
    return [
        {'lv': f'u32(r0 + {lay["level"]:#x})', 'tb': f'u32(r0 + {lay["table"]:#x})'},
        {
            'tx': f'u32(r0 + {lay["texels"]:#x} + 4 * $lv)',
            'lw': f'u16(r0 + {lay["log2"]:#x} + 2 * $lv)',
            'lh': f'u16(r0 + {lay["log2"] + 6:#x} + 2 * $lv)',
            # The colour table is a distance shade: each entry is the colour darkened (and, far
            # away, moved a little towards blue). Its entry for white is taken as a multiplier.
            'sh': f'$tb != 0 && $tb != u32(r0 + {lay["plain"]:#x})',
            # A quad whose corners 0 and 3, and 1 and 2, share their x is a rectangle on the screen.
            'rc': 'r1 == u32(sp + 36) && u32(sp + 4) == u32(sp + 20)',
        },
        {
            'cr': 'sel($sh, ((u16($tb + 0x1ffe) >> 8) & 15) * 17, 255)',
            'cg': 'sel($sh, ((u16($tb + 0x1ffe) >> 4) & 15) * 17, 255)',
            'cb': 'sel($sh, (u16($tb + 0x1ffe) & 15) * 17, 255)',
        },
    ]


def draw(at, count, layout, variants):
    """A rasteriser: r0 the renderer, the polygon's vertices passed by value (16 bytes each:
    x and y in eighths of a pixel, the depth, then u and v as bytes, fractions of the
    texture's width and height). The first twelve bytes of vertex 0 are in r1 to r3, the
    rest on the stack from sp, so vertex i (from 1) is at sp - 12 + 16 * i. Each variant is
    one draw hook: a `when` (what the game tests before it draws, and the mode), whether it
    tests depth, whether it is the half blend, whether the colour key is on, and whether the
    texture is square (the span filler reads it as square of its width)."""
    hooks = [{'at': hex(at), 'do': 'set', 'note': 'The polygon\'s texture, its size and the colour table.' if n == 0 else None,
              'vars': vars} for n, vars in enumerate(state(layout))]
    for hook in hooks:
        if hook['note'] is None:
            del hook['note']
    for variant in variants:
        width = '(1 << $lw)'
        height = width if variant['square'] else '(1 << $lh)'
        fields = {
            'x': f'fx(sel(i == 0, {signed("r1")}, s32(p)), 3)',
            'y': f'fx(sel(i == 0, {signed("r2")}, s32(p + 4)), 3) + 0.5',
            'z': f'sel(i == 0, {signed("r3")}, s32(p + 8))',
            'w': f'1048576 / max(sel(i == 0, {signed("r3")}, s32(p + 8)), 1)',
            'u': f'u8(p + 12) * {width} / 256',
            'v': f'u8(p + 13) * {height} / 256',
            'r': '$cr',
            'g': '$cg',
            'b': '$cb',
        }
        if variant['half']:
            fields['a'] = 128
        hooks.append({
            'at': hex(at),
            'do': 'draw',
            'note': variant['note'],
            'when': variant['when'],
            'mode': 'fan',
            'count': count,
            'vertex': 'sp - 12 + 16 * i',
            'fields': fields,
            'texture': {
                'pixels': '$tx',
                'width': width,
                'height': height,
                'format': 'rgb444',
                'key': variant['key'],
            },
            'blend': 'alpha' if variant['half'] else 'key',
            'depth': 'greater' if variant['depth'] else 'none',
        })
    hooks.append({
        'at': hex(at),
        'do': 'set',
        'note': 'Replacing: the rasteriser returns at once, so the guest draws none of the polygon.',
        'vars': {},
        'skip': True,
    })
    return hooks


def spans(what, checks):
    """The four modes of the span filler: with or without depth, opaque or the half blend;
    the colour key by its state."""
    return [{
        'note': f'{what}, {"half the texel over half the picture" if half else "opaque"}, '
                f'{"with" if depth else "without"} the depth buffer.',
        'when': f'{checks} && {"" if depth else "!"}u32(r0 + {DEPTH:#x}) && {"" if half else "!"}u32(r0 + {HALF:#x})',
        'depth': depth, 'half': half, 'square': True, 'key': f'sel(u32(r0 + {KEY:#x}), 0x0f0f, 0x10000)',
    } for half in (0, 1) for depth in (1, 0)]


def image(row):
    lay = LAYOUTS[row['layout']]
    renderer = row['renderer']
    hooks = [
        {
            'at': hex(row['scene']),
            'do': 'begin',
            'note': f'RenderScene, after it set the view (r0 nonzero when there is one). {renderer} is the renderer, '
                    'which holds the picture the 3D is drawn into (12-bit colours, 176 by 208).',
            'when': 'r0',
            'target': {
                'pixels': f'u32({renderer} + {lay["picture"]:#x})',
                'width': f'u32({renderer} + 0x10)',
                'height': f'u32({renderer} + 0x14)',
                'pitch': f'u32({renderer} + 0x10) * 2',
                'format': 'rgb444',
            },
        },
        {'at': hex(row['scene']), 'do': 'set', 'when': 'r0', 'vars': {'scene': 1}},
        {
            'at': hex(row['scene_end']),
            'do': 'end',
            'when': '$scene',
            'note': 'RenderScene returns: every mesh is drawn; the game draws its 2D after this.',
        },
        {'at': hex(row['scene_end']), 'do': 'set', 'vars': {'scene': 0}},
    ]
    # The span filler draws a texture of 16 to 256 a side, read as square of its width; the
    # quad rasteriser also refuses one that is not square.
    sizes = '$tx != 0 && $lw >= 4 && $lw <= 8'
    # A rectangle on the screen (a billboard) goes to a column filler of its own, which always
    # tests depth and keys 0x0F0F. It takes square textures of 32 to 128 a side when render
    # state 4 is set, and otherwise widths of 16 to 64 with the height the same or twice.
    # With corner 1 left of corner 0 the game draws nothing.
    rect_sizes = 'sel(u32(r0 + 0x21c), $lw == $lh && $lw >= 5 && $lw <= 7, $lw >= 4 && $lw <= 6 && ($lh == $lw || $lh == $lw + 1))'
    rect = f'$tx != 0 && $rc && s32(sp + 4) >= {signed("r1")} && {rect_sizes}'
    quad = spans('A quad (grids: floors, terrain)', f'{sizes} && !$rc && $lw == $lh')
    quad += [{
        'note': f'A rectangle on the screen (billboards: plants, signs), {"half the texel over half the picture" if half else "opaque"}; '
                'always the depth buffer and the colour key.',
        'when': f'{rect} && {"" if half else "!"}u32(r0 + {HALF:#x})',
        'depth': 1, 'half': half, 'square': False, 'key': '0x0f0f',
    } for half in (0, 1)]
    hooks += draw(row['quad'], 4, row['layout'], quad)
    hooks += draw(row['tri'], 3, row['layout'], spans('A triangle (models)', sizes))
    return {'name': row['name'], 'hash': row['hash'], 'game': row['game'], 'hooks': hooks}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'catalog/enhance/stormvm.json'
    profile = {
        'engine': 'stormvm',
        'about': "The 3D of StormBASIC's virtual machine (STORMVM.DLL, or the same code in a game's _lnk.DLL): "
                 'meshes drawn as textured quads and triangles with a depth buffer, a colour key and a distance shade.',
        'viewport': {'width': 176, 'height': 208},
        'images': [image(row) for row in IMAGES],
    }
    with open(out, 'w') as fh:
        json.dump(profile, fh, indent=2)
        fh.write('\n')


if __name__ == '__main__':
    main()
