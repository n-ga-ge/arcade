// Cache lifetimes with and without ?v=<sha256>, and the edge cache.
// Each test uses its own object: the edge cache keeps entries between tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMMUTABLE, REVALIDATE, bucket, bytes, call, counting, sha256 } from './helpers.js';

const asMetadata = (hash) => ({ customMetadata: { sha256: hash } });

// Stores made-up bytes under games/<name>.zip the way the upload tool does,
// with the hash as metadata, and returns what the tests need.
async function put(name, seed, options = asMetadata) {
  const data = bytes(2000, seed);
  const hash = await sha256(data);
  const object = await bucket.put(`games/${name}.zip`, data, options(hash));
  return { path: `/assets/games/${name}.zip`, url: `/assets/games/${name}.zip?v=${hash}`, data, hash, etag: object.httpEtag };
}

const ranged = (range) => ({ 'Sec-Fetch-Site': 'same-origin', Range: range });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('without a version', () => {
  it('gives a short lifetime with revalidation and stays out of the edge cache', async () => {
    const { path, data } = await put('plain', 1);
    for (let i = 0; i < 2; i++) {
      const { status, headers, body } = await call(path);
      expect(status).toBe(200);
      expect(headers.get('Cache-Control')).toBe(REVALIDATE);
      expect(headers.get('X-Assets-Cache')).toBe('bypass');
      expect(body).toEqual(data);
    }
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc123'],
    ['upper case', (hash) => hash.toUpperCase()],
    ['not hex', 'g'.repeat(64)],
    ['too long', (hash) => `${hash}0`],
  ])('treats a v that is not a sha256 (%s) as no version', async (_name, v) => {
    const { path, hash } = await put('malformed', 2);
    const { status, headers } = await call(`${path}?v=${typeof v === 'string' ? v : v(hash)}`);
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe(REVALIDATE);
    expect(headers.get('X-Assets-Cache')).toBe('bypass');
  });

  it('shows a replaced object at once', async () => {
    const { path, data } = await put('replaced', 3);
    expect((await call(path)).body).toEqual(data);
    const next = await put('replaced', 4);
    const { headers, body } = await call(path);
    expect(body).toEqual(next.data);
    expect(headers.get('ETag')).toBe(next.etag);
  });

  it('reads R2 once for a whole object, and metadata first for a range, HEAD or a conditional request', async () => {
    const { path } = await put('reads', 5);
    const whole = counting();
    await call(path, { vars: whole });
    expect(whole.reads).toEqual({ head: 0, get: 1, ranged: 0 });
    const part = counting();
    await call(path, { headers: ranged('bytes=0-9'), vars: part });
    expect(part.reads).toEqual({ head: 1, get: 1, ranged: 1 });
    const head = counting();
    await call(path, { method: 'HEAD', vars: head });
    expect(head.reads).toEqual({ head: 1, get: 0, ranged: 0 });
    // A revalidation that ends in 304 never opens the body.
    const etag = (await call(path)).headers.get('ETag');
    const same = counting();
    await call(path, { headers: { 'Sec-Fetch-Site': 'same-origin', 'If-None-Match': etag }, vars: same });
    expect(same.reads).toEqual({ head: 1, get: 0, ranged: 0 });
    const changed = counting();
    await call(path, { headers: { 'Sec-Fetch-Site': 'same-origin', 'If-None-Match': '"other"' }, vars: changed });
    expect(changed.reads).toEqual({ head: 1, get: 1, ranged: 0 });
  });
});

describe('with ?v=<sha256>', () => {
  it('is immutable, from R2 first and from the edge cache after that', async () => {
    const { url, data, etag } = await put('versioned', 10);
    const first = await call(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe(IMMUTABLE);
    expect(first.headers.get('X-Assets-Cache')).toBe('miss');
    expect(first.body).toEqual(data);

    const reads = counting();
    const second = await call(url, { vars: reads });
    expect(second.status).toBe(200);
    expect(second.headers.get('Cache-Control')).toBe(IMMUTABLE);
    expect(second.headers.get('X-Assets-Cache')).toBe('hit');
    expect(second.body).toEqual(data);
    // A hit does not contact R2 at all.
    expect(reads.reads).toEqual({ head: 0, get: 0, ranged: 0 });
    // The cached copy answers exactly like the original.
    for (const name of ['ETag', 'Last-Modified', 'Content-Length', 'Content-Type', 'Accept-Ranges']) {
      expect(second.headers.get(name)).toBe(first.headers.get(name));
    }
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('X-Assets-Meta')).toBeNull();
  });

  it('answers HEAD, ranges and conditional requests from the edge cache', async () => {
    const { url, data, etag } = await put('cached-forms', 11);
    await call(url);
    const reads = counting();

    const head = await call(url, { method: 'HEAD', vars: reads });
    expect(head.status).toBe(200);
    expect(head.headers.get('X-Assets-Cache')).toBe('hit');
    expect(head.headers.get('Content-Length')).toBe('2000');
    expect(head.body.length).toBe(0);

    for (const [range, start, end] of [
      ['bytes=100-299', 100, 299],
      ['bytes=-50', 1950, 1999],
      ['bytes=1990-', 1990, 1999],
      ['bytes=1990-9999', 1990, 1999],
      ['BYTES=0-0', 0, 0],
    ]) {
      const part = await call(url, { headers: ranged(range), vars: reads });
      expect(part.status).toBe(206);
      expect(part.headers.get('X-Assets-Cache')).toBe('hit');
      expect(part.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/2000`);
      expect(part.headers.get('Content-Length')).toBe(String(end - start + 1));
      expect(part.body).toEqual(data.slice(start, end + 1));
    }

    const beyond = await call(url, { headers: ranged('bytes=2000-'), vars: reads });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('Content-Range')).toBe('bytes */2000');

    const several = await call(url, { headers: ranged('bytes=0-1,5-6'), vars: reads });
    expect(several.status).toBe(200);
    expect(several.body).toEqual(data);

    const same = await call(url, { headers: { 'Sec-Fetch-Site': 'same-origin', 'If-None-Match': etag }, vars: reads });
    expect(same.status).toBe(304);
    expect(same.headers.get('Cache-Control')).toBe(IMMUTABLE);
    expect(same.headers.get('X-Assets-Cache')).toBe('hit');

    const stale = await call(url, { headers: { ...ranged('bytes=0-9'), 'If-Range': '"somethingelse"' }, vars: reads });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Assets-Cache')).toBe('hit');
    expect(stale.body).toEqual(data);

    expect(reads.reads).toEqual({ head: 0, get: 0, ranged: 0 });
  });

  it('looks a hit up once, whole or as a range', async () => {
    const { url } = await put('one-lookup', 20);
    await call(url);
    const match = vi.spyOn(caches.default, 'match');
    await call(url);
    expect(match).toHaveBeenCalledTimes(1);
    match.mockClear();
    await call(url, { headers: ranged('bytes=10-19') });
    expect(match).toHaveBeenCalledTimes(1);
  });

  it('fills the edge cache from a range request too', async () => {
    const { url, data } = await put('range-first', 12);
    const part = await call(url, { headers: ranged('bytes=0-99') });
    expect(part.status).toBe(206);
    expect(part.headers.get('X-Assets-Cache')).toBe('miss');
    expect(part.body).toEqual(data.slice(0, 100));
    const full = await call(url);
    expect(full.headers.get('X-Assets-Cache')).toBe('hit');
    expect(full.body).toEqual(data);
  });

  it('does not fill the edge cache from HEAD, 304 or 416', async () => {
    const { url, etag } = await put('no-fill', 13);
    await call(url, { method: 'HEAD' });
    await call(url, { headers: { 'Sec-Fetch-Site': 'same-origin', 'If-None-Match': etag } });
    await call(url, { headers: ranged('bytes=9999-') });
    expect((await call(url)).headers.get('X-Assets-Cache')).toBe('miss');
    expect((await call(url)).headers.get('X-Assets-Cache')).toBe('hit');
  });

  it('copies an object into the edge cache once for simultaneous requests', async () => {
    const { url, data } = await put('together', 21);
    const reads = counting();
    const all = await Promise.all(
      ['bytes=0-499', 'bytes=500-999', 'bytes=1000-1499', 'bytes=1500-'].map((range) =>
        call(url, { headers: ranged(range), vars: reads }),
      ),
    );
    expect(all.map((part) => part.status)).toEqual([206, 206, 206, 206]);
    const joined = new Uint8Array(all.flatMap((part) => [...part.body]));
    expect(joined).toEqual(data);
    // Four ranges for the clients and one whole object for the cache.
    expect(reads.reads).toEqual({ head: 4, get: 5, ranged: 4 });
    expect((await call(url)).headers.get('X-Assets-Cache')).toBe('hit');
  });

  it('does not keep copying where the cache keeps nothing', async () => {
    // The Cache API accepts and drops everything in some places.
    vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);
    const { url, data } = await put('dropped', 22);
    const first = counting();
    expect((await call(url, { vars: first })).body).toEqual(data);
    expect(first.reads.get).toBe(2);
    for (let i = 0; i < 3; i++) {
      const again = counting();
      const { headers, body } = await call(url, { vars: again });
      expect(headers.get('X-Assets-Cache')).toBe('miss');
      expect(headers.get('Cache-Control')).toBe(IMMUTABLE);
      expect(body).toEqual(data);
      expect(again.reads).toEqual({ head: 0, get: 1, ranged: 0 });
    }
  });

  it('copies an evicted object again, but not more than once per interval', async () => {
    const { url, data } = await put('evicted', 25);
    await call(url);
    expect((await call(url)).headers.get('X-Assets-Cache')).toBe('hit');
    await caches.default.delete(new Request(`https://n-ga.ge${url}`));
    // Still within the interval of the first copy: served from R2, not copied.
    for (let i = 0; i < 2; i++) {
      const reads = counting();
      const { headers, body } = await call(url, { vars: reads });
      expect(headers.get('X-Assets-Cache')).toBe('miss');
      expect(body).toEqual(data);
      expect(reads.reads.get).toBe(1);
    }
    const later = Date.now() + 11 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await call(url)).headers.get('X-Assets-Cache')).toBe('miss');
    expect((await call(url)).headers.get('X-Assets-Cache')).toBe('hit');
  });

  it('does not copy an object that is served from the edge cache', async () => {
    const { url } = await put('settled', 26);
    await call(url);
    const later = Date.now() + 11 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const put_ = vi.spyOn(caches.default, 'put');
    const reads = counting();
    for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, ranged('bytes=0-9')]) {
      expect((await call(url, { headers, vars: reads })).headers.get('X-Assets-Cache')).toBe('hit');
    }
    expect(put_).not.toHaveBeenCalled();
    expect(reads.reads).toEqual({ head: 0, get: 0, ranged: 0 });
  });

  it('keeps serving the cached version after the object is replaced', async () => {
    const old = await put('repacked', 14);
    await call(old.url);
    const next = await put('repacked', 15);

    // The old hash still names the old bytes: that is what immutable means.
    const pinned = await call(old.url);
    expect(pinned.headers.get('X-Assets-Cache')).toBe('hit');
    expect(pinned.body).toEqual(old.data);
    expect(pinned.headers.get('ETag')).toBe(old.etag);
    const part = await call(old.url, { headers: ranged('bytes=5-14') });
    expect(part.body).toEqual(old.data.slice(5, 15));

    // The new hash and the plain URL get the new bytes.
    const fresh = await call(next.url);
    expect(fresh.headers.get('X-Assets-Cache')).toBe('miss');
    expect(fresh.body).toEqual(next.data);
    expect((await call(next.path)).body).toEqual(next.data);
  });

  it('gives the old hash the new object, briefly, once the old one is gone from the cache', async () => {
    const old = await put('repacked-cold', 23);
    const next = await put('repacked-cold', 24);
    for (let i = 0; i < 2; i++) {
      const { status, headers, body } = await call(old.url);
      expect(status).toBe(200);
      expect(headers.get('Cache-Control')).toBe(REVALIDATE);
      expect(headers.get('X-Assets-Cache')).toBe('bypass');
      expect(headers.get('ETag')).toBe(next.etag);
      expect(body).toEqual(next.data);
    }
  });

  it('ignores other query parameters', async () => {
    const { path, url, data, hash } = await put('extra-query', 16);
    await call(url);
    const { headers, body } = await call(`${path}?utm=x&v=${hash}&cb=123`);
    expect(headers.get('X-Assets-Cache')).toBe('hit');
    expect(body).toEqual(data);
  });

  it('keeps each object apart in the edge cache', async () => {
    const a = await put('twin-a', 17);
    const b = await put('twin-b', 17);
    expect(b.hash).toBe(a.hash);
    await call(a.url);
    // Same bytes and hash, but its own entry.
    const other = await call(b.url);
    expect(other.headers.get('X-Assets-Cache')).toBe('miss');
    expect(other.headers.get('ETag')).toBe(b.etag);
  });

  it('is 404 for a missing object and caches nothing', async () => {
    const v = 'a'.repeat(64);
    for (let i = 0; i < 2; i++) {
      const { status, headers } = await call(`/assets/games/never-uploaded.zip?v=${v}`);
      expect(status).toBe(404);
      expect(headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('applies the access rules to cached objects', async () => {
    const { url } = await put('guarded', 19);
    await call(url);
    expect((await call(url, { headers: {} })).status).toBe(403);
    expect((await call(url, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });
});

// The version in the URL is checked against the hash the upload recorded
// before a response is called immutable, however the hash was recorded.
describe.each([
  ['custom metadata', asMetadata],
  ['upper-case custom metadata', (hash) => ({ customMetadata: { sha256: hash.toUpperCase() } })],
  ['an R2 checksum', (hash) => ({ sha256: hash })],
])('with the hash recorded as %s', (name, options) => {
  const slug = `recorded-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

  it('is immutable when the version is the hash', async () => {
    const { url, data } = await put(`${slug}-match`, 30, options);
    const first = await call(url);
    expect(first.headers.get('Cache-Control')).toBe(IMMUTABLE);
    expect(first.headers.get('X-Assets-Cache')).toBe('miss');
    const second = await call(url);
    expect(second.headers.get('X-Assets-Cache')).toBe('hit');
    expect(second.body).toEqual(data);
  });

  it('serves the object with the short lifetime when the version is another hash', async () => {
    const { path, data } = await put(`${slug}-mismatch`, 31, options);
    const wrong = 'b'.repeat(64);
    for (let i = 0; i < 2; i++) {
      const { status, headers, body } = await call(`${path}?v=${wrong}`);
      expect(status).toBe(200);
      expect(headers.get('Cache-Control')).toBe(REVALIDATE);
      expect(headers.get('X-Assets-Cache')).toBe('bypass');
      expect(body).toEqual(data);
    }
  });
});

describe.each([
  ['no recorded hash', () => undefined],
  ['metadata that is not a hash', () => ({ customMetadata: { sha256: 'unknown' } })],
])('with %s', (name, options) => {
  it('never calls a response immutable, whatever the version says', async () => {
    const { path, url, data } = await put(`unrecorded-${name.length}`, 32, options);
    const reads = counting();
    for (const target of [url, url, `${path}?v=${'c'.repeat(64)}`]) {
      const { status, headers, body } = await call(target, { vars: reads });
      expect(status).toBe(200);
      expect(headers.get('Cache-Control')).toBe(REVALIDATE);
      expect(headers.get('X-Assets-Cache')).toBe('bypass');
      expect(body).toEqual(data);
    }
    // One read each: nothing was copied into the edge cache.
    expect(reads.reads).toEqual({ head: 0, get: 3, ranged: 0 });
  });
});

// The edge cache is only trusted as far as it can be checked.
describe('an edge cache that does not behave', () => {
  it('ignores an entry this Worker did not write and replaces it', async () => {
    const { url, data } = await put('foreign', 40);
    const foreign = new Response('something else', { headers: { 'Cache-Control': 'max-age=3600' } });
    await caches.default.put(new Request(`https://n-ga.ge${url}`), foreign);
    const first = await call(url);
    expect(first.headers.get('X-Assets-Cache')).toBe('miss');
    expect(first.body).toEqual(data);
    const second = await call(url);
    expect(second.headers.get('X-Assets-Cache')).toBe('hit');
    expect(second.body).toEqual(data);
  });

  it.each([
    ['returns the whole object for a range', (hit) => hit],
    ['returns another range', (hit) => new Response(hit.body, { status: 206, headers: withRange(hit, 'bytes 0-9/2000') })],
    ['answers a range with an error', () => new Response('no', { status: 416 })],
    ['has lost the entry by the second lookup', () => undefined],
  ])('reads the range from R2 when the cache %s', async (_name, misbehave) => {
    const { url, data, etag } = await put('no-ranges', 41);
    await call(url);
    const real = caches.default.match.bind(caches.default);
    let ranged = 0;
    vi.spyOn(caches.default, 'match').mockImplementation(async (request) => {
      if (!request.headers.has('Range')) return real(request);
      ranged++;
      return misbehave(await real(new Request(request.url)));
    });
    const reads = counting();
    const part = await call(url, { headers: { 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=100-199' }, vars: reads });
    expect(ranged).toBeGreaterThan(0);
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/2000');
    expect(part.headers.get('Content-Length')).toBe('100');
    expect(part.headers.get('ETag')).toBe(etag);
    expect(part.headers.get('Cache-Control')).toBe(IMMUTABLE);
    expect(part.body).toEqual(data.slice(100, 200));
    // From the bucket, and without copying the object into the cache again.
    expect(reads.reads).toEqual({ head: 1, get: 1, ranged: 1 });
  });

  it('uses a range that comes back without the metadata header', async () => {
    const { url, data } = await put('bare-ranges', 44);
    await call(url);
    const real = caches.default.match.bind(caches.default);
    vi.spyOn(caches.default, 'match').mockImplementation(async (request) => {
      const found = await real(request);
      if (found?.status !== 206) return found;
      return new Response(found.body, { status: 206, headers: { 'Content-Range': found.headers.get('Content-Range') } });
    });
    const reads = counting();
    const part = await call(url, { headers: { 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=-300' }, vars: reads });
    expect(part.status).toBe(206);
    expect(part.headers.get('X-Assets-Cache')).toBe('hit');
    expect(part.headers.get('Content-Range')).toBe('bytes 1700-1999/2000');
    expect(part.body).toEqual(data.slice(1700));
    expect(reads.reads).toEqual({ head: 0, get: 0, ranged: 0 });
  });

  it('serves the current object when the cached version cannot supply a range any more', async () => {
    const old = await put('no-ranges-repacked', 42);
    await call(old.url);
    const next = await put('no-ranges-repacked', 43);
    const real = caches.default.match.bind(caches.default);
    vi.spyOn(caches.default, 'match').mockImplementation(async (request) =>
      request.headers.has('Range') ? real(new Request(request.url)) : real(request),
    );
    const part = await call(old.url, { headers: { 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=100-199' } });
    // Headers and bytes are the new object's, and it is not called immutable.
    expect(part.status).toBe(206);
    expect(part.headers.get('ETag')).toBe(next.etag);
    expect(part.headers.get('Cache-Control')).toBe(REVALIDATE);
    expect(part.body).toEqual(next.data.slice(100, 200));
  });
});

function withRange(hit, contentRange) {
  const headers = new Headers(hit.headers);
  headers.set('Content-Range', contentRange);
  return headers;
}
