#!/usr/bin/env python3
"""Write catalog/enhance/exient.json from a table of addresses per image.

    python3 -I tools/re/exient_profile.py [OUT]

Exient's renderer (SSX Out of Bounds, WWE Aftershock) walks a list of
polygons sorted far to near and hands each to a triangle or a quad function
with r0 the renderer, r1 the polygon's vertices and r2 the material. The
material picks a span filler, so a draw is a hook for each kind of filler at
each of the two functions, told apart by `when`. They are written once here;
an image is a row of IMAGES. docs/enhancements.md (Engine notes, Exient)
explains every address and field.
"""
import json
import sys

# The kinds of span filler. SSX's material says which by its mode bits (the
# filler table's own tests, in this order); WWE's material holds the filler's
# address, so there the kind is told by the filler's offset in the code.
SSX_KINDS = {
    'textured': '$tex && (($m & 0x40) || ($m & 0x26) == 0)',
    'keyed': '$tex && ($m & 0x40) == 0 && ($m & 0x24) == 0 && ($m & 2)',
    'half': '$tex && ($m & 0x40) == 0 && ((($m & 0x20) && ($m & 2) == 0) || (($m & 0x20) == 0 && ($m & 4)))',
    'half-keyed': '$tex && ($m & 0x40) == 0 && ($m & 0x20) && ($m & 2)',
    'ramp': '$tex == 0 && ($m & 0x24) == 0 && ($m & 0x80) && $ramp',
    'ramp-half': '$tex == 0 && ($m & 0x20) && $ramp',
    'flat': '$tex == 0 && ($m & 0x24) == 0 && ($m & 0x80) == 0 && $ramp == 0',
    'flat-half': '$tex == 0 && ($m & 0x24) && $ramp == 0',
}
WWE_FILLERS = {
    'textured': [0x64600, 0x63a80],    # palette by the light; palette row per pixel (mode bit 0x80)
    'keyed': [0x650b8],
    'half': [0x66d28, 0x6599c],        # half and half; every other pixel
    'half-keyed': [0x66324],
    'direct': [0x63360],               # 16-bit texels, no palette (mode bit 0x40)
    'ramp': [0x685f0],
    'flat': [0x681e4],
    'flat-half': [0x67bf8],
}

IMAGES = [
    {
        'name': '6R65.app', 'hash': '0x4E81FA0B', 'game': 'ssx-out-of-bounds',
        'begin': 0x70394,           # empties the renderer's sorted list: the 3D of a frame starts
        'darken': 0xa0bf8,          # halves every pixel of a rectangle: the dimming behind a menu
        'polygons': [0x62da0, 0x60734],    # a triangle and a quad (mode bit 0x10 picks the triangle)
        # Offsets inside the renderer object.
        'view': 0x10,               # the 3D view's first pixel (16 rows into the screen buffer)
        'pitch': 0x18,              # bytes a row
        'screen': 0xb854,           # the screen object; its +8 is the screen buffer
        'light': 0xb95c,            # the light of the polygon being drawn (512 is the colour as it is)
        # The material: texture (or ramp, or colour), palettes, mode.
        'material': {'texture': 0x18, 'palette': 0x1c, 'mode': 0x20},
        # A vertex: 12 bytes, x and y in quarter pixels of the view, u and v in 128ths of a texel, the shade, the
        # depth. {a} is the vertex's address.
        'vertex': {'size': 12, 'x': 's16({a}) / 4', 'y': 's16({a} + 2) / 4', 'top': 's16({a} + 2)',
                   'u': 's16({a} + 4) / 128', 'v': 's16({a} + 6) / 128', 'shade': 's16({a} + 8)',
                   'w': 's16({a} + 10)'},
        'kinds': SSX_KINDS,
        'lit': True,                # an untextured colour goes through the light function
        'clip': True,               # the view is smaller than the screen: clip at its top
    },
]
# The Polish release: the same code, other text, so another hash.
IMAGES.append(dict(IMAGES[0], hash='0x299798D8', game='ssx-out-of-bounds-pl'))

IMAGES.append({
    'name': '6RAA.APP', 'hash': '0x1CAE5616', 'game': 'wwe-aftershock',
    'begin': 0x6cfbc,
    'darken': 0x86c1c,
    # The match's frame function (0x7d26c) draws the 3D in two passes with 2D between them, emptying the list
    # before each: only the first starts a frame.
    'begin_when': 'lr - (pc - 0x6cfbc) != 0x7d404',
    'polygons': [0x624f4, 0x60a90],
    'view': 0x10,                   # here the screen buffer itself: the view is the whole screen
    'pitch': 0x18,
    'screen': None,
    'light': 0x2b5c,
    'material': {'texture': 0x28, 'palette': 0x2c, 'mode': 0x30, 'filler': 0x3c},
    # 20 bytes: x and y in 64ths of a screen pixel, u and v in 128ths of a texel, the shade (32 bits each).
    'vertex': {'size': 20, 'x': 's32({a}) / 64', 'y': 's32({a} + 4) / 64', 'top': 's32({a} + 4)',
               'u': 's32({a} + 8) / 128', 'v': 's32({a} + 12) / 128', 'shade': 's32({a} + 16)', 'w': None},
    'kinds': {kind: '(' + ' || '.join(f'$f == {offset:#x}' for offset in offsets) + ')'
              for kind, offsets in WWE_FILLERS.items()},
    'lit': False,                   # its colour function returns the colour as it is
    'clip': False,
})

VIEW_WIDTH, VIEW_HEIGHT, SCREEN_HEIGHT = 176, 176, 208


def hexa(value):
    return f'{value:#x}'


def channel(shift, lit):
    """A 4-bit channel of the material's colour, as 0 to 255; through the game's light function when `lit`.

    For a light L of 512 or less a channel n becomes n * (L + 1024) / 1536,
    above 512 it goes towards 16 by (L - 512) / 1536, rounded down both times.
    """
    n = f'(($col >> {shift}) & 15)' if shift else '($col & 15)'
    if not lit:
        return f'{n} * 17'
    x = f'sel($L <= 512, {n} * ($L + 1024), {n} * 1536 + (16 - {n}) * ($L - 512))'
    return f'min(15, (({x}) - ({x}) % 1536) / 1536) * 17'


def chain(values):
    """sel(i == 0, v0, sel(i == 1, v1, ...)): a value per vertex slot."""
    text = values[-1]
    for n in range(len(values) - 2, -1, -1):
        text = f'sel(i == {n}, {values[n]}, {text})'
    return text


def clip_vars(vertex, half, corners):
    """Set hooks that clip one triangle of a polygon at the top of the view (y 0 of its coordinates).

    The triangle (corners: three vertex numbers of the polygon) becomes a fan of six slots, two per corner: the
    corner itself when it is inside, otherwise the points where the outline leaves it towards the corner before and
    the corner after (when that one is outside too, towards the third). Slot s is corner s // 2 moved by $tH_s
    (0 to 1) towards the vertex at $eH_s. The key fill cannot be clipped at the top: the black bar above the view is
    in the target.
    """
    size, top = vertex['size'], vertex['top']
    address = [f'r1 + {size * c}' for c in corners]
    ends, moves = {}, {}
    for slot in range(6):
        k, towards_next = slot // 2, slot % 2
        b = (k + 1) % 3 if towards_next else (k + 2) % 3
        c = 3 - k - b
        ends[f'e{half}_{slot}'] = f'sel({top.format(a=address[b])} >= 0, {address[b]}, {address[c]})'
        ya = top.format(a=address[k])
        moves[f't{half}_{slot}'] = f'sel({ya} >= 0, 0, {ya} / ({ya} - {top.format(a=f"$e{half}_{slot}")}))'
    return ends, moves


def fields_of(vertex, kind, extra, clip, half):
    """The fields of a draw: position, and u, v, w for a texture (`kind` 'texture'), u for a ramp ('ramp')."""
    if not clip:
        out = {'x': vertex['x'].format(a='p'), 'y': vertex['y'].format(a='p') + ' + $yo'}
        if kind == 'texture':
            if vertex['w']:
                out['w'] = vertex['w'].format(a='p')
            out['u'] = vertex['u'].format(a='p')
            out['v'] = vertex['v'].format(a='p')
        elif kind == 'ramp':
            out['u'] = f'{vertex["shade"].format(a="p")} / 32 + 0.5'
            out['v'] = '0.5'
        out.update(extra)
        return out

    # Clipped: `p` is the slot's corner, T how far it moves towards the vertex at E.
    t = chain([f'$t{half}_{slot}' for slot in range(6)])
    e = chain([f'$e{half}_{slot}' for slot in range(6)])

    def linear(template):
        a, b = template.format(a='p'), template.format(a=e)
        return f'({a} + {t} * ({b} - {a}))'

    def perspective(template):
        """With perspective, as the redraw interpolates across the triangle."""
        w = vertex['w']
        wa, wb = w.format(a='p'), w.format(a=e)
        q = f'((1 - {t}) / {wa} + {t} / {wb})'
        return f'((1 - {t}) * {template.format(a="p")} / {wa} + {t} * {template.format(a=e)} / {wb}) / {q}'

    out = {'x': linear(vertex['x']), 'y': linear(vertex['y']) + ' + $yo'}
    if kind == 'texture':
        out['w'] = f'1 / ((1 - {t}) / {vertex["w"].format(a="p")} + {t} / {vertex["w"].format(a=e)})'
        out['u'] = perspective(vertex['u'])
        out['v'] = perspective(vertex['v'])
    elif kind == 'ramp':
        out['u'] = f'{linear(vertex["shade"])} / 32 + 0.5'
        out['v'] = '0.5'
    out.update(extra)
    return out


def hooks(image):
    hx = hexa
    mat, vertex = image['material'], image['vertex']
    screen = f'u32(u32(r0 + {hx(image["screen"])}) + 8)' if image['screen'] else f'u32(r0 + {hx(image["view"])})'
    rows_down = f'(u32(r0 + {hx(image["view"])}) - {screen}) / u32(r0 + {hx(image["pitch"])})'
    target = {
        'pixels': screen,
        'width': str(VIEW_WIDTH),
        'height': f'{rows_down} + {VIEW_HEIGHT}' if image['clip'] else str(SCREEN_HEIGHT),
        'pitch': f'u32(r0 + {hx(image["pitch"])})',
        'format': 'rgb444',
    }
    out = [{
        'at': hx(image['begin']), 'do': 'begin',
        'note': ('The 3D of a frame starts: the sorted list of polygons is emptied. r0 is the renderer. The target is '
                 'the screen buffer from its first row to the last row of the view (176 by 176, 16 rows down in a '
                 'race), so that the key never covers the black bar below it.') if image['clip'] else
                ('The 3D of a frame starts: the sorted list of polygons is emptied. r0 is the renderer, whose +0x10 '
                 'is the screen buffer: the view is the whole screen.'),
        'target': target,
    }]
    if image.get('begin_when'):
        out[0]['when'] = image['begin_when']
    # A menu over the 3D (the pause menu, the end of a match) dims the whole picture after the 3D is drawn, which
    # turns the key colour into a dark purple the layer cannot find. So the polygons are left to the game for a frame
    # after any dimming: the frames are counted, and the dimming function notes the frame it ran in.
    count = {'at': hx(image['begin']), 'do': 'set', 'note': 'Counts the frames.', 'vars': {'fno': '$fno + 1'}}
    if image.get('begin_when'):
        count['when'] = image['begin_when']
    out.append(count)
    out.append({'at': hx(image['darken']), 'do': 'set',
                'note': 'Dims a rectangle of the picture (behind a menu): the polygons are left to the game while it '
                        'is used.',
                'vars': {'dimmed': '$fno'}})
    for n, at_value in enumerate(image['polygons']):
        at = hx(at_value)
        first = n == 0
        corners = 3 if first else 4
        size = vertex['size']
        mean = '(' + ' + '.join(vertex['shade'].format(a=f'r1 + {size * k}') for k in range(corners)) + f') / {corners}'
        variables = {
            'm': f'u32(r2 + {hx(mat["mode"])})',
            'col': f'u32(r2 + {hx(mat["texture"])})',
            'L': f'u32(r0 + {hx(image["light"])})',
            'yo': rows_down if image['clip'] else '0',
        }
        if 'filler' in mat:
            # The filler this material uses, as an offset in this image's code (pc is where the hook is).
            variables['f'] = f'u32(r2 + {hx(mat["filler"])}) - (pc - {at})'
        out.append({
            'at': at, 'do': 'set',
            'note': (f'A triangle: r0 the renderer, r1 three vertices of {size} bytes, r2 the material '
                     f'(+{hx(mat["texture"])} texture or colour, +{hx(mat["palette"])} palettes, +{hx(mat["mode"])} '
                     'mode).') if first else 'A quad: the same arguments, with four vertices.',
            'vars': variables,
        })
        if 'filler' in mat:
            rows = '$f == 0x63a80'
        else:
            # Bit 0x80 with the plain or perspective fillers.
            rows = '($m & 0x80) && (($m & 0x40) || ($m & 0x26) == 0)'
        out.append({
            'at': at, 'do': 'set',
            'vars': {
                'tex': '($m & 1) == 0',
                # The palette row picked per pixel by the interpolated shade (32 rows of 256 from the palettes),
                # approximated by the row of the mean shade.
                'rows': rows,
                'shade': mean,
                # Untextured: the material's texture word is a colour ramp's address or a 12-bit colour.
                'ramp': '$col >= 0x10000',
                # Nothing was dimmed in the frame before.
                'clear': '$fno - $dimmed > 1',
            },
        })
        out.append({
            'at': at, 'do': 'set',
            'vars': {
                'pal': f'u32(r2 + {hx(mat["palette"])}) + sel($rows, min(31, max(0, sar($shade, 5))), '
                       'sel($m & 0x80, 0, sar($L, 5))) * 512',
            },
        })
        halves = [None]
        if image['clip']:
            halves = [(0, 1, 2)] if first else [(0, 1, 2), (0, 2, 3)]
            for half, corners_of_half in enumerate(halves):
                ends, moves = clip_vars(vertex, half, corners_of_half)
                note = ('Clipping at the top of the view: where each corner of the triangle moves to.' if half == 0
                        else 'The same for the quad\'s second triangle (vertices 0, 2, 3).')
                out.append({'at': at, 'do': 'set', 'note': note, 'vars': ends})
                out.append({'at': at, 'do': 'set', 'vars': moves})

        def draw(kind, note, field_kind, extra, blend, texture=None):
            when = image['kinds'].get(kind)
            if when is None:
                return
            when = f'({when})'
            for half, corners_of_half in enumerate(halves):
                hook = {'at': at, 'do': 'draw'}
                if first and half == 0:
                    hook['note'] = note
                if corners_of_half is None:
                    hook.update({'when': f'$clear && {when}', 'skip': True, 'mode': 'triangles' if first else 'fan',
                                 'count': str(corners), 'vertex': f'r1 + {size} * i'})
                else:
                    vertex_at = '((i - i % 2) / 2)' if half == 0 else 'sel(i < 2, 0, (i - i % 2) / 2 + 1)'
                    inside = ' || '.join(vertex['top'].format(a=f'r1 + {size * c}') + ' >= 0'
                                         for c in corners_of_half)
                    hook.update({'when': f'$clear && ({inside}) && {when}', 'skip': True, 'mode': 'fan', 'count': '6',
                                 'vertex': f'r1 + {size} * {vertex_at}'})
                hook['fields'] = fields_of(vertex, field_kind, extra, corners_of_half is not None, half)
                if texture:
                    hook['texture'] = texture
                hook.update({'blend': blend, 'depth': 'none'})
                out.append(hook)

        paletted = {
            'pixels': '$col', 'width': '64', 'height': '64', 'pitch': '256', 'format': 'p8',
            'palette': '$pal', 'paletteFormat': 'rgb444',
        }
        keyed = dict(paletted, key='0')
        draw('textured', 'Textured, opaque: 64 by 64 texels of 8 bits, 256 bytes a row, through one of 64 palettes '
             'picked by the light, or a row per pixel by the shade (mode bit 0x80).', 'texture', {}, 'none', paletted)
        draw('keyed', 'Textured, index 0 transparent (bit 2).', 'texture', {}, 'key', keyed)
        draw('half', 'Textured, half and half with the picture (bit 4), or every other pixel (bit 0x20).', 'texture',
             {'a': '128'}, 'alpha', paletted)
        draw('half-keyed', 'Textured, every other pixel, index 0 transparent.', 'texture', {'a': '128'}, 'alpha',
             keyed)
        draw('direct', 'Textured with 16-bit texels, 64 by 64, 512 bytes a row, no palette.', 'texture', {}, 'none',
             {'pixels': '$col', 'width': '64', 'height': '64', 'pitch': '512', 'format': 'rgb444'})

        ramp_texture = {'pixels': '$col', 'width': '32', 'height': '1', 'pitch': '64', 'format': 'rgb444'}
        draw('ramp', 'Untextured, shaded: each pixel takes the colour ramp entry (32 entries of 12 bits) of the shade '
             'interpolated across the polygon, dithered; the ramp is drawn as a texture.', 'ramp', {}, 'none',
             ramp_texture)
        draw('ramp-half', 'Untextured, shaded, every other pixel (bit 0x20): drawn as half and half.', 'ramp',
             {'a': '128'}, 'alpha', ramp_texture)

        flat = {'r': channel(8, image['lit']), 'g': channel(4, image['lit']), 'b': channel(0, image['lit'])}
        draw('flat', 'Untextured, one colour' + (': the material\'s 12-bit colour through the light.'
                                                 if image['lit'] else ': the material\'s 12-bit colour.'),
             'flat', flat, 'none')
        draw('flat-half', 'Untextured, one colour, half and half (bit 4) or every other pixel (bit 0x20).', 'flat',
             dict(flat, a='128'), 'alpha')
    return out


def main():
    profile = {
        'engine': 'exient',
        'about': "Exient's software renderer (SSX Out of Bounds, WWE Aftershock): polygons sorted far to near, each "
                 'drawn by a triangle or a quad function through a span filler the material picks: 8-bit textures '
                 'with a palette per light level, colour ramps, flat colours, half-transparent and keyed variants.',
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
