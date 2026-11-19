// Objects, methods, byte ranges and conditional requests.

import { beforeAll, describe, expect, it } from 'vitest';
import { UNSATISFIABLE, parseRange } from '../src/conditions.js';
import { REVALIDATE, bucket, bytes, call } from './helpers.js';

const ZIP = bytes(1000, 7);
const ROM = bytes(4096, 11);
let etag;

beforeAll(async () => {
  await bucket.put('NGAGE.ROM', ROM);
  etag = (await bucket.put('games/alpha.zip', ZIP)).httpEtag;
  await bucket.put('games/empty.zip', new Uint8Array(0));
  await bucket.put('devices/rm-409.zip', ZIP);
  await bucket.put('ngage2/ngage-1.40.1557.sis', ROM);
  await bucket.put('devices/other.zip', ZIP);
  await bucket.put('ngage2/other.sis', ROM);
  // In the bucket, but not keys the site uses.
  await bucket.put('manifest.json', '{}');
  await bucket.put('games/Bad_Name.zip', ZIP);
  await bucket.put('games/sub/dir.zip', ZIP);
  await bucket.put('games/alpha.zip.bak', ZIP);
});

describe('GET', () => {
  it('returns a game zip with its headers', async () => {
    const { status, headers, body } = await call('/assets/games/alpha.zip');
    expect(status).toBe(200);
    expect(body).toEqual(ZIP);
    expect(headers.get('Content-Length')).toBe('1000');
    expect(headers.get('Content-Type')).toBe('application/zip');
    expect(headers.get('Accept-Ranges')).toBe('bytes');
    expect(headers.get('ETag')).toBe(etag);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Date.parse(headers.get('Last-Modified'))).not.toBeNaN();
    expect(headers.get('Content-Range')).toBeNull();
  });

  it('returns the firmware as plain bytes', async () => {
    const { status, headers, body } = await call('/assets/NGAGE.ROM');
    expect(status).toBe(200);
    expect(body).toEqual(ROM);
    expect(headers.get('Content-Length')).toBe('4096');
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it.each([['/assets/devices/rm-409.zip', 'application/zip'], ['/assets/ngage2/ngage-1.40.1557.sis', 'application/octet-stream']])(
    'returns the N-Gage 2.0 firmware %s', async (path, type) => {
      const { status, headers } = await call(path);
      expect(status).toBe(200);
      expect(headers.get('Content-Type')).toBe(type);
    });

  it('returns an empty object', async () => {
    const { status, headers, body } = await call('/assets/games/empty.zip');
    expect(status).toBe(200);
    expect(body.length).toBe(0);
    expect(headers.get('Content-Length')).toBe('0');
  });
});

describe('HEAD', () => {
  it('describes the object without a body', async () => {
    const { status, headers, body } = await call('/assets/games/alpha.zip', { method: 'HEAD' });
    expect(status).toBe(200);
    expect(body.length).toBe(0);
    expect(headers.get('Content-Length')).toBe('1000');
    expect(headers.get('Content-Type')).toBe('application/zip');
    expect(headers.get('Accept-Ranges')).toBe('bytes');
    expect(headers.get('ETag')).toBe(etag);
  });

  it('ignores Range, which is only defined for GET', async () => {
    const headers = { 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=0-9' };
    const head = await call('/assets/games/alpha.zip', { method: 'HEAD', headers });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('1000');
    expect(head.headers.get('Content-Range')).toBeNull();
  });

  it('answers 404 without a body', async () => {
    const { status, body } = await call('/assets/games/missing.zip', { method: 'HEAD' });
    expect(status).toBe(404);
    expect(body.length).toBe(0);
  });
});

describe('Range', () => {
  const ranged = (range, path = '/assets/games/alpha.zip') =>
    call(path, { headers: { 'Sec-Fetch-Site': 'same-origin', Range: range } });

  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=100-199', 100, 199],
    ['bytes=0-0', 0, 0],
    ['bytes=999-999', 999, 999],
    ['bytes=900-', 900, 999],
    ['bytes=0-', 0, 999],
    ['bytes=-100', 900, 999],
    ['bytes=-1', 999, 999],
    // An end past the object is cut to its last byte.
    ['bytes=990-5000', 990, 999],
    // A suffix longer than the object is the whole object.
    ['bytes=-5000', 0, 999],
    ['BYTES=10-19', 10, 19],
  ])('%s is bytes %i-%i', async (range, start, end) => {
    const { status, headers, body } = await ranged(range);
    expect(status).toBe(206);
    expect(headers.get('Content-Range')).toBe(`bytes ${start}-${end}/1000`);
    expect(headers.get('Content-Length')).toBe(String(end - start + 1));
    expect(body).toEqual(ZIP.slice(start, end + 1));
    expect(headers.get('ETag')).toBe(etag);
    expect(headers.get('Accept-Ranges')).toBe('bytes');
    expect(headers.get('Content-Type')).toBe('application/zip');
  });

  it.each(['bytes=1000-', 'bytes=1000-1001', 'bytes=5000-6000', 'bytes=-0'])('%s is 416', async (range) => {
    const { status, headers } = await ranged(range);
    expect(status).toBe(416);
    expect(headers.get('Content-Range')).toBe('bytes */1000');
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('is 416 for any range of an empty object', async () => {
    for (const range of ['bytes=0-', 'bytes=0-0', 'bytes=-1']) {
      const { status, headers } = await ranged(range, '/assets/games/empty.zip');
      expect(status).toBe(416);
      expect(headers.get('Content-Range')).toBe('bytes */0');
    }
  });

  // A server may ignore a Range header it does not handle; the whole object
  // is then the correct answer.
  it.each(['bytes=0-1,5-6', 'items=0-5', 'bytes=5-2', 'bytes=abc', 'bytes=-', 'bytes 0-5', ''])(
    '"%s" is ignored',
    async (range) => {
      const { status, headers, body } = await ranged(range);
      expect(status).toBe(200);
      expect(headers.get('Content-Range')).toBeNull();
      expect(body).toEqual(ZIP);
    },
  );

  it('handles positions too large for exact arithmetic', () => {
    const huge = '9'.repeat(400);
    expect(parseRange(`bytes=${huge}-`, 1000)).toBe(UNSATISFIABLE);
    expect(parseRange(`bytes=5-${huge}`, 1000)).toEqual({ start: 5, end: 999 });
    expect(parseRange(`bytes=-${huge}`, 1000)).toEqual({ start: 0, end: 999 });
  });
});

describe('conditional requests', () => {
  const conditional = (extra, method = 'GET') =>
    call('/assets/games/alpha.zip', { method, headers: { 'Sec-Fetch-Site': 'same-origin', ...extra } });
  const PAST = 'Sat, 01 Jan 2000 00:00:00 GMT';
  const FUTURE = 'Fri, 01 Jan 2100 00:00:00 GMT';
  const OTHER = '"0123456789abcdef0123456789abcdef"';

  it.each([
    ['the ETag', () => etag],
    ['the weak form of the ETag', () => `W/${etag}`],
    ['a list that contains the ETag', () => `${OTHER}, ${etag}`],
    ['*', () => '*'],
  ])('If-None-Match with %s is 304', async (_name, value) => {
    const { status, headers, body } = await conditional({ 'If-None-Match': value() });
    expect(status).toBe(304);
    expect(body.length).toBe(0);
    expect(headers.get('ETag')).toBe(etag);
    expect(headers.get('Cache-Control')).toBe(REVALIDATE);
    expect(headers.get('Content-Length')).toBeNull();
  });

  it('If-None-Match with another ETag gets the object', async () => {
    const { status, body } = await conditional({ 'If-None-Match': OTHER });
    expect(status).toBe(200);
    expect(body).toEqual(ZIP);
  });

  it('If-None-Match works for HEAD', async () => {
    expect((await conditional({ 'If-None-Match': etag }, 'HEAD')).status).toBe(304);
    expect((await conditional({ 'If-None-Match': OTHER }, 'HEAD')).status).toBe(200);
  });

  it('If-Modified-Since compares with the upload time', async () => {
    expect((await conditional({ 'If-Modified-Since': FUTURE })).status).toBe(304);
    expect((await conditional({ 'If-Modified-Since': PAST })).status).toBe(200);
    expect((await conditional({ 'If-Modified-Since': 'not a date' })).status).toBe(200);
    const { headers } = await conditional({});
    expect((await conditional({ 'If-Modified-Since': headers.get('Last-Modified') })).status).toBe(304);
  });

  it('If-None-Match takes precedence over If-Modified-Since', async () => {
    const { status } = await conditional({ 'If-None-Match': OTHER, 'If-Modified-Since': FUTURE });
    expect(status).toBe(200);
  });

  it('If-Match and If-Unmodified-Since fail with 412', async () => {
    expect((await conditional({ 'If-Match': OTHER })).status).toBe(412);
    expect((await conditional({ 'If-Match': etag })).status).toBe(200);
    expect((await conditional({ 'If-Match': '*' })).status).toBe(200);
    // If-Match needs a strong match.
    expect((await conditional({ 'If-Match': `W/${etag}` })).status).toBe(412);
    expect((await conditional({ 'If-Unmodified-Since': PAST })).status).toBe(412);
    expect((await conditional({ 'If-Unmodified-Since': FUTURE })).status).toBe(200);
  });

  it('a 304 wins over Range', async () => {
    const { status } = await conditional({ 'If-None-Match': etag, Range: 'bytes=0-9' });
    expect(status).toBe(304);
  });

  it('If-Range sends the range only while the validator still matches', async () => {
    const lastModified = (await conditional({})).headers.get('Last-Modified');
    for (const validator of [etag, lastModified]) {
      const { status, body } = await conditional({ Range: 'bytes=10-19', 'If-Range': validator });
      expect(status).toBe(206);
      expect(body).toEqual(ZIP.slice(10, 20));
    }
    // A download begun against an older version must restart, not continue.
    for (const validator of [OTHER, `W/${etag}`, PAST, FUTURE]) {
      const { status, headers, body } = await conditional({ Range: 'bytes=10-19', 'If-Range': validator });
      expect(status).toBe(200);
      expect(headers.get('Content-Range')).toBeNull();
      expect(body).toEqual(ZIP);
    }
  });
});

describe('what is not served', () => {
  it.each([
    '/assets/games/missing.zip',
    // These exist in the bucket.
    '/assets/manifest.json',
    '/assets/games/Bad_Name.zip',
    '/assets/games/sub/dir.zip',
    '/assets/games/alpha.zip.bak',
    // No listing.
    '/assets/',
    '/assets/games',
    '/assets/games/',
    // Keys are matched as written, not decoded.
    '/assets/games/%61lpha.zip',
    '/assets/games%2Falpha.zip',
    '/assets//games/alpha.zip',
    '/assets/NGAGE.ROM/',
    '/assets/ngage.rom',
    // The N-Gage 2.0 firmware by its names only.
    '/assets/devices/',
    '/assets/devices/other.zip',
    '/assets/ngage2/other.sis',
    // Outside /assets/, which the Worker sees on workers.dev.
    '/',
    '/assets',
    '/assetsgames/alpha.zip',
    '/games/alpha.zip',
    '/NGAGE.ROM',
    // As long as the prefix, with a real key behind it.
    '/static/games/alpha.zip',
    '/abcdef/NGAGE.ROM',
    '/ASSETS/NGAGE.ROM',
  ])('%s is 404', async (path) => {
    const { status, headers } = await call(path);
    expect(status).toBe(404);
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('resolves dot segments before matching', async () => {
    expect((await call('/assets/games/../NGAGE.ROM')).status).toBe(200);
    expect((await call('/assets/../NGAGE.ROM')).status).toBe(404);
  });

  it.each(['POST', 'OPTIONS', 'HEAD'])('%s outside /assets/ is 404 too', async (method) => {
    expect((await call('/other', { method })).status).toBe(404);
    expect((await call('/static/games/alpha.zip', { method })).status).toBe(404);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is 405', async (method) => {
    const { status, headers } = await call('/assets/games/alpha.zip', { method });
    expect(status).toBe(405);
    expect(headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('leaves the bucket unchanged after a refused write', async () => {
    await call('/assets/games/alpha.zip', { method: 'DELETE' });
    expect((await call('/assets/games/alpha.zip')).body).toEqual(ZIP);
  });
});

// A repack can replace an object while a request for it is in flight. A range
// needs the object's size first, so it takes two reads; the stand-in bucket
// below replaces the object between them.
describe('an object replaced between reading its metadata and its body', () => {
  const OLD = bytes(300, 21);
  const NEW = bytes(700, 22);
  const ranged = { 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=100-' };

  function replacing(key, times) {
    let left = times;
    return {
      async head(name) {
        const object = await bucket.head(name);
        if (name === key && left > 0) {
          left--;
          await bucket.put(key, object.size === OLD.length ? NEW : OLD);
        }
        return object;
      },
      get: (...args) => bucket.get(...args),
    };
  }

  it('is read again, so headers and bytes belong to the same version', async () => {
    await bucket.put('games/moving.zip', OLD);
    const sent = await call('/assets/games/moving.zip', {
      headers: ranged,
      vars: { ASSETS: replacing('games/moving.zip', 1) },
    });
    expect(sent.status).toBe(206);
    expect(sent.body).toEqual(NEW.slice(100));
    expect(sent.headers.get('Content-Range')).toBe('bytes 100-699/700');
    expect(sent.headers.get('Content-Length')).toBe('600');
    expect(sent.headers.get('ETag')).toBe((await bucket.head('games/moving.zip')).httpEtag);
  });

  it('is 503 with Retry-After when it keeps changing', async () => {
    await bucket.put('games/moving.zip', OLD);
    const { status, headers } = await call('/assets/games/moving.zip', {
      headers: ranged,
      vars: { ASSETS: replacing('games/moving.zip', Infinity) },
    });
    expect(status).toBe(503);
    expect(headers.get('Retry-After')).toBe('1');
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('cannot happen to a whole object, which is one read', async () => {
    await bucket.put('games/moving.zip', OLD);
    const { status, body } = await call('/assets/games/moving.zip', {
      vars: { ASSETS: replacing('games/moving.zip', Infinity) },
    });
    expect(status).toBe(200);
    expect(body).toEqual(OLD);
  });
});
