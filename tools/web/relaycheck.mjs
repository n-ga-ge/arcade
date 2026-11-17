// Conformance check for the multiplayer room relay: the one in the dev server
// (tools/web/relay.py) and the deployed one (the Worker) must both pass it.
//
//   node tools/web/relaycheck.mjs --base http://127.0.0.1:8080/net/ [options]
//
//   --base URL       where the relay is: the http(s) address of /net/
//                    (default http://127.0.0.1:8080/net/)
//   --origin VALUE   send this Origin with every request, as a page of that
//                    site would; a deployed relay refuses upgrades without the
//                    site's
//   --skip A,B       leave out the checks that are heavy on a shared relay:
//                    rate   the too-fast limit (bursts of 2000 and 2100 frames)
//                    ids    using up a room's 255 ids (254 connections in a row)
//                    fifty  the limit of the room list (52 rooms at once)
//   --timeout MS     how long to wait for any one answer (default 5000)
//
// It checks what version 1 of the protocol says, statement by statement, and
// nothing that the protocol leaves open: health, the room list, creating and
// joining, hello, join and leave notices, ids, frames to one member and to
// all, sizes, order, every error with its close code, the listing switch,
// ping, and that an emptied room's code is free again. Every check makes rooms
// of its own, under a game name of its own, so it can run against a relay
// that others are using.
//
// One line per check: "ok", "FAIL" with what was seen, or "skip". Exit code 0
// when all passed, 1 when any failed, 2 when the command line is wrong.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isDeepStrictEqual } from 'node:util';

const OPTIONS = { base: 'value', origin: 'value', skip: 'value', timeout: 'value' };
const GROUPS = ['rate', 'ids', 'fifty'];

function usage(message) {
  console.error(`${message}\nusage: node tools/web/relaycheck.mjs [--base URL] [--origin VALUE] [--skip ${GROUPS.join(',')}] [--timeout MS]`);
  process.exit(2);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, '');
  if (!process.argv[i].startsWith('--') || !OPTIONS[name]) usage(`unknown argument: ${process.argv[i]}`);
  if (i + 1 >= process.argv.length) usage(`--${name} needs a value`);
  args[name] = process.argv[++i];
}

let BASE;
try {
  BASE = new URL(args.base || 'http://127.0.0.1:8080/net/');
} catch {
  usage(`--base is not a URL: ${args.base}`);
}
if (!/^https?:$/.test(BASE.protocol)) usage('--base is the http or https address of /net/');
if (!BASE.pathname.endsWith('/')) BASE.pathname += '/';
BASE.search = '';
BASE.hash = '';
const ORIGIN = args.origin || null;
const TIMEOUT = args.timeout ? Number(args.timeout) : 5000;
if (!(TIMEOUT > 0)) usage('--timeout is a number of milliseconds');
const SKIP = new Set((args.skip || '').split(',').filter(Boolean));
for (const group of SKIP) if (!GROUPS.includes(group)) usage(`--skip knows ${GROUPS.join(', ')}, not ${group}`);

if (typeof WebSocket !== 'function') usage('this Node has no WebSocket; use Node 22 or newer');

// Node's WebSocket takes request headers as an option, which browsers do not
// have. A Node that ignored the option would send no Origin and every check
// would fail for a reason that is not the relay's, so that is found out first.
function sendsOrigin() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.on('upgrade', (request, socket) => {
      socket.destroy();
      probe.close();
      resolve(request.headers.origin === ORIGIN);
    });
    probe.listen(0, '127.0.0.1', () => {
      const socket = new WebSocket(`ws://127.0.0.1:${probe.address().port}/`, { headers: { Origin: ORIGIN } });
      socket.addEventListener('error', () => {});
    });
  });
}
if (ORIGIN && !(await sendsOrigin())) usage('this Node\'s WebSocket cannot send an Origin header; use a newer one (Node 26 can)');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLOSE = { 'bad-request': 4400, 'no-room': 4404, 'room-exists': 4409, 'room-full': 4413, 'too-fast': 4429 };
const MAX_MEMBERS = 8;
const MAX_IDS = 255;
const MAX_PAYLOAD = 32768;
const LIST_MAX = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newCode = () => Array.from(crypto.randomBytes(6), (byte) => ALPHABET[byte % 32]).join('');
// A game nobody else uses, so that the room list can be filtered down to this check's rooms.
const newGame = () => `relaycheck-${crypto.randomBytes(5).toString('hex')}`;
const cut = (text) => (text.length > 200 ? `${text.slice(0, 200)}...` : text);

function describe(item) {
  if (item.text !== undefined) return `the text message ${cut(item.text)}`;
  if (item.binary !== undefined) return `a binary message of ${item.binary.length} bytes starting ${Buffer.from(item.binary.subarray(0, 8)).toString('hex')}`;
  return `a close with code ${item.close}`;
}

function fail(message) {
  throw new Error(message);
}

function same(actual, expected, what) {
  if (!isDeepStrictEqual(actual, expected)) fail(`${what}: expected ${cut(JSON.stringify(expected))}, got ${cut(JSON.stringify(actual))}`);
}

// Every field of `expected` is in `actual` with that value. More fields are
// allowed: the protocol names the ones that must be there.
function has(actual, expected, what) {
  if (!actual || typeof actual !== 'object') fail(`${what}: expected an object, got ${cut(JSON.stringify(actual))}`);
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(actual[key], value)) fail(`${what}: expected "${key}" to be ${cut(JSON.stringify(value))}, got ${cut(JSON.stringify(actual[key]))} in ${cut(JSON.stringify(actual))}`);
  }
}

// Tries until it holds: for what the protocol promises without saying when
// (the list after a change, a code after its room emptied).
async function eventually(what, attempt) {
  const until = Date.now() + TIMEOUT;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= until) fail(`${what}: ${error.message}`);
      await sleep(50);
    }
  }
}

// --- HTTP ----------------------------------------------------------------------

function get(target, headers = {}) {
  const url = new URL(target, BASE);
  const all = { ...(ORIGIN ? { Origin: ORIGIN } : {}), ...headers };
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', headers: all, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, headers: response.headers, body: '' });
    });
    request.on('error', reject);
    request.setTimeout(TIMEOUT, () => request.destroy(new Error(`no answer within ${TIMEOUT} ms`)));
    request.end();
  });
}

function json(response, what) {
  try {
    return JSON.parse(response.body);
  } catch {
    return fail(`${what}: the body is not JSON: ${cut(response.body)}`);
  }
}

function notCached(response, what) {
  if (!/\bno-store\b/i.test(String(response.headers['cache-control'] || ''))) fail(`${what}: Cache-Control is ${JSON.stringify(response.headers['cache-control'])}, expected no-store`);
}

async function listing(game) {
  const what = game ? `/net/rooms?game=${game}` : '/net/rooms';
  const response = await get(game ? `rooms?game=${encodeURIComponent(game)}` : 'rooms');
  if (response.status !== 200) fail(`${what}: status ${response.status}`);
  notCached(response, what);
  const body = json(response, what);
  if (!body || !Array.isArray(body.rooms)) fail(`${what}: expected {"rooms":[...]}, got ${cut(response.body)}`);
  return body.rooms;
}

// --- one connection ------------------------------------------------------------

class Client {
  constructor(code, query, label) {
    const url = new URL(`room/${encodeURIComponent(code)}`, BASE);
    url.protocol = BASE.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [name, value] of Object.entries({ v: 1, ...query })) if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
    this.label = label;
    this.items = [];      // what arrived and nobody has asked for yet, in order
    this.waiting = null;
    this.ended = null;    // the close, which is also the answer to every later question
    this.socket = ORIGIN ? new WebSocket(url.href, { headers: { Origin: ORIGIN } }) : new WebSocket(url.href);
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', (event) => this.arrive(typeof event.data === 'string' ? { text: event.data } : { binary: new Uint8Array(event.data) }));
    this.socket.addEventListener('close', (event) => {
      this.ended = { close: event.code };
      this.arrive(this.ended);
    });
    this.socket.addEventListener('error', () => {});   // the close that follows says it
  }

  arrive(item) {
    if (this.waiting) {
      const { resolve, timer } = this.waiting;
      this.waiting = null;
      clearTimeout(timer);
      resolve(item);
    } else {
      this.items.push(item);
    }
  }

  // The next thing that arrived: { text }, { binary } or { close }.
  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.ended) return Promise.resolve(this.ended);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error(`${this.label} got nothing within ${TIMEOUT} ms`));
      }, TIMEOUT);
      this.waiting = { resolve, timer };
    });
  }

  async message(what) {
    const item = await this.next();
    if (item.text === undefined) fail(`${what}: ${this.label} expected a text message, got ${describe(item)}`);
    try {
      return JSON.parse(item.text);
    } catch {
      return fail(`${what}: ${this.label} got text that is not JSON: ${cut(item.text)}`);
    }
  }

  async expect(expected, what) {
    has(await this.message(what), expected, `${what}: ${this.label}`);
  }

  async frame(what) {
    const item = await this.next();
    if (item.binary === undefined) fail(`${what}: ${this.label} expected a binary message, got ${describe(item)}`);
    return item.binary;
  }

  async expectFrame(sender, payload, what) {
    const frame = await this.frame(what);
    if (frame[0] !== sender) fail(`${what}: ${this.label} expected byte 0 to be the sender's id ${sender}, got ${frame[0]}`);
    if (frame.length !== payload.length + 1 || Buffer.compare(frame.subarray(1), payload) !== 0) fail(`${what}: ${this.label} got a payload of ${frame.length - 1} bytes that differs from the ${payload.length} sent`);
  }

  async closes(code, what) {
    const item = await this.next();
    if (item.close !== code) fail(`${what}: ${this.label} expected a close with code ${code}, got ${describe(item)}`);
  }

  // Nothing but the answer to a ping: whatever else the relay had sent this
  // member before would arrive first.
  async quiet(what) {
    this.send({ t: 'ping' });
    const item = await this.next();
    let message = null;
    try {
      message = item.text === undefined ? null : JSON.parse(item.text);
    } catch {
      // judged below
    }
    if (!message || message.t !== 'pong') fail(`${what}: ${this.label} expected nothing but the pong, got ${describe(item)}`);
  }

  send(data) {
    this.socket.send(typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data));
  }

  // To member `to` (0 for every other member).
  sendFrame(to, payload) {
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = to;
    frame.set(payload, 1);
    this.socket.send(frame);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // not open yet, or closed already
    }
  }

  // Closes and waits until the relay has answered.
  async leave() {
    this.close();
    const until = Date.now() + TIMEOUT;
    while (!this.ended && Date.now() < until) await sleep(5);
    if (!this.ended) fail(`${this.label}: the relay did not answer a close within ${TIMEOUT} ms`);
  }
}

// The connections of one check, closed when it ends.
class Scope {
  constructor() {
    this.clients = [];
    this.game = newGame();
  }

  connect(code, query) {
    const client = new Client(code, query, query && query.name ? String(query.name).trim() || 'a client' : 'a client');
    this.clients.push(client);
    return client;
  }

  // Connects and takes the hello.
  async enter(code, query) {
    const client = this.connect(code, query);
    const first = await client.next();
    if (first.close === 1006) fail(`${client.label}: the connection did not open (was the upgrade refused?)`);
    let hello = null;
    try {
      hello = first.text === undefined ? null : JSON.parse(first.text);
    } catch {
      // judged below
    }
    if (!hello || hello.t !== 'hello') {
      client.close();   // or it would stay in the room it may have got into
      fail(`${client.label} expected the hello first, got ${describe(first)}`);
    }
    client.id = hello.id;
    client.hello = hello;
    return client;
  }

  // A new room; its creator is `name` (default Ann).
  async create(query = {}) {
    const code = newCode();
    const creator = await this.enter(code, { name: 'Ann', create: 1, game: this.game, ...query });
    return { code, creator };
  }

  // A room with members Ann (1), Bo (2), Cy (3), with their notices taken.
  async three(query = {}) {
    const { code, creator: ann } = await this.create(query);
    const bo = await this.enter(code, { name: 'Bo' });
    await ann.expect({ t: 'join', id: 2 }, 'a room of three');
    const cy = await this.enter(code, { name: 'Cy' });
    await ann.expect({ t: 'join', id: 3 }, 'a room of three');
    await bo.expect({ t: 'join', id: 3 }, 'a room of three');
    return { code, ann, bo, cy };
  }

  // A connection that must be accepted, told the error and closed with its code.
  async refused(code, query, name, what) {
    const client = this.connect(code, query);
    const first = await client.next();
    if (first.close !== undefined) fail(`${what}: closed with ${first.close} before any error message${first.close === 1006 ? ' (the upgrade must be accepted and the error sent as a message)' : ''}`);
    let message = null;
    try {
      message = first.text === undefined ? null : JSON.parse(first.text);
    } catch {
      // judged below
    }
    if (!message || message.t !== 'error' || message.code !== name || typeof message.message !== 'string') {
      client.close();   // it may be a member now, and would keep the room alive
      fail(`${what}: expected {"t":"error","code":"${name}","message":"..."}, got ${describe(first)}`);
    }
    await client.closes(CLOSE[name], what);
  }

  async end() {
    for (const client of this.clients) client.close();
    const until = Date.now() + 2000;
    while (this.clients.some((client) => !client.ended) && Date.now() < until) await sleep(10);
  }
}

// --- the checks ------------------------------------------------------------------

const checks = [];
function check(name, run, group = null) {
  checks.push({ name, run, group });
}

check('health: 200 with {"ok":true,"v":1}, not cached', async () => {
  const response = await get('health');
  if (response.status !== 200) fail(`status ${response.status}`);
  same(json(response, '/net/health'), { ok: true, v: 1 }, 'the body');
  notCached(response, '/net/health');
});

check('room list: 200 with {"rooms":[...]}, not cached, every entry complete', async () => {
  const rooms = await listing();
  if (rooms.length > LIST_MAX) fail(`${rooms.length} rooms, more than ${LIST_MAX}`);
  for (const room of rooms) {
    const fine = room && /^[A-HJ-NP-Z2-9]{6}$/.test(room.room) && typeof room.game === 'string' && typeof room.host === 'string'
      && Number.isInteger(room.players) && room.players >= 1 && room.players < MAX_MEMBERS && room.max === MAX_MEMBERS;
    if (!fine) fail(`an entry that is not {room, game, host, players below ${MAX_MEMBERS}, max ${MAX_MEMBERS}}: ${cut(JSON.stringify(room))}`);
  }
});

check('a room without a WebSocket upgrade: 426', async () => {
  const response = await get(`room/${newCode()}?v=1&name=Ann`);
  if (response.status !== 426) fail(`status ${response.status}`);
});

check('create: the hello comes first, with id 1, the room, the game, public false, max 8 and no peers', async (scope) => {
  const { code, creator } = await scope.create();
  has(creator.hello, { t: 'hello', v: 1, id: 1, room: code, game: scope.game, public: false, max: MAX_MEMBERS, peers: [] }, 'the hello');
});

check('create with public=1: the hello says public true', async (scope) => {
  const { creator } = await scope.create({ public: 1 });
  has(creator.hello, { id: 1, public: true }, 'the hello');
});

check('join: the hello has the next id, the room\'s game and the other members as peers', async (scope) => {
  const { code } = await scope.create({ public: 1 });
  const bo = await scope.enter(code, { name: 'Bo', game: 'ignored-on-join', public: 0 });
  has(bo.hello, { t: 'hello', v: 1, id: 2, room: code, game: scope.game, public: true, max: MAX_MEMBERS, peers: [{ id: 1, name: 'Ann' }] }, 'the second member\'s hello');
  const cy = await scope.enter(code, { name: 'Cy' });
  has({ ...cy.hello, peers: [...cy.hello.peers].sort((a, b) => a.id - b.id) }, { id: 3, peers: [{ id: 1, name: 'Ann' }, { id: 2, name: 'Bo' }] }, 'the third member\'s hello');
});

check('room codes: lower case is accepted and the relay uses upper case', async (scope) => {
  const code = newCode();
  const creator = await scope.enter(code.toLowerCase(), { name: 'Ann', create: 1, game: scope.game });
  has(creator.hello, { id: 1, room: code }, 'the hello of a room created in lower case');
  const bo = await scope.enter(code, { name: 'Bo' });
  has(bo.hello, { id: 2, room: code }, 'the hello of a join in upper case');
  const cy = await scope.enter(code.toLowerCase(), { name: 'Cy' });
  has(cy.hello, { id: 3, room: code }, 'the hello of a join in lower case');
});

check('join notice: to every other member, not to the one who joined; the hello comes once', async (scope) => {
  const { code, creator: ann } = await scope.create();
  const bo = await scope.enter(code, { name: 'Bo' });
  same(await ann.message('the notice'), { t: 'join', id: 2, name: 'Bo' }, 'what the creator got');
  const cy = await scope.enter(code, { name: 'Cy' });
  same(await ann.message('the notice'), { t: 'join', id: 3, name: 'Cy' }, 'what the creator got');
  same(await bo.message('the notice'), { t: 'join', id: 3, name: 'Cy' }, 'what the second member got');
  for (const client of [ann, bo, cy]) await client.quiet('after the joins');
});

check('leave notice: to every other member', async (scope) => {
  const { ann, bo, cy } = await scope.three();
  await bo.leave();
  same(await ann.message('the notice'), { t: 'leave', id: 2 }, 'what the creator got');
  same(await cy.message('the notice'), { t: 'leave', id: 2 }, 'what the third member got');
  for (const client of [ann, cy]) await client.quiet('after the leave');
});

check('ids: in join order, and not used again after a member left', async (scope) => {
  const { code, ann, bo, cy } = await scope.three();
  await bo.leave();
  await ann.expect({ t: 'leave', id: 2 }, 'the notice');
  await cy.expect({ t: 'leave', id: 2 }, 'the notice');
  const di = await scope.enter(code, { name: 'Di' });
  has({ ...di.hello, peers: [...di.hello.peers].sort((a, b) => a.id - b.id) }, { id: 4, peers: [{ id: 1, name: 'Ann' }, { id: 3, name: 'Cy' }] }, 'the hello after a member left');
  await ann.expect({ t: 'join', id: 4, name: 'Di' }, 'the notice');
});

check('names: outer blanks and control characters are removed; 24 characters fit', async (scope) => {
  const { code, creator } = await scope.create({ name: '  A\u0007nn  ' });
  const long = 'N'.repeat(24);
  const second = await scope.enter(code, { name: `\u0001${long}\u001f` });
  has(second.hello, { peers: [{ id: 1, name: 'Ann' }] }, 'the creator\'s name as a peer');
  same(await creator.message('the notice'), { t: 'join', id: 2, name: long }, 'the join notice');
});

check('a room lives on without its creator', async (scope) => {
  const { code, ann, bo, cy } = await scope.three();
  await ann.leave();
  await bo.expect({ t: 'leave', id: 1 }, 'the notice');
  await cy.expect({ t: 'leave', id: 1 }, 'the notice');
  const di = await scope.enter(code, { name: 'Di' });
  has({ ...di.hello, peers: [...di.hello.peers].sort((a, b) => a.id - b.id) }, { id: 4, game: scope.game, peers: [{ id: 2, name: 'Bo' }, { id: 3, name: 'Cy' }] }, 'the hello of a later member');
  bo.sendFrame(4, Buffer.from('still here'));
  await di.expectFrame(2, Buffer.from('still here'), 'a frame in the room');
});

check('frames to one member: delivered to it alone, with the sender\'s id in byte 0', async (scope) => {
  const { ann, bo, cy } = await scope.three();
  ann.sendFrame(2, Buffer.from('for Bo'));
  ann.sendFrame(0, Buffer.from('marker'));
  await bo.expectFrame(1, Buffer.from('for Bo'), 'the frame');
  await bo.expectFrame(1, Buffer.from('marker'), 'the frame after it');
  await cy.expectFrame(1, Buffer.from('marker'), 'what the third member got');
  cy.sendFrame(1, Buffer.from('for Ann'));
  await ann.expectFrame(3, Buffer.from('for Ann'), 'the frame back');
  for (const client of [ann, bo, cy]) await client.quiet('afterwards');
});

check('frames to 0: delivered to every other member, not to the sender', async (scope) => {
  const { ann, bo, cy } = await scope.three();
  bo.sendFrame(0, Buffer.from('for all'));
  await ann.expectFrame(2, Buffer.from('for all'), 'the frame');
  await cy.expectFrame(2, Buffer.from('for all'), 'the frame');
  for (const client of [ann, bo, cy]) await client.quiet('afterwards');
});

check('frames to an id that is not there, to one that left, or to the sender: dropped', async (scope) => {
  const { ann, bo, cy } = await scope.three();
  await cy.leave();
  await ann.expect({ t: 'leave', id: 3 }, 'the notice');
  await bo.expect({ t: 'leave', id: 3 }, 'the notice');
  for (const to of [1, 3, 4, 9, 255]) ann.sendFrame(to, Buffer.from(`dropped ${to}`));
  ann.sendFrame(0, Buffer.from('marker'));
  await bo.expectFrame(1, Buffer.from('marker'), 'the first frame after the dropped ones');
  for (const client of [ann, bo]) await client.quiet('afterwards');
});

check('payloads: 1 to 32768 bytes arrive unchanged', async (scope) => {
  const { ann, bo, cy } = await scope.three();
  for (const size of [1, 2, 124, 125, 126, 127, 4096, 16384, MAX_PAYLOAD - 1, MAX_PAYLOAD]) {
    const payload = crypto.randomBytes(size);
    ann.sendFrame(2, payload);
    await bo.expectFrame(1, payload, `${size} bytes to one member`);
    bo.sendFrame(0, payload);
    await ann.expectFrame(2, payload, `${size} bytes to all`);
    await cy.expectFrame(2, payload, `${size} bytes to all`);
  }
});

check('order: kept for each sender and receiver', async (scope) => {
  const { ann, bo, cy } = await scope.three();
  const number = (index) => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(index);
    return payload;
  };
  // Ann alternates between Bo alone and everyone while Cy sends to Bo as well.
  for (let index = 0; index < 400; index++) {
    ann.sendFrame(index % 2 ? 2 : 0, number(index));
    if (index % 2) cy.sendFrame(2, number(index));
  }
  const seen = { 1: [], 3: [] };
  for (let count = 0; count < 600; count++) {
    const frame = await bo.frame('the frames for the second member');
    if (!seen[frame[0]]) fail(`a frame from id ${frame[0]}`);
    seen[frame[0]].push(Buffer.from(frame).readUInt32LE(1));
  }
  same(seen[1], Array.from({ length: 400 }, (_, index) => index), 'the first member\'s frames as the second got them');
  same(seen[3], Array.from({ length: 200 }, (_, index) => index * 2 + 1), 'the third member\'s frames as the second got them');
  const third = [];
  for (let count = 0; count < 200; count++) third.push(Buffer.from(await cy.frame('the frames for the third member')).readUInt32LE(1));
  same(third, Array.from({ length: 200 }, (_, index) => index * 2), 'the first member\'s frames to all as the third got them');
});

check('ping: answered with pong', async (scope) => {
  const { creator } = await scope.create();
  creator.send({ t: 'ping' });
  same(await creator.message('the answer'), { t: 'pong' }, 'the answer');
});

check('other text messages: ignored, and the connection stays', async (scope) => {
  const { creator: ann, code } = await scope.create();
  const bo = await scope.enter(code, { name: 'Bo' });
  await ann.expect({ t: 'join', id: 2 }, 'the notice');
  for (const text of ['{"t":"nonsense"}', '{"t":"hello"}', '{"t":"join","id":7,"name":"X"}', '{}', '[]', 'null', '"ping"', 'not json', '{"t":"public"}', '{"t":"public","value":"yes"}']) bo.send(text);
  await bo.quiet('after the messages');
  await ann.quiet('after the other member\'s messages');
  ann.sendFrame(2, Buffer.from('still there'));
  await bo.expectFrame(1, Buffer.from('still there'), 'a frame afterwards');
});

check('bad-request (4400): a room code that is not 6 characters of the alphabet', async (scope) => {
  // The last three become six letters of the alphabet when put in upper case
  // ("ß" is "SS" then), which does not make them codes.
  for (const code of ['ABCDE', 'ABCDEFG', 'ABCDE1', 'ABCDE0', 'ABCDEI', 'ABCDEO', 'ABCD-F', 'abcd\u00df', 'abcde\u017f', 'abcd\ufb00']) {
    await scope.refused(code, { name: 'Ann', create: 1, game: scope.game }, 'bad-request', `creating ${code}`);
    await scope.refused(code, { name: 'Ann' }, 'bad-request', `joining ${code}`);
  }
});

check('bad-request (4400): a name that is missing, empty, blank or longer than 24 characters', async (scope) => {
  const { code } = await scope.create();
  for (const [name, what] of [[null, 'no name'], ['', 'an empty name'], ['   ', 'a blank name'], ['\u0001\u0002', 'a name of control characters'], ['N'.repeat(25), 'a name of 25 characters']]) {
    await scope.refused(newCode(), { name, create: 1, game: scope.game }, 'bad-request', `creating with ${what}`);
    await scope.refused(code, { name }, 'bad-request', `joining with ${what}`);
  }
});

check('bad-request (4400): a version that is missing or not 1', async (scope) => {
  const { code } = await scope.create();
  for (const [v, what] of [[null, 'no v'], [2, 'v=2'], [0, 'v=0'], ['x', 'v=x']]) {
    await scope.refused(newCode(), { v, name: 'Ann', create: 1, game: scope.game }, 'bad-request', `creating with ${what}`);
    await scope.refused(code, { v, name: 'Bo' }, 'bad-request', `joining with ${what}`);
  }
});

check('bad-request (4400): create without a game, or with one that is not a slug', async (scope) => {
  for (const [game, what] of [[null, 'no game'], ['', 'an empty game'], ['Rayman-3', 'capitals'], ['rayman_3', 'an underscore'], ['rayman 3', 'a blank'], ['g'.repeat(65), '65 characters']]) {
    await scope.refused(newCode(), { name: 'Ann', create: 1, game }, 'bad-request', `creating with ${what}`);
  }
  const code = newCode();
  const creator = await scope.enter(code, { name: 'Ann', create: 1, game: 'g'.repeat(64) });
  has(creator.hello, { id: 1, game: 'g'.repeat(64) }, 'a game of 64 characters');
});

check('no-room (4404): joining a room that does not exist', async (scope) => {
  await scope.refused(newCode(), { name: 'Bo' }, 'no-room', 'joining');
});

check('room-exists (4409): creating a code that is in use', async (scope) => {
  const { code, creator } = await scope.create();
  await scope.refused(code, { name: 'Bo', create: 1, game: scope.game }, 'room-exists', 'creating it again');
  await scope.refused(code.toLowerCase(), { name: 'Bo', create: 1, game: scope.game }, 'room-exists', 'creating it again in lower case');
  await creator.quiet('the room\'s creator');
});

check('room-full (4413): eight members fit, the ninth is refused, and a place that was left can be taken', async (scope) => {
  const { code, creator } = await scope.create();
  const members = [creator];
  for (let id = 2; id <= MAX_MEMBERS; id++) {
    const member = await scope.enter(code, { name: `P${id}` });
    if (member.id !== id) fail(`member number ${id} got id ${member.id}`);
    if (member.hello.peers.length !== id - 1) fail(`member number ${id} was told of ${member.hello.peers.length} peers`);
    members.push(member);
  }
  await scope.refused(code, { name: 'Ninth' }, 'room-full', 'the ninth member');
  for (let id = 2; id <= MAX_MEMBERS; id++) await creator.expect({ t: 'join', id }, 'the notices');
  await creator.quiet('after the refused member');
  await members[3].leave();
  await creator.expect({ t: 'leave', id: 4 }, 'the notice');
  const late = await scope.enter(code, { name: 'Late' });
  has(late.hello, { id: MAX_MEMBERS + 1 }, 'the member who took the free place');
});

check('room-full (4413): a room that has given out 255 ids takes nobody more', async (scope) => {
  const { code, creator } = await scope.create();
  for (let id = 2; id <= MAX_IDS; id++) {
    const member = await scope.enter(code, { name: `P${id}` });
    if (member.id !== id) fail(`the member after id ${id - 1} got id ${member.id}`);
    await creator.expect({ t: 'join', id }, 'the notice');
    await member.leave();
    await creator.expect({ t: 'leave', id }, 'the notice');
    scope.clients.pop();
  }
  await scope.refused(code, { name: 'Late' }, 'room-full', 'the member after id 255');
  await creator.quiet('the creator');
}, 'ids');

check('a message that is too big: closed with 1009', async (scope) => {
  const { code, creator } = await scope.create();
  const bo = await scope.enter(code, { name: 'Bo' });
  await creator.expect({ t: 'join', id: 2 }, 'the notice');
  bo.sendFrame(1, Buffer.alloc(MAX_PAYLOAD + 1, 7));
  let item = await bo.next();
  while (item.text !== undefined) item = await bo.next();   // an error message before the close is allowed
  if (item.close !== 1009) fail(`expected a close with code 1009, got ${describe(item)}`);
  same(await creator.message('what the other member got'), { t: 'leave', id: 2 }, 'what the other member got');
});

check('2000 frames within a second are not too fast', async (scope) => {
  const { creator } = await scope.create();
  for (let count = 0; count < 2000; count++) creator.sendFrame(9, Buffer.of(count & 255));
  await sleep(1500);    // the ping below belongs to the next second
  await creator.quiet('after 2000 frames');
}, 'rate');

check('too-fast (4429): more than 2000 frames within a second', async (scope) => {
  // 2100, not many more: a relay that allowed 2500 would be wrong too. A relay
  // that counts by the clock's seconds can see such a burst as two halves
  // when a second ends in the middle of it, so a burst that passes is tried
  // again, twice, a little later.
  for (let attempt = 1; ; attempt++) {
    const { creator } = await scope.create();
    // To a member that is not there, so that nothing is passed on.
    for (let count = 0; count < 2100; count++) creator.sendFrame(9, Buffer.of(count & 255));
    creator.send({ t: 'ping' });
    const message = await creator.message('the answer to the burst');
    if (message.t === 'pong' && attempt < 3) {
      await sleep(370);
      continue;
    }
    if (message.t !== 'error' || message.code !== 'too-fast' || typeof message.message !== 'string') fail(`expected {"t":"error","code":"too-fast","message":"..."} after 2100 frames, got ${cut(JSON.stringify(message))}`);
    await creator.closes(CLOSE['too-fast'], 'the close');
    return;
  }
}, 'rate');

check('room list: a public room with its code, game, host, players and max; a private one is not listed', async (scope) => {
  const open = await scope.create({ name: ' Hostess ', public: 1 });
  const hidden = await scope.create({ name: 'Hidden' });
  const zero = await scope.create({ name: 'Zero', public: 0 });
  await eventually('the list for the game', async () => same(await listing(scope.game), [{ room: open.code, game: scope.game, host: 'Hostess', players: 1, max: MAX_MEMBERS }], 'its rooms'));
  const all = (await listing()).map((room) => room.room);
  if (all.length < LIST_MAX && !all.includes(open.code)) fail('the public room is not in the list of all games');
  if (all.includes(hidden.code) || all.includes(zero.code)) fail('a private room is in the list of all games');
  same(await listing(newGame()), [], 'the list for a game without rooms');
});

check('room list: players follows joins and leaves', async (scope) => {
  const { code } = await scope.create({ public: 1 });
  const bo = await scope.enter(code, { name: 'Bo' });
  await scope.enter(code, { name: 'Cy' });
  await eventually('after two joins', async () => has((await listing(scope.game))[0], { room: code, players: 3 }, 'the entry'));
  await bo.leave();
  await eventually('after a leave', async () => has((await listing(scope.game))[0], { room: code, players: 2 }, 'the entry'));
});

check('room list: a full room is not listed, and is again when a place is free', async (scope) => {
  const { code } = await scope.create({ public: 1 });
  let last = null;
  for (let id = 2; id <= MAX_MEMBERS; id++) {
    last = await scope.enter(code, { name: `P${id}` });
    if (id === MAX_MEMBERS - 1) await eventually('with seven members', async () => has((await listing(scope.game))[0], { room: code, players: MAX_MEMBERS - 1 }, 'the entry'));
  }
  await eventually('with eight members', async () => same(await listing(scope.game), [], 'the list'));
  await last.leave();
  await eventually('after one left', async () => has((await listing(scope.game))[0], { room: code, players: MAX_MEMBERS - 1 }, 'the entry'));
});

check('room list: newest first, filtered by game', async (scope) => {
  const other = newGame();
  const codes = [];
  for (let index = 0; index < 6; index++) {
    codes.push((await scope.create({ name: `H${index}`, public: 1, game: index % 2 ? other : scope.game })).code);
    await sleep(20);    // rooms made in the same millisecond have no order to speak of
  }
  await eventually('the list for one game', async () => same((await listing(scope.game)).map((room) => room.room), [codes[4], codes[2], codes[0]], 'its rooms'));
  await eventually('the list for the other', async () => same((await listing(other)).map((room) => room.room), [codes[5], codes[3], codes[1]], 'its rooms'));
  const all = (await listing()).map((room) => room.room).filter((code) => codes.includes(code));
  same(all, [...codes].reverse().slice(0, all.length), 'these rooms in the list of all games');
  if (!all.length) fail('none of these rooms is in the list of all games');
});

check('room list: at most 50, the newest', async (scope) => {
  const codes = [];
  for (let index = 0; index < LIST_MAX + 2; index++) {
    codes.push((await scope.create({ name: `H${index}`, public: 1 })).code);
    await sleep(20);
  }
  await eventually('the list for the game', async () => same((await listing(scope.game)).map((room) => room.room), [...codes].reverse().slice(0, LIST_MAX), 'its rooms'));
  const all = await listing();
  if (all.length !== LIST_MAX) fail(`the list of all games has ${all.length} rooms`);
}, 'fifty');

check('room list: the host stays the creator\'s name after the creator left', async (scope) => {
  const { code, creator } = await scope.create({ name: 'Founder', public: 1 });
  const bo = await scope.enter(code, { name: 'Bo' });
  await creator.leave();
  await bo.expect({ t: 'leave', id: 1 }, 'the notice');
  await eventually('the list', async () => same(await listing(scope.game), [{ room: code, game: scope.game, host: 'Founder', players: 1, max: MAX_MEMBERS }], 'its rooms'));
});

check('public: the creator switches the listing on and off, and everyone is told', async (scope) => {
  const { code, ann, bo, cy } = await scope.three();
  same(await listing(scope.game), [], 'the list before');
  ann.send({ t: 'public', value: true });
  for (const client of [ann, bo, cy]) same(await client.message('the message'), { t: 'public', value: true }, `what ${client.label} got`);
  await eventually('the list after switching on', async () => has((await listing(scope.game))[0], { room: code, host: 'Ann', players: 3 }, 'the entry'));
  const di = await scope.enter(code, { name: 'Di' });
  has(di.hello, { id: 4, public: true }, 'the hello of a later member');
  for (const client of [ann, bo, cy]) await client.expect({ t: 'join', id: 4 }, 'the notice');
  ann.send({ t: 'public', value: false });
  for (const client of [ann, bo, cy, di]) same(await client.message('the message'), { t: 'public', value: false }, `what ${client.label} got`);
  await eventually('the list after switching off', async () => same(await listing(scope.game), [], 'its rooms'));
});

check('public: from a member who is not the creator, ignored', async (scope) => {
  const { code, ann, bo, cy } = await scope.three();
  bo.send({ t: 'public', value: true });
  for (const client of [bo, ann, cy]) await client.quiet('after the message');
  same(await listing(scope.game), [], 'the list');
  ann.send({ t: 'public', value: true });
  for (const client of [ann, bo, cy]) await client.expect({ t: 'public', value: true }, 'the creator\'s message');
  cy.send({ t: 'public', value: false });
  for (const client of [cy, ann, bo]) await client.quiet('after the message');
  await eventually('the list', async () => has((await listing(scope.game))[0], { room: code }, 'the entry'));
});

check('an emptied room: its code is free again', async (scope) => {
  const { code, creator } = await scope.create({ public: 1 });
  const bo = await scope.enter(code, { name: 'Bo' });
  await creator.leave();
  await bo.leave();
  await eventually('joining it', () => scope.refused(code, { name: 'Cy' }, 'no-room', 'a join'));
  const game = newGame();
  const again = await eventually('creating it again', () => scope.enter(code, { name: 'Di', create: 1, game }));
  has(again.hello, { id: 1, room: code, game, public: false, peers: [] }, 'the new room\'s hello');
});

check('origin: an upgrade from another site is refused', async () => {
  const response = await get(`room/${newCode()}?v=1&name=Ann&create=1&game=${newGame()}`, {
    Origin: 'https://relaycheck.invalid', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
  });
  if (response.status === 101) fail('it was accepted');
});

// --- run -------------------------------------------------------------------------

console.log(`relaycheck: ${BASE.href}${ORIGIN ? ` as ${ORIGIN}` : ''}`);
try {
  await get('health');
} catch (error) {
  console.log(`FAIL the relay cannot be reached: ${error.message}`);
  process.exit(1);
}

let failed = 0;
let skipped = 0;
for (const { name, run, group } of checks) {
  if (group && SKIP.has(group)) {
    skipped++;
    console.log(`skip ${name}`);
    continue;
  }
  const scope = new Scope();
  try {
    await run(scope);
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  } finally {
    await scope.end();
  }
}
console.log(`relaycheck: ${checks.length - failed - skipped} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
