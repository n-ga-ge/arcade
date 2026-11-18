#!/usr/bin/env python3
"""Prove an enhancement profile: what it captures, drawn at 4x and scaled back, must be the game's own picture.

    python3 -I tools/re/enhancetest.py --game SLUG --out DIR [--profile FILE] [--scale 4]
                                       [--control-port 8091] [--boot --port 8080] [--keys "ok,ok"]

It needs the game running where its 3D is on screen, in a session of
tools/web/explore.mjs. With --boot it starts that session itself (the dev
server must be running on --port), replays the catalogue's test script and
quits it at the end; --keys presses more keys after the script.

The profile is --profile, or catalog/enhance/<engine>.json for the engine the
game's catalogue entry names (`enhance.engine`).

It loads the profile, waits for captured frames, pauses the game, takes the
last captured frame, its textures and the emulator's own screenshot, and
writes to DIR:

    guest.png      what the game drew (176x208)
    render-Nx.png  the captured triangles drawn at N times that
    render-1x.png  that picture scaled back down
    frame.json, texture-<n>.png   what was captured

and compares render-1x with guest where the triangles cover the picture.
It passes when they cover at least --min-cover of the screen (default 0.15)
and differ by at most --max-diff per colour channel on average (default 24
of 255; the guest shows 4 bits a channel and its rasteriser rounds its own
way, so a correct profile lands around 5 to 15).

A pass means the geometry, textures and colours are read correctly. Look at
render-Nx.png all the same: the number cannot see a missing blend mode on a
small object, or what is wrong only at the higher resolution.

Exit status: 0 pass, 1 fail, 2 could not run.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import dbg  # noqa: E402
import render  # noqa: E402


def fail(message, code=2):
    print(message)
    sys.exit(code)


def answer(port, path, timeout=30):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=timeout) as res:
        return res.read().decode()


def boot(args, out):
    log = open(out / 'explore.log', 'w')
    process = subprocess.Popen(['node', str(ROOT / 'tools' / 'web' / 'explore.mjs'), '--game', args.game, '--script',
                                '--port', str(args.port), '--control-port', str(args.control_port),
                                '--out', str(out / 'explore')], stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 600
    while time.time() < deadline:
        if process.poll() is not None:
            fail(f'explore.mjs stopped; see {out / "explore.log"}')
        try:
            answer(args.control_port, '/status', 5)
            return process
        except OSError:
            time.sleep(2)
    process.kill()
    fail('the game did not start within ten minutes')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--game', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--profile')
    parser.add_argument('--scale', type=int, default=4)
    parser.add_argument('--control-port', type=int, default=8091)
    parser.add_argument('--boot', action='store_true')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--keys', default='')
    parser.add_argument('--min-cover', type=float, default=0.15)
    parser.add_argument('--max-diff', type=float, default=24)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    profile = args.profile
    if not profile:
        entry = json.loads((ROOT / 'catalog' / 'games' / f'{args.game}.json').read_text())
        engine = (entry.get('enhance') or {}).get('engine')
        if not engine:
            fail(f'{args.game} names no enhancement engine in its catalogue entry; pass --profile FILE')
        profile = ROOT / 'catalog' / 'enhance' / f'{engine}.json'

    process = boot(args, out) if args.boot else None
    session = dbg.Session(args.control_port)
    try:
        for key in filter(None, args.keys.split(',')):
            answer(args.control_port, f'/key?name={key.strip()}&hold=300&wait=1200')

        status = session.call('PUT', '/v1/enhance/profile', json.loads(Path(profile).read_text()))
        if not status['active']:
            names = ', '.join(sorted({seg['name'] + ' ' + seg['hash'] for seg in session.segments()}))
            fail(f'the profile matches no loaded code. It names: '
                 f'{", ".join(sorted({hook["image"] for hook in status["hooks"]}))}; loaded: {names}', 1)

        before = status['frames']
        deadline = time.time() + 30
        while time.time() < deadline:
            time.sleep(1)
            status = session.call('GET', '/v1/enhance')
            if status['frames'] >= before + 3 and status['triangles']:
                break
        else:
            hits = ', '.join(f'{hook["do"]}@{hook["at"]}: {hook["hits"]} hits, {hook["faults"]} faults' for hook in status['hooks'])
            fail(f'no frame with triangles in 30 s ({status["frames"] - before} frames). {hits}', 1)

        # A paused game keeps its last frame on screen and in memory.
        session.call('POST', '/v1/emulator/pause')
        time.sleep(0.5)
        try:
            frame = session.call('GET', '/v1/enhance/frame')
            textures = {}
            for index in range(len(frame['textures'])):
                status_code, data = session.raw('GET', f'/v1/enhance/texture?index={index}')
                if status_code < 400:
                    import struct
                    tw, th = struct.unpack_from('<II', data, 0)
                    textures[index] = (tw, th, data[8:])
                    dbg.write_png(out / f'texture-{index}.png', tw, th, data[8:])
                else:
                    print(f'texture {index} could not be read: {data.decode("latin1")[:120]}')
            shot = session.screenshot()
            final = session.call('GET', '/v1/enhance')
        finally:
            session.call('POST', '/v1/emulator/resume')
    finally:
        if process:
            try:
                answer(args.control_port, '/quit', 10)
            except OSError:
                process.kill()

    (out / 'frame.json').write_text(json.dumps(frame))
    (out / 'guest.png').write_bytes(shot)
    gw, gh, guest = dbg.read_png(shot)
    if (gw, gh) != (frame['width'], frame['height']):
        fail(f'the screenshot is {gw}x{gh} but the profile\'s viewport is {frame["width"]}x{frame["height"]}')

    started = time.time()
    width, height, rgba, coverage = render.render(frame, textures, args.scale)
    dbg.write_png(out / f'render-{args.scale}x.png', width, height, rgba)
    sw, sh, small, covered = render.shrink(width, height, rgba, coverage, args.scale)
    dbg.write_png(out / 'render-1x.png', sw, sh, small)
    cover, diff = render.compare(small, guest, covered)

    triangles = len(frame['vertices']) // (3 * render.stride_of(frame))
    faults = sum(hook['faults'] for hook in final['hooks'])
    print(f'{args.game}: frame {frame["frame"]}, {triangles} triangles in {len(frame["draws"])} draws, '
          f'{len(textures)}/{len(frame["textures"])} textures read, {faults} faults, '
          f'drawn in {time.time() - started:.1f} s')
    print(f'covers {100 * cover:.1f}% of the screen (needs {100 * args.min_cover:.0f}%), '
          f'differs by {diff:.1f} of 255 there (at most {args.max_diff:g})')
    print(f'pictures in {out}: guest.png, render-{args.scale}x.png, render-1x.png')
    passed = cover >= args.min_cover and diff <= args.max_diff
    print('PASS' if passed else 'FAIL')
    sys.exit(0 if passed else 1)


if __name__ == '__main__':
    main()
