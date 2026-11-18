#!/usr/bin/env python3
"""Write catalog/enhance/exient.json from a table of addresses per image.

    python3 -I tools/re/exient_profile.py [OUT]

Exient's renderer (SSX Out of Bounds, WWE Aftershock) hands every triangle,
far to near, to one of two functions with r0 the renderer, r1 three 12-byte
vertices and r2 the material. The material's mode word picks the span filler,
so a draw is a hook per blend mode at each of the two functions, told apart by
`when`. They are written once here; an image is a row of IMAGES.
docs/enhancements.md (Engine notes, Exient) explains every address and field.
"""
import json
import sys

IMAGES = [
    {
        'name': '6R65.app', 'hash': '0x4E81FA0B', 'game': 'ssx-out-of-bounds',
        'begin': 0x70394,           # empties the renderer's sorted list: the 3D of a frame starts
        'polygons': [0x62da0, 0x60734],    # a triangle and a quad (mode bit 0x10 picks the triangle)
        # Offsets inside the renderer object.
        'view': 0x10,               # the 3D view's first pixel (16 rows into the screen buffer)
        'pitch': 0x18,              # bytes a row
        'screen': 0xb854,           # the screen object; its +8 is the screen buffer
        'light': 0xb95c,            # the light of the triangle being drawn (512 is the colour as it is)
    },
]
# The Polish release: the same code, other text, so another hash.
IMAGES.append(dict(IMAGES[0], hash='0x299798D8', game='ssx-out-of-bounds-pl'))

VIEW_WIDTH, VIEW_HEIGHT, SCREEN_HEIGHT = 176, 176, 208


def hexa(value):
    return f'{value:#x}'


def channel(shift):
    """A 4-bit channel of the material's colour through the game's light function, as 0 to 255.

    For a light L of 512 or less a channel n becomes n * (L + 1024) / 1536,
    above 512 it goes towards 16 by (L - 512) / 1536, rounded down both times.
    """
    n = f'(($col >> {shift}) & 15)' if shift else '($col & 15)'
    x = f'sel($L <= 512, {n} * ($L + 1024), {n} * 1536 + (16 - {n}) * ($L - 512))'
    return f'min(15, (({x}) - ({x}) % 1536) / 1536) * 17'


def chain(values):
    """sel(i == 0, v0, sel(i == 1, v1, ...)): a value per vertex slot."""
    text = values[-1]
    for n in range(len(values) - 2, -1, -1):
        text = f'sel(i == {n}, {values[n]}, {text})'
    return text


def clip_vars(half, corners):
    """Set hooks that clip one triangle of a polygon at the top of the view (y 0 of its quarter pixels).

    The triangle (corners: three vertex numbers of the polygon) becomes a fan of six slots, two per corner: the
    corner itself when it is inside, otherwise the points where the outline leaves it towards the corner before and
    the corner after (when that one is outside too, towards the third). Slot s is corner s // 2 moved by $tH_s
    (0 to 1) towards the vertex at $eH_s. The key fill cannot be clipped at the top: the black bar above the view is
    in the target.
    """
    address = [f'r1 + {12 * c}' for c in corners]
    ends, moves = {}, {}
    for slot in range(6):
        k, towards_next = slot // 2, slot % 2
        b = (k + 1) % 3 if towards_next else (k + 2) % 3
        c = 3 - k - b
        ends[f'e{half}_{slot}'] = f'sel(s16({address[b]} + 2) >= 0, {address[b]}, {address[c]})'
        ya = f's16({address[k]} + 2)'
        moves[f't{half}_{slot}'] = f'sel({ya} >= 0, 0, {ya} / ({ya} - s16($e{half}_{slot} + 2)))'
    return ends, moves


def clipped(half, corners, fields):
    """Fields of a clipped slot: `p` is the corner, T how far it moves towards E."""
    t = chain([f'$t{half}_{slot}' for slot in range(6)])
    e = chain([f'$e{half}_{slot}' for slot in range(6)])

    def linear(of):
        return f'({of("p")} + {t} * ({of(e)} - {of("p")}))'

    out = {
        'x': f'{linear(lambda a: f"s16({a})")} / 4',
        'y': f'{linear(lambda a: f"s16({a} + 2)")} / 4 + $yo',
    }
    for name, value in fields.items():
        out[name] = value(linear, t, e) if callable(value) else value
    return out


def perspective(of, t, e):
    """An attribute at a clipped slot, interpolated with perspective (as the redraw does across the triangle)."""
    q = f'((1 - {t}) / s16(p + 10) + {t} / s16({e} + 10))'
    return f'((1 - {t}) * {of("p")} / s16(p + 10) + {t} * {of(e)} / s16({e} + 10)) / {q}'


def hooks(image):
    out = [{
        'at': hexa(image['begin']), 'do': 'begin',
        'note': 'The 3D of a frame starts: the sorted list of triangles is emptied. r0 is the renderer. The target is the '
                'screen buffer from its first row to the last row of the view (176 by 176, 16 rows down in a race).',
        'target': {
            'pixels': f'u32(u32(r0 + {hexa(image["screen"])}) + 8)',
            'width': str(VIEW_WIDTH),
            # Down to the view's last row, so that the key never covers the black bar below it.
            'height': f'(u32(r0 + {hexa(image["view"])}) - u32(u32(r0 + {hexa(image["screen"])}) + 8)) / '
                      f'u32(r0 + {hexa(image["pitch"])}) + {VIEW_HEIGHT}',
            'pitch': f'u32(r0 + {hexa(image["pitch"])})',
            'format': 'rgb444',
        },
    }]
    for n, at in enumerate(image['polygons']):
        at = hexa(at)
        first = n == 0
        corners = 3 if first else 4
        halves = [(0, 1, 2)] if first else [(0, 1, 2), (0, 2, 3)]
        mean = '(' + ' + '.join(f's16(r1 + {12 * k + 8})' for k in range(corners)) + f') / {corners}'
        out.append({
            'at': at, 'do': 'set',
            'note': ('A triangle: r0 the renderer, r1 three vertices of 12 bytes (x, y in quarter pixels of the view, '
                     'u, v in 128ths of a texel, shade, depth), r2 the material (+0x18 texture or colour, +0x1c '
                     'palette, +0x20 mode).') if first else 'A quad: the same arguments, with four vertices.',
            'vars': {
                'm': 'u32(r2 + 0x20)',
                'col': 'u32(r2 + 0x18)',
                'L': f'u32(r0 + {hexa(image["light"])})',
                'yo': f'(u32(r0 + {hexa(image["view"])}) - u32(u32(r0 + {hexa(image["screen"])}) + 8)) / '
                      f'u32(r0 + {hexa(image["pitch"])})',
            },
        })
        out.append({
            'at': at, 'do': 'set',
            'vars': {
                'tex': '($m & 1) == 0',
                # Bit 0x80 with the plain or perspective fillers: the palette row is picked per pixel by the
                # interpolated shade (32 rows of 256 from +0x1c). Approximated by the row of the mean shade.
                'rows': '($m & 0x80) && (($m & 0x40) || ($m & 0x26) == 0)',
                'shade': mean,
                # Untextured: +0x18 is a colour ramp's address or a 12-bit colour.
                'ramp': '$col >= 0x10000',
            },
        })
        out.append({
            'at': at, 'do': 'set',
            'vars': {
                'pal': 'u32(r2 + 0x1c) + sel($rows, min(31, max(0, sar($shade, 5))), '
                       'sel($m & 0x80, 0, sar($L, 5))) * 512',
            },
        })
        for half, corners_of_half in enumerate(halves):
            ends, moves = clip_vars(half, corners_of_half)
            note = ('Clipping at the top of the view: where each corner of the triangle moves to.' if half == 0 else
                    'The same for the quad\'s second triangle (vertices 0, 2, 3).')
            out.append({'at': at, 'do': 'set', 'note': note, 'vars': ends})
            out.append({'at': at, 'do': 'set', 'vars': moves})

        def draw(when, note, fields, blend, texture=None):
            for half, corners_of_half in enumerate(halves):
                vertex = 'r1 + 12 * ' + (f'((i - i % 2) / 2)' if half == 0 else 'sel(i < 2, 0, (i - i % 2) / 2 + 1)')
                any_inside = ' || '.join(f's16(r1 + {12 * c + 2}) >= 0' for c in corners_of_half)
                hook = {'at': at, 'do': 'draw'}
                if first:
                    hook['note'] = note
                hook.update({'when': f'({any_inside}) && {when}', 'skip': True, 'mode': 'fan', 'count': '6',
                             'vertex': vertex, 'fields': clipped(half, corners_of_half, fields)})
                if texture:
                    hook['texture'] = texture
                hook.update({'blend': blend, 'depth': 'none'})
                out.append(hook)

        def textured(when, blend, note, alpha=None, key=False):
            texture = {
                'pixels': '$col', 'width': '64', 'height': '64', 'pitch': '256', 'format': 'p8',
                'palette': '$pal', 'paletteFormat': 'rgb444',
            }
            if key:
                texture['key'] = '0'
            fields = {
                'w': lambda linear, t, e: f'1 / ((1 - {t}) / s16(p + 10) + {t} / s16({e} + 10))',
                'u': lambda linear, t, e: perspective(lambda a: f's16({a} + 4)', t, e) + ' / 128',
                'v': lambda linear, t, e: perspective(lambda a: f's16({a} + 6)', t, e) + ' / 128',
            }
            if alpha is not None:
                fields['a'] = str(alpha)
            draw(f'$tex && {when}', note, fields, blend, texture)

        textured('(($m & 0x40) || ($m & 0x26) == 0)', 'none',
                 'Textured, opaque: 64 by 64 texels of 8 bits, 256 bytes a row, through one of 64 palettes picked by '
                 'the light (or the one palette, mode bit 0x80). Bit 0x40 corrects perspective per pixel.')
        textured('($m & 0x40) == 0 && ($m & 0x24) == 0 && ($m & 2)', 'key', 'Textured, index 0 transparent (bit 2).',
                 key=True)
        textured('($m & 0x40) == 0 && ((($m & 0x20) && ($m & 2) == 0) || (($m & 0x20) == 0 && ($m & 4)))', 'alpha',
                 'Textured, half and half with the picture (bit 4), or every other pixel (bit 0x20).', alpha=128)
        textured('($m & 0x40) == 0 && ($m & 0x20) && ($m & 2)', 'alpha',
                 'Textured, every other pixel, index 0 transparent.', alpha=128, key=True)

        ramp_texture = {'pixels': '$col', 'width': '32', 'height': '1', 'pitch': '64', 'format': 'rgb444'}
        ramp_fields = {'u': lambda linear, t, e: f'{linear(lambda a: f"s16({a} + 8)")} / 32 + 0.5', 'v': '0.5'}
        draw('$tex == 0 && ($m & 0x24) == 0 && ($m & 0x80) && $ramp',
             'Untextured, shaded: each pixel takes the colour ramp entry (32 entries of 12 bits) of the shade '
             'interpolated across the triangle, dithered; the ramp is drawn as a texture.',
             ramp_fields, 'none', ramp_texture)
        draw('$tex == 0 && ($m & 0x20) && $ramp', 'Untextured, shaded, every other pixel (bit 0x20): drawn as half '
             'and half.', dict(ramp_fields, a='128'), 'alpha', ramp_texture)

        flat = {'r': channel(8), 'g': channel(4), 'b': channel(0)}
        draw('$tex == 0 && ($m & 0x24) == 0 && ($m & 0x80) == 0 && $ramp == 0',
             'Untextured, one colour: the material\'s 12-bit colour through the light.', flat, 'none')
        draw('$tex == 0 && ($m & 0x24) && $ramp == 0',
             'Untextured, one colour, half and half (bit 4) or every other pixel (bit 0x20).', dict(flat, a='128'),
             'alpha')
    return out


def main():
    profile = {
        'engine': 'exient',
        'about': "Exient's software renderer (SSX Out of Bounds): triangles sorted far to near, each drawn by one of "
                 'two functions through a span filler picked by the material: 8-bit textures with a palette per '
                 'light level, colour ramps, flat colours, half-transparent and keyed variants.',
        'viewport': {'width': VIEW_WIDTH, 'height': SCREEN_HEIGHT},
        'images': [{'name': image['name'], 'hash': image['hash'], 'game': image['game'], 'hooks': hooks(image)}
                   for image in IMAGES],
    }
    out = sys.argv[1] if len(sys.argv) > 1 else 'catalog/enhance/exient.json'
    with open(out, 'w') as fh:
        json.dump(profile, fh, indent=2)
        fh.write('\n')


if __name__ == '__main__':
    main()
