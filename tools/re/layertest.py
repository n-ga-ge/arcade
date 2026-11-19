#!/usr/bin/env python3
"""Test the GPU layer with a made-up scene, without a game's profile.

    python3 -I tools/re/layertest.py --control-port 8101 --out .scratch/layer [--scales 1,4] [--filter nearest] [--flat sharp]

It needs a session of tools/web/explore.mjs with any game running (the layer
draws when a guest presents its screen, and into that screen's texture). The
tool pauses the emulator, and for each scale:

  - switches the layer on (`PATCH /v1/enhance {"scale": N}`);
  - posts a frame (`POST /v1/enhance/test-frame`) with triangles in every
    blend mode, with depth, with a texture seen in perspective, a wall whose
    palette is chosen per pixel from eight (palette rows), and with a
    picture that stands in for the guest's screen: a sky, an overlay, and the
    key colour where the triangles belong;
  - reads the screen back at that scale (`GET /v1/screenshot?scale=N`) and
    compares it with the same scene drawn by `composite()` below, which states
    in plain Python what the layer has to show;
  - saves a screenshot of the page.

Then it checks that the picture at the highest scale is nearer to the scene
than the picture at scale 1 enlarged, which is what the layer is for.

The comparison is exact for the flat picture (`flat`, how the guest's own
picture is enlarged) `sharp` and `smooth`. With `--flat sharp` (the default)
the scene is then drawn once more at the highest scale with the pixel-art
scaler, which is not modelled here: it has to differ from the sharp picture
(it redraws edges), but only near edges of the picture (most pixels the same,
the mean difference small). Then everything is put back and the emulator
resumed.

Files in --out: layer-<N>x.png (the emulator's picture), reference-<N>x.png,
page-<N>x.png (what the page shows), layer-<N>x-scaler.png, frame.json (the
body that was posted).

`python3 -I tools/re/layertest.py --write FILE.json` only writes the frame.
"""
import argparse
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dbg  # noqa: E402
import render  # noqa: E402

WIDTH, HEIGHT = 176, 208
KEY = (255, 0, 255)
# How far the layer looks for a pixel that is not in the key colour, how far
# from the key colour a pixel can be that was mixed with it, and how much of
# the key colour makes a pixel one that may be.
REACH = 3
MIXED_REACH = 2
MIXED_FROM = 0.2
# Left, top, right and bottom of the line in steps in the picture's bar.
LINE = (8, 182, 48, 187)


def is_key(r, g, b):
    return r > 244 and g < 11 and b > 244


def key_share(r, g, b):
    """How much of a colour is the key colour, if the rest of it is grey."""
    return min(max((min(r, b) - g) / 255, 0.0), 1.0)


def scene():
    """(frame, textures) of the test scene; textures as {index: (width, height, RGBA bytes)}."""
    vertices, draws = [], []

    def vertex(x, y, z=0.0, w=1.0, u=0.0, v=0.0, colour=0xFFFFFFFF, row=0.0):
        return [x, y, z, w, u, v, colour, row]

    def add(corners, texture=-1, blend='none', depth='none'):
        draws.append({'first': len(vertices) // render.STRIDE, 'count': len(corners), 'texture': texture, 'blend': blend, 'depth': depth})
        for corner in corners:
            vertices.extend(corner)

    # A floor that runs away from the viewer: a texture of 8x8 texels repeated,
    # with perspective (w grows with the distance).
    near_left = vertex(4, 172, 1, 1, 0, 0)
    near_right = vertex(172, 172, 1, 1, 64, 0)
    far_right = vertex(118, 96, 8, 4, 64, 96)
    far_left = vertex(58, 96, 8, 4, 0, 96)
    add([near_left, near_right, far_right, near_left, far_right, far_left], texture=0, depth='less')

    # Two triangles through each other: only the depth test gets them right,
    # and the second is drawn first.
    add([vertex(30, 40, 6, colour=0xFF2060E0), vertex(110, 60, 2, colour=0xFF2060E0), vertex(40, 120, 6, colour=0xFF2060E0)],
        depth='less')
    add([vertex(100, 30, 6, colour=0xFFE0A020), vertex(20, 80, 2, colour=0xFFE0A020), vertex(120, 110, 6, colour=0xFFE0A020)],
        depth='less')

    # A triangle with a colour at each corner.
    add([vertex(120, 20, colour=0xFFFF0000), vertex(170, 30, colour=0xFF00FF00), vertex(140, 70, colour=0xFF0000FF)])

    # One of each blend mode over what is there.
    add([vertex(60, 60, colour=0x80FFFFFF), vertex(160, 80, colour=0x80FFFFFF), vertex(90, 150, colour=0x80FFFFFF)], blend='alpha')
    add([vertex(10, 130, colour=0xFF404040), vertex(70, 125, colour=0xFF404040), vertex(30, 168, colour=0xFF404040)], blend='add')
    add([vertex(110, 120, colour=0xFF80FF80), vertex(168, 128, colour=0xFF80FF80), vertex(150, 168, colour=0xFF80FF80)],
        blend='multiply')

    # A texture with holes.
    add([vertex(124, 76, u=0, v=0), vertex(164, 76, u=4, v=0), vertex(164, 116, u=4, v=4),
         vertex(124, 76, u=0, v=0), vertex(164, 116, u=4, v=4), vertex(124, 116, u=0, v=4)], texture=1, blend='key')

    # A wall in perspective whose texels are indices into a table of eight
    # palettes, the palette chosen per pixel by a row running from 0 at the
    # near edge to almost 8 at the far one (the light across a wall).
    add([vertex(4, 2, 0, 1, 0, 0, row=0), vertex(60, 10, 0, 3, 16, 0, row=7.99), vertex(60, 26, 0, 3, 16, 8, row=7.99),
         vertex(4, 2, 0, 1, 0, 0, row=0), vertex(60, 26, 0, 3, 16, 8, row=7.99), vertex(4, 34, 0, 1, 0, 8, row=0)], texture=2)

    rows = 8
    indices = bytes((x + y) % 3 for y in range(8) for x in range(8))
    table = bytearray()
    for r in range(rows):
        entries = [(r * 30, 40, 40, 255), (40, r * 30, 40, 255), (200, 200, r * 30, 255)] + [(0, 0, 0, 255)] * 253
        table += b''.join(bytes(e) for e in entries)
    # The reference reads it as the emulator's texture route gives it: the
    # picture through each palette, one under the other.
    stacked = b''.join(bytes(table[(r * 256 + i) * 4:(r * 256 + i) * 4 + 4]) for r in range(rows) for i in indices)

    checker = bytearray()
    for y in range(8):
        for x in range(8):
            checker += bytes((230, 230, 210, 255)) if (x // 4 + y // 4) % 2 else bytes((60, 90, 60, 255))
    holes = bytearray()
    for y in range(4):
        for x in range(4):
            holes += bytes((250, 240, 60, 255)) if (x + y) % 2 else bytes((0, 0, 0, 0))

    frame = {'width': WIDTH, 'height': HEIGHT, 'vertices': vertices, 'draws': draws,
             'vertexLayout': ['x', 'y', 'z', 'w', 'u', 'v', 'color', 'row'],
             'textures': [{'width': 8, 'height': 8}, {'width': 4, 'height': 4},
                          {'width': 8, 'height': 8, 'paletteRows': rows, 'indices': indices, 'table': bytes(table)}]}
    return frame, {0: (8, 8, bytes(checker)), 1: (4, 4, bytes(holes)), 2: (8, 8 * rows, stacked)}


def picture(frame):
    """The stand-in for the guest's screen, as RGBA bytes.

    A sky, the key colour on every pixel a triangle touches (as the emulator
    fills it when it replaces a game's triangles), and an overlay that the
    game would have drawn afterwards: a bar at the bottom and a box in the
    middle of the 3D. In the bar, a shallow line in steps, for the pixel-art
    scaler to smooth.
    """
    out = bytearray()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            out += bytes((40 + y // 3, 90 + y // 2, 200 - y // 4, 255))

    # Touched: any of 8x8 points of the pixel is inside a triangle.
    bare = dict(frame, draws=[dict(d, texture=-1, blend='none', depth='none') for d in frame['draws']])
    _, _, _, coverage = render.render(bare, {}, 8)
    for y in range(HEIGHT):
        for x in range(WIDTH):
            if any(coverage[(y * 8 + sy) * WIDTH * 8 + x * 8 + sx] for sy in range(8) for sx in range(8)):
                out[(y * WIDTH + x) * 4:(y * WIDTH + x) * 4 + 3] = bytes(KEY)

    def box(left, top, right, bottom, colour):
        for y in range(top, bottom):
            for x in range(left, right):
                edge = x in (left, right - 1) or y in (top, bottom - 1)
                out[(y * WIDTH + x) * 4:(y * WIDTH + x) * 4 + 3] = bytes((255, 255, 255) if edge else colour)

    box(0, 180, WIDTH, HEIGHT, (30, 30, 40))
    for n in range(8):
        box(8 + n * 20, 188, 22 + n * 20, 200, (200, 60 + n * 20, 40))
    box(76, 84, 100, 100, (20, 20, 20))
    for x in range(LINE[0], LINE[2]):
        y = LINE[3] - 1 - (x - LINE[0]) // 8
        out[(y * WIDTH + x) * 4:(y * WIDTH + x) * 4 + 3] = bytes((230, 230, 230))

    # The soft edge of an overlay: a dark line two pixels wide under the box,
    # drawn over what is there with half and with a quarter of its strength.
    for y, strength in ((100, 0.5), (101, 0.25)):
        for x in range(76, 100):
            at = (y * WIDTH + x) * 4
            for channel in range(3):
                out[at + channel] = int(out[at + channel] * (1 - strength) + 20 * strength)
    return bytes(out)


def body_of(frame, textures, screen):
    """The JSON to post: the frame with its textures' pixels and the picture inline."""
    body = dict(frame)
    body['textures'] = []
    for n, t in enumerate(frame['textures']):
        if 'indices' in t:
            # Palette rows: the texel indices and the table, as they are.
            body['textures'].append(dict(t, indices=base64.b64encode(t['indices']).decode(),
                                         table=base64.b64encode(t['table']).decode()))
        else:
            body['textures'].append(dict(t, data=base64.b64encode(textures[n][2]).decode()))
    body['screen'] = {'width': WIDTH, 'height': HEIGHT, 'data': base64.b64encode(screen).decode()}
    return body


def composite(frame, textures, screen, scale, smooth=False):
    """RGBA of what the layer shows for a frame and the guest's picture, at a whole scale.

    The rules:
      1. under the triangles is the picture, where a pixel in the key colour
         takes the nearest pixel (by its centre, at most REACH pixels away)
         that has nothing of the key colour; with none in reach it is black;
      2. the triangles are drawn as render.py draws them;
      3. over them comes the picture again, without its pixels in the key colour.
    A pixel that has a good part of the key colour in it (`key_share`) and a
    pixel in the key colour at most MIXED_REACH away was mixed with the key
    colour by the game: the soft edge of something it drew over its 3D. Under
    the triangles it counts as in the key colour; over them it is added, less
    the key colour's part, to that part of what is there.
    With `smooth`, the picture is taken linearly between its four pixels
    around a point, leaving out those with the key colour in them.
    """
    width, height = WIDTH * scale, HEIGHT * scale
    colours = [screen[at * 4:at * 4 + 3] for at in range(WIDTH * HEIGHT)]
    key = [is_key(*c) for c in colours]
    share = [1.0 if key[at] else key_share(*colours[at]) for at in range(WIDTH * HEIGHT)]
    keyish = [s >= MIXED_FROM for s in share]

    def near_key(cx, cy):
        return any(key[y * WIDTH + x]
                   for y in range(max(cy - MIXED_REACH, 0), min(cy + MIXED_REACH, HEIGHT - 1) + 1)
                   for x in range(max(cx - MIXED_REACH, 0), min(cx + MIXED_REACH, WIDTH - 1) + 1))

    mixed = [not key[at] and keyish[at] and near_key(at % WIDTH, at // WIDTH) for at in range(WIDTH * HEIGHT)]

    def sample(gx, gy, cell):
        if not smooth:
            return colours[cell]
        fx, fy = gx - 0.5, gy - 0.5
        bx, by = int(fx // 1), int(fy // 1)
        tx, ty = fx - bx, fy - by
        total, r, g, b = 0.0, 0.0, 0.0, 0.0
        for j in (0, 1):
            for i in (0, 1):
                at = min(max(by + j, 0), HEIGHT - 1) * WIDTH + min(max(bx + i, 0), WIDTH - 1)
                weight = (tx if i else 1 - tx) * (ty if j else 1 - ty)
                if not keyish[at]:
                    total += weight
                    r, g, b = r + colours[at][0] * weight, g + colours[at][1] * weight, b + colours[at][2] * weight
        return bytes((int(r / total + 0.5), int(g / total + 0.5), int(b / total + 0.5))) if total else colours[cell]

    under = bytearray(width * height * 4)
    over = {}
    for y in range(height):
        gy = (y + 0.5) / scale
        cy = min(int(gy), HEIGHT - 1)
        for x in range(width):
            gx = (x + 0.5) / scale
            cx = min(int(gx), WIDTH - 1)
            cell = cy * WIDTH + cx
            at = (y * width + x) * 4

            if mixed[cell]:
                s = share[cell]
                over[at] = (bytes((max(colours[cell][0] - int(s * 255 + 0.5), 0), colours[cell][1],
                                   max(colours[cell][2] - int(s * 255 + 0.5), 0))), s)
            elif not key[cell]:
                colour = sample(gx, gy, cell)
                over[at] = (colour, 0.0)

            if key[cell] or mixed[cell]:
                best, colour = None, b'\0\0\0'
                for dy in range(-REACH, REACH + 1):
                    for dx in range(-REACH, REACH + 1):
                        px, py = cx + dx, cy + dy
                        if px < 0 or py < 0 or px >= WIDTH or py >= HEIGHT or keyish[py * WIDTH + px]:
                            continue
                        distance = (px + 0.5 - gx) ** 2 + (py + 0.5 - gy) ** 2
                        if best is None or distance < best:
                            best, colour = distance, colours[py * WIDTH + px]

            under[at:at + 3] = colour
            under[at + 3] = 255

    _, _, out, _ = render.render(frame, textures, scale, canvas=under)
    for at, (colour, kept) in over.items():
        for channel in range(3):
            out[at + channel] = min(255, int(colour[channel] + out[at + channel] * kept + 0.5))
    return out


def difference(a, b):
    """(mean absolute difference a channel, share of pixels that differ by more than 48 in a channel)."""
    total = far = 0
    for at in range(0, len(a), 4):
        d = max(abs(a[at] - b[at]), abs(a[at + 1] - b[at + 1]), abs(a[at + 2] - b[at + 2]))
        total += abs(a[at] - b[at]) + abs(a[at + 1] - b[at + 1]) + abs(a[at + 2] - b[at + 2])
        far += d > 48
    pixels = len(a) // 4
    return total / (3 * pixels), far / pixels


def enlarge(rgba, width, height, factor):
    out = bytearray()
    for y in range(height):
        row = bytearray()
        for x in range(width):
            row += rgba[(y * width + x) * 4:(y * width + x) * 4 + 4] * factor
        out += row * factor
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--control-port', type=int, default=int(os.environ.get('RE_CONTROL_PORT', 8091)))
    parser.add_argument('--out', default='layer')
    parser.add_argument('--scales', default='1,4', help='whole numbers, the last being the one that has to be sharper')
    parser.add_argument('--filter', default='nearest', choices=['nearest', 'linear'],
                        help='the textures\' filter; the comparison is only exact enough to fail on with nearest')
    parser.add_argument('--flat', default='sharp', choices=['sharp', 'smooth'],
                        help='how the guest\'s picture is enlarged for the exact comparison')
    parser.add_argument('--write', help='only write the frame to this file')
    parser.add_argument('--keep', action='store_true', help='leave the last frame on screen and the emulator paused')
    args = parser.parse_args()

    frame, textures = scene()
    screen = picture(frame)
    body = body_of(frame, textures, screen)

    if args.write:
        Path(args.write).write_text(json.dumps(body))
        print(f'{len(frame["vertices"]) // (3 * render.STRIDE)} triangles written to {args.write}')
        return 0

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'frame.json').write_text(json.dumps(body))
    session = dbg.Session(args.control_port)
    scales = [int(s) for s in args.scales.split(',')]
    smooth = args.flat == 'smooth'

    def pageshot(name):
        # The page dims the picture under its "click for sound" note.
        hide = b'const o = document.getElementById("overlay"); if (o) o.hidden = true; return 1'
        urllib.request.urlopen(urllib.request.Request(f'{session.base}/eval', data=hide, method='POST'), timeout=60).read()
        with urllib.request.urlopen(f'{session.base}/pageshot?name={name}', timeout=120) as res:
            source = Path(res.read().decode().strip())
        if source.exists() and source.resolve() != (out / source.name).resolve():
            (out / source.name).write_bytes(source.read_bytes())

    ok = True
    shots = {}
    session.call('POST', '/v1/emulator/pause')
    try:
        for scale in scales:
            status = session.call('PATCH', '/v1/enhance', {'scale': scale, 'filter': args.filter, 'flat': args.flat})
            session.call('POST', '/v1/enhance/test-frame', body)
            status = session.call('GET', '/v1/enhance')
            if status['scale'] != scale:
                print(f'FAIL the layer reports scale {status["scale"]}, asked for {scale}')
                ok = False

            code, data = session.raw('GET', f'/v1/screenshot?scale={scale}')
            if code >= 400:
                raise SystemExit(f'screenshot: {data.decode("latin1")[:200]}')
            (out / f'layer-{scale}x.png').write_bytes(data)
            width, height, shot = dbg.read_png(data)
            if (width, height) != (WIDTH * scale, HEIGHT * scale):
                raise SystemExit(f'the screenshot at scale {scale} is {width}x{height}')
            shots[scale] = shot
            pageshot(f'page-{scale}x')

            reference = composite(frame, textures, screen, scale, smooth)
            dbg.write_png(out / f'reference-{scale}x.png', width, height, reference)
            mean, far = difference(shot, reference)
            # Edges fall on other pixels by the rasterisers' rounding, and a
            # blend is rounded differently: a wrong mode, a missing texture or
            # a picture upside down are far above this.
            good = args.filter != 'nearest' or (mean < 2.5 and far < 0.02)
            ok &= good
            print(f'{"ok  " if good else "FAIL"} scale {scale}: differs from the reference by {mean:.2f} of 255 a channel, '
                  f'{far * 100:.2f}% of the pixels by more than 48')

        code, data = session.raw('GET', '/v1/screenshot')
        width, height, _ = dbg.read_png(data)
        good = (width, height) == (WIDTH, HEIGHT)
        ok &= good
        print(f'{"ok  " if good else "FAIL"} GET /v1/screenshot is {width}x{height} with the layer at {scales[-1]}x')
        (out / 'screenshot.png').write_bytes(data)

        if len(scales) > 1 and scales[0] == 1:
            top = scales[-1]
            reference = composite(frame, textures, screen, top, smooth)
            sharp, _ = difference(shots[top], reference)
            coarse, _ = difference(enlarge(shots[1], WIDTH, HEIGHT, top), reference)
            good = sharp < coarse * 0.6
            ok &= good
            print(f'{"ok  " if good else "FAIL"} against the scene at {top}x: the layer at {top}x differs by {sharp:.2f}, '
                  f'the layer at 1x enlarged by {coarse:.2f}')

        if args.flat == 'sharp' and scales[-1] > 1:
            top = scales[-1]
            session.call('PATCH', '/v1/enhance', {'scale': top, 'filter': args.filter, 'flat': 'scaler'})
            session.call('POST', '/v1/enhance/test-frame', body)
            code, data = session.raw('GET', f'/v1/screenshot?scale={top}')
            if code >= 400:
                raise SystemExit(f'screenshot: {data.decode("latin1")[:200]}')
            (out / f'layer-{top}x-scaler.png').write_bytes(data)
            _, _, scaled = dbg.read_png(data)
            mean, far = difference(scaled, shots[top])
            changed = sum(1 for at in range(0, len(scaled), 4)
                          if scaled[at:at + 3] != shots[top][at:at + 3]) / (len(scaled) // 4)
            # The scene's picture is mostly rectangles, whose corners the
            # scaler rounds; it has to smooth the line in steps, and change
            # little else.
            left, top_row, right, bottom = (v * top for v in LINE)
            line = [(y * WIDTH * top + x) * 4 for y in range(top_row, bottom) for x in range(left, right)]
            smoothed = sum(1 for at in line if scaled[at:at + 3] != shots[top][at:at + 3]) / len(line)
            good = smoothed > 0.01 and changed < 0.1 and mean < 3
            ok &= good
            print(f'{"ok  " if good else "FAIL"} the scaler at {top}x: {smoothed * 100:.1f}% of the pixels around the line in '
                  f'steps and {changed * 100:.1f}% of all differ from the sharp picture, by {mean:.2f} of 255 a channel on average')
    finally:
        if not args.keep:
            session.call('DELETE', '/v1/enhance/test-frame')
            session.call('PATCH', '/v1/enhance', {'scale': 0})
            session.call('POST', '/v1/emulator/resume')

    print('PASS' if ok else 'FAIL', f'(pictures in {out})')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
