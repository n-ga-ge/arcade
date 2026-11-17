// One room: who gets in, what the members are told, where the frames go, and
// what closes a connection.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SITE, create, frame, freshCode, join, open, roomStub, settle } from './helpers.js';

const refusedWith = async (client, code, close) => {
  expect(client.status).toBe(101);
  const message = await client.next();
  expect(message).toMatchObject({ t: 'error', code });
  expect(message.message).toBeTypeOf('string');
  expect(Object.keys(message).sort()).toEqual(['code', 'message', 't']);
  expect(await client.closed).toMatchObject({ code: close });
};

describe('creating and joining', () => {
  it('greets the creator', async () => {
    const code = freshCode();
    const ann = await create(code);
    expect(ann.hello).toEqual({ t: 'hello', v: 1, id: 1, room: code, game: 'rayman-3', public: false, max: 8, peers: [] });
    expect(Object.keys(ann.hello)).toEqual(['t', 'v', 'id', 'room', 'game', 'public', 'max', 'peers']);
  });
  it('greets a member with the others, and tells the others', async () => {
    const code = freshCode();
    const ann = await create(code, { game: 'barakel', isPublic: true });
    const bo = await join(code);
    expect(bo.hello).toEqual({
      t: 'hello',
      v: 1,
      id: 2,
      room: code,
      game: 'barakel',
      public: true,
      max: 8,
      peers: [{ id: 1, name: 'Ann' }],
    });
    expect(await ann.next()).toEqual({ t: 'join', id: 2, name: 'Bo' });
    const cy = await join(code, { name: 'Cy' });
    expect(cy.hello.id).toBe(3);
    expect(cy.hello.peers).toEqual([
      { id: 1, name: 'Ann' },
      { id: 2, name: 'Bo' },
    ]);
    expect(await ann.next()).toEqual({ t: 'join', id: 3, name: 'Cy' });
    expect(await bo.next()).toEqual({ t: 'join', id: 3, name: 'Cy' });
    // Nobody is told about themselves.
    expect(await cy.quiet()).toBe(true);
  });
  it('takes the code in lower case and uses upper case', async () => {
    const code = freshCode();
    const ann = await create(code.toLowerCase());
    expect(ann.hello.room).toBe(code);
    const bo = await join(code.toLowerCase());
    expect(bo.hello.room).toBe(code);
    expect(bo.hello.peers).toHaveLength(1);
  });
  it('cleans the names it passes on', async () => {
    const code = freshCode();
    const ann = await create(code, { name: ' \u0007An\nn\u0000 ' });
    const bo = await join(code, { name: '\t<b>Bo</b>\u009f' });
    expect(bo.hello.peers).toEqual([{ id: 1, name: 'Ann' }]);
    expect(await ann.next()).toEqual({ t: 'join', id: 2, name: '<b>Bo</b>' });
  });
  it('keeps the rooms of two sites apart', async () => {
    const code = freshCode();
    await create(code);
    const dev = 'https://dev.n-ga.ge';
    await refusedWith(await open(code, { v: 1, name: 'Bo' }, { site: dev }), 'no-room', 4404);
    const other = await create(code, { site: dev });
    expect(other.hello.id).toBe(1);
  });
});

describe('leaving', () => {
  it('tells the others', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    const cy = await join(code, { name: 'Cy' });
    await ann.next();
    await ann.next();
    await bo.next();
    bo.close(1000);
    expect(await ann.next()).toEqual({ t: 'leave', id: 2 });
    expect(await cy.next()).toEqual({ t: 'leave', id: 2 });
    expect(await bo.closed).toMatchObject({ code: 1000 });
  });
  it('never gives an id out twice', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    bo.close();
    await settle();
    const cy = await join(code, { name: 'Cy' });
    expect(cy.hello.id).toBe(3);
    expect(cy.hello.peers).toEqual([{ id: 1, name: 'Ann' }]);
    expect(await ann.next()).toEqual({ t: 'join', id: 2, name: 'Bo' });
    expect(await ann.next()).toEqual({ t: 'leave', id: 2 });
    expect(await ann.next()).toEqual({ t: 'join', id: 3, name: 'Cy' });
  });
  it('keeps the room when its creator leaves', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    ann.close();
    expect(await bo.next()).toEqual({ t: 'leave', id: 1 });
    const cy = await join(code, { name: 'Cy' });
    expect(cy.hello).toMatchObject({ id: 3, game: 'rayman-3', peers: [{ id: 2, name: 'Bo' }] });
  });
  it('frees the code with the last member, and leaves nothing behind', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    ann.close();
    bo.close();
    await settle();
    await refusedWith(await open(code, { v: 1, name: 'Cy' }), 'no-room', 4404);
    await runInDurableObject(roomStub(SITE, code), async (_, state) => {
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const again = await create(code, { name: 'Di', game: 'barakel' });
    expect(again.hello).toMatchObject({ id: 1, game: 'barakel', peers: [] });
  });
});

describe('refusals', () => {
  it.each([
    ['no version', { name: 'Ann' }],
    ['another version', { v: 2, name: 'Ann' }],
    ['no name', { v: 1 }],
    ['a name of control characters', { v: 1, name: '\u0001\u0002' }],
    ['a name of 25 characters', { v: 1, name: 'a'.repeat(25) }],
    ['a create without a game', { v: 1, name: 'Ann', create: 1 }],
    ['a create with a bad game', { v: 1, name: 'Ann', create: 1, game: 'Rayman_3' }],
  ])('answers bad-request to %s', async (_, query) => refusedWith(await open(freshCode(), query), 'bad-request', 4400));
  it.each(['K7M2Q', 'K7M2QXA', 'K7M2Q0', 'K7M2QI', ''])('answers bad-request to the code "%s"', async (code) =>
    refusedWith(await open(code, { v: 1, name: 'Ann' }), 'bad-request', 4400),
  );
  it('answers bad-request to a code that only upper-cases to one, and does not reach that room', async () => {
    // "ß" is "SS" in upper case, the long s is "S": six characters either way.
    await create('ABCDSS');
    await create('ABCDES');
    for (const code of ['abcdß', 'abcdeſ', encodeURIComponent('abcdß'), encodeURIComponent('abcdeſ')]) {
      await refusedWith(await open(code, { v: 1, name: 'Bo' }), 'bad-request', 4400);
      await refusedWith(await open(code, { v: 1, name: 'Bo', create: 1, game: 'rayman-3' }), 'bad-request', 4400);
    }
  });
  it('does not create a room for a bad request', async () => {
    const code = freshCode();
    await refusedWith(await open(code, { v: 1, name: 'Ann', create: 1 }), 'bad-request', 4400);
    await refusedWith(await open(code, { v: 1, name: 'Bo' }), 'no-room', 4404);
  });
  it('answers no-room to a join of a room that does not exist', async () =>
    refusedWith(await open(freshCode(), { v: 1, name: 'Bo' }), 'no-room', 4404));
  it('answers room-exists to a create of a code in use', async () => {
    const code = freshCode();
    const ann = await create(code);
    await refusedWith(await open(code, { v: 1, name: 'Bo', create: 1, game: 'barakel' }), 'room-exists', 4409);
    // The room is as it was.
    const cy = await join(code, { name: 'Cy' });
    expect(cy.hello).toMatchObject({ id: 2, game: 'rayman-3', peers: [{ id: 1, name: 'Ann' }] });
    expect(await ann.next()).toEqual({ t: 'join', id: 2, name: 'Cy' });
  });
  it('lets one of two simultaneous creates win', async () => {
    const code = freshCode();
    const ask = (name) => open(code, { v: 1, name, create: 1, game: 'rayman-3' });
    const clients = await Promise.all([ask('Ann'), ask('Bo'), ask('Cy')]);
    const first = await Promise.all(clients.map((client) => client.next()));
    expect(first.map((message) => message.t).sort()).toEqual(['error', 'error', 'hello']);
    expect(first.filter((message) => message.t === 'error').map((message) => message.code)).toEqual(['room-exists', 'room-exists']);
    expect(first.find((message) => message.t === 'hello')).toMatchObject({ id: 1, peers: [] });
  });
  it('answers room-full to a ninth member, and takes one again when a seat is free', async () => {
    const code = freshCode();
    const members = [await create(code)];
    for (let i = 2; i <= 8; i++) members.push(await join(code, { name: `P${i}` }));
    expect(members.map((member) => member.hello.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(members[7].hello.peers).toHaveLength(7);
    await refusedWith(await open(code, { v: 1, name: 'P9' }), 'room-full', 4413);
    // The refused one was never a member.
    expect(await members[7].quiet()).toBe(true);
    members[3].close();
    await settle();
    const late = await join(code, { name: 'P10' });
    expect(late.hello.id).toBe(9);
    expect(late.hello.peers.map((peer) => peer.id)).toEqual([1, 2, 3, 5, 6, 7, 8]);
  });
  it('answers room-full once 255 ids are used', async () => {
    const code = freshCode();
    await create(code);
    await runInDurableObject(roomStub(SITE, code), (_, state) => {
      state.storage.kv.put('room', { ...state.storage.kv.get('room'), nextId: 255 });
    });
    const last = await join(code);
    expect(last.hello.id).toBe(255);
    await refusedWith(await open(code, { v: 1, name: 'Cy' }), 'room-full', 4413);
  });
});

describe('binary frames', () => {
  const three = async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    const cy = await join(code, { name: 'Cy' });
    await ann.next();
    await ann.next();
    await bo.next();
    return { code, ann, bo, cy };
  };

  it('go to one member, with the sender in byte 0', async () => {
    const { ann, bo, cy } = await three();
    bo.send(frame(3, 10, 20, 30));
    expect(await cy.next()).toEqual(new Uint8Array([2, 10, 20, 30]));
    cy.send(frame(1, 0, 255));
    expect(await ann.next()).toEqual(new Uint8Array([3, 0, 255]));
    expect(await ann.quiet()).toBe(true);
    expect(await bo.quiet(10)).toBe(true);
  });
  it('go to every other member with destination 0', async () => {
    const { ann, bo, cy } = await three();
    ann.send(frame(0, 1, 2, 3));
    expect(await bo.next()).toEqual(new Uint8Array([1, 1, 2, 3]));
    expect(await cy.next()).toEqual(new Uint8Array([1, 1, 2, 3]));
    expect(await ann.quiet()).toBe(true);
  });
  it('are dropped when the destination is the sender, unknown or gone', async () => {
    const { ann, bo, cy } = await three();
    cy.close();
    await ann.next();
    await bo.next();
    ann.send(frame(1, 1));
    ann.send(frame(3, 2));
    ann.send(frame(9, 3));
    ann.send(frame(255, 4));
    ann.send(frame(2, 5));
    expect(await bo.next()).toEqual(new Uint8Array([1, 5]));
    expect(await ann.quiet()).toBe(true);
    expect(await bo.quiet(10)).toBe(true);
  });
  it('are dropped without a payload', async () => {
    const { ann, bo } = await three();
    ann.send(new Uint8Array([2]));
    ann.send(new Uint8Array([]));
    ann.send(frame(2, 6));
    expect(await bo.next()).toEqual(new Uint8Array([1, 6]));
  });
  it('keep their order and their bytes', async () => {
    const { ann, bo } = await three();
    for (let i = 0; i < 200; i++) ann.send(frame(2, i, 255 - i, 0, i));
    for (let i = 0; i < 200; i++) expect(await bo.next()).toEqual(new Uint8Array([1, i, 255 - i, 0, i]));
  });
  it('carry up to 32768 bytes', async () => {
    const { ann, bo } = await three();
    const big = new Uint8Array(32769);
    for (let i = 1; i < big.length; i++) big[i] = (i * 31) & 255;
    big[0] = 2;
    ann.send(big);
    const got = await bo.next();
    expect(got.length).toBe(32769);
    expect(got[0]).toBe(1);
    expect(got.subarray(1)).toEqual(big.subarray(1));
  });
  it('close the connection with 1009 when they are bigger', async () => {
    const { ann, bo, cy } = await three();
    ann.send(new Uint8Array(32770));
    expect(await ann.closed).toMatchObject({ code: 1009 });
    // Nothing was delivered, and the others see the member go.
    expect(await bo.next()).toEqual({ t: 'leave', id: 1 });
    expect(await cy.next()).toEqual({ t: 'leave', id: 1 });
  });
  it('close the connection with 1009 for a text frame that is too big, too', async () => {
    const { ann, bo } = await three();
    ann.send('x'.repeat(32770));
    expect(await ann.closed).toMatchObject({ code: 1009 });
    expect(await bo.next()).toEqual({ t: 'leave', id: 1 });
  });
});

describe('text frames', () => {
  it('answer a ping', async () => {
    const ann = await create(freshCode());
    ann.send('{"t":"ping"}');
    expect(await ann.next()).toEqual({ t: 'pong' });
    ann.send('{ "t": "ping" }');
    expect(await ann.next()).toEqual({ t: 'pong' });
  });
  it('are ignored when they are anything else', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    await ann.next();
    for (const text of ['', 'hello', '{', 'null', '5', '[]', '{"t":"join","id":9,"name":"Eve"}', '{"t":"hello"}', '{"t":"leave","id":1}', '{"t":"error"}', 'x'.repeat(5000)]) {
      bo.send(text);
    }
    bo.send('{"t":"ping"}');
    expect(await bo.next()).toEqual({ t: 'pong' });
    expect(await ann.quiet()).toBe(true);
    expect(await bo.quiet(10)).toBe(true);
  });
  it('change the listing when the creator says so, and tell everyone', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    await ann.next();
    ann.send('{"t":"public","value":true}');
    expect(await ann.next()).toEqual({ t: 'public', value: true });
    expect(await bo.next()).toEqual({ t: 'public', value: true });
    const cy = await join(code, { name: 'Cy' });
    expect(cy.hello.public).toBe(true);
    await ann.next();
    await bo.next();
    ann.send('{"t":"public","value":false}');
    for (const member of [ann, bo, cy]) expect(await member.next()).toEqual({ t: 'public', value: false });
  });
  it('say nothing when the listing does not change', async () => {
    const ann = await create(freshCode(), { isPublic: true });
    ann.send('{"t":"public","value":true}');
    expect(await ann.quiet()).toBe(true);
  });
  it('do not let another member change the listing', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    await ann.next();
    bo.send('{"t":"public","value":true}');
    expect(await ann.quiet()).toBe(true);
    expect(await bo.quiet(10)).toBe(true);
    expect((await join(code, { name: 'Cy' })).hello.public).toBe(false);
  });
  it.each(['"true"', '1', 'null', '{}'])('ignore a public message whose value is %s', async (value) => {
    const ann = await create(freshCode());
    ann.send(`{"t":"public","value":${value}}`);
    expect(await ann.quiet()).toBe(true);
  });
});

describe('too many frames', () => {
  it('close the connection with too-fast, and not the others', async () => {
    const code = freshCode();
    const ann = await create(code);
    const bo = await join(code);
    await ann.next();
    for (let i = 0; i < 2100; i++) bo.send(frame(1, i & 255));
    // Everything up to the limit is delivered, then the member is gone.
    for (let i = 0; i < 2000; i++) expect(await ann.next()).toEqual(new Uint8Array([2, i & 255]));
    expect(await ann.next()).toEqual({ t: 'leave', id: 2 });
    expect(await bo.next()).toMatchObject({ t: 'error', code: 'too-fast' });
    expect(await bo.closed).toMatchObject({ code: 4429 });
    expect(await ann.quiet()).toBe(true);
    ann.send('{ "t": "ping" }');
    expect(await ann.next()).toEqual({ t: 'pong' });
  });
  it('count text frames as well', async () => {
    const ann = await create(freshCode());
    for (let i = 0; i < 2001; i++) ann.send('{"t":"nothing"}');
    expect(await ann.next()).toMatchObject({ t: 'error', code: 'too-fast' });
    expect(await ann.closed).toMatchObject({ code: 4429 });
  });
});

describe('hibernation', () => {
  it('keeps the members, their ids and names, and the room', async () => {
    const code = freshCode();
    const ann = await create(code, { game: 'barakel' });
    const bo = await join(code);
    await ann.next();
    await evictDurableObject(roomStub(SITE, code));

    // Frames still find their way, in both directions.
    ann.send(frame(2, 1));
    expect(await bo.next()).toEqual(new Uint8Array([1, 1]));
    await evictDurableObject(roomStub(SITE, code));
    bo.send(frame(0, 2));
    expect(await ann.next()).toEqual(new Uint8Array([2, 2]));

    // A new member is told who is there, and gets the next id.
    await evictDurableObject(roomStub(SITE, code));
    const cy = await join(code, { name: 'Cy' });
    expect(cy.hello).toEqual({
      t: 'hello',
      v: 1,
      id: 3,
      room: code,
      game: 'barakel',
      public: false,
      max: 8,
      peers: [
        { id: 1, name: 'Ann' },
        { id: 2, name: 'Bo' },
      ],
    });
    expect(await ann.next()).toEqual({ t: 'join', id: 3, name: 'Cy' });

    // The creator is still the creator, and a leave is still seen.
    await evictDurableObject(roomStub(SITE, code));
    bo.send('{"t":"public","value":true}');
    ann.send('{"t":"public","value":true}');
    expect(await bo.next()).toEqual({ t: 'join', id: 3, name: 'Cy' });
    expect(await bo.next()).toEqual({ t: 'public', value: true });
    await evictDurableObject(roomStub(SITE, code));
    cy.close();
    expect(await bo.next()).toEqual({ t: 'leave', id: 3 });
    await evictDurableObject(roomStub(SITE, code));
    await refusedWith(await open(code, { v: 1, name: 'Di', create: 1, game: 'rayman-3' }), 'room-exists', 4409);
  });
  it('answers pings without the object', async () => {
    const code = freshCode();
    const ann = await create(code);
    await evictDurableObject(roomStub(SITE, code));
    ann.send('{"t":"ping"}');
    expect(await ann.next()).toEqual({ t: 'pong' });
  });
  it('ends the room when the last member leaves a sleeping object', async () => {
    const code = freshCode();
    const ann = await create(code);
    await evictDurableObject(roomStub(SITE, code));
    ann.close();
    await settle();
    await runInDurableObject(roomStub(SITE, code), async (_, state) => {
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await refusedWith(await open(code, { v: 1, name: 'Bo' }), 'no-room', 4404);
  });
});

describe('a room that lost its sockets', () => {
  const lose = async (options) => {
    const code = freshCode();
    const ann = await create(code, options);
    const bo = await join(code);
    await evictDurableObject(roomStub(SITE, code), { webSockets: 'close' });
    await Promise.all([ann.closed, bo.closed]);
    return code;
  };

  it('does not exist for a join, and is cleared by its alarm', async () => {
    const code = await lose();
    await refusedWith(await open(code, { v: 1, name: 'Cy' }), 'no-room', 4404);
    expect(await runDurableObjectAlarm(roomStub(SITE, code))).toBe(true);
    await runInDurableObject(roomStub(SITE, code), async (_, state) => {
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
  it('gives its code to a new room', async () => {
    const code = await lose();
    const cy = await create(code, { name: 'Cy', game: 'barakel' });
    expect(cy.hello).toMatchObject({ id: 1, game: 'barakel', peers: [] });
    const di = await join(code, { name: 'Di' });
    expect(di.hello.peers).toEqual([{ id: 1, name: 'Cy' }]);
  });
});

describe('the alarm', () => {
  it('is set for every room and set again while the room lives', async () => {
    for (const isPublic of [false, true]) {
      const code = freshCode();
      await create(code, { isPublic });
      const stub = roomStub(SITE, code);
      const before = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
      expect(before).toBeGreaterThan(Date.now());
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const after = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
      expect(after).toBeGreaterThan(Date.now());
      // The room is untouched.
      expect((await join(code)).hello.id).toBe(2);
    }
  });
});
