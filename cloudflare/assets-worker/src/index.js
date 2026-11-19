// Serves /assets/<key> from the private R2 bucket: the firmware (the N-Gage ROM,
// and for N-Gage 2.0 the phone's device zip and the N-Gage application) and
// one zip per game. README.md describes the behaviour; the short version:
//
// - only GET and HEAD of the known keys, only for the site, the origins in
//   ALLOWED_ORIGINS and holders of ASSETS_TOKEN (access.js);
// - Range and conditional requests are answered here (conditions.js);
// - a request that names the object's hash (?v=<sha256>) is immutable: it gets
//   a year's lifetime and is kept in the edge cache. Anything else goes to R2
//   every time and gets a short lifetime with revalidation.

import { applyAccessHeaders, checkAccess } from './access.js';
import { UNSATISFIABLE, evaluatePreconditions, isSingleRange, resolveRange } from './conditions.js';

const PREFIX = '/assets/';
// The firmware keys are tools/assets/common.py's FIRMWARE.
const KEY = /^(?:NGAGE\.ROM|devices\/rm-409\.zip|ngage2\/ngage-1\.40\.1557\.sis|games\/[a-z0-9-]+\.zip)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const IMMUTABLE = 'max-age=31536000, immutable';
const REVALIDATE = 'max-age=300, must-revalidate';
const ALLOW = 'GET, HEAD, OPTIONS';
const CONDITIONAL = ['If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'];
// What a cross-origin page may send besides the simple headers.
const CORS_REQUEST_HEADERS = ['Range', 'If-Range', ...CONDITIONAL].join(', ');

// The object's metadata rides along in the cached response under this header,
// so a hit does not depend on what the cache does to ETag or Content-Length.
const META = 'X-Assets-Meta';

// When this isolate last began copying each versioned URL into the edge cache.
// One copy per interval is enough: it keeps simultaneous requests for an
// object that is not cached yet from each reading all of it again, and bounds
// the waste where the cache does not keep what it is given.
const fills = new Map();
const FILL_INTERVAL = 10 * 60 * 1000;

function text(status, message, headers = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function contentType(key) {
  return key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The SHA-256 stored with the object, if the upload recorded one: as custom
// metadata "sha256" (hex; tools/assets/upload.py does this) or as R2's own
// SHA-256 checksum.
function recordedSha256(object) {
  const custom = object.customMetadata?.sha256?.toLowerCase();
  if (custom !== undefined && SHA256.test(custom)) return custom;
  return object.checksums?.sha256 ? hex(object.checksums.sha256) : null;
}

// Both sources below describe one version of an object: its validators and
// size, and open(range), which resolves to the body, or to undefined when that
// version can no longer be read. `rangeHeader` is the client's Range header if
// it asks for a single range, else null.

async function fromBucket(bucket, key, eager) {
  // A plain GET of the whole object takes metadata and body in one read.
  // Otherwise the metadata comes first: a range can only be checked against
  // the size, and a conditional request mostly ends without a body.
  const object = eager ? await bucket.get(key) : await bucket.head(key);
  if (object === null) return null;
  let unread = eager ? object.body : undefined;
  const discard = async () => {
    await unread?.cancel();
    unread = undefined;
  };
  return {
    cached: false,
    etag: object.httpEtag,
    size: object.size,
    modified: Math.floor(object.uploaded.getTime() / 1000) * 1000,
    sha256: recordedSha256(object),
    discard,
    async open(range) {
      if (!range && unread !== undefined) {
        const body = unread;
        unread = undefined;
        return body;
      }
      await discard();
      // The headers are built from the metadata read earlier. If the object
      // has been replaced since, its bytes must not go out under them.
      const options = { onlyIf: { etagMatches: object.etag } };
      if (range) options.range = { offset: range.start, length: range.end - range.start + 1 };
      const found = await bucket.get(key, options);
      return found?.body;
    },
  };
}

function cachedMeta(response) {
  try {
    const meta = JSON.parse(response.headers.get(META));
    const valid =
      typeof meta?.etag === 'string' && Number.isSafeInteger(meta.size) && Number.isSafeInteger(meta.modified);
    return valid ? meta : null;
  } catch {
    // Not an entry this Worker wrote.
    return null;
  }
}

async function fromCache(cacheKey, rangeHeader) {
  const lookup = (range) =>
    caches.default.match(range === null ? cacheKey : new Request(cacheKey, { headers: { Range: range } }));
  // Asking for the client's range at once makes a hit a single lookup: the
  // cache cuts the range out of the stored object and returns the metadata
  // header with it. If that answer cannot be used, the whole entry is looked
  // up as for any other request.
  let held = await lookup(rangeHeader);
  let meta = held ? cachedMeta(held) : null;
  if (held && meta === null && rangeHeader !== null) {
    await held.body?.cancel();
    held = await lookup(null);
    meta = held ? cachedMeta(held) : null;
  }
  const discard = async () => {
    await held?.body?.cancel();
    held = undefined;
  };
  if (meta === null) {
    await discard();
    return null;
  }
  return {
    cached: true,
    etag: meta.etag,
    size: meta.size,
    modified: meta.modified,
    sha256: null,
    discard,
    async open(range) {
      // Check that the cache returned exactly what is about to be announced:
      // a whole object or another range must not go out as this range.
      const expected = range ? `bytes ${range.start}-${range.end}/${meta.size}` : null;
      const fits = (response) =>
        response !== undefined &&
        (range ? response.status === 206 && response.headers.get('Content-Range') === expected : response.status === 200);
      if (!fits(held)) {
        await discard();
        held = await lookup(range ? `bytes=${range.start}-${range.end}` : null);
      }
      if (!fits(held)) {
        await discard();
        return undefined;
      }
      const body = held.body;
      held = undefined;
      return body;
    },
  };
}

function fillDue(cacheKey) {
  const now = Date.now();
  const last = fills.get(cacheKey.url);
  if (last !== undefined && now - last < FILL_INTERVAL) return false;
  fills.set(cacheKey.url, now);
  return true;
}

// Copies the object into the edge cache under its versioned URL. It reads R2
// again instead of splitting the stream that goes to the client: a split
// stream buffers whatever the slower reader has not taken yet, which for a
// 50 MB zip and a slow phone is most of the file.
async function fillCache(cacheKey, key, source) {
  try {
    const body = await source.open(null);
    if (body === undefined) return;
    const meta = { etag: source.etag, size: source.size, modified: source.modified };
    await caches.default.put(
      cacheKey,
      new Response(body, {
        headers: {
          'Cache-Control': IMMUTABLE,
          'Content-Length': String(source.size),
          'Content-Type': contentType(key),
          ETag: source.etag,
          [META]: JSON.stringify(meta),
        },
      }),
    );
  } catch (error) {
    // The response is already on its way from R2; a cache that will not take
    // the object only costs speed.
    console.warn(`edge cache fill failed for ${key}: ${error}`);
  }
}

// Builds the response for one version of the object. Returns null when its
// body turned out to be gone, so that the caller can look the object up again.
async function respond(request, key, source, immutable) {
  const headers = new Headers({
    'Cache-Control': immutable ? IMMUTABLE : REVALIDATE,
    ETag: source.etag,
    'Last-Modified': new Date(source.modified).toUTCString(),
    'X-Assets-Cache': source.cached ? 'hit' : immutable ? 'miss' : 'bypass',
  });

  const outcome = evaluatePreconditions(request.headers, source);
  if (outcome === 412) {
    await source.discard();
    return text(412, 'Precondition failed');
  }
  if (outcome === 304) {
    await source.discard();
    return new Response(null, { status: 304, headers });
  }

  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', contentType(key));
  if (request.method === 'HEAD') {
    // Range is only defined for GET, so HEAD describes the whole object.
    await source.discard();
    headers.set('Content-Length', String(source.size));
    return new Response(null, { headers });
  }

  const range = resolveRange(request.headers, source);
  if (range === UNSATISFIABLE) {
    await source.discard();
    return text(416, 'Range not satisfiable', { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${source.size}` });
  }
  const body = await source.open(range);
  if (body === undefined) return null;
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${source.size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(body, { status: 206, headers });
  }
  headers.set('Content-Length', String(source.size));
  return new Response(body, { headers });
}

async function serve(request, env, ctx, url, key) {
  const v = url.searchParams.get('v');
  const version = v !== null && SHA256.test(v) ? v : null;
  // Other query parameters do not select anything, so they are left out of
  // the cache key: they would only store the same object again.
  const cacheKey = version ? new Request(`${url.origin}${url.pathname}?v=${version}`) : null;
  const get = request.method === 'GET';
  const range = get ? request.headers.get('Range') : null;
  const rangeHeader = range !== null && isSingleRange(range) ? range.trim() : null;
  const plain = get && rangeHeader === null && !CONDITIONAL.some((name) => request.headers.has(name));

  let source = cacheKey ? await fromCache(cacheKey, rangeHeader) : null;
  const hit = source !== null;
  // Two more looks at the bucket cover a cache entry that could not supply a
  // range and an object replaced between reading its metadata and its body.
  for (let attempt = 0; attempt < 3; attempt++) {
    source ??= await fromBucket(env.ASSETS, key, plain);
    if (source === null) return text(404, 'Not found');
    // A hash in the URL promises that the content never changes, so the
    // promise is checked against the hash the upload recorded. After a
    // repack, a stale page still asking for the old hash gets the new object
    // with the short lifetime instead of having it pinned under the wrong
    // name; so does a request for an object without a recorded hash. That
    // also means only one URL per object can enter the edge cache.
    const immutable = source.cached || (version !== null && source.sha256 === version);
    const response = await respond(request, key, source, immutable);
    if (response !== null) {
      const delivers = response.status === 200 || response.status === 206;
      if (immutable && !hit && delivers && get && fillDue(cacheKey)) {
        ctx.waitUntil(fillCache(cacheKey, key, source));
      }
      return response;
    }
    source = null;
  }
  return text(503, 'The object is being replaced, try again', { 'Retry-After': '1' });
}

function options(request, access) {
  if (!request.headers.has('Access-Control-Request-Method')) {
    return new Response(null, { status: 204, headers: { Allow: ALLOW } });
  }
  if (access.corsOrigin === null) return text(403, 'Forbidden');
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, HEAD',
      'Access-Control-Allow-Headers': CORS_REQUEST_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function route(request, env, ctx, url, access) {
  // The production route only sends /assets/* here, but on workers.dev the
  // Worker gets every path.
  if (!url.pathname.startsWith(PREFIX)) return text(404, 'Not found');
  if (request.method === 'OPTIONS') return options(request, access);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Method not allowed', { Allow: ALLOW });
  }
  if (!access.allowed) return text(403, 'Forbidden');
  // Only the keys the site uses, so nothing else that ends up in
  // the bucket is reachable, and there is no listing.
  const key = url.pathname.slice(PREFIX.length);
  if (!KEY.test(key)) return text(404, 'Not found');
  return serve(request, env, ctx, url, key);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const access = await checkAccess(request, url.origin, env);
    let response;
    try {
      response = await route(request, env, ctx, url, access);
    } catch (error) {
      // Answer in the Worker's own format: the platform's error page has no
      // CORS headers, and the page would see a network error instead of a 500.
      console.error(`${request.method} ${url.pathname}: ${error?.stack ?? error}`);
      response = text(500, 'Internal error');
    }
    applyAccessHeaders(response.headers, access);
    if (request.method === 'HEAD' && response.body !== null) {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  },
};
