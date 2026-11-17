#!/usr/bin/env python3
"""The multiplayer room relay, as the dev server runs it under /net/.

Players' pages meet in a room and the relay passes their binary frames to each
other. It knows nothing about what is in them. The deployed site has the same
relay as a Cloudflare Worker; this one keeps its rooms in memory and exists so
that everything local and in CI has a relay on the page's own origin.
tools/web/relaycheck.mjs holds both to the protocol.

  GET /net/health          {"ok":true,"v":1}
  GET /net/rooms[?game=]   the public rooms that still have a free place, newest first
  GET /net/room/<CODE>     a WebSocket: ?v=1&name=..., with create=1&game=...[&public=1]
                           to create the room, without them to join it

The protocol, version 1:

- CODE is 6 characters of ABCDEFGHJKLMNPQRSTUVWXYZ23456789, made up by the
  page that creates the room; lower case is accepted.
- The upgrade is always accepted, because a browser cannot read the status of a
  refused one. A failure is a text frame {"t":"error","code":...,"message":...}
  and then a close: bad-request 4400, no-room 4404, room-exists 4409,
  room-full 4413, too-fast 4429. A message that is too big closes with 1009.
- A room has at most 8 members at once. Ids are 1 to 255 in join order and are
  not used twice; the creator is 1. The room lives while it has members.
- Server to client, as JSON text frames: "hello" (first, once, with the other
  members as "peers"), "join" and "leave" (to the others), "public" (to
  everyone when the listing changes), "pong".
- Client to server, as JSON text frames: "public" (only the creator's counts),
  "ping". Anything else is ignored.
- Binary frames: byte 0 is the destination id, 0 for every other member, then
  1 to 32768 bytes. They arrive with byte 0 replaced by the sender's id. A
  frame for an id that is not there, or for the sender, is dropped.
- More than 2000 frames from one connection within a second: too-fast.
- An upgrade is refused (403) when it names an Origin other than localhost or
  127.0.0.1; one that names none is accepted, for tools.

Use, from a http.server request handler (see devserver.py):

  relay = Relay()
  def do_GET(self):
      if self.path.startswith("/net/"):
          return relay.handle(self)

handle() answers the request. For a room it keeps the handler's thread for as
long as the connection lives, so the server must be a threading one. Standard
library only.

  python3 -I tools/web/relay.py --self-test   checks the frame codec, the room
                                              rules and a relay on a local port
"""
import base64
import collections
import hashlib
import http.server
import json
import re
import socket
import struct
import sys
import threading
import time
import unicodedata
import urllib.parse

VERSION = 1
MAX_MEMBERS = 8
MAX_IDS = 255
MAX_PAYLOAD = 32768
MAX_MESSAGE = MAX_PAYLOAD + 1       # the destination byte and the payload
RATE_FRAMES = 2000                  # more than this many frames ...
RATE_WINDOW = 1.0                   # ... within this many seconds is too fast
LIST_MAX = 50
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
# Matched before the code is put in upper case: that can turn one character
# into two ("ß" into "SS") and a code that is none into one that looks right.
CODE = re.compile("[" + ALPHABET + ALPHABET.lower() + "]{6}")
GAME = re.compile("[a-z0-9-]{1,64}")
ERRORS = {"bad-request": 4400, "no-room": 4404, "room-exists": 4409, "room-full": 4413, "too-fast": 4429}

# What may wait to be written to one member. A member that reads slower than
# the others send is cut off when this is full, instead of holding them up.
QUEUE_LIMIT = 16 << 20
# After the relay has said goodbye it reads on for the peer's answer this long.
LINGER = 3.0

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
OPCODES = (OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG)


# --- WebSocket frames (RFC 6455) -------------------------------------------------

class Gone(Exception):
    """The connection ended."""


class WsError(Exception):
    """The peer broke the protocol. `code` is the close code that answers it,
    `pending` the bytes of the offending frame that were not read yet."""

    def __init__(self, code, reason, pending=0):
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.pending = pending


def accept_key(key):
    return base64.b64encode(hashlib.sha1(key.encode("ascii") + GUID).digest()).decode("ascii")


def mask_bytes(data, mask):
    """XOR with the repeated 4-byte mask. As two big integers: a loop over
    32 KiB in Python would take milliseconds per frame."""
    size = len(data)
    if not size:
        return b""
    key = (mask * (size // 4 + 1))[:size]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(size, "big")


def encode_frame(opcode, payload=b"", fin=True, mask=None):
    """One frame. A server sends without a mask, a client must give one."""
    size = len(payload)
    flag = 0x80 if mask else 0
    head = bytes([(0x80 if fin else 0) | opcode])
    if size < 126:
        head += bytes([flag | size])
    elif size < 65536:
        head += bytes([flag | 126]) + struct.pack(">H", size)
    else:
        head += bytes([flag | 127]) + struct.pack(">Q", size)
    if mask:
        return head + mask + mask_bytes(payload, mask)
    return head + payload


def close_payload(code=None, reason=""):
    if code is None:
        return b""
    return struct.pack(">H", code) + reason.encode("utf-8")[:123]


def parse_close(payload):
    """(code, reason) of a close frame; the code is None when it gave none."""
    if not payload:
        return None, ""
    if len(payload) == 1:
        raise WsError(1002, "a close frame with half a code")
    code = struct.unpack(">H", payload[:2])[0]
    if not (1000 <= code <= 1003 or 1007 <= code <= 1011 or 3000 <= code <= 4999):
        raise WsError(1002, "a close code that may not be sent")
    return code, payload[2:].decode("utf-8", "replace")


def read_exact(read, size):
    data = read(size) if size else b""
    if len(data) != size:
        raise Gone()
    return data


def read_header(read, masked=True):
    """(fin, opcode, length, mask) of the next frame. The whole header is read
    before anything is judged, so that `pending` is right and the reader can
    still find the frame after a bad one."""
    first, second = read_exact(read, 2)
    fin, opcode = bool(first & 0x80), first & 0x0F
    has_mask, length = bool(second & 0x80), second & 0x7F
    minimal = True
    if length == 126:
        length = struct.unpack(">H", read_exact(read, 2))[0]
        minimal = length >= 126
    elif length == 127:
        length = struct.unpack(">Q", read_exact(read, 8))[0]
        minimal = length >= 65536
    mask = read_exact(read, 4) if has_mask else None
    if first & 0x70:
        raise WsError(1002, "reserved bits set", length)
    if opcode not in OPCODES:
        raise WsError(1002, "unknown opcode", length)
    if not minimal or length >> 63:
        raise WsError(1002, "bad frame length", length)
    if opcode >= 0x8 and (not fin or length > 125):
        raise WsError(1002, "bad control frame", length)
    if has_mask != masked:
        raise WsError(1002, "client frames are masked, server frames are not", length)
    return fin, opcode, length, mask


class Reader:
    """Reads the frames of one connection and puts messages together.

    `read(n)` returns n bytes, or fewer when the connection ended. `tick`, when
    given, is called once per frame and returns true when the frame is one too
    many (the rate limit).
    """

    def __init__(self, read, limit=MAX_MESSAGE, masked=True, tick=None):
        self.read = read
        self.limit = limit
        self.masked = masked
        self.tick = tick
        self.kind = None    # opcode of the message whose fragments are arriving
        self.parts = []
        self.size = 0

    def payload(self, length, mask):
        data = read_exact(self.read, length)
        return mask_bytes(data, mask) if mask else data

    def skip(self, length):
        while length > 0:
            length -= len(read_exact(self.read, min(length, 65536)))

    def message(self):
        """The next message as (opcode, bytes): text, binary, ping, pong or
        close. Control frames may come between the fragments of a message."""
        while True:
            fin, opcode, length, mask = read_header(self.read, self.masked)
            if self.tick and self.tick():
                raise WsError(ERRORS["too-fast"], "too-fast", length)
            if opcode >= 0x8:
                return opcode, self.payload(length, mask)
            if opcode == OP_CONT:
                if self.kind is None:
                    raise WsError(1002, "a continuation of nothing", length)
            elif self.kind is not None:
                raise WsError(1002, "a new message inside an unfinished one", length)
            else:
                self.kind, self.parts, self.size = opcode, [], 0
            # Judged from the header: a message over the limit is never read
            # into memory, however large it claims to be.
            if self.size + length > self.limit:
                raise WsError(1009, "message too big", length)
            self.parts.append(self.payload(length, mask))
            self.size += length
            if fin:
                kind, data = self.kind, b"".join(self.parts)
                self.kind, self.parts, self.size = None, [], 0
                return kind, data

    def drain(self, pending=0):
        """Drops what the peer still sends, up to and including its close
        frame. Raises Gone when the connection ends first."""
        while True:
            self.skip(pending)
            try:
                _, opcode, pending, _ = read_header(self.read, self.masked)
            except WsError as error:
                pending = error.pending
                continue
            if opcode == OP_CLOSE:
                self.skip(pending)
                return


class Rate:
    """True for the frame that makes it more than `frames` within `window` seconds."""

    def __init__(self, frames=RATE_FRAMES, window=RATE_WINDOW, clock=time.monotonic):
        self.times = collections.deque(maxlen=frames + 1)
        self.window = window
        self.clock = clock

    def __call__(self):
        now = self.clock()
        self.times.append(now)
        return len(self.times) == self.times.maxlen and now - self.times[0] < self.window


class Connection:
    """One WebSocket. The handler's thread reads it; frames for it go into a
    queue that a thread of its own writes out, so that nobody who sends to this
    member ever waits for this member's socket."""

    def __init__(self, sock, read, queue_limit=QUEUE_LIMIT, rate=None):
        self.sock = sock
        self.reader = Reader(read, tick=rate)
        self.queue_limit = queue_limit
        self.state = threading.Condition()
        self.queue = collections.deque()
        self.queued = 0
        self.closing = False    # a close frame is queued: nothing follows it
        self.ending = False     # the writer stops once the queue is empty
        self.dead = False       # the socket was cut
        self.writer = threading.Thread(target=self.write_loop, name="relay-writer", daemon=True)
        self.writer.start()

    def send(self, frame, last=False):
        """Queues an encoded frame. Never blocks."""
        with self.state:
            if self.dead or self.closing:
                return
            if self.queued + len(frame) > self.queue_limit:
                overflow = True
            else:
                overflow = False
                self.queue.append(frame)
                self.queued += len(frame)
                self.closing = last
                self.state.notify()
        if overflow:
            self.cut()

    def text(self, message):
        self.send(encode_frame(OP_TEXT, dumps(message)))

    def close(self, code=None, reason=""):
        self.send(encode_frame(OP_CLOSE, close_payload(code, reason)), last=True)

    def fail(self, name, message):
        """The protocol's own errors: the reason as a message, then the close."""
        self.text({"t": "error", "code": name, "message": message})
        self.close(ERRORS[name], name)

    def cut(self):
        """Ends the connection at once. Shutting the socket down also wakes the
        threads that are blocked reading from it or writing to it."""
        with self.state:
            self.dead = True
            self.queue.clear()
            self.queued = 0
            self.state.notify()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def write_loop(self):
        while True:
            with self.state:
                while not (self.queue or self.dead or self.ending):
                    self.state.wait()
                if self.dead or not self.queue:
                    return
                data = b"".join(self.queue)
                self.queue.clear()
                self.queued = 0
            try:
                self.sock.sendall(data)
            except OSError:
                self.cut()
                return

    def linger(self, pending=0):
        """After a close from this side: reads on until the peer's close frame,
        for a limited time. Closing with unread input would reset the
        connection, and the peer could lose the reason it was given."""
        timer = threading.Timer(LINGER, self.cut)
        timer.daemon = True
        timer.start()
        try:
            self.reader.drain(pending)
        except Gone:
            pass
        finally:
            timer.cancel()

    def finish(self):
        """Writes out what is queued, within reason, and stops the writer."""
        with self.state:
            self.ending = True
            self.state.notify()
        self.writer.join(LINGER)
        if self.writer.is_alive():
            self.cut()
            self.writer.join()


# --- rooms -----------------------------------------------------------------------

def dumps(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# What JavaScript's trim() removes, so that both relays agree on a name:
# Python's strip() leaves the byte order mark.
BLANKS = re.compile(r"^[\s\ufeff]+|[\s\ufeff]+$")


def clean_name(raw):
    """A player's name without control characters and outer blanks, or None
    when that leaves nothing or more than 24 characters."""
    name = BLANKS.sub("", "".join(ch for ch in raw if unicodedata.category(ch) != "Cc"))
    return name if 1 <= len(name) <= 24 else None


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Member:
    def __init__(self, room, ident, name, conn):
        self.room = room
        self.id = ident
        self.name = name
        self.conn = conn


class Room:
    def __init__(self, code, game, public, host, born):
        self.code = code
        self.game = game
        self.public = public
        self.host = host        # the creator's name, also after the creator left
        self.born = born        # creation order, for "newest first"
        self.members = {}       # id -> Member
        self.next_id = 1

    def full(self):
        return len(self.members) >= MAX_MEMBERS or self.next_id > MAX_IDS


class Rooms:
    """The rooms and their rules. A member's connection needs only `send`
    (an encoded frame) and `text` (a JSON value), neither of which may block:
    one lock guards everything, and frames are queued while it is held, which
    is what keeps their order."""

    def __init__(self):
        self.lock = threading.Lock()
        self.rooms = {}     # code -> Room
        self.born = 0

    def listing(self, game=None):
        with self.lock:
            rooms = [room for room in self.rooms.values() if room.public and not room.full() and (game is None or room.game == game)]
            rooms.sort(key=lambda room: -room.born)
            return [{"room": room.code, "game": room.game, "host": room.host, "players": len(room.members), "max": MAX_MEMBERS} for room in rooms[:LIST_MAX]]

    def enter(self, code, query, conn):
        """Creates or joins the room and returns the new member. `query` is
        the request's parameters as a dict. Raises Refused."""
        if query.get("v") != str(VERSION):
            raise Refused("bad-request", f"this relay speaks version {VERSION}: v={VERSION} is required")
        if not CODE.fullmatch(code):
            raise Refused("bad-request", f"a room code is 6 characters of {ALPHABET}")
        code = code.upper()
        name = clean_name(query.get("name", ""))
        if name is None:
            raise Refused("bad-request", "name is required: 1 to 24 characters")
        create = query.get("create") == "1"
        game = query.get("game", "")
        if create and not GAME.fullmatch(game):
            raise Refused("bad-request", "game is required to create a room: 1 to 64 of a-z, 0-9 and -")
        with self.lock:
            room = self.rooms.get(code)
            if create:
                if room:
                    raise Refused("room-exists", f"room {code} exists already")
                self.born += 1
                room = self.rooms[code] = Room(code, game, query.get("public") == "1", name, self.born)
            elif not room:
                raise Refused("no-room", f"there is no room {code}")
            elif room.full():
                raise Refused("room-full", f"room {code} is full")
            member = Member(room, room.next_id, name, conn)
            room.next_id += 1
            # The hello is queued before the member can be sent anything else.
            conn.text({"t": "hello", "v": VERSION, "id": member.id, "room": code, "game": room.game, "public": room.public, "max": MAX_MEMBERS,
                       "peers": [{"id": other.id, "name": other.name} for other in room.members.values()]})
            for other in room.members.values():
                other.conn.text({"t": "join", "id": member.id, "name": name})
            room.members[member.id] = member
            return member

    def leave(self, member):
        """Takes the member out of its room. Harmless to call twice."""
        with self.lock:
            room = member.room
            if room.members.get(member.id) is not member:
                return
            del room.members[member.id]
            if not room.members:
                del self.rooms[room.code]
            for other in room.members.values():
                other.conn.text({"t": "leave", "id": member.id})

    def text(self, member, text):
        try:
            message = json.loads(text)
        except (ValueError, RecursionError):
            return
        if not isinstance(message, dict):
            return
        kind = message.get("t")
        if kind == "ping":
            member.conn.text({"t": "pong"})
        elif kind == "public" and member.id == 1 and isinstance(message.get("value"), bool):
            with self.lock:
                room = member.room
                if room.members.get(member.id) is member and room.public != message["value"]:
                    room.public = message["value"]
                    for other in room.members.values():
                        other.conn.text({"t": "public", "value": room.public})

    def binary(self, member, data):
        if len(data) < 2:
            return
        target = data[0]
        with self.lock:
            room = member.room
            if room.members.get(member.id) is not member:
                return
            if target == 0:
                targets = [other for other in room.members.values() if other is not member]
            else:
                other = room.members.get(target)
                targets = [other] if other and other is not member else []
            if targets:
                frame = encode_frame(OP_BINARY, bytes([member.id]) + data[1:])
                for other in targets:
                    other.conn.send(frame)


# --- the HTTP side ---------------------------------------------------------------

def local_origin(origin):
    """The dev server's rule: any port and scheme of localhost or 127.0.0.1,
    and requests without an Origin, which only tools send."""
    if origin is None:
        return True
    try:
        return urllib.parse.urlsplit(origin).hostname in ("localhost", "127.0.0.1")
    except ValueError:
        return False


def header_tokens(headers, name):
    return {token.strip().lower() for value in headers.get_all(name) or [] for token in value.split(",")}


class Relay:
    """The relay behind a http.server request handler: call handle(handler)
    for every GET or HEAD under /net/."""

    def __init__(self, origin_ok=local_origin, queue_limit=QUEUE_LIMIT):
        self.rooms = Rooms()
        self.origin_ok = origin_ok
        self.queue_limit = queue_limit

    def handle(self, handler):
        url = urllib.parse.urlsplit(handler.path)
        query = {name: values[0] for name, values in urllib.parse.parse_qs(url.query, keep_blank_values=True).items()}
        if url.path == "/net/health":
            self.answer(handler, 200, {"ok": True, "v": VERSION})
        elif url.path == "/net/rooms":
            self.answer(handler, 200, {"rooms": self.rooms.listing(query.get("game"))})
        elif url.path.startswith("/net/room/"):
            self.room(handler, urllib.parse.unquote(url.path[len("/net/room/"):]), query)
        else:
            self.answer(handler, 404, {"error": "not-found"})

    @staticmethod
    def answer(handler, status, body, headers=()):
        data = dumps(body)
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-store")
        for name, value in headers:
            handler.send_header(name, value)
        handler.end_headers()
        if handler.command != "HEAD":
            handler.wfile.write(data)

    def room(self, handler, code, query):
        headers = handler.headers
        if handler.command != "GET" or "websocket" not in header_tokens(headers, "Upgrade") or "upgrade" not in header_tokens(headers, "Connection"):
            return self.answer(handler, 426, {"error": "upgrade-required", "message": "a room is a WebSocket"}, [("Upgrade", "websocket")])
        if headers.get("Sec-WebSocket-Version", "").strip() != "13":
            return self.answer(handler, 426, {"error": "upgrade-required", "message": "WebSocket version 13"}, [("Upgrade", "websocket"), ("Sec-WebSocket-Version", "13")])
        key = headers.get("Sec-WebSocket-Key", "").strip()
        try:
            if len(base64.b64decode(key, validate=True)) != 16:
                raise ValueError(key)
        except ValueError:
            return self.answer(handler, 400, {"error": "bad-request", "message": "Sec-WebSocket-Key is missing or malformed"})
        if not self.origin_ok(headers.get("Origin")):
            return self.answer(handler, 403, {"error": "forbidden", "message": "this origin may not use the relay"})

        sock = handler.connection
        handler.close_connection = True     # the socket is a WebSocket from here on
        try:
            # Game frames are small and frequent: without this each one could
            # wait for the acknowledgement of the one before.
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # A peer whose machine or network vanished without a word is
            # noticed after a minute and a half. A page that merely stopped
            # running (a frozen tab, a breakpoint) still answers these, and
            # stays a member until its tab closes.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            for option, value in (("TCP_KEEPIDLE", 60), ("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 3)):
                if hasattr(socket, option):
                    sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, option), value)
            sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n").encode("ascii"))
        except OSError:
            return None

        def read(size):
            # The handler's buffered reader, not the socket: it may already
            # hold the first frames. A broken connection reads as an ended one.
            try:
                return handler.rfile.read(size) or b""
            except (OSError, ValueError):
                return b""

        conn = Connection(sock, read, self.queue_limit, Rate())
        try:
            self.serve(conn, code, query)
        finally:
            conn.finish()
        return None

    def serve(self, conn, code, query):
        try:
            member = self.rooms.enter(code, query, conn)
        except Refused as refusal:
            conn.fail(refusal.code, refusal.message)
            conn.linger()
            return
        try:
            while True:
                opcode, data = conn.reader.message()
                if opcode == OP_BINARY:
                    self.rooms.binary(member, data)
                elif opcode == OP_TEXT:
                    try:
                        text = data.decode("utf-8")
                    except UnicodeDecodeError:
                        raise WsError(1007, "text that is not UTF-8") from None
                    self.rooms.text(member, text)
                elif opcode == OP_PING:
                    conn.send(encode_frame(OP_PONG, data))
                elif opcode == OP_CLOSE:
                    # Out of the room before the answer: when the peer sees the
                    # connection closed, the room has already changed.
                    self.rooms.leave(member)
                    try:
                        conn.close(parse_close(data)[0])
                    except WsError as error:
                        # The peer has said its last word, however badly:
                        # there is nothing more to wait for.
                        conn.close(error.code, error.reason)
                    return
        except Gone:
            pass
        except WsError as error:
            self.rooms.leave(member)
            if error.code == ERRORS["too-fast"]:
                conn.fail("too-fast", f"more than {RATE_FRAMES} frames within a second")
            else:
                conn.close(error.code, error.reason)
            conn.linger(error.pending)
        finally:
            self.rooms.leave(member)


# --- self-test -------------------------------------------------------------------

def self_test():
    import io
    import os
    import urllib.error
    import urllib.request

    failures = []

    def check(ok, message):
        if not ok:
            failures.append(message)

    def reader(data, **options):
        return Reader(io.BytesIO(data).read, **options)

    def outcome(data, **options):
        """What reading `data` as a client's frames gives: the messages, then
        the close code of the error that ended it (None at the end of input)."""
        source, messages = reader(data, **options), []
        try:
            while True:
                messages.append(source.message())
        except Gone:
            return messages, None
        except WsError as error:
            return messages, error.code

    mask = b"\x37\xfa\x21\x3d"

    # The codec, against the examples of RFC 6455.
    check(accept_key("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "codec: accept key of the RFC's example")
    check(encode_frame(OP_TEXT, b"Hello") == bytes.fromhex("810548656c6c6f"), "codec: unmasked text frame")
    check(encode_frame(OP_TEXT, b"Hello", mask=mask) == bytes.fromhex("818537fa213d7f9f4d5158"), "codec: masked text frame")
    check(outcome(bytes.fromhex("818537fa213d7f9f4d5158")) == ([(OP_TEXT, b"Hello")], None), "codec: read a masked text frame")
    check(outcome(bytes.fromhex("810548656c6c6f"), masked=False) == ([(OP_TEXT, b"Hello")], None), "codec: read an unmasked frame as a client")
    check(outcome(bytes.fromhex("810548656c6c6f")) == ([], 1002), "codec: an unmasked frame from a client is refused")
    check(outcome(bytes.fromhex("818537fa213d7f9f4d5158"), masked=False) == ([], 1002), "codec: a masked frame from a server is refused")
    for size in (0, 1, 125, 126, 127, 65535, 65536, 70000):
        payload = os.urandom(size)
        for key in (None, os.urandom(4)):
            frame = encode_frame(OP_BINARY, payload, mask=key)
            check(outcome(frame, limit=1 << 20, masked=bool(key)) == ([(OP_BINARY, payload)], None), f"codec: round trip of {size} bytes, mask {bool(key)}")
        header = 2 + (0 if size < 126 else 2 if size < 65536 else 8)
        check(len(encode_frame(OP_BINARY, payload)) == header + size, f"codec: header length for {size} bytes")
    check(mask_bytes(mask_bytes(b"abcdefg", mask), mask) == b"abcdefg" and mask_bytes(b"", mask) == b"", "codec: masking twice gives the input")

    # Fragments, and control frames between them.
    def client(opcode, payload=b"", fin=True):
        return encode_frame(opcode, payload, fin, mask=os.urandom(4))

    fragments = client(OP_BINARY, b"He", fin=False) + client(OP_PING, b"p") + client(OP_CONT, b"ll", fin=False) + client(OP_CONT, b"o")
    check(outcome(fragments) == ([(OP_PING, b"p"), (OP_BINARY, b"Hello")], None), "fragments: a message in three parts with a ping between")
    check(outcome(client(OP_BINARY, b"a") + client(OP_TEXT, b"b") + client(OP_PONG) + client(OP_CLOSE, close_payload(1000, "bye"))) ==
          ([(OP_BINARY, b"a"), (OP_TEXT, b"b"), (OP_PONG, b""), (OP_CLOSE, b"\x03\xe8bye")], None), "fragments: whole messages in a row")
    check(outcome(client(OP_CONT, b"x")) == ([], 1002), "fragments: a continuation of nothing")
    check(outcome(client(OP_TEXT, b"a", fin=False) + client(OP_TEXT, b"b")) == ([], 1002), "fragments: a new message inside an unfinished one")
    check(outcome(client(OP_PING, b"x", fin=False)) == ([], 1002), "frames: a fragmented control frame")
    check(outcome(client(OP_PING, b"x" * 126)) == ([], 1002), "frames: a control frame over 125 bytes")
    check(outcome(bytes([0x80 | 0x40 | OP_TEXT, 0x80]) + mask) == ([], 1002), "frames: a reserved bit")
    check(outcome(bytes([0x80 | 0x3, 0x80]) + mask) == ([], 1002), "frames: an unknown opcode")
    check(outcome(bytes([0x82, 0x80 | 126, 0, 5]) + mask + b"12345") == ([], 1002), "frames: a length in more bytes than needed")
    check(outcome(bytes([0x82, 0x80 | 127]) + struct.pack(">Q", 1 << 63) + mask) == ([], 1002), "frames: a length with the top bit set")
    check(outcome(client(OP_BINARY, b"abc")[:-1]) == ([], None), "frames: a frame cut short is the end of the connection")

    # The size limit, judged before the payload is read.
    check(outcome(client(OP_BINARY, bytes(MAX_MESSAGE))) == ([(OP_BINARY, bytes(MAX_MESSAGE))], None), "limit: a message of exactly the limit")
    check(outcome(client(OP_BINARY, bytes(MAX_MESSAGE + 1))) == ([], 1009), "limit: one byte more")
    check(outcome(client(OP_TEXT, bytes(MAX_MESSAGE + 1))) == ([], 1009), "limit: a text message over it")
    check(outcome(client(OP_BINARY, bytes(MAX_MESSAGE), fin=False) + client(OP_CONT, b"x")) == ([], 1009), "limit: fragments that add up to more")
    check(outcome(bytes([0x82, 0x80 | 127]) + struct.pack(">Q", 1 << 40) + mask) == ([], 1009), "limit: a huge frame is refused from its header")

    # After an error the reader finds the peer's close frame behind the rest.
    source = reader(client(OP_BINARY, bytes(MAX_MESSAGE + 5)) + client(OP_CONT, b"zz") + client(OP_TEXT, b"more") + client(OP_CLOSE, close_payload(1009)) + b"tail")
    try:
        source.message()
        check(False, "drain: the oversized message was accepted")
    except WsError as error:
        source.drain(error.pending)
        check(source.read(10) == b"tail", "drain: stops right after the close frame")
    try:
        reader(client(OP_TEXT, b"never closes")).drain()
        check(False, "drain: returned without a close frame")
    except Gone:
        pass

    # Close frames.
    check(parse_close(b"") == (None, "") and parse_close(close_payload(4400, "bad-request")) == (4400, "bad-request"), "close: payloads")
    for bad in (b"\x03", struct.pack(">H", 999), struct.pack(">H", 1005), struct.pack(">H", 5000)):
        try:
            parse_close(bad)
            check(False, f"close: {bad!r} was accepted")
        except WsError as error:
            check(error.code == 1002, f"close: {bad!r} is a protocol error")

    # The rate limit, on a clock of its own.
    now = [0.0]
    rate = Rate(frames=5, window=1.0, clock=lambda: now[0])
    burst = [rate() for _ in range(5)]
    check(not any(burst) and rate() is True, "rate: the sixth frame within the window is one too many")
    now[0] = 2.0
    check(not any(rate() for _ in range(5)), "rate: five more after the window has passed")
    slow = Rate(frames=5, window=1.0, clock=lambda: now[0])
    steady = []
    for _ in range(50):
        now[0] += 0.21
        steady.append(slow())
    check(not any(steady), "rate: a steady stream under the limit")

    # Names.
    check(clean_name("  A\x07n\tn \x7f ") == "Ann" and clean_name("\x00 Ann B \x9f") == "Ann B", "name: control characters and outer blanks go")
    check(clean_name("") is None and clean_name(" \x00\x1f ") is None, "name: nothing left")
    check(clean_name("x" * 24) == "x" * 24 and clean_name("x" * 25) is None, "name: 24 characters at most")
    check(clean_name("Zoë 😀") == "Zoë 😀", "name: other characters stay")
    check(clean_name("\ufeff\u00a0 Ann\u2028\ufeff") == "Ann" and clean_name("A\ufeffnn") == "A\ufeffnn", "name: what a browser's trim() removes, at the ends only")

    # The room rules, with members that only record what they are sent.
    class Fake:
        def __init__(self):
            self.got = []

        def send(self, frame):
            source = reader(frame, masked=False, limit=1 << 20)
            opcode, data = source.message()
            self.got.append(json.loads(data) if opcode == OP_TEXT else data)

        def text(self, message):
            self.send(encode_frame(OP_TEXT, dumps(message)))

        def take(self):
            got, self.got = self.got, []
            return got

    rooms = Rooms()

    def enter(code, **query):
        conn = Fake()
        try:
            return rooms.enter(code, {"v": "1", **query}, conn), conn
        except Refused as refusal:
            return refusal.code, conn

    ann, ann_conn = enter("k7m2qx", name=" Ann ", create="1", game="rayman-3")
    check(ann_conn.take() == [{"t": "hello", "v": 1, "id": 1, "room": "K7M2QX", "game": "rayman-3", "public": False, "max": 8, "peers": []}], "rooms: the creator's hello")
    bo, bo_conn = enter("K7M2QX", name="Bo")
    check(bo_conn.take() == [{"t": "hello", "v": 1, "id": 2, "room": "K7M2QX", "game": "rayman-3", "public": False, "max": 8, "peers": [{"id": 1, "name": "Ann"}]}], "rooms: a joiner's hello names the others")
    check(ann_conn.take() == [{"t": "join", "id": 2, "name": "Bo"}], "rooms: the others are told of a join")
    cy, cy_conn = enter("k7m2qx", name="Cy", create="0", game="ignored", public="1")
    check(cy.id == 3 and [peer["id"] for peer in cy_conn.take()[0]["peers"]] == [1, 2], "rooms: ids in join order")
    ann_conn.take(), bo_conn.take()

    for query, what in (({"name": "x", "v": "2"}, "another version"), ({"name": ""}, "an empty name"), ({"name": "x" * 25}, "a long name"),
                        ({"name": "x", "create": "1"}, "create without a game"), ({"name": "x", "create": "1", "game": "Rayman"}, "a game in capitals"),
                        ({"name": "x", "create": "1", "game": "a" * 65}, "a long game"), ({"name": "x", "create": "1", "game": "a\n"}, "a game with a line end")):
        check(enter("ZZZZZZ", **query)[0] == "bad-request", f"rooms: {what} is a bad request")
    check("ZZZZZZ" not in rooms.rooms, "rooms: a refused create leaves no room")
    try:
        rooms.enter("K7M2QX", {"name": "x"}, Fake())
        check(False, "rooms: a missing version was accepted")
    except Refused as refusal:
        check(refusal.code == "bad-request", "rooms: a missing version is a bad request")
    for code in ("K7M2Q", "K7M2QXX", "K7M2Q1", "K7M2QO", "K7M2Q-", "", "k7m2ß", "k7m2qſ", "k7m2ﬀ", "K7M2Q\n"):
        check(enter(code, name="x")[0] == "bad-request", f"rooms: {code!r} is not a code")
    check(enter("AAAAAA", name="x")[0] == "no-room", "rooms: joining a room that is not there")
    check(enter("K7M2QX", name="x", create="1", game="snakes")[0] == "room-exists", "rooms: creating a code in use")

    rooms.binary(ann, b"\x02to bo")
    check(bo_conn.take() == [b"\x01to bo"] and cy_conn.take() == [] and ann_conn.take() == [], "frames: to one member, with the sender's id in front")
    rooms.binary(cy, b"\x00to all")
    check(ann_conn.take() == [b"\x03to all"] and bo_conn.take() == [b"\x03to all"] and cy_conn.take() == [], "frames: to every other member")
    for dropped in (b"\x09nobody", b"\x01myself", b"\x02", b""):
        rooms.binary(ann, dropped)
    check(ann_conn.take() == [] and bo_conn.take() == [] and cy_conn.take() == [], "frames: no such member, the sender itself and empty frames are dropped")
    big = os.urandom(MAX_PAYLOAD)
    rooms.binary(bo, b"\x01" + big)
    check(ann_conn.take() == [b"\x02" + big], "frames: 32768 bytes arrive unchanged")
    for index in range(100):
        rooms.binary(ann, bytes([2 if index % 2 else 0, index]))
    check([frame[1] for frame in bo_conn.take()] == list(range(100)) and [frame[1] for frame in cy_conn.take()] == list(range(0, 100, 2)), "frames: order is kept")

    rooms.text(bo, '{"t":"ping"}')
    check(bo_conn.take() == [{"t": "pong"}] and ann_conn.take() == [], "text: ping is answered to the sender only")
    for ignored in ('{"t":"nonsense"}', "not json", "[1]", '"ping"', "[" * 20000, '{"t":"public","value":1}', '{"t":"public"}'):
        rooms.text(ann, ignored)
    check(ann_conn.take() == [] and bo_conn.take() == [], "text: anything else is ignored")
    check(rooms.listing() == [], "list: a private room is not listed")
    rooms.text(bo, '{"t":"public","value":true}')
    check(rooms.listing() == [] and bo_conn.take() == [] and ann_conn.take() == [], "public: only the creator's counts")
    rooms.text(ann, '{"t":"public","value":true}')
    told = {"t": "public", "value": True}
    check(ann_conn.take() == [told] and bo_conn.take() == [told] and cy_conn.take() == [told], "public: everyone is told")
    check(rooms.listing() == [{"room": "K7M2QX", "game": "rayman-3", "host": "Ann", "players": 3, "max": 8}], "list: the room's entry")
    rooms.text(ann, '{"t":"public","value":true}')
    check(ann_conn.take() == [], "public: no message when nothing changes")

    rooms.leave(bo)
    rooms.leave(bo)
    check(ann_conn.take() == [{"t": "leave", "id": 2}] and cy_conn.take() == [{"t": "leave", "id": 2}] and bo_conn.take() == [], "rooms: the others are told of a leave, once")
    rooms.binary(bo, b"\x00late")
    rooms.binary(ann, b"\x02gone")
    check(ann_conn.take() == [] and cy_conn.take() == [], "frames: nothing from or to a member that left")
    di, di_conn = enter("K7M2QX", name="Di")
    check(di.id == 4, "rooms: an id is not used twice")
    rooms.leave(ann)
    check(rooms.listing()[0]["host"] == "Ann" and rooms.listing()[0]["players"] == 2, "list: the host stays the creator's name")
    rooms.text(cy, '{"t":"public","value":false}')
    check(len(rooms.listing()) == 1, "public: nobody inherits the creator's right")
    others = [enter("K7M2QX", name=f"P{index}") for index in range(6)]
    check([member.id for member, _ in others] == [5, 6, 7, 8, 9, 10], "rooms: eight members fit")
    check(enter("K7M2QX", name="Ninth")[0] == "room-full" and rooms.listing() == [], "rooms: the ninth is refused, and a full room is not listed")
    rooms.leave(others[0][0])
    check(rooms.listing()[0]["players"] == 7, "list: listed again when a place is free")
    for member in [cy, di] + [member for member, _ in others[1:]]:
        rooms.leave(member)
    check(rooms.rooms == {} and enter("K7M2QX", name="x")[0] == "no-room", "rooms: an empty room is gone")
    again, _ = enter("K7M2QX", name="Eve", create="1", game="snakes", public="1")
    check(again.id == 1 and rooms.listing()[0]["host"] == "Eve", "rooms: its code is free again")

    last = again
    for expected in range(2, MAX_IDS + 1):
        member, _ = enter("K7M2QX", name="x")
        if member.id != expected:
            check(False, f"rooms: id {member.id} where {expected} was due")
            break
        rooms.leave(last)
        last = member
    check(enter("K7M2QX", name="x")[0] == "room-full" and rooms.listing() == [], "rooms: after 255 ids the room takes nobody, and is not listed")
    rooms.leave(last)

    for index in range(LIST_MAX + 5):
        enter("AAAA" + ALPHABET[index // 32] + ALPHABET[index % 32], name=f"H{index}", create="1", game="snakes" if index % 2 else "pandemonium", public="1")
    listed = rooms.listing()
    check(len(listed) == LIST_MAX and [entry["host"] for entry in listed] == [f"H{index}" for index in range(LIST_MAX + 4, 4, -1)], "list: the newest fifty, newest first")
    check([entry["host"] for entry in rooms.listing("snakes")] == [f"H{index}" for index in range(LIST_MAX + 3, 0, -2)], "list: one game's rooms")
    check(rooms.listing("no-such-game") == [], "list: a game without rooms")

    check(local_origin(None) and local_origin("http://127.0.0.1:8080") and local_origin("https://localhost") and local_origin("http://LOCALHOST:1"), "origin: localhost, 127.0.0.1 and none")
    check(not local_origin("https://n-ga.ge") and not local_origin("null") and not local_origin("http://127.0.0.1.example.com") and not local_origin("http://[bad"), "origin: anything else")

    # A relay on a local port, with clients on plain sockets.
    class Handler(http.server.BaseHTTPRequestHandler):
        relay = Relay(queue_limit=1 << 20)

        def do_GET(self):
            self.relay.handle(self)

        do_HEAD = do_GET

        def log_message(self, fmt, *args):
            pass

    class Server(http.server.ThreadingHTTPServer):
        request_queue_size = 64

    server = Server(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def fetch(path, method="GET"):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    # Not through urllib, which replaces the Connection header with its own.
    upgrade = {"Upgrade": "websocket", "Connection": "keep-alive, Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": base64.b64encode(bytes(16)).decode()}

    class Client:
        def __init__(self, target, **headers):
            self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
            lines = [f"GET {target} HTTP/1.1", f"Host: 127.0.0.1:{port}"] + [f"{name}: {value}" for name, value in {**upgrade, **headers}.items()]
            self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            self.file = self.sock.makefile("rb")
            self.status = self.file.readline().decode().strip()
            self.headers = {}
            while True:
                line = self.file.readline().decode().strip()
                if not line:
                    break
                name, _, value = line.partition(":")
                self.headers[name.lower()] = value.strip()
            self.reader = Reader(self.read, limit=1 << 20, masked=False)

        def read(self, size):
            try:
                return self.file.read(size) or b""
            except OSError:
                return b""

        def send(self, opcode, payload=b"", fin=True):
            self.sock.sendall(encode_frame(opcode, payload, fin, mask=os.urandom(4)))

        def next(self):
            """The next message: a JSON value for text, bytes for binary,
            ("close", code) for a close, ("pong", payload), None at the end."""
            try:
                opcode, data = self.reader.message()
            except (Gone, WsError):
                return None
            if opcode == OP_TEXT:
                return json.loads(data)
            if opcode == OP_CLOSE:
                return ("close", parse_close(data)[0])
            return ("pong", data) if opcode == OP_PONG else data

        def end(self):
            # Both, or the socket stays open for as long as the file object lives.
            for part in (self.file, self.sock):
                try:
                    part.close()
                except OSError:
                    pass

    def member(code, name, **query):
        query = urllib.parse.urlencode({"v": 1, "name": name, **query})
        connection = Client(f"/net/room/{code}?{query}")
        return connection, connection.next()

    threads_before = None
    try:
        status, headers, body = fetch("/net/health")
        check(status == 200 and body == b'{"ok":true,"v":1}' and headers.get_all("Cache-Control") == ["no-store"], "live: /net/health")
        status, headers, body = fetch("/net/health", method="HEAD")
        check(status == 200 and body == b"" and headers["Content-Length"] == "17", "live: HEAD /net/health")
        check(fetch("/net/rooms")[2] == b'{"rooms":[]}' and fetch("/net/nothing")[0] == 404, "live: /net/rooms, and an unknown path")
        status, headers, _ = fetch("/net/room/ABCDEF?v=1&name=x")
        check(status == 426 and headers["Upgrade"] == "websocket", "live: 426 without an upgrade")
        for expected, headers, what in ((426, {"Sec-WebSocket-Version": "8"}, "an old WebSocket version"), (426, {"Connection": "keep-alive"}, "an Upgrade header alone"),
                                        (400, {"Sec-WebSocket-Key": "short"}, "a bad key"), (403, {"Origin": "https://elsewhere.example"}, "another origin")):
            refused = Client("/net/room/ABCDEF?v=1&name=x", **headers)
            check(refused.status.split()[1] == str(expected) and refused.headers.get("cache-control") == "no-store", f"live: {expected} for {what}")
            refused.end()

        threads_before = threading.active_count()
        ann, hello = member("abcdef", "Ann", create=1, game="snakes", public=1)
        check(ann.status.split()[1] == "101" and ann.headers.get("sec-websocket-accept") == accept_key(upgrade["Sec-WebSocket-Key"]), "live: the handshake")
        check(hello == {"t": "hello", "v": 1, "id": 1, "room": "ABCDEF", "game": "snakes", "public": True, "max": 8, "peers": []}, "live: the creator's hello")
        bo = Client("/net/room/ABCDEF?v=1&name=Bo", Origin="http://localhost:8080")
        check(bo.next()["peers"] == [{"id": 1, "name": "Ann"}] and ann.next() == {"t": "join", "id": 2, "name": "Bo"}, "live: join, from a page on localhost")
        check(json.loads(fetch("/net/rooms?game=snakes")[2]) == {"rooms": [{"room": "ABCDEF", "game": "snakes", "host": "Ann", "players": 2, "max": 8}]}, "live: the room is listed")

        ann.send(OP_BINARY, b"\x02He", fin=False)
        ann.send(OP_PING, b"between")
        ann.send(OP_CONT, b"ll", fin=False)
        ann.send(OP_CONT, b"o")
        check(ann.next() == ("pong", b"between") and bo.next() == b"\x01Hello", "live: a fragmented message, and a ping between its parts")
        payload = os.urandom(MAX_PAYLOAD)
        bo.send(OP_BINARY, b"\x00" + payload)
        check(ann.next() == b"\x02" + payload, "live: 32768 bytes")
        bo.send(OP_TEXT, b'{"t":"ping"}')
        check(bo.next() == {"t": "pong"}, "live: ping and pong as messages")

        refusals = {}
        for what, target in (("bad-request", "/net/room/ABCDEF?name=x"), ("bad-request", "/net/room/nope?v=1&name=x"), ("no-room", "/net/room/ZZZZZZ?v=1&name=x"),
                             ("room-exists", "/net/room/ABCDEF?v=1&name=x&create=1&game=snakes")):
            started = time.monotonic()
            connection = Client(target)
            error, closed = connection.next(), connection.next()
            connection.send(OP_CLOSE, close_payload(ERRORS[what]))
            check(error and error.get("t") == "error" and error.get("code") == what and closed == ("close", ERRORS[what]) and connection.next() is None, f"live: {what} for {target}")
            refusals[target] = time.monotonic() - started
            connection.end()
        check(max(refusals.values()) < LINGER / 2, "live: a refused connection ends as soon as the peer has answered")

        bo.send(OP_BINARY, bytes(MAX_MESSAGE + 1))
        closed = bo.next()
        bo.send(OP_CLOSE, close_payload(1009))
        check(closed == ("close", 1009) and bo.next() is None, "live: a message over the limit closes with 1009")
        check(ann.next() == {"t": "leave", "id": 2}, "live: the others are told")
        bo.end()

        cy, _ = member("ABCDEF", "Cy")
        check(ann.next() == {"t": "join", "id": 3, "name": "Cy"}, "live: the next id")
        cy.sock.sendall(b"".join(encode_frame(OP_BINARY, b"\x09x", mask=mask) for _ in range(RATE_FRAMES + 200)))
        error, closed = cy.next(), cy.next()
        cy.send(OP_CLOSE, close_payload(4429))
        check(error == {"t": "error", "code": "too-fast", "message": error and error.get("message")} and closed == ("close", 4429) and cy.next() is None, "live: too many frames in a second")
        check(ann.next() == {"t": "leave", "id": 3}, "live: and the others are told")
        cy.end()

        # A member that stops reading is cut off, and the sender never waits.
        di, _ = member("ABCDEF", "Di")
        eve, _ = member("ABCDEF", "Eve")
        check(ann.next() == {"t": "join", "id": 4, "name": "Di"} and ann.next() == {"t": "join", "id": 5, "name": "Eve"} and di.next() == {"t": "join", "id": 5, "name": "Eve"}, "live: two more members")
        started = time.monotonic()
        chunk = bytes(MAX_PAYLOAD)
        for _ in range(400):       # 13 MiB for Di, who has stopped reading; the limit here is 1 MiB
            ann.send(OP_BINARY, b"\x04" + chunk)
        ann.send(OP_TEXT, b'{"t":"ping"}')
        check(ann.next() == {"t": "leave", "id": 4} and eve.next() == {"t": "leave", "id": 4}, "live: a member that does not read is dropped")
        check(ann.next() == {"t": "pong"} and time.monotonic() - started < 10, "live: and did not hold the sender up")
        while di.read(65536):
            pass
        di.end()

        # A member that disappears without a close frame.
        eve.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        eve.end()
        check(ann.next() == {"t": "leave", "id": 5}, "live: a connection that was reset is a leave")

        fay, _ = member("ABCDEF", "Fay")
        check(ann.next() == {"t": "join", "id": 6, "name": "Fay"}, "live: one more member")
        started = time.monotonic()
        fay.send(OP_CLOSE, b"\x03")
        check(fay.next() == ("close", 1002) and fay.next() is None and time.monotonic() - started < LINGER / 2, "live: a malformed close is answered with 1002, without waiting")
        check(ann.next() == {"t": "leave", "id": 6}, "live: and is a leave")
        fay.end()

        ann.send(OP_CLOSE, close_payload(1000))
        check(ann.next() == ("close", 1000) and ann.next() is None, "live: a close is answered and the connection ends")
        ann.end()
        check(fetch("/net/rooms")[2] == b'{"rooms":[]}', "live: the empty room is gone")
        until = time.monotonic() + 10
        while threading.active_count() > threads_before and time.monotonic() < until:
            time.sleep(0.05)
        check(threading.active_count() <= threads_before, f"live: no thread is left behind ({threading.active_count()} now, {threads_before} before)")
    except Exception as error:  # a broken relay shows as a failure, not a traceback
        failures.append(f"live: stopped by {type(error).__name__}: {error}")
    finally:
        server.shutdown()
        server.server_close()

    for failure in failures:
        print("FAIL", failure, file=sys.stderr)
    print(f"relay self-test: {len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    if sys.argv[1:] != ["--self-test"]:
        sys.exit(__doc__.split("\n\n")[-1])
    sys.exit(self_test())
