#!/usr/bin/env python3
"""Look into a running game: a client for the emulator's /v1/debug and /v1/enhance routes.

It talks to a session of tools/web/explore.mjs (start one first; it prints
"ready"), on --control-port (default 8091, or $RE_CONTROL_PORT):

    python3 -I tools/re/dbg.py segs                      the game's code segments: name, hash, where they run
    python3 -I tools/re/dbg.py threads                   threads and their registers
    python3 -I tools/re/dbg.py mem ADDR [LEN]            hex dump of guest memory (--words, --out FILE)
    python3 -I tools/re/dbg.py poke ADDR HEXBYTES        write guest memory
    python3 -I tools/re/dbg.py profile [--ms 3000]       where the processor spends its time, by function
    python3 -I tools/re/dbg.py hook IMAGE AT [...]       record the registers at an address (see below)
    python3 -I tools/re/dbg.py hooks | unhook [ID]
    python3 -I tools/re/dbg.py enhance status | load FILE | unload | replace on|off
    python3 -I tools/re/dbg.py enhance frame [--out FILE.json]
    python3 -I tools/re/dbg.py enhance texture INDEX --out FILE.png
    python3 -I tools/re/dbg.py enhance target --out FILE.png
    python3 -I tools/re/dbg.py api METHOD TARGET [JSON]  any control API call
    python3 -I tools/re/dbg.py pause | resume

`hook IMAGE AT` puts a hook AT an offset from the start of IMAGE's code (the
offsets of tools/re/e32.py), lets the game run for --wait seconds (default 2),
prints what was recorded and removes the hook:

    --limit N          hits to record (default 8); all hits are counted
    --stack N          also record N words from the stack pointer up
    --watch EXPR       also record this expression (repeatable); the language
                       of profiles: "u32(r0+8)", "fx(s32(r1), 16)", ...
    --skip             do not run the function: return at once (--return EXPR
                       sets r0). The hook must be on a function's first
                       instruction. Shows what the function was for.
    --keep             leave the hook in place (`unhook` removes it)

`profile` names functions when it can read the game's files: pass
--game SLUG so it finds them in the dump.

The emulator must be running the interpreter (it always does in the browser).
"""
import argparse
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import e32  # noqa: E402


def stride_of(frame):
    """Numbers a vertex of a captured frame: x, y, z, w, u, v, colour, row; a
    frame saved before the row was added has seven, and its vertexLayout says so."""
    return len(frame.get('vertexLayout') or ()) or 8


class Session:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}'

    def raw(self, method, target, body=None, timeout=120):
        """(status, bytes) of a control API call."""
        url = f'{self.base}/api?raw=1&method={method}&target={urllib.parse.quote(target, safe="")}'
        data = b'' if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, method='POST'), timeout=timeout) as res:
                return int(res.headers.get('X-Status', '200')), res.read()
        except urllib.error.URLError as error:
            raise SystemExit(f'no explore session answers on {self.base} ({error}); start tools/web/explore.mjs first')

    def call(self, method, target, body=None, timeout=120):
        """The JSON of a control API call; stops with the emulator's message on an error."""
        status, data = self.raw(method, target, body, timeout)
        if status >= 400:
            try:
                message = json.loads(data)['error']['message']
            except (ValueError, KeyError, TypeError):
                message = data.decode('latin1')[:200]
            raise SystemExit(f'{method} {target}: {status} {message}')
        return json.loads(data) if data else None

    def app_uid(self):
        """The UID of the running game, which is also its process's."""
        session = self.call('GET', '/v1/session')
        return session.get('uid')

    def segments(self, everything=False):
        segs = self.call('GET', '/v1/debug/codesegs')['codesegs']
        return segs if everything else [s for s in segs if not s['rom'] and s['attaches']]

    def memory(self, addr, length, process=None):
        process = process or self.app_uid()
        target = f'/v1/debug/mem?addr={addr:#x}&len={length}' + (f'&process={process}' if process else '')
        status, data = self.raw('GET', target)
        if status >= 400:
            raise SystemExit(f'reading {addr:#x}: {data.decode("latin1")[:200]}')
        return data

    def pixels(self, target):
        """(width, height, RGBA bytes) of /v1/enhance/texture or /target."""
        status, data = self.raw('GET', target)
        if status >= 400:
            raise SystemExit(f'{target}: {data.decode("latin1")[:200]}')
        width, height = struct.unpack_from('<II', data, 0)
        return width, height, data[8:]

    def screenshot(self):
        status, data = self.raw('GET', '/v1/screenshot')
        if status >= 400:
            raise SystemExit(f'screenshot: {data.decode("latin1")[:200]}')
        return data


def write_png(path, width, height, rgba):
    """An RGBA picture as a PNG file, with the standard library only."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    rows = b''.join(b'\0' + bytes(rgba[y * width * 4:(y + 1) * width * 4]) for y in range(height))
    with open(path, 'wb') as out:
        out.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                  + chunk(b'IDAT', zlib.compress(rows, 6)) + chunk(b'IEND', b''))


def read_png(data):
    """(width, height, RGBA bytearray) of an 8-bit RGB or RGBA PNG without interlacing."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG')
    position, compressed, header = 8, b'', None
    while position < len(data):
        length, kind = struct.unpack_from('>I4s', data, position)
        body = data[position + 8:position + 8 + length]
        if kind == b'IHDR':
            header = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            compressed += body
        position += 12 + length
    width, height, depth, colour, _, _, interlace = header
    if depth != 8 or colour not in (2, 6) or interlace:
        raise ValueError('only 8-bit RGB or RGBA PNGs without interlacing')
    channels = 4 if colour == 6 else 3
    raw = zlib.decompress(compressed)
    stride = width * channels
    out = bytearray(width * height * 4)
    previous = bytearray(stride)
    for y in range(height):
        kind = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + left) & 255
            elif kind == 2:
                line[x] = (line[x] + up) & 255
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 255
            elif kind == 4:
                estimate = left + up - corner
                a, b, c = abs(estimate - left), abs(estimate - up), abs(estimate - corner)
                line[x] = (line[x] + (left if a <= b and a <= c else up if b <= c else corner)) & 255
        previous = line
        row = y * width * 4
        if channels == 4:
            out[row:row + width * 4] = line
        else:
            for x in range(width):
                out[row + x * 4:row + x * 4 + 3] = line[x * 3:x * 3 + 3]
                out[row + x * 4 + 3] = 255
    return width, height, out


def number(text):
    return int(text, 0)


def hexdump(data, base, words):
    if words:
        for offset in range(0, len(data) - 3, 16):
            values = struct.unpack_from('<%dI' % (min(16, len(data) - offset) // 4), data, offset)
            print(f'{base + offset:08x}  ' + ' '.join(f'{v:08x}' for v in values))
        return
    for offset in range(0, len(data), 16):
        line = data[offset:offset + 16]
        text = ''.join(chr(c) if 32 <= c < 127 else '.' for c in line)
        print(f'{base + offset:08x}  {line.hex(" "):<47}  {text}')


def images_of(session, slug):
    """[(segment, run address, e32.Image or None)] for the game's own code."""
    out = []
    for seg in session.segments():
        image = None
        if slug:
            try:
                image = e32.Image(e32.locate(f'{slug}:{os.path.basename(seg["path"].replace(chr(92), "/")) or seg["name"]}'))
                if image.hash != int(seg['hash'], 16):
                    image = None
            except SystemExit:
                image = None
        for attach in seg['attaches']:
            out.append((seg, int(attach['code'], 16), image))
    return out


def place(images, addr):
    """'name+0xoffset' of an address, and the function it is in when the file is at hand."""
    for seg, base, image in images:
        if base <= addr < base + seg['codeSize']:
            offset = addr - base
            if image and offset < image.text_size:
                start, _ = e32.function_bounds(image, offset)
                return seg['name'], offset, start
            return seg['name'], offset, None
    return None, addr, None


def cmd_profile(session, args):
    images = images_of(session, args.game)
    result = session.call('POST', '/v1/debug/profile', {'ms': args.ms, 'limit': 20000}, timeout=args.ms / 1000 + 60)
    total = result['samples']
    functions, callers, outside = {}, {}, 0
    for pc, lr, count in result['top']:
        name, offset, start = place(images, int(pc, 16))
        if name is None:
            outside += count
            continue
        key = (name, start if start is not None else offset & ~0x3F)
        functions[key] = functions.get(key, 0) + count
        cname, coffset, cstart = place(images, int(lr, 16))
        if cname is not None:
            caller = (cname, cstart if cstart is not None else coffset & ~0x3F)
            if caller != key:
                callers.setdefault(key, {})
                callers[key][caller] = callers[key].get(caller, 0) + count
    print(f'{total} samples in {args.ms} ms; {100 * outside / max(total, 1):.1f}% outside the game\'s own code '
          '(the system, other processes, waiting)')
    print('  share  function' + ('' if args.game else '  (64-byte blocks: pass --game SLUG for functions)'))
    for (name, start), count in sorted(functions.items(), key=lambda item: -item[1])[:args.top]:
        print(f'{100 * count / total:6.2f}%  {name}+{start:#x}')
        for (cname, cstart), ccount in sorted(callers.get((name, start), {}).items(), key=lambda item: -item[1])[:3]:
            print(f'           link register in {cname}+{cstart:#x} ({100 * ccount / count:.0f}%)')


def cmd_hook(session, args):
    body = {'image': args.image, 'at': args.at, 'limit': args.limit, 'stack': args.stack, 'skip': args.skip}
    if args.watch:
        body['watch'] = args.watch
    if getattr(args, 'return'):
        body['return'] = getattr(args, 'return')
    hook = session.call('POST', '/v1/debug/hooks', body)
    if not hook['addresses']:
        print(f'warning: no loaded code segment is called {args.image} (see `segs`); the hook waits for one')
    time.sleep(args.wait)
    result = session.call('GET' if args.keep else 'DELETE', f'/v1/debug/hooks/{hook["id"]}')
    print(f'hook {hook["id"]} at {", ".join(result["addresses"]) or "?"}: {result["hits"]} hits in {args.wait} s'
          + (' (kept)' if args.keep else ''))
    for n, hit in enumerate(result['captured']):
        regs = hit['regs']
        print(f'#{n} {hit["thread"]}')
        for row in range(0, 16, 4):
            print('   ' + '  '.join(f'r{row + k:<2}={regs[row + k][2:].lower()}' for k in range(4)))
        if hit['stack']:
            print('   stack ' + ' '.join(word[2:].lower() for word in hit['stack']))
        for expression, value in zip(result['watch'], hit['values']):
            shown = 'unmapped' if value is None else (f'{int(value):#x} ({value:g})' if float(value).is_integer() else f'{value:g}')
            print(f'   {expression} = {shown}')


def cmd_enhance(session, args):
    if args.action == 'status':
        print(json.dumps(session.call('GET', '/v1/enhance'), indent=1))
    elif args.action == 'load':
        print(json.dumps(session.call('PUT', '/v1/enhance/profile', json.loads(Path(args.what).read_text())), indent=1))
    elif args.action == 'unload':
        session.call('DELETE', '/v1/enhance/profile')
    elif args.action == 'replace':
        print(session.call('PATCH', '/v1/enhance', {'replace': args.what == 'on'})['replace'])
    elif args.action == 'frame':
        frame = session.call('GET', '/v1/enhance/frame')
        if args.out:
            Path(args.out).write_text(json.dumps(frame))
        print(f'frame {frame["frame"]}: {len(frame["vertices"]) // (3 * stride_of(frame))} triangles in {len(frame["draws"])} draws, '
              f'{len(frame["textures"])} textures' + (f', written to {args.out}' if args.out else ''))
        for n, texture in enumerate(frame['textures']):
            rows = texture.get('paletteRows') or 0
            print(f'  texture {n}: {texture["width"]}x{texture["height"]} {texture["format"]} at {texture["pixels"]}'
                  + (f', {rows} palettes from {texture["palette"]}' if rows else ''))
    elif args.action in ('texture', 'target'):
        if not args.out:
            raise SystemExit('--out FILE.png is required')
        target = '/v1/enhance/target' if args.action == 'target' else f'/v1/enhance/texture?index={int(args.what)}'
        width, height, rgba = session.pixels(target)
        write_png(args.out, width, height, rgba)
        print(f'{width}x{height} written to {args.out}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--control-port', type=int, default=int(os.environ.get('RE_CONTROL_PORT', 8091)))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('segs').add_argument('--all', action='store_true', help='the ROM\'s too')
    sub.add_parser('threads')
    mem = sub.add_parser('mem')
    mem.add_argument('addr', type=number)
    mem.add_argument('length', type=number, nargs='?', default=0x100)
    mem.add_argument('--words', action='store_true')
    mem.add_argument('--out')
    mem.add_argument('--process')
    poke = sub.add_parser('poke')
    poke.add_argument('addr', type=number)
    poke.add_argument('hex')
    poke.add_argument('--process')
    profile = sub.add_parser('profile')
    profile.add_argument('--ms', type=int, default=3000)
    profile.add_argument('--top', type=int, default=25)
    profile.add_argument('--game')
    hook = sub.add_parser('hook')
    hook.add_argument('image')
    hook.add_argument('at', type=number)
    hook.add_argument('--limit', type=int, default=8)
    hook.add_argument('--stack', type=int, default=0)
    hook.add_argument('--watch', action='append')
    hook.add_argument('--skip', action='store_true')
    hook.add_argument('--return')
    hook.add_argument('--wait', type=float, default=2)
    hook.add_argument('--keep', action='store_true')
    sub.add_parser('hooks')
    sub.add_parser('unhook').add_argument('id', nargs='?')
    enhance = sub.add_parser('enhance')
    enhance.add_argument('action', choices=['status', 'load', 'unload', 'replace', 'frame', 'texture', 'target'])
    enhance.add_argument('what', nargs='?')
    enhance.add_argument('--out')
    api = sub.add_parser('api')
    api.add_argument('method')
    api.add_argument('target')
    api.add_argument('body', nargs='?')
    sub.add_parser('pause')
    sub.add_parser('resume')
    args = parser.parse_args()
    session = Session(args.control_port)

    if args.command == 'segs':
        for seg in session.segments(args.all):
            where = ', '.join(f'{a["code"]} in {a["process"]}' for a in seg['attaches']) or seg.get('romCode') or '-'
            print(f'{seg["name"]:<28} hash {seg["hash"]}  code {seg["codeSize"]:#9x}  at {where}')
    elif args.command == 'threads':
        for thread in session.call('GET', '/v1/debug/threads')['threads']:
            regs = thread['regs']
            print(f'{"*" if thread["running"] else " "} {thread["name"]:<40} state {thread["state"]:<2} '
                  f'pc {regs[15]} lr {regs[14]} sp {regs[13]}')
    elif args.command == 'mem':
        data = session.memory(args.addr, args.length, args.process)
        if args.out:
            Path(args.out).write_bytes(data)
            print(f'{len(data)} bytes written to {args.out}')
        else:
            hexdump(data, args.addr, args.words)
    elif args.command == 'poke':
        body = {'addr': args.addr, 'hex': args.hex, 'process': args.process or session.app_uid()}
        print(session.call('PUT', '/v1/debug/mem', body))
    elif args.command == 'profile':
        cmd_profile(session, args)
    elif args.command == 'hook':
        cmd_hook(session, args)
    elif args.command == 'hooks':
        for hook in session.call('GET', '/v1/debug/hooks')['hooks']:
            print(f'{hook["id"]}: {hook["image"]}+{hook["at"]} at {", ".join(hook["addresses"]) or "?"}: {hook["hits"]} hits')
    elif args.command == 'unhook':
        session.call('DELETE', '/v1/debug/hooks' + (f'/{args.id}' if args.id else ''))
    elif args.command == 'enhance':
        cmd_enhance(session, args)
    elif args.command == 'api':
        status, data = session.raw(args.method, args.target, json.loads(args.body) if args.body else None)
        print(status, data.decode('utf-8', 'replace') if len(data) < 20000 else f'{len(data)} bytes')
    elif args.command in ('pause', 'resume'):
        print(session.call('POST', f'/v1/emulator/{args.command}'))


if __name__ == '__main__':
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
