// The relay for multiplayer: rooms of up to 8 players under /net/ on the
// site's own host names. A room passes opaque binary frames between its
// members and knows nothing about what is in them. README.md describes the
// protocol; the short version:
//
// - GET /net/health            {"ok":true,"v":1}
// - GET /net/rooms[?game=]     the public rooms that can be joined (directory.js)
// - GET /net/room/<CODE>       a WebSocket into one room (room.js), for pages
//                              of the site and of the origins in ALLOWED_ORIGINS
//
// Rooms and lists are kept per host name the request arrived on, so the live
// site and the dev site do not see each other's rooms.

import { checkOrigin } from './access.js';
import { CLOSE, VERSION, isGame, parseJoin } from './protocol.js';

export { Directory } from './directory.js';
export { Room } from './room.js';

const ALLOW = 'GET, HEAD';

function headers(access, extra = {}) {
  const all = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin', ...extra });
  if (access.corsOrigin !== null) all.set('Access-Control-Allow-Origin', access.corsOrigin);
  return all;
}

function text(status, message, access, extra = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: headers(access, { 'Content-Type': 'text/plain; charset=utf-8', ...extra }),
  });
}

function json(body, access) {
  return new Response(JSON.stringify(body), {
    headers: headers(access, { 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

// A connection that is refused before it reaches a room: the upgrade is
// accepted all the same, because a browser cannot read the status of a
// refused one, and the reason goes out as a message before the close.
function refuse(code, message) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.send(JSON.stringify({ t: 'error', code, message }));
  server.close(CLOSE[code], code);
  return new Response(null, { status: 101, webSocket: client });
}

async function connect(request, env, url, pathCode, access) {
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return text(426, 'This address takes WebSocket connections only.', access, { Upgrade: 'websocket' });
  }
  if (!access.allowed) return text(403, 'Forbidden', access);
  const ask = parseJoin(pathCode, url.searchParams);
  if (ask.error) return refuse('bad-request', ask.error);
  // What the room gets is the validated request, not the client's query.
  const inner = new URL('https://room/');
  inner.search = new URLSearchParams({
    site: url.host,
    code: ask.code,
    name: ask.name,
    create: ask.create ? '1' : '',
    game: ask.game ?? '',
    public: ask.isPublic ? '1' : '',
  }).toString();
  const room = env.ROOMS.get(env.ROOMS.idFromName(`${url.host}/${ask.code}`));
  return room.fetch(new Request(inner, request));
}

async function rooms(env, url, access) {
  const game = url.searchParams.get('game');
  // No room can have a game that is not a slug.
  if (game !== null && !isGame(game)) return json({ rooms: [] }, access);
  const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName(url.host));
  return json({ rooms: await directory.list(game) }, access);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const access = checkOrigin(request, url.origin, env);
    const room = /^\/net\/room\/([^/]*)$/.exec(url.pathname);
    if (url.pathname !== '/net/health' && url.pathname !== '/net/rooms' && room === null) {
      return text(404, 'Not found', access);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'Method not allowed', access, { Allow: ALLOW });
    }
    if (room !== null) return connect(request, env, url, room[1], access);
    if (url.pathname === '/net/health') return json({ ok: true, v: VERSION }, access);
    return rooms(env, url, access);
  },
};
