// Who may fetch (each rule both ways), CORS and preflights.

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { allowedOrigins } from '../src/access.js';
import { PREVIEW, SITE, TOKEN, bucket, bytes, call } from './helpers.js';

const ZIP = bytes(500, 3);
const PATH = '/assets/games/alpha.zip';

beforeAll(async () => {
  await bucket.put('games/alpha.zip', ZIP);
});

const allowed = async (headers, options = {}) => {
  const { status, body } = await call(PATH, { headers, ...options });
  expect(status).toBe(200);
  expect(body).toEqual(ZIP);
};
const refused = async (headers, options = {}) => {
  const { status, headers: sent, body } = await call(PATH, { headers, ...options });
  expect(status).toBe(403);
  expect(new TextDecoder().decode(body)).toBe('Forbidden\n');
  expect(sent.get('Cache-Control')).toBe('no-store');
  expect(sent.get('Access-Control-Allow-Origin')).toBeNull();
  expect(sent.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  expect(sent.get('ETag')).toBeNull();
};

describe('Sec-Fetch-Site', () => {
  it('allows same-origin', () => allowed({ 'Sec-Fetch-Site': 'same-origin' }));
  it.each(['cross-site', 'same-site', 'none', 'SAME-ORIGIN', ''])('refuses "%s"', (value) =>
    refused({ 'Sec-Fetch-Site': value }),
  );
  it('does not let cross-site override a listed Origin', () =>
    allowed({ 'Sec-Fetch-Site': 'cross-site', Origin: PREVIEW }));
});

describe('Origin', () => {
  it('allows the site', () => allowed({ Origin: SITE }));
  it('allows a listed origin', () => allowed({ Origin: 'https://n-ga-ge.pages.dev' }));
  it('allows a subdomain of a wildcard entry', async () => {
    await allowed({ Origin: PREVIEW });
    await allowed({ Origin: 'https://feature-x.n-ga-ge.pages.dev' });
    await allowed({ Origin: 'https://a.b.n-ga-ge.pages.dev' });
  });
  it.each([
    'https://evil.example',
    'null',
    '',
    // Other scheme, other port, other host that merely looks alike.
    'http://n-ga.ge',
    'https://n-ga.ge:8443',
    'https://www.n-ga.ge',
    'https://n-ga.ge.evil.example',
    'http://abc123.n-ga-ge.pages.dev',
    'https://n-ga-ge.pages.dev.evil.example',
    'https://evil-n-ga-ge.pages.dev',
    'https://evil.example/.n-ga-ge.pages.dev',
    'https://evil.example#.n-ga-ge.pages.dev',
    'https://.n-ga-ge.pages.dev',
  ])('refuses "%s"', (origin) => refused({ Origin: origin }));
  it('is not overruled by a Referer from the site', () =>
    refused({ Origin: 'https://evil.example', Referer: `${SITE}/play/` }));
  it('refuses the listed origins once the list is empty', async () => {
    await refused({ Origin: PREVIEW }, { vars: { ALLOWED_ORIGINS: '' } });
    await refused({ Origin: PREVIEW }, { vars: { ALLOWED_ORIGINS: undefined } });
    await allowed({ Origin: SITE }, { vars: { ALLOWED_ORIGINS: undefined } });
  });
});

describe('Referer', () => {
  it('allows a page of the site', async () => {
    await allowed({ Referer: `${SITE}/play/?g=shadowkey` });
    await allowed({ Referer: SITE });
  });
  it('allows a page of a listed origin', () => allowed({ Referer: `${PREVIEW}/play/` }));
  it.each([
    'https://evil.example/',
    'https://evil.example/https://n-ga.ge/play/',
    'https://n-ga.ge.evil.example/play/',
    'https://n-ga.ge@evil.example/',
    'http://n-ga.ge/play/',
    'not a url',
    '',
  ])('refuses "%s"', (referer) => refused({ Referer: referer }));
});

describe('bearer token', () => {
  it('allows the secret', async () => {
    await allowed({ Authorization: `Bearer ${TOKEN}` });
    await allowed({ Authorization: `bearer ${TOKEN}` });
  });
  it('allows the secret whatever the other headers say', () =>
    allowed({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }));
  it.each([
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    `Bearer ${TOKEN.toUpperCase()}`,
    `Bearer x${TOKEN}`,
    'Bearer ',
    'Bearer',
    `Basic ${TOKEN}`,
    TOKEN,
    `Bearer ${TOKEN} extra`,
  ])('refuses "%s"', (authorization) => refused({ Authorization: authorization }));
  it('refuses every token when no secret is configured', async () => {
    for (const secret of [undefined, '']) {
      for (const authorization of ['Bearer ', 'Bearer undefined', 'Bearer null', `Bearer ${TOKEN}`]) {
        await refused({ Authorization: authorization }, { vars: { ASSETS_TOKEN: secret } });
      }
    }
  });
});

describe('anything else', () => {
  it('refuses a request that says nothing about itself', () => refused({}));
  it('refuses without telling whether the object exists', async () => {
    const { status, body } = await call('/assets/games/missing.zip', { headers: {} });
    expect(status).toBe(403);
    expect(new TextDecoder().decode(body)).toBe('Forbidden\n');
  });
  it('refuses HEAD the same way', async () => {
    const { status, body } = await call(PATH, { method: 'HEAD', headers: {} });
    expect(status).toBe(403);
    expect(body.length).toBe(0);
  });
});

describe('on the workers.dev address', () => {
  const base = 'https://n-ga-ge-assets.example.workers.dev';
  it('treats that address as its own origin and the listed origins as before', async () => {
    await allowed({ 'Sec-Fetch-Site': 'same-origin' }, { base });
    await allowed({ Origin: PREVIEW }, { base });
    await allowed({ Authorization: `Bearer ${TOKEN}` }, { base });
  });
  it('needs the production site listed to serve it from there', async () => {
    await refused({ Origin: SITE }, { base });
    const { status, headers } = await call(PATH, {
      base,
      headers: { Origin: SITE },
      vars: { ALLOWED_ORIGINS: `${SITE},https://*.n-ga-ge.pages.dev` },
    });
    expect(status).toBe(200);
    expect(headers.get('Access-Control-Allow-Origin')).toBe(SITE);
  });
});

describe('cross-origin headers', () => {
  it('marks same-origin responses for the isolated page', async () => {
    const { headers } = await call(PATH);
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(headers.get('Vary')).toBe('Origin');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sends no CORS headers when Origin is the site itself, listed or not', async () => {
    for (const vars of [{}, { ALLOWED_ORIGINS: `${SITE} ${PREVIEW}` }]) {
      const { status, headers } = await call(PATH, { headers: { Origin: SITE }, vars });
      expect(status).toBe(200);
      expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('grants CORS to a listed origin', async () => {
    const { status, headers, body } = await call(PATH, { headers: { Origin: PREVIEW, Range: 'bytes=0-9' } });
    expect(status).toBe(206);
    expect(body).toEqual(ZIP.slice(0, 10));
    expect(headers.get('Access-Control-Allow-Origin')).toBe(PREVIEW);
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(headers.get('Vary')).toBe('Origin');
    const exposed = headers.get('Access-Control-Expose-Headers').split(', ');
    expect(exposed).toEqual(expect.arrayContaining(['Content-Range', 'ETag', 'Accept-Ranges', 'Content-Length']));
    // No cookies or other credentials are involved.
    expect(headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('grants CORS on errors and 304 too, so the page can read the status', async () => {
    const missing = await call('/assets/games/missing.zip', { headers: { Origin: PREVIEW } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Access-Control-Allow-Origin')).toBe(PREVIEW);
    const etag = (await call(PATH)).headers.get('ETag');
    const same = await call(PATH, { headers: { Origin: PREVIEW, 'If-None-Match': etag } });
    expect(same.status).toBe(304);
    expect(same.headers.get('Access-Control-Allow-Origin')).toBe(PREVIEW);
    expect(same.headers.get('Vary')).toBe('Origin');
  });

  it('lets a listed page embed the response when it sent a Referer but no Origin', async () => {
    // A no-cors request: CORS headers would not help, the resource policy does.
    const { status, headers } = await call(PATH, { headers: { Referer: `${PREVIEW}/play/` } });
    expect(status).toBe(200);
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
    const own = await call(PATH, { headers: { Referer: `${SITE}/play/` } });
    expect(own.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('marks every response, also for paths the Worker does not serve', async () => {
    for (const path of ['/', '/other', '/assets']) {
      const plain = await call(path);
      expect(plain.status).toBe(404);
      expect(plain.headers.get('Vary')).toBe('Origin');
      expect(plain.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(plain.headers.get('X-Content-Type-Options')).toBe('nosniff');
      const listed = await call(path, { headers: { Origin: PREVIEW } });
      expect(listed.status).toBe(404);
      expect(listed.headers.get('Access-Control-Allow-Origin')).toBe(PREVIEW);
    }
  });

  it('grants nothing to an unlisted origin that holds the token', async () => {
    const { status, headers } = await call(PATH, {
      headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` },
    });
    expect(status).toBe(200);
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });
});

describe('OPTIONS', () => {
  const preflight = (origin, extra = {}) =>
    call(PATH, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', ...extra },
    });

  it('answers a preflight from a listed origin', async () => {
    const { status, headers, body } = await preflight(PREVIEW, {
      'Access-Control-Request-Headers': 'range, if-none-match',
    });
    expect(status).toBe(204);
    expect(body.length).toBe(0);
    expect(headers.get('Access-Control-Allow-Origin')).toBe(PREVIEW);
    expect(headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD');
    const requestHeaders = headers.get('Access-Control-Allow-Headers').toLowerCase().split(', ');
    expect(requestHeaders).toEqual(expect.arrayContaining(['range', 'if-none-match', 'if-range', 'if-modified-since']));
    // The token is for CI, not for pages.
    expect(requestHeaders).not.toContain('authorization');
    expect(headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(headers.get('Vary')).toBe('Origin');
  });

  it('answers a preflight for a path that does not exist', async () => {
    const { status } = await call('/assets/games/missing.zip', {
      method: 'OPTIONS',
      headers: { Origin: PREVIEW, 'Access-Control-Request-Method': 'HEAD' },
    });
    expect(status).toBe(204);
  });

  it.each(['https://evil.example', 'null', SITE])('refuses a preflight from "%s"', async (origin) => {
    // The site itself never sends one: its requests are same-origin.
    const { status, headers } = await preflight(origin);
    expect(status).toBe(403);
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(headers.get('Access-Control-Allow-Methods')).toBeNull();
  });

  it('answers a plain OPTIONS with the methods', async () => {
    const { status, headers } = await call(PATH, { method: 'OPTIONS', headers: {} });
    expect(status).toBe(204);
    expect(headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('ALLOWED_ORIGINS', () => {
  it('lists nothing in the configuration that is checked in', async () => {
    // Trusting a hostname is a decision for whoever deploys, once it is known
    // to belong to the account.
    expect(env.ALLOWED_ORIGINS).toBe('');
    await refused({ Origin: PREVIEW }, { vars: { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS } });
    await refused({ Origin: 'https://n-ga-ge.pages.dev' }, { vars: { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS } });
  });

  it('takes entries separated by spaces, commas or newlines', () => {
    const listed = allowedOrigins(' https://a.example,https://b.example\n\thttps://c.example:8443 , ');
    expect(listed('https://a.example')).toBe(true);
    expect(listed('https://b.example')).toBe(true);
    expect(listed('https://c.example:8443')).toBe(true);
    expect(listed('https://c.example')).toBe(false);
    expect(listed('')).toBe(false);
  });

  it('forgives a trailing slash and capitals in an entry', () => {
    const listed = allowedOrigins('HTTPS://Example.DEV/');
    expect(listed('https://example.dev')).toBe(true);
  });

  it('matches a wildcard against subdomains only', () => {
    const listed = allowedOrigins('https://*.example.dev:8443');
    expect(listed('https://x.example.dev:8443')).toBe(true);
    expect(listed('https://x.y.example.dev:8443')).toBe(true);
    expect(listed('https://example.dev:8443')).toBe(false);
    expect(listed('https://x.example.dev')).toBe(false);
    expect(listed('https://xexample.dev:8443')).toBe(false);
  });

  it('gives a wildcard no meaning anywhere but in front', () => {
    expect(allowedOrigins('*')('https://evil.example')).toBe(false);
    expect(allowedOrigins('https://*')('https://evil.example')).toBe(false);
    expect(allowedOrigins('https://a.*.example')('https://a.b.example')).toBe(false);
    expect(allowedOrigins('https://*example.dev')('https://evilexample.dev')).toBe(false);
  });

  it('lists nothing when unset', () => {
    expect(allowedOrigins(undefined)('https://a.example')).toBe(false);
    expect(allowedOrigins('')('')).toBe(false);
  });
});
