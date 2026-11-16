// Puts a file into the local R2 simulation that `wrangler dev` reads, with its
// SHA-256 as metadata like tools/assets/upload.py does for the real bucket
// (`wrangler r2 object put --local` cannot set metadata, and without the hash
// the Worker never treats ?v= as immutable).
//
//   node seed-local.mjs <key> <file> [--persist-to <dir>]
//   node seed-local.mjs games/demo.zip ~/demo.zip
//
// --persist-to is the same directory as given to `wrangler dev`; without it
// both use .wrangler/state in this folder.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';

const { values, positionals } = parseArgs({ options: { 'persist-to': { type: 'string' } }, allowPositionals: true });
const [key, file] = positionals;
if (!key || !file || positionals.length !== 2) {
  console.error('usage: node seed-local.mjs <key> <file> [--persist-to <dir>]');
  process.exit(2);
}

const data = await readFile(file);
const sha256 = createHash('sha256').update(data).digest('hex');
// wrangler keeps its simulation in the "v3" folder of the directory it is given.
const path = join(resolve(values['persist-to'] ?? '.wrangler/state'), 'v3');
const { env, dispose } = await getPlatformProxy({ persist: { path } });
try {
  await env.ASSETS.put(key, data, { customMetadata: { sha256 } });
} finally {
  await dispose();
}
console.log(`${key}: ${data.length} bytes, /assets/${key}?v=${sha256}`);
