// One room: the object that holds its members' WebSockets and passes frames
// between them. There is one object per site and room code.
//
// The sockets are accepted through the WebSocket Hibernation API: while nobody
// sends anything the object is evicted from memory and costs nothing, and the
// connections stay open. Everything that has to outlive that is kept outside
// the object's memory: each member's id, name and creator flag in the
// attachment of its socket, and the room itself (game, public flag, next id)
// in storage. The constructor rebuilds the member table from the sockets.

import { DurableObject } from 'cloudflare:workers';
import { REFRESH_MS } from './directory.js';
import { CLOSE, FrameMeter, LAST_ID, MAX_FRAME, MAX_MEMBERS, MAX_TEXT, TOO_BIG, VERSION } from './protocol.js';

// How often a room that is not public checks that it still has members. A
// room normally ends when its last member leaves; this clears the record of
// one whose sockets were cut without that being seen (a new version of the
// Worker disconnects every socket).
const CHECK_MS = 60 * 60 * 1000;

const PING = JSON.stringify({ t: 'ping' });
const PONG = JSON.stringify({ t: 'pong' });

function send(ws, message) {
  try {
    ws.send(message);
  } catch {
    // The socket is closing; its close event removes the member.
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.kv = ctx.storage.kv;
    this.members = new Map(); // id -> { ws, id, name, creator }
    this.sockets = new Map(); // ws -> the same member
    this.meters = new WeakMap(); // ws -> FrameMeter; starting again after hibernation is fine
    this.told = Promise.resolve(); // the calls to the directory, one after another
    for (const ws of ctx.getWebSockets()) {
      const kept = ws.deserializeAttachment();
      if (kept) this.enrol(ws, kept);
    }
    this.answerPings();
  }

  // The runtime answers a ping itself, without waking the object: members
  // send one every 30 seconds, and that must not keep the room in memory.
  answerPings() {
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  enrol(ws, { id, name, creator }) {
    const member = { ws, id, name, creator };
    this.members.set(id, member);
    this.sockets.set(ws, member);
  }

  // The room's record: { site, code, game, public, host, created, nextId },
  // or undefined while there is no room under this code.
  room() {
    return this.kv.get('room');
  }

  // A connection, already checked by the Worker (index.js): the query holds
  // the validated request. The upgrade is always accepted, because a browser
  // cannot read why one was refused; a connection that cannot be admitted is
  // told so in a message and closed.
  async fetch(request) {
    const query = new URL(request.url).searchParams;
    const ask = {
      site: query.get('site'),
      code: query.get('code'),
      name: query.get('name'),
      create: query.get('create') === '1',
      game: query.get('game'),
      isPublic: query.get('public') === '1',
    };
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // admit() does not wait for anything, so two connections cannot both
    // find the code free or the same seat empty.
    const refusal = this.admit(server, ask);
    if (refusal) {
      send(server, JSON.stringify({ t: 'error', code: refusal.code, message: refusal.message }));
      server.close(CLOSE[refusal.code], refusal.code);
    } else {
      const room = this.room();
      if (ask.create) await this.ctx.storage.setAlarm(Date.now() + (room.public ? REFRESH_MS : CHECK_MS));
      if (room.public) await this.publish(room);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  admit(ws, { site, code, name, create, game, isPublic }) {
    let room = this.room();
    if (room && this.members.size === 0) {
      // The record of a room that lost its members without their leaving
      // being seen. The code is free; a join leaves the record to alarm().
      if (room.public) this.publish(room);
      room = undefined;
    }
    if (create) {
      if (room) return { code: 'room-exists', message: `the room ${code} exists already` };
      room = { site, code, game, public: isPublic, host: name, created: Date.now(), nextId: 1 };
      this.answerPings();
    } else {
      if (!room) return { code: 'no-room', message: `there is no room ${code}` };
      if (this.members.size >= MAX_MEMBERS) return { code: 'room-full', message: `the room ${code} is full` };
      if (room.nextId > LAST_ID) return { code: 'room-full', message: `the room ${code} takes no more players` };
    }
    const member = { id: room.nextId++, name, creator: create };
    this.kv.put('room', room);
    ws.serializeAttachment(member);
    // In join order, which the member table loses when it is rebuilt.
    const peers = [...this.members.values()].map(({ id, name: peer }) => ({ id, name: peer })).sort((a, b) => a.id - b.id);
    send(
      ws,
      JSON.stringify({
        t: 'hello',
        v: VERSION,
        id: member.id,
        room: room.code,
        game: room.game,
        public: room.public,
        max: MAX_MEMBERS,
        peers,
      }),
    );
    this.toAll(JSON.stringify({ t: 'join', id: member.id, name }));
    this.enrol(ws, member);
    return null;
  }

  toAll(message, except = null) {
    for (const member of this.members.values()) {
      if (member !== except) send(member.ws, message);
    }
  }

  // Writes the room's entry in the site's directory, or removes it: a room is
  // listed while it is public, has members and can still give out an id. The
  // calls are queued, so the directory ends up with the last state.
  publish(room) {
    const listed = room.public && this.members.size > 0 && room.nextId <= LAST_ID;
    const entry = { room: room.code, game: room.game, host: room.host, players: this.members.size, created: room.created };
    this.told = this.told.then(async () => {
      try {
        const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(room.site));
        if (listed) await directory.update(entry);
        else await directory.remove(room.code);
      } catch (error) {
        // The list is then wrong until the room's next refresh, or until the
        // entry expires.
        console.warn(`room ${room.code}: could not reach the directory: ${error}`);
      }
    });
    return this.told;
  }

  async webSocketMessage(ws, message) {
    const member = this.sockets.get(ws);
    if (!member) return; // refused, or closed by the relay and still sending
    let meter = this.meters.get(ws);
    if (!meter) this.meters.set(ws, (meter = new FrameMeter()));
    if (meter.tooFast(Date.now())) {
      send(ws, JSON.stringify({ t: 'error', code: 'too-fast', message: 'too many frames in one second' }));
      ws.close(CLOSE['too-fast'], 'too-fast');
      return this.depart(ws);
    }
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME) {
      ws.close(TOO_BIG, 'message too big');
      return this.depart(ws);
    }
    if (typeof message === 'string') return this.text(ws, member, message);

    // Byte 0 names the destination; the frame goes out with the sender's id
    // there instead, and the payload as it came.
    if (size < 2) return;
    const frame = new Uint8Array(message);
    const to = frame[0];
    if (to === member.id) return;
    frame[0] = member.id;
    if (to === 0) this.toAll(message, member);
    else if (this.members.has(to)) send(this.members.get(to).ws, message);
  }

  async text(ws, member, message) {
    if (message.length > MAX_TEXT) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data === null || typeof data !== 'object') return;
    if (data.t === 'ping') {
      // Only a ping the runtime did not answer itself (other spacing).
      send(ws, PONG);
    } else if (data.t === 'public' && typeof data.value === 'boolean' && member.creator) {
      const room = this.room();
      if (!room || room.public === data.value) return;
      room.public = data.value;
      this.kv.put('room', room);
      this.toAll(JSON.stringify({ t: 'public', value: room.public }));
      await this.ctx.storage.setAlarm(Date.now() + (room.public ? REFRESH_MS : CHECK_MS));
      await this.publish(room);
    }
  }

  // A member is gone: tell the others, and end the room with its last one.
  async depart(ws) {
    // A socket that was closing when the object woke up is not among
    // getWebSockets(), so the constructor did not see it; its attachment
    // still says who it was.
    const member = this.sockets.get(ws) ?? ws.deserializeAttachment();
    if (!member) return;
    this.sockets.delete(ws);
    this.members.delete(member.id);
    try {
      // So that the socket does not count as a member after hibernation, for
      // as long as its closing takes.
      ws.serializeAttachment(null);
    } catch {
      // Already closed for good.
    }
    this.toAll(JSON.stringify({ t: 'leave', id: member.id }));
    const room = this.room();
    if (!room) return;
    if (this.members.size === 0) await this.dissolve(room);
    else if (room.public) await this.publish(room);
  }

  // The room is over: nothing of it stays in storage, and the code is free.
  async dissolve(room) {
    this.kv.delete('room');
    this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (room.public) await this.publish(room);
  }

  async webSocketClose(ws, code) {
    try {
      // Complete the closing handshake with the member's own code where that
      // is one that may be sent.
      if (code === 1000 || (code >= 3000 && code <= 4999)) ws.close(code);
      else ws.close();
    } catch {
      // Closed already, by the relay or by the runtime.
    }
    await this.depart(ws);
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, 'connection error');
    } catch {
      // Closed already.
    }
    await this.depart(ws);
  }

  // Runs every REFRESH_MS for a public room, to keep its entry in the
  // directory alive, and every CHECK_MS for the others.
  async alarm() {
    const room = this.room();
    if (!room) return;
    if (this.members.size === 0) return this.dissolve(room);
    if (room.public) await this.publish(room);
    await this.ctx.storage.setAlarm(Date.now() + (room.public ? REFRESH_MS : CHECK_MS));
  }
}
