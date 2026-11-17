// The public rooms: what GET /net/rooms lists, and how an entry comes and goes.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPIRE_MS, REFRESH_MS } from '../src/directory.js';
import { call, create, directoryStub, freshCode, freshSite, join, roomStub, rooms, settle } from './helpers.js';

afterEach(() => vi.useRealTimers());

// A sign of life that reaches the room: the tests move the clock by minutes,
// and a member that sends nothing for that long is taken for gone. (The ping
// a client really sends is answered by the runtime, which has its own clock.)
const alive = async (client) => {
  client.send('{ "t": "ping" }');
  expect(await client.next()).toEqual({ t: 'pong' });
};

describe('GET /net/rooms', () => {
  it('answers an empty list', async () => {
    const response = await call('/net/rooms', { site: freshSite() });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"rooms":[]}');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });
  it('lists a public room and not a private one', async () => {
    const site = freshSite();
    const open = freshCode();
    await create(open, { site, isPublic: true, name: ' Ann\u0000 ' });
    await create(freshCode(), { site, name: 'Bo' });
    const response = await call('/net/rooms', { site });
    expect(await response.text()).toBe(`{"rooms":[{"room":"${open}","game":"rayman-3","host":"Ann","players":1,"max":8}]}`);
  });
  it('lists the rooms of one game with ?game=', async () => {
    const site = freshSite();
    const a = freshCode();
    const b = freshCode();
    await create(a, { site, isPublic: true, game: 'rayman-3' });
    await create(b, { site, isPublic: true, game: 'barakel' });
    expect((await rooms(site)).map((room) => room.room).sort()).toEqual([a, b].sort());
    expect((await rooms(site, 'barakel')).map((room) => room.room)).toEqual([b]);
    expect(await rooms(site, 'rayman-3')).toEqual([{ room: a, game: 'rayman-3', host: 'Ann', players: 1, max: 8 }]);
    expect(await rooms(site, 'tony-hawk')).toEqual([]);
  });
  it('lists nothing for a game that is not a slug', async () => {
    const site = freshSite();
    await create(freshCode(), { site, isPublic: true });
    for (const game of ['', 'Rayman', 'a%20b', "'%20OR%201=1", 'x'.repeat(65)]) expect(await rooms(site, game)).toEqual([]);
  });
  it('keeps the lists of two sites apart', async () => {
    const one = freshSite();
    const two = freshSite();
    await create(freshCode(), { site: one, isPublic: true });
    expect(await rooms(one)).toHaveLength(1);
    expect(await rooms(two)).toEqual([]);
  });
  it('lists the newest room first', async () => {
    const site = freshSite();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push(freshCode());
      await create(codes[i], { site, isPublic: true });
      vi.advanceTimersByTime(1000);
    }
    expect((await rooms(site)).map((room) => room.room)).toEqual([...codes].reverse());
    // A join does not make a room newer.
    await join(codes[0], { site });
    expect((await rooms(site)).map((room) => [room.room, room.players])).toEqual([
      [codes[3], 1],
      [codes[2], 1],
      [codes[1], 1],
      [codes[0], 2],
    ]);
  });
  it('lists at most 50', async () => {
    const site = freshSite();
    const directory = directoryStub(site);
    const codes = Array.from({ length: 60 }, freshCode);
    for (const [i, room] of codes.entries()) {
      await directory.update({ room, game: i % 2 ? 'barakel' : 'rayman-3', host: 'Ann', players: 1, created: 1000 + i });
    }
    const all = await rooms(site);
    expect(all).toHaveLength(50);
    expect(all.map((room) => room.room)).toEqual(codes.reverse().slice(0, 50));
    expect(await rooms(site, 'barakel')).toHaveLength(30);
  });
});

describe('a room in the list', () => {
  it('shows how many players it has', async () => {
    const site = freshSite();
    const code = freshCode();
    await create(code, { site, isPublic: true });
    const bo = await join(code, { site });
    await join(code, { site, name: 'Cy' });
    expect(await rooms(site)).toEqual([{ room: code, game: 'rayman-3', host: 'Ann', players: 3, max: 8 }]);
    bo.close();
    await settle();
    expect((await rooms(site))[0].players).toBe(2);
  });
  it('is not listed while it is full', async () => {
    const site = freshSite();
    const code = freshCode();
    await create(code, { site, isPublic: true });
    const members = [];
    for (let i = 2; i <= 8; i++) members.push(await join(code, { site, name: `P${i}` }));
    expect(await rooms(site)).toEqual([]);
    members[0].close();
    await settle();
    expect(await rooms(site)).toEqual([{ room: code, game: 'rayman-3', host: 'Ann', players: 7, max: 8 }]);
  });
  it('comes and goes with the creator\'s "public" message', async () => {
    const site = freshSite();
    const code = freshCode();
    const ann = await create(code, { site });
    expect(await rooms(site)).toEqual([]);
    ann.send('{"t":"public","value":true}');
    await ann.next();
    await settle();
    expect(await rooms(site)).toEqual([{ room: code, game: 'rayman-3', host: 'Ann', players: 1, max: 8 }]);
    ann.send('{"t":"public","value":false}');
    await ann.next();
    await settle();
    expect(await rooms(site)).toEqual([]);
  });
  it('keeps the creator as host after the creator left', async () => {
    const site = freshSite();
    const code = freshCode();
    const ann = await create(code, { site, isPublic: true });
    await join(code, { site });
    ann.close();
    await settle();
    expect(await rooms(site)).toEqual([{ room: code, game: 'rayman-3', host: 'Ann', players: 1, max: 8 }]);
  });
  it('goes when the room empties', async () => {
    const site = freshSite();
    const code = freshCode();
    const ann = await create(code, { site, isPublic: true });
    const bo = await join(code, { site });
    ann.close();
    bo.close();
    await settle();
    expect(await rooms(site)).toEqual([]);
  });
  it('goes when the room has no id left to give', async () => {
    const site = freshSite();
    const code = freshCode();
    await create(code, { site, isPublic: true });
    await runInDurableObject(roomStub(site, code), (_, state) => {
      state.storage.kv.put('room', { ...state.storage.kv.get('room'), nextId: 255 });
    });
    await join(code, { site });
    expect(await rooms(site)).toEqual([]);
  });
});

describe('an entry that is not refreshed', () => {
  it('expires', async () => {
    const site = freshSite();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await create(freshCode(), { site, isPublic: true });
    vi.advanceTimersByTime(EXPIRE_MS - 1000);
    expect(await rooms(site)).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(await rooms(site)).toEqual([]);
  });
  it('is kept alive by the room\'s alarm', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const ann = await create(code, { site, isPublic: true });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(REFRESH_MS);
      await alive(ann);
      expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    }
    expect(REFRESH_MS * 5).toBeGreaterThan(EXPIRE_MS);
    expect(await rooms(site)).toHaveLength(1);
  });
  it('is kept alive across hibernation', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const ann = await create(code, { site, isPublic: true });
    for (let i = 0; i < 5; i++) {
      await evictDurableObject(roomStub(site, code));
      vi.advanceTimersByTime(REFRESH_MS);
      await alive(ann);
      await evictDurableObject(roomStub(site, code));
      expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    }
    expect(await rooms(site)).toEqual([{ room: code, game: 'rayman-3', host: 'Ann', players: 1, max: 8 }]);
  });
  it('is removed by the alarm of a room that lost its sockets', async () => {
    const site = freshSite();
    const code = freshCode();
    const ann = await create(code, { site, isPublic: true });
    await evictDurableObject(roomStub(site, code), { webSockets: 'close' });
    await ann.closed;
    // Nobody saw the member go, so the entry is still there...
    expect(await rooms(site)).toHaveLength(1);
    // ...until the room's next alarm.
    expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    expect(await rooms(site)).toEqual([]);
  });
  it('is removed when a join finds the room gone, or a new room takes the code', async () => {
    const site = freshSite();
    const code = freshCode();
    const ann = await create(code, { site, isPublic: true });
    await evictDurableObject(roomStub(site, code), { webSockets: 'close' });
    await ann.closed;
    const cy = await create(code, { site, name: 'Cy', game: 'barakel' });
    expect(cy.hello.public).toBe(false);
    await settle();
    expect(await rooms(site)).toEqual([]);
  });
});

describe('a member that went silent', () => {
  it('is dropped by the alarm, and the room goes on without it', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const ann = await create(code, { site, isPublic: true });
    vi.advanceTimersByTime(100 * 1000);
    const bo = await join(code, { site });
    await ann.next();
    vi.advanceTimersByTime(100 * 1000);
    // Ann was last heard of 200 seconds ago, Bo 100.
    expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    expect(await ann.closed).toMatchObject({ code: 4408 });
    expect(await bo.next()).toEqual({ t: 'leave', id: 1 });
    expect(await rooms(site)).toEqual([{ room: code, game: 'rayman-3', host: 'Ann', players: 1, max: 8 }]);
  });
  it('ends the room when it was the last one, and the listing with it', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const ann = await create(code, { site, isPublic: true });
    vi.advanceTimersByTime(REFRESH_MS);
    expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    expect(await rooms(site)).toHaveLength(1);
    vi.advanceTimersByTime(REFRESH_MS);
    expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    expect(await ann.closed).toMatchObject({ code: 4408 });
    expect(await rooms(site)).toEqual([]);
    await runInDurableObject(roomStub(site, code), async (_, state) => {
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
  it('gives its seat to the next one who joins', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const ann = await create(code, { site });
    const bo = await join(code, { site });
    await ann.next();
    vi.advanceTimersByTime(200 * 1000);
    await alive(bo);
    const cy = await join(code, { site, name: 'Cy' });
    expect(cy.hello).toMatchObject({ id: 3, peers: [{ id: 2, name: 'Bo' }] });
    expect(await ann.closed).toMatchObject({ code: 4408 });
    expect(await bo.next()).toEqual({ t: 'leave', id: 1 });
    expect(await bo.next()).toEqual({ t: 'join', id: 3, name: 'Cy' });
  });
  it('is not one whose pings the runtime answered', async () => {
    const site = freshSite();
    const code = freshCode();
    const ann = await create(code, { site });
    const stub = roomStub(site, code);
    // As if Ann's last frame were long ago: only a ping can save her.
    const forget = (instance) => {
      for (const member of instance.members.values()) member.seen = 0;
    };
    expect(await runInDurableObject(stub, (instance) => (forget(instance), instance.silent(Date.now()).length))).toBe(1);
    ann.send('{"t":"ping"}');
    expect(await ann.next()).toEqual({ t: 'pong' });
    expect(await runInDurableObject(stub, (instance) => (forget(instance), instance.silent(Date.now()).length))).toBe(0);
  });
  it('is not one that keeps sending, across hibernation', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const ann = await create(code, { site });
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(100 * 1000);
      await alive(ann);
      await evictDurableObject(roomStub(site, code));
      expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    }
    expect((await join(code, { site })).hello.peers).toEqual([{ id: 1, name: 'Ann' }]);
  });
});

describe('what the directory accepts', () => {
  it('drops an entry that is not valid', async () => {
    const site = freshSite();
    const directory = directoryStub(site);
    const good = { room: 'K7M2QX', game: 'rayman-3', host: 'Ann', players: 1, created: 1 };
    for (const bad of [
      { room: 'nope' },
      { game: 'Not A Slug' },
      { host: '' },
      { host: 'a'.repeat(25) },
      { players: 0 },
      { players: 9 },
      { players: '1' },
      { created: 'now' },
    ]) {
      await directory.update({ ...good, ...bad });
    }
    expect(await rooms(site)).toEqual([]);
    await directory.update(good);
    expect(await rooms(site)).toEqual([{ room: 'K7M2QX', game: 'rayman-3', host: 'Ann', players: 1, max: 8 }]);
  });
});
