// The plain HTTP answers: health, the paths, the methods, a request that is
// not a WebSocket, and who may open a room.

import { describe, expect, it } from 'vitest';
import { SITE, call, freshCode, open } from './helpers.js';

const LIST = { ALLOWED_ORIGINS: 'https://n-ga-ge.pages.dev, https://*.n-ga-ge.pages.dev http://localhost:*' };
const ASK = { v: 1, name: 'Ann', create: 1, game: 'rayman-3' };

describe('GET /net/health', () => {
  it('answers', async () => {
    const response = await call('/net/health');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true,"v":1}');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('names the deployed build when it is given one', async () => {
    const id = '0123456789abcdef0123456789abcdef01234567';
    expect((await call('/net/health', { vars: { BUILD: id } })).headers.get('X-Relay-Build')).toBe(id);
    for (const BUILD of ['', undefined, 'not a hash', `${id}\r\nSet-Cookie: x=1`]) {
      const response = await call('/net/health', { vars: { BUILD } });
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Relay-Build')).toBeNull();
    }
  });
  it('answers HEAD', async () => expect((await call('/net/health', { method: 'HEAD' })).status).toBe(200));
  it('lets a listed origin read it, and no other', async () => {
    const listed = await call('/net/health', { headers: { Origin: 'https://abc.n-ga-ge.pages.dev' }, vars: LIST });
    expect(listed.headers.get('Access-Control-Allow-Origin')).toBe('https://abc.n-ga-ge.pages.dev');
    expect(listed.headers.get('Vary')).toBe('Origin');
    const other = await call('/net/health', { headers: { Origin: 'https://evil.example' }, vars: LIST });
    expect(other.status).toBe(200);
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('paths and methods', () => {
  it.each(['/net/', '/net', '/net/health/', '/net/rooms/', '/net/room', '/net/room/K7M2QX/x', '/net/other', '/'])(
    'answers 404 for %s',
    async (path) => {
      const response = await call(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    },
  );
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('answers 405 for %s', async (method) => {
    for (const path of ['/net/health', '/net/rooms', '/net/room/K7M2QX']) {
      const response = await call(path, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
    }
  });
});

describe('GET /net/room/<CODE> without an upgrade', () => {
  it('answers 426', async () => {
    const response = await call(`/net/room/${freshCode()}?v=1&name=Ann`, { headers: { Origin: SITE } });
    expect(response.status).toBe(426);
    expect(response.headers.get('Upgrade')).toBe('websocket');
  });
  it('answers 426 whatever the rest of the request is', async () => {
    expect((await call('/net/room/nonsense')).status).toBe(426);
    expect((await call('/net/room/')).status).toBe(426);
    expect((await call('/net/room/K7M2QX', { headers: { Origin: 'https://evil.example' } })).status).toBe(426);
  });
});

describe('the origin of an upgrade', () => {
  const allowed = async (origin, options = {}) => {
    const client = await open(freshCode(), ASK, { origin, ...options });
    expect(client.status).toBe(101);
    expect((await client.next()).t).toBe('hello');
    client.close();
  };
  const refused = async (origin, options = {}) => {
    const client = await open(freshCode(), ASK, { origin, ...options });
    expect(client.status).toBe(403);
    expect(await client.response.text()).toBe('Forbidden\n');
  };

  it('allows the site the request arrived on', async () => {
    await allowed(SITE);
    await allowed('https://dev.n-ga.ge', { site: 'https://dev.n-ga.ge' });
  });
  it.each([
    'https://evil.example',
    'null',
    '',
    // Other scheme, other port, other host that merely looks alike.
    'http://n-ga.ge',
    'https://n-ga.ge:8443',
    'https://www.n-ga.ge',
    'https://dev.n-ga.ge',
    'https://n-ga.ge.evil.example',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
  ])('refuses "%s"', (origin) => refused(origin));
  it('refuses a request without an Origin', () => refused(null));
  it('allows a listed origin', async () => {
    await allowed('https://n-ga-ge.pages.dev', { vars: LIST });
    await allowed('https://feature-x.n-ga-ge.pages.dev', { vars: LIST });
    await allowed('http://localhost:8080', { vars: LIST });
  });
  it('refuses what the list does not name', async () => {
    await refused('https://evil-n-ga-ge.pages.dev', { vars: LIST });
    await refused('http://127.0.0.1:8080', { vars: LIST });
    await refused(null, { vars: LIST });
  });
  it('allows a request without an Origin when the list says "none"', async () => {
    await allowed(null, { vars: { ALLOWED_ORIGINS: 'none' } });
    await refused('https://evil.example', { vars: { ALLOWED_ORIGINS: 'none' } });
  });
  it('checks the origin before the request', async () => {
    const client = await open('nonsense', {}, { origin: 'https://evil.example' });
    expect(client.status).toBe(403);
  });
});
