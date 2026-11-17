// The input rules: names, codes, games, the request of a connection, the
// frame counter and the origin list.

import { describe, expect, it } from 'vitest';
import { allowedOrigins } from '../src/access.js';
import { FrameMeter, MAX_FRAMES_PER_SECOND, isGame, parseJoin, playerName, roomCode } from '../src/protocol.js';

const query = (values) => new URLSearchParams(values);

describe('playerName', () => {
  it('keeps an ordinary name', () => expect(playerName('Ann')).toBe('Ann'));
  it('trims', () => expect(playerName('  Ann \t')).toBe('Ann'));
  it('removes control characters, inside and at the ends', () => {
    expect(playerName('\u0000A\u0007n\u001bn\u007f\u0085')).toBe('Ann');
    expect(playerName('\n Ann')).toBe('Ann');
    expect(playerName('A\r\nnn')).toBe('Ann');
  });
  it('keeps what a page must escape, unchanged', () => expect(playerName('<b>&"\'</b>')).toBe('<b>&"\'</b>'));
  it('counts characters, not bytes or UTF-16 units', () => {
    expect(playerName('é'.repeat(24))).toBe('é'.repeat(24));
    expect(playerName('😀'.repeat(24))).toBe('😀'.repeat(24));
    expect(playerName('😀'.repeat(25))).toBeNull();
  });
  it('accepts 1 to 24 characters', () => {
    expect(playerName('a')).toBe('a');
    expect(playerName('a'.repeat(24))).toBe('a'.repeat(24));
    expect(playerName('a'.repeat(25))).toBeNull();
    expect(playerName(` ${'a'.repeat(24)} `)).toBe('a'.repeat(24));
  });
  it.each(['', '   ', '\u0000\u0001', '\t\n', null, undefined, 5])('refuses %j', (value) => expect(playerName(value)).toBeNull());
});

describe('roomCode', () => {
  it('accepts the alphabet and makes it upper case', () => {
    expect(roomCode('K7M2QX')).toBe('K7M2QX');
    expect(roomCode('k7m2qx')).toBe('K7M2QX');
  });
  it('accepts every character of the alphabet in both cases, and no other ASCII character', () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 128; i++) {
      const ch = String.fromCharCode(i);
      const expected = alphabet.includes(ch.toUpperCase()) ? `AAAAA${ch.toUpperCase()}` : null;
      expect(roomCode(`AAAAA${ch}`), `character ${i}`).toBe(expected);
    }
  });
  it.each(['', 'K7M2Q', 'K7M2QXA', 'K7M2QI', 'K7M2QO', 'K7M2Q0', 'K7M2Q1', 'K7M2Q-', 'K7M 2Q', '%4B7M2QX', 'k7m2qi', 'k7m2ql0', null, undefined, 5, ['K7M2QX']])(
    'refuses %j',
    (value) => expect(roomCode(value)).toBeNull(),
  );
  // Letters whose upper case is, or looks like, letters of the alphabet:
  // "ß" becomes "SS", the long s "S", the ligature "ﬀ" "FF"; the Kelvin sign
  // and the dotless i fold to "k" and "I"; full-width letters are not ASCII.
  it.each(['abcdß', 'ABCDß', 'abcdeſ', 'abcdﬀ', 'abcde\u212a', 'abcde\u0131', 'ＡＢＣＤＥＦ', 'abcde\u00e9', 'K7M2Q\u0301'])(
    'refuses %j, which only upper-cases to a code',
    (value) => expect(roomCode(value)).toBeNull(),
  );
});

describe('isGame', () => {
  it.each(['a', 'rayman-3', 'x'.repeat(64), '007'])('accepts %j', (value) => expect(isGame(value)).toBe(true));
  it.each(['', 'Rayman', 'rayman_3', 'rayman 3', 'x'.repeat(65), 'a/b', null, undefined])('refuses %j', (value) =>
    expect(isGame(value)).toBe(false),
  );
});

describe('parseJoin', () => {
  it('reads a join', () =>
    expect(parseJoin('k7m2qx', query({ v: 1, name: ' Bo ' }))).toEqual({
      code: 'K7M2QX',
      name: 'Bo',
      create: false,
      game: null,
      isPublic: false,
    }));
  it('ignores game and public on a join', () =>
    expect(parseJoin('K7M2QX', query({ v: 1, name: 'Bo', game: 'Not A Slug', public: 1 }))).toMatchObject({
      create: false,
      game: null,
      isPublic: false,
    }));
  it('reads a create', () =>
    expect(parseJoin('K7M2QX', query({ v: 1, name: 'Ann', create: 1, game: 'rayman-3', public: 1 }))).toEqual({
      code: 'K7M2QX',
      name: 'Ann',
      create: true,
      game: 'rayman-3',
      isPublic: true,
    }));
  it('takes create and public only when they are exactly 1', () => {
    for (const value of ['', '0', '01', '1.0', ' 1', 'true', 'yes', 'on']) {
      // Not a create: so no game is needed, and none is taken.
      expect(parseJoin('K7M2QX', query({ v: 1, name: 'Ann', create: value })), `create=${value}`).toEqual({
        code: 'K7M2QX',
        name: 'Ann',
        create: false,
        game: null,
        isPublic: false,
      });
      expect(parseJoin('K7M2QX', query({ v: 1, name: 'Ann', create: 1, game: 'rayman-3', public: value })).isPublic, `public=${value}`).toBe(false);
    }
  });
  it('creates a private room without public=1', () => {
    expect(parseJoin('K7M2QX', query({ v: 1, name: 'Ann', create: 1, game: 'rayman-3' })).isPublic).toBe(false);
    expect(parseJoin('K7M2QX', query({ v: 1, name: 'Ann', create: 1, game: 'rayman-3', public: 'true' })).isPublic).toBe(false);
  });
  it.each([
    ['no version', { name: 'Ann' }],
    ['another version', { v: 2, name: 'Ann' }],
    ['a version that only starts right', { v: '1.0', name: 'Ann' }],
    ['no name', { v: 1 }],
    ['an empty name', { v: 1, name: ' \u0000 ' }],
    ['a long name', { v: 1, name: 'a'.repeat(25) }],
    ['a create without a game', { v: 1, name: 'Ann', create: 1 }],
    ['a create with a game that is not a slug', { v: 1, name: 'Ann', create: 1, game: 'Rayman 3' }],
  ])('refuses %s', (_, values) => expect(parseJoin('K7M2QX', query(values)).error).toBeTypeOf('string'));
  it('refuses a code that is not one', () => expect(parseJoin('K7M2Q0', query({ v: 1, name: 'Ann' })).error).toBeTypeOf('string'));
});

describe('FrameMeter', () => {
  it('allows the limit within a second and refuses one more', () => {
    const meter = new FrameMeter();
    for (let i = 0; i < MAX_FRAMES_PER_SECOND; i++) expect(meter.tooFast(5000 + Math.floor((i * 900) / MAX_FRAMES_PER_SECOND))).toBe(false);
    expect(meter.tooFast(5899)).toBe(true);
  });
  it('forgets frames that are a second old', () => {
    const meter = new FrameMeter();
    for (let i = 0; i < MAX_FRAMES_PER_SECOND; i++) meter.tooFast(5000);
    expect(meter.tooFast(6000)).toBe(false);
    for (let i = 0; i < MAX_FRAMES_PER_SECOND - 1; i++) expect(meter.tooFast(6050)).toBe(false);
    expect(meter.tooFast(6099)).toBe(true);
  });
  it('never refuses a steady rate at the limit', () => {
    const meter = new FrameMeter();
    // 200 frames every 100 ms for a minute.
    for (let tick = 0; tick < 600; tick++) {
      for (let i = 0; i < MAX_FRAMES_PER_SECOND / 10; i++) expect(meter.tooFast(100000 + tick * 100)).toBe(false);
    }
  });
  it('survives a clock that goes backwards', () => {
    const meter = new FrameMeter();
    for (let i = 0; i < MAX_FRAMES_PER_SECOND; i++) meter.tooFast(9000);
    expect(meter.tooFast(3000)).toBe(false);
  });
});

describe('allowedOrigins', () => {
  it('accepts nothing when empty', () => {
    for (const value of ['', undefined, null, ' , ']) {
      expect(allowedOrigins(value)('https://n-ga.ge')).toBe(false);
      expect(allowedOrigins(value)(null)).toBe(false);
    }
  });
  it('matches an exact origin', () => {
    const allowed = allowedOrigins('https://a.example, https://b.example/');
    expect(allowed('https://a.example')).toBe(true);
    expect(allowed('https://b.example')).toBe(true);
    expect(allowed('http://a.example')).toBe(false);
    expect(allowed('https://a.example:8443')).toBe(false);
    expect(allowed('https://a.example.evil.test')).toBe(false);
  });
  it('matches subdomains of a wildcard entry, not the bare domain', () => {
    const allowed = allowedOrigins('https://*.n-ga-ge.pages.dev');
    expect(allowed('https://abc.n-ga-ge.pages.dev')).toBe(true);
    expect(allowed('https://a.b.n-ga-ge.pages.dev')).toBe(true);
    expect(allowed('https://n-ga-ge.pages.dev')).toBe(false);
    expect(allowed('https://evil-n-ga-ge.pages.dev')).toBe(false);
    expect(allowed('https://evil.example/.n-ga-ge.pages.dev')).toBe(false);
    expect(allowed('https://.n-ga-ge.pages.dev')).toBe(false);
    expect(allowed('https://abc.n-ga-ge.pages.dev:444')).toBe(false);
  });
  it('matches any port of a ":*" entry', () => {
    const allowed = allowedOrigins('http://127.0.0.1:* http://localhost:*');
    expect(allowed('http://127.0.0.1:8080')).toBe(true);
    expect(allowed('http://127.0.0.1')).toBe(true);
    expect(allowed('http://localhost:8110')).toBe(true);
    expect(allowed('https://localhost:8110')).toBe(false);
    expect(allowed('http://localhost.evil.test:8110')).toBe(false);
    expect(allowed('http://localhost:8110.evil.test')).toBe(false);
    expect(allowed('http://localhost:81:10')).toBe(false);
    expect(allowed('http://127.0.0.10:8080')).toBe(false);
  });
  it('accepts a request without Origin only when the list says "none"', () => {
    expect(allowedOrigins('https://a.example')(null)).toBe(false);
    expect(allowedOrigins('https://a.example none')(null)).toBe(true);
    // The word is not an origin: a page cannot send it.
    expect(allowedOrigins('none')('none')).toBe(false);
    expect(allowedOrigins('none')('null')).toBe(false);
  });
});
