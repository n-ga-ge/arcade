#!/usr/bin/env python3
"""Draw a captured frame at any scale, slowly and plainly: the reference for an enhancement profile.

    python3 -I tools/re/render.py FRAME.json --scale 4 --out FILE.png [--textures DIR] [--background RRGGBB]

FRAME.json is what `dbg.py enhance frame --out` saved. Textures are read from
DIR as texture-<index>.png (what `dbg.py enhance texture` saves); a draw whose
texture is missing is drawn with its vertex colours alone.

This is not what the player uses (that is the GPU layer in the emulator). It
exists so that a profile can be proven on its own: if the triangles a profile
captures, drawn here and scaled back down, give the picture the game drew
itself, the profile reads the engine correctly. tools/re/enhancetest.py does
that comparison.

The rules, which the GPU layer follows too:
  - x and y are guest pixels, the origin is the top left corner, a pixel is
    covered when its centre is inside the triangle;
  - u and v are texels; textures repeat; the nearest texel is taken;
  - w is the divisor of the perspective projection: when the three w of a
    triangle differ, u, v and the colour are interpolated with perspective;
  - colour is 0xAARRGGBB and multiplies the texel;
  - blend `none` replaces, `key` replaces unless the texel's alpha is zero,
    `alpha` mixes by alpha, `add` and `multiply` do that, `subtract` takes the
    colour from the pixel and stops at black;
  - depth `none` draws in order; the others compare z as named and write it.
"""
import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dbg  # noqa: E402

STRIDE = 7


def render(frame, textures, scale, background=(0, 0, 0), canvas=None):
    """(width, height, RGBA bytearray, coverage bytearray) of a frame drawn at a whole scale.

    `textures` maps a texture index to (width, height, RGBA bytes). Coverage is
    1 where any triangle drew. The triangles are drawn over `canvas` (RGBA of
    the scaled size) when one is given, over the background colour otherwise.
    """
    width, height = frame['width'] * scale, frame['height'] * scale
    out = bytearray(canvas) if canvas is not None else bytearray(bytes((*background, 255)) * (width * height))
    coverage = bytearray(width * height)
    depth_buffer = None
    vertices = frame['vertices']

    for draw in frame['draws']:
        texture = textures.get(draw['texture'])
        blend, depth = draw['blend'], draw['depth']
        if depth != 'none' and depth_buffer is None:
            start = float('inf') if depth in ('less', 'lequal') else float('-inf')
            depth_buffer = [start] * (width * height)
        if texture:
            tw, th, texels = texture

        for first in range(draw['first'], draw['first'] + draw['count'], 3):
            corner = [vertices[(first + k) * STRIDE:(first + k + 1) * STRIDE] for k in range(3)]
            (x0, y0, z0, w0, u0, v0, c0), (x1, y1, z1, w1, u1, v1, c1), (x2, y2, z2, w2, u2, v2, c2) = corner
            x0, y0, x1, y1, x2, y2 = (value * scale for value in (x0, y0, x1, y1, x2, y2))
            area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if area == 0:
                continue

            left, right = max(0, int(min(x0, x1, x2))), min(width - 1, int(max(x0, x1, x2)) + 1)
            top, bottom = max(0, int(min(y0, y1, y2))), min(height - 1, int(max(y0, y1, y2)) + 1)
            if left > right or top > bottom:
                continue

            # With perspective, interpolate everything divided by w, and 1/w.
            perspective = not (w0 == w1 == w2) and w0 > 0 and w1 > 0 and w2 > 0
            q0, q1, q2 = (1 / w0, 1 / w1, 1 / w2) if perspective else (1.0, 1.0, 1.0)
            channels = []
            for shift in (16, 8, 0, 24):
                channels.append([((c >> shift) & 255) * q for c, q in ((c0, q0), (c1, q1), (c2, q2))])
            flat = c0 == c1 == c2
            us, vs = (u0 * q0, u1 * q1, u2 * q2), (v0 * q0, v1 * q1, v2 * q2)
            inverse = 1 / area

            for y in range(top, bottom + 1):
                py = y + 0.5
                row = y * width
                for x in range(left, right + 1):
                    px = x + 0.5
                    b0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inverse
                    b1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inverse
                    b2 = 1 - b0 - b1
                    if b0 < 0 or b1 < 0 or b2 < 0:
                        continue

                    at = row + x
                    if depth != 'none':
                        z = b0 * z0 + b1 * z1 + b2 * z2
                        old = depth_buffer[at]
                        if ((depth == 'less' and not z < old) or (depth == 'lequal' and not z <= old)
                                or (depth == 'greater' and not z > old) or (depth == 'gequal' and not z >= old)):
                            continue

                    q = b0 * q0 + b1 * q1 + b2 * q2 if perspective else 1.0
                    if flat and not perspective:
                        r, g, b, a = (c0 >> 16) & 255, (c0 >> 8) & 255, c0 & 255, (c0 >> 24) & 255
                    else:
                        r, g, b, a = ((b0 * ch[0] + b1 * ch[1] + b2 * ch[2]) / q for ch in channels)

                    if texture:
                        tu = math.floor((b0 * us[0] + b1 * us[1] + b2 * us[2]) / q) % tw
                        tv = math.floor((b0 * vs[0] + b1 * vs[1] + b2 * vs[2]) / q) % th
                        texel = (tv * tw + tu) * 4
                        if blend == 'key' and texels[texel + 3] == 0:
                            continue
                        r = r * texels[texel] / 255
                        g = g * texels[texel + 1] / 255
                        b = b * texels[texel + 2] / 255
                        a = a * texels[texel + 3] / 255

                    pixel = at * 4
                    if blend == 'alpha':
                        keep = 1 - a / 255
                        r = r * a / 255 + out[pixel] * keep
                        g = g * a / 255 + out[pixel + 1] * keep
                        b = b * a / 255 + out[pixel + 2] * keep
                    elif blend == 'add':
                        r, g, b = r + out[pixel], g + out[pixel + 1], b + out[pixel + 2]
                    elif blend == 'multiply':
                        r, g, b = r * out[pixel] / 255, g * out[pixel + 1] / 255, b * out[pixel + 2] / 255
                    elif blend == 'subtract':
                        r, g, b = out[pixel] - r, out[pixel + 1] - g, out[pixel + 2] - b

                    out[pixel] = min(255, max(0, int(r)))
                    out[pixel + 1] = min(255, max(0, int(g)))
                    out[pixel + 2] = min(255, max(0, int(b)))
                    coverage[at] = 1
                    if depth != 'none':
                        depth_buffer[at] = z

    return width, height, out, coverage


def shrink(width, height, rgba, coverage, scale):
    """Average blocks of scale x scale pixels: (width, height, RGBA, covered) where covered is 1 for a block drawn all over."""
    w, h = width // scale, height // scale
    out = bytearray(w * h * 4)
    covered = bytearray(w * h)
    count = scale * scale
    for y in range(h):
        for x in range(w):
            r = g = b = seen = 0
            for sy in range(scale):
                at = (y * scale + sy) * width + x * scale
                for sx in range(scale):
                    pixel = (at + sx) * 4
                    r += rgba[pixel]
                    g += rgba[pixel + 1]
                    b += rgba[pixel + 2]
                    seen += coverage[at + sx]
            pixel = (y * w + x) * 4
            out[pixel:pixel + 4] = bytes((r // count, g // count, b // count, 255))
            covered[y * w + x] = 1 if seen == count else 0
    return w, h, out, covered


def compare(rgba_a, rgba_b, covered):
    """(share of pixels compared, mean absolute difference per channel over them, 0 to 255)."""
    total = diff = 0
    for at, on in enumerate(covered):
        if on:
            pixel = at * 4
            total += 1
            diff += (abs(rgba_a[pixel] - rgba_b[pixel]) + abs(rgba_a[pixel + 1] - rgba_b[pixel + 1])
                     + abs(rgba_a[pixel + 2] - rgba_b[pixel + 2]))
    return total / max(1, len(covered)), (diff / (3 * total)) if total else 255.0


def load_textures(frame, folder):
    textures = {}
    for index in range(len(frame['textures'])):
        path = Path(folder) / f'texture-{index}.png'
        if path.exists():
            textures[index] = dbg.read_png(path.read_bytes())
    return textures


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('frame')
    parser.add_argument('--scale', type=int, default=4)
    parser.add_argument('--out', required=True)
    parser.add_argument('--textures')
    parser.add_argument('--background', default='000000')
    args = parser.parse_args()

    frame = json.loads(Path(args.frame).read_text())
    textures = load_textures(frame, args.textures) if args.textures else {}
    width, height, rgba, _ = render(frame, textures, args.scale, tuple(bytes.fromhex(args.background)))
    dbg.write_png(args.out, width, height, rgba)
    print(f'{len(frame["vertices"]) // (3 * STRIDE)} triangles, {width}x{height}, written to {args.out}')


if __name__ == '__main__':
    main()
