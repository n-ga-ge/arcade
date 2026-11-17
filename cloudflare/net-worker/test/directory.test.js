// The public rooms: what GET /net/rooms lists, and how an entry comes and goes.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPIRE_MS, REFRESH_MS } from '../src/directory.js';
import { call, create, directoryStub, freshCode, freshSite, join, roomStub, rooms, settle } from './helpers.js';

afterEach(() => vi.useRealTimers());

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
    await create(code, { site, isPublic: true });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(REFRESH_MS);
      expect(await runDurableObjectAlarm(roomStub(site, code))).toBe(true);
    }
    expect(REFRESH_MS * 5).toBeGreaterThan(EXPIRE_MS);
    expect(await rooms(site)).toHaveLength(1);
  });
  it('is kept alive across hibernation', async () => {
    const site = freshSite();
    const code = freshCode();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await create(code, { site, isPublic: true });
    for (let i = 0; i < 5; i++) {
      await evictDurableObject(roomStub(site, code));
      vi.advanceTimersByTime(REFRESH_MS);
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
