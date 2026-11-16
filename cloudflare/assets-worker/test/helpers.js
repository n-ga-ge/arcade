// Shared by the test files: made-up objects in the simulated bucket and a
// function that sends one request through the Worker.

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index.js';

export const SITE = 'https://n-ga.ge';
export const PREVIEW = 'https://abc123.n-ga-ge.pages.dev';
export const TOKEN = 'made-up-token-for-the-tests';
export const VARS = {
  ALLOWED_ORIGINS: 'https://n-ga-ge.pages.dev, https://*.n-ga-ge.pages.dev',
  ASSETS_TOKEN: TOKEN,
};
// What a browser sends when the site's own page fetches an asset.
export const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

export const IMMUTABLE = 'max-age=31536000, immutable';
export const REVALIDATE = 'max-age=300, must-revalidate';

// Reproducible bytes that are not a repeating short pattern, so a slice taken
// at the wrong offset does not compare equal.
export function bytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state >> 16;
  }
  return out;
}

export async function sha256(data) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const bucket = env.ASSETS;

// One request through the Worker. Returns the response with its body read and
// every background task (the edge cache fill) finished.
export async function call(path, { method = 'GET', headers = SAME_ORIGIN, vars = {}, base = SITE } = {}) {
  const ctx = createExecutionContext();
  const request = new Request(base + path, { method, headers });
  const response = await worker.fetch(request, { ASSETS: bucket, ...VARS, ...vars }, ctx);
  const body = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, body };
}

// A bucket that counts the reads made through it.
export function counting() {
  const reads = { head: 0, get: 0, ranged: 0 };
  return {
    reads,
    ASSETS: {
      head(key) {
        reads.head++;
        return bucket.head(key);
      },
      get(key, options) {
        reads.get++;
        if (options?.range) reads.ranged++;
        return bucket.get(key, options);
      },
    },
  };
}
