#!/usr/bin/env python3
"""Write catalog/enhance/gameloft.json.

    python3 -I tools/re/gameloft_profile.py [OUT]

Gameloft's engine as Splinter Cell: Chaos Theory links it. The expressions are
long (a light level computed per corner, read back through the game's own
light table, a texel shift worked out from the plane gradients), so they are
written once here; edit this script, not the JSON. docs/enhancements.md
(Engine notes, Gameloft) explains every address and field.
"""
import json
import sys


def c444(e):
    """A 12-bit 0x0RGB colour as 0xFFRRGGBB."""
    return f"0xFF000000 | (({e}) & 0xf00) * 0x1100 | (({e}) & 0xf0) * 0x110 | (({e}) & 0xf) * 0x11"


def light_row(level):
    """The vertex colour for a light level: what the light table makes of white
    (16 rows of 4096 12-bit colours at $T; rows 11 to 15 leave white white)."""
    return c444(f"u16($T + 2 * (({level}) * 4096 + 0xfff))")


def boost(level):
    """What rows 12 to 15 add above the texture's own colour, for a second,
    added draw: the row's mid grey (0x888) over 8, less one, per channel."""
    e = f"u16($T + 2 * (({level}) * 4096 + 0x888))"
    return (f"0xFF000000 | max(0, (({e}) >> 8 & 15) - 8) * 0x200000"
            f" | max(0, (({e}) >> 4 & 15) - 8) * 0x2000 | max(0, (({e}) & 15) - 8) * 0x20")


def tex(C):
    """The texture of a draw context C: 8-bit indices into 256 words of 12-bit colour."""
    return {
        "pixels": f"u32({C} + 8)",
        "width": f"1 << u32({C} + 0x14)",
        "height": f"u32({C} + 0x10) + 1",
        "format": "p8",
        "palette": f"u32({C} + 0xc)",
        "paletteFormat": "rgb444",
        "paletteStride": 4,
    }


# The rasterisers fill row y from floor(left edge) to floor(right edge), the
# right one left out, and take each pixel's texel at its left edge (x, y). With
# the layer's pixel centres that is x - 0.499 and y + 0.5, and texel
# coordinates moved by about one pixel to the left (u - du/dx).
XO = "- 0.499"
XS = "0.999"


def corner_fields(colour, kind, G):
    """A corner p: {vertex pointer, u, v} with u and v in 16ths of a texel; the
    vertex has x, y (whole pixels) and the depth at +8. G: the gradients."""
    Z = "s32(u32(p) + 8)"
    if kind == "affine":
        # rounded by the game (it adds 127/256 before the shift); gradients of
        # u and v in 256ths of a texel a pixel
        u = f"s32(p + 4) / 16 + 0.5 - {XS} * s32({G}) / 256"
        v = f"s32(p + 8) / 16 + 0.5 - {XS} * s32({G} + 4) / 256"
    else:
        # whole texels (the game drops the 16ths); the gradients are of u/z,
        # v/z and 1/z with 1/z in units of 2^26/z
        U = "sar(s32(p + 4), 4)"
        V = "sar(s32(p + 8), 4)"
        u = f"{U} - {XS} * (256 * s32({G}) - {U} * s32({G} + 8)) * {Z} / 67108864"
        v = f"{V} - {XS} * (256 * s32({G} + 4) - {V} * s32({G} + 8)) * {Z} / 67108864"
    return {"x": f"s32(u32(p)) {XO}", "y": "s32(u32(p) + 4) + 0.5", "z": Z, "w": Z,
            "u": u, "v": v, "color": colour}


def world_level(G, p="p"):
    """The world's light at corner p: L = g0*u*v + g1*v + g2*u + g3 over whole
    texels (gradients +0x1c to +0x28); the level is (L + 2047) >> 12."""
    U = f"sar(s32({p} + 4), 4)"
    V = f"sar(s32({p} + 8), 4)"
    L = f"s32({G} + 0x1c) * {U} * {V} + s32({G} + 0x20) * {V} + s32({G} + 0x24) * {U} + s32({G} + 0x28)"
    return f"max(0, min(15, sar({L} + 2047, 12)))"


def world_draws(at, regs, vertex, G, C, mode, note, when=None):
    """A world polygon, and the same again added where its light brightens."""
    main = {"at": at, "do": "draw", "skip": True, "note": note,
            "mode": mode, "count": len(regs), "vertex": vertex,
            "fields": corner_fields(light_row(world_level(G)), "persp", G),
            "texture": tex(C), "blend": "none", "depth": "lequal"}
    extra = {"at": at, "do": "draw",
             "note": "The same polygon again, added, where its light is above the texture's own colour "
                     "(rows 12 to 15 of the light table brighten it).",
             "when": " || ".join(f"({world_level(G, r)}) > 11" for r in regs),
             "mode": mode, "count": len(regs), "vertex": vertex,
             "fields": corner_fields(boost(world_level(G)), "persp", G),
             "texture": tex(C), "blend": "add", "depth": "lequal"}
    if when:
        main["when"] = when
        extra["when"] = f"{when} && ({extra['when']})"
    return [main, extra]


def model_draws(at, kind, how):
    """A model triangle, and the same again added where its light brightens."""
    level = "(u32(u32(sp) + 4) >> 12) & 15"
    vertex = "sel(i == 0, r0, sel(i == 1, r1, r2))"
    return [
        {"at": at, "do": "draw", "skip": True, "when": "u8(r3 + 0x18)",
         "note": f"A model triangle, {kind}: r0 to r2 point to its corners, r3 the gradients (+0x18 nonzero: "
                 "drawable), [sp] the texture, the light level (+4, bits 12 to 15) and whether index 0 is transparent (+0x18).",
         "mode": "triangles", "count": 3, "vertex": vertex,
         "fields": corner_fields(light_row(level), how, "r3"),
         "texture": dict(tex("u32(sp)"), key="sel(u8(u32(sp) + 0x18), 0, 0x100)"),
         "blend": "key", "depth": "lequal"},
        {"at": at, "do": "draw", "when": f"u8(r3 + 0x18) && !u8(u32(sp) + 0x18) && ({level}) > 11",
         "note": "The same triangle again, added, when its light brightens the texture (rows 12 to 15) and it has "
                 "no transparent texels (their colour would be added too).",
         "mode": "triangles", "count": 3, "vertex": vertex,
         "fields": corner_fields(boost(level), how, "r3"),
         "texture": tex("u32(sp)"), "blend": "add", "depth": "lequal"},
    ]


def cross(a, b):
    """Twice the signed area of r1, a, b on screen."""
    X = lambda r: f"s32(u32({r}))"  # noqa: E731
    Y = lambda r: f"s32(u32({r}) + 4)"  # noqa: E731
    return f"(({X(a)} - {X('r1')}) * ({Y(b)} - {Y('r1')}) - ({Y(a)} - {Y('r1')}) * ({X(b)} - {X('r1')}))"


def splinter_cell():
    hooks = [
        {"at": "0x1007fc", "do": "begin",
         "note": "Draws the 3D scene's world, once a frame. r1: the renderer; its first word points to the frame "
                 "buffer's address (32-bit words while drawing, the 16-bit picture after the resolve).",
         "target": {"pixels": "u32(u32(r1))", "width": 176, "height": 208, "pitch": 352, "format": "rgb444"}},
        {"at": "0x1007fc", "do": "set",
         "note": "The light table (16 rows of 4096 12-bit colours) the resolve looks every pixel up in, and that "
                 "this frame has a 3D view.",
         "vars": {"T": "u32(u32(u32(r1 + 0x2724) + 4))", "view": 1}},
        {"at": "0x1007fc", "do": "set",
         "note": "Night vision and thermal vision rewrite the table (every colour to a green or a red ramp), which "
                 "no vertex colour can express: then nothing is captured and the game draws its 3D itself. The plain "
                 "table leaves pure red, green and blue as they are in row 11.",
         "vars": {"plain": "$T && u16($T + 2 * (11 * 4096 + 0xf00)) == 0xf00 && u16($T + 2 * (11 * 4096 + 0xf0)) == 0xf0"
                           " && u16($T + 2 * (11 * 4096 + 0xf)) == 0xf"}},
        {"at": "0x1181e4", "do": "set",
         "note": "The corners come in one of two orders: r0, r1, r3, r2 around the quad when r0 and r2 lie on the "
                 "same side of the line from r1 to r3, else r0, r1, r2, r3.",
         "vars": {"zig": f"{cross('r3', 'r0')} * {cross('r3', 'r2')} >= 0"}},
    ]
    hooks += world_draws(
        "0x1181e4", ("r0", "r1", "r2", "r3"),
        "sel(i == 0, r0, sel(i == 1, r1, sel(i == 2, sel($zig, r3, r2), sel($zig, r2, r3))))",
        "u32(sp)", "u32(sp + 4)", "fan",
        "A world quad: r0 to r3 point to its corners (vertex pointer, u and v in 16ths of a texel), in one of the "
        "two orders the `set` before tells apart. [sp]: the plane gradients, with the bilinear light at +0x1c; "
        "[sp+4]: the texture and buffer.")
    hooks += world_draws(
        "0x118dc8", ("r0", "r1", "r2"), "sel(i == 0, r0, sel(i == 1, r1, r2))", "r3", "u32(sp)", "triangles",
        "A world triangle (the pieces of a quad cut by the near plane): r0 to r2 its corners, r3 the gradients "
        "(+0x18 nonzero: drawable), [sp] the texture and buffer.",
        when="u8(r3 + 0x18)")
    hooks += model_draws("0x118750", "affine", "affine")
    hooks += model_draws("0x118978", "with perspective", "persp")
    hooks += [
        {"at": "0xd3470", "do": "end", "when": "$view",
         "note": "After the resolve of the 32-bit buffer into the 16-bit picture; the radar and the HUD come after this."},
        {"at": "0xd3470", "do": "set", "vars": {"view": 0}},
    ]
    for hook in hooks:
        if hook["do"] == "draw":
            # Nothing before the first begin has set the table; nothing in night or thermal vision.
            hook["when"] = f"$plain && ({hook['when']})" if "when" in hook else "$plain"
    return {"name": "6r73.app", "hash": "0x27DEE20C", "game": "splinter-cell-chaos-theory", "hooks": hooks}


def main():
    profile = {
        "engine": "gameloft",
        "about": "Gameloft's 3D engine as Splinter Cell: Chaos Theory links it: a world of textured quads with a "
                 "bilinear light and models of textured triangles, drawn into 32-bit words (depth, light level, "
                 "12-bit colour) that are resolved through a light table.",
        "viewport": {"width": 176, "height": 208},
        "images": [splinter_cell()],
    }
    out = sys.argv[1] if len(sys.argv) > 1 else "catalog/enhance/gameloft.json"
    with open(out, "w") as fh:
        json.dump(profile, fh, indent=2)
        fh.write("\n")
    print(out, sum(len(image["hooks"]) for image in profile["images"]), "hooks")


main()
