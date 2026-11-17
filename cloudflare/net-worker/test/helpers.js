// Shared by the test files: requests through the Worker and WebSocket clients
// whose messages can be awaited one by one.

import { env } from 'cloudflare:workers';
import worker from '../src/index.js';

export const SITE = 'https://n-ga.ge';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Every test gets rooms and a site of its own, so that tests neither meet in
// a room nor see each other's public rooms.
let counter = 0;
export function freshCode() {
  let n = ++counter;
  let code = '';
  for (let i = 0; i < 6; i++) {
    code = ALPHABET[n % 32] + code;
    n = Math.floor(n / 32);
  }
  return code;
}
export function freshSite() {
  return `https://site-${++counter}.test`;
}

export function call(path, { method = 'GET', headers = {}, vars = {}, site = SITE } = {}) {
  // ALLOWED_ORIGINS is set here whatever .dev.vars gives the local runtime.
  return worker.fetch(new Request(site + path, { method, headers }), { ...env, ALLOWED_ORIGINS: '', ...vars });
}

export const roomStub = (site, code) => env.ROOMS.get(env.ROOMS.idFromName(`${new URL(site).host}/${code}`));
export const directoryStub = (site) => env.DIRECTORY.get(env.DIRECTORY.idFromName(new URL(site).host));

export async function rooms(site, game) {
  const response = await call(`/net/rooms${game === undefined ? '' : `?game=${game}`}`, { site });
  return (await response.json()).rooms;
}

const WAIT_MS = 2000;

// One connection. `query` is the query string as an object; `origin` null
// sends no Origin header. Resolves to a client:
//   next()      the next message: parsed JSON for a text frame, a Uint8Array
//               for a binary one; rejects when none comes
//   quiet()     true when no message arrives within a short while
//   closed      resolves to { code, reason } when the server closes
//   send(), close()
export async function open(code, query, { site = SITE, origin = site, vars = {} } = {}) {
  const headers = { Upgrade: 'websocket' };
  if (origin !== null) headers.Origin = origin;
  const search = new URLSearchParams(query).toString();
  const response = await call(`/net/room/${code}${search ? `?${search}` : ''}`, { headers, vars, site });
  if (response.status !== 101) return { status: response.status, response };
  const ws = response.webSocket;
  // The runtime hands binary frames out as Blobs unless told otherwise.
  ws.binaryType = 'arraybuffer';
  const queue = [];
  const waiting = [];
  let done;
  const closed = new Promise((resolve) => (done = resolve));
  ws.addEventListener('message', (event) => {
    const message = typeof event.data === 'string' ? JSON.parse(event.data) : new Uint8Array(event.data);
    if (waiting.length) waiting.shift()(message);
    else queue.push(message);
  });
  ws.addEventListener('close', (event) => done({ code: event.code, reason: event.reason }));
  ws.accept();
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no message arrived')), WAIT_MS);
          waiting.push((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        });
  return {
    status: 101,
    ws,
    next,
    closed,
    quiet: async (ms = 100) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return queue.length === 0;
    },
    send: (data) => ws.send(data),
    close: (...args) => ws.close(...args),
  };
}

// Creates a room and returns its creator, with the hello already read.
export async function create(code, { name = 'Ann', game = 'rayman-3', isPublic = false, ...options } = {}) {
  const client = await open(code, { v: 1, name, create: 1, game, ...(isPublic ? { public: 1 } : {}) }, options);
  client.hello = await client.next();
  return client;
}

export async function join(code, { name = 'Bo', ...options } = {}) {
  const client = await open(code, { v: 1, name }, options);
  client.hello = await client.next();
  return client;
}

// A binary frame: the destination and the payload bytes.
export const frame = (to, ...payload) => new Uint8Array([to, ...payload]);

// Lets the objects finish what a close set off (leave notices, the directory).
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
