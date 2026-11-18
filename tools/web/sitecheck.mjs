// Checks a deployed site the way a visitor meets it: the pages and their
// headers, the game files behind the Worker, the multiplayer relay, the front
// page, and then every game, started from its link in a fresh browser.
//
//   node tools/web/sitecheck.mjs [--base https://n-ga.ge] [--games a,b,c | --all] [--out DIR]
//                                [--browser chrome|chrome-software] [--timeout 120]
//
//   --base      the site (default https://n-ga.ge)
//   --games     slugs to start; by default the games the front page lists
//               (every entry whose status is not "untested"); --all starts
//               every entry of the catalogue
//   --out       folder for results.json, summary.md and one screenshot per game
//               (default tools/web/results-site)
//   --browser   chrome (the toolchain's Chrome with a GPU, the default when
//               there is one) or chrome-software (Playwright's Chromium, as CI)
//
// A game passes when it does what its catalogue entry says: an entry that is
// ingame, menu or boots must start, draw, and be shown by the page (the page's
// canvas is compared with the emulator's own screenshot); an entry that is
// broken is expected not to, and the result says when it did better. The key
// script of the entry is not replayed here: the per-game CI job does that.
// This is the check that the deployed pieces fit together. For a game whose
// entry names an enhancement profile (docs/enhancements.md) that includes the
// profile: the site must publish it, and the page must have handed it to the
// emulator.
//
// Every page must carry the site's icons and share tags (tools/site/steps/
// 70-head.py), and the files they name must be served. A link to one game
// must keep the player's headers, and on a host with the share Worker
// (cloudflare/share-worker/) preview that game.
//
// The relay (/net/, docs/deployment.md) is checked without a browser: its
// health address must answer, and two connections must meet in a room made
// for the purpose and pass a frame each way. The room is not public, so it
// never shows in the site's list of open rooms.
//
// Exit code 0 when everything passed, 1 otherwise.
import { chromium } from 'playwright';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SHOWN_AT, likeness, picture } from './gamecheck.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, i, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const base = String(args.base || 'https://n-ga.ge').replace(/\/+$/, '');
const outDir = path.resolve(String(args.out || path.join(path.dirname(new URL(import.meta.url).pathname), 'results-site')));
const startTimeout = Number(args.timeout || 120) * 1000;
fs.mkdirSync(outDir, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];   // everything that is wrong, in words
const notes = [];      // worth knowing, not wrong
const fail = (what) => { problems.push(what); console.log('FAIL ', what); };
const ok = (what) => console.log('ok   ', what);

function toolchainChrome() {
  const root = path.join(process.env.EKA2L1_TOOLCHAIN || '', 'chrome', 'chrome');
  if (!process.env.EKA2L1_TOOLCHAIN || !fs.existsSync(root)) return null;
  const version = fs.readdirSync(root).sort().pop();
  return version ? path.join(root, version, 'chrome-linux64', 'chrome') : null;
}
const chrome = toolchainChrome();
const mode = String(args.browser || (chrome ? 'chrome' : 'chrome-software'));
const launch = () => chromium.launch(mode === 'chrome'
  ? { executablePath: chrome || undefined, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] }
  : { headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function head(url, headers = {}) {
  const response = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
  await response.body?.cancel();
  return response;
}

// --- 1. pages and headers -------------------------------------------------------

async function checkPages() {
  for (const address of ['/', '/play/', '/docs/', '/catalog/index.json', '/catalog/assets.json']) {
    const response = await head(base + address);
    if (response.status !== 200) fail(`${address} answers ${response.status}`);
  }
  for (const address of ['/', '/play/']) {
    const response = await head(base + address);
    const missing = [['cross-origin-opener-policy', 'same-origin'], ['cross-origin-embedder-policy', 'require-corp']]
      .filter(([name, value]) => response.headers.get(name) !== value).map(([name]) => name);
    if (missing.length) fail(`${address} lacks ${missing.join(' and ')}: the player cannot use threads`);
    const cache = response.headers.get('cache-control') || '';
    if (!/max-age=0|no-cache|no-store/.test(cache)) fail(`${address} may be kept by browsers ("${cache}"): visitors would stay on an old page after a deployment`);
  }
  ok('pages answer and are cross-origin isolated');

  // The player's files must not be able to go stale separately from each other.
  const html = await (await fetch(`${base}/play/`)).text();
  const references = [...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((ref) => !/^[a-z][a-z0-9+.-]*:|^\//i.test(ref));
  const build = (references.find((ref) => /^b\/[0-9a-f]+\//.test(ref)) || '').split('/').slice(0, 2).join('/');
  if (!build) notes.push('the player page does not keep its files in a per-build folder (/play/b/<id>/)');
  const files = new Set(references);
  const before = problems.length;
  if (build) for (const name of ['eka2l1_web.wasm', 'eka2l1_web.data', 'eka2l1-client.js', 'loader.js']) files.add(`${build}/${name}`);
  for (const file of files) {
    const response = await head(`${base}/play/${file}`);
    const cache = response.headers.get('cache-control') || '';
    if (response.status !== 200) { fail(`/play/${file} answers ${response.status}`); continue; }
    const seconds = Number((cache.match(/max-age=(\d+)/) || [])[1] || 0);
    if (seconds > 0 && !(build && file.startsWith(build) && /immutable/.test(cache))) {
      fail(`/play/${file} is kept by browsers for ${seconds} s ("${cache}") under a name that changes content with every deployment: a kept copy can meet newer files of the player`);
    }
  }
  if (problems.length === before) ok(`the player's files (${files.size} checked${build ? `, build ${build.split('/')[1]}` : ''}) cannot go stale against each other`);

  // The same for the front page: its own scripts and style sheet.
  const front = await (await fetch(`${base}/`)).text();
  const own = [...new Set([...front.matchAll(/\b(?:src|href)="(\/[^"#?]+\.(?:js|css))"/g)].map((m) => m[1]))];
  const frontBefore = problems.length;
  for (const file of own) {
    const response = await head(base + file);
    const cache = response.headers.get('cache-control') || '';
    if (response.status !== 200) { fail(`${file} answers ${response.status}`); continue; }
    const seconds = Number((cache.match(/max-age=(\d+)/) || [])[1] || 0);
    if (seconds > 0 && !(/^\/s\/[0-9a-f]+\//.test(file) && /immutable/.test(cache))) {
      fail(`${file} is kept by browsers for ${seconds} s ("${cache}") under a name that changes content with every deployment: a returning visitor can run an old front-page script against a new catalogue`);
    }
  }
  if (problems.length === frontBefore) ok(`the front page's own files (${own.length} checked) cannot go stale against the page`);

  // The dev server hands the game files to anyone; only a deployed site has
  // the Worker and its access rule in front of them.
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(base).hostname);
  const served = await head(`${base}/assets/NGAGE.ROM`, { 'Sec-Fetch-Site': 'same-origin' });
  const refused = local ? null : await head(`${base}/assets/NGAGE.ROM`);
  if (served.status !== 200) fail(`/assets/NGAGE.ROM answers ${served.status} to the site itself`);
  if (refused && refused.status !== 403) fail(`/assets/NGAGE.ROM answers ${refused.status} to a request that is not from the site (expected 403)`);
  if (served.status === 200 && (!refused || refused.status === 403)) ok(local ? 'game files: served (a dev server has no access rule to check)' : 'game files: served to the site, refused to others');
}

// --- 1b. icons and share tags -------------------------------------------------------

const metaContent = (html, key) => (html.match(new RegExp(`<meta [^>]*${key}[^>]*>`)) || [''])[0].match(/content="([^"]*)"/)?.[1];
const decode = (text) => text && text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function checkShareTags(catalog) {
  const before = problems.length;
  const named = new Set();
  // The dev server has no 404 page and does not apply _headers.
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(base).hostname);
  for (const address of ['/', '/play/', '/docs/', '/docs/playing/', ...(local ? [] : ['/no-such-page-sitecheck'])]) {
    const html = await (await fetch(base + address)).text();
    for (const rel of ['icon', 'apple-touch-icon', 'manifest']) {
      const link = html.match(new RegExp(`<link rel="${rel}" href="([^"]+)"`));
      if (!link || !link[1].startsWith('/')) fail(`${address} has no <link rel="${rel}"> naming a file of the site`);
      else named.add(link[1]);
    }
    for (const key of ['property="og:title"', 'property="og:image"', 'name="twitter:card"']) {
      if (!metaContent(html, key)) fail(`${address} has no <meta ${key}>`);
    }
    const image = metaContent(html, 'property="og:image"');
    if (image && URL.canParse(decode(image))) named.add(new URL(decode(image)).pathname);
  }
  named.add('/favicon.ico');
  for (const file of named) {
    const response = await head(base + file);
    const type = response.headers.get('content-type') || '';
    if (response.status !== 200) fail(`${file} (an icon or share picture) answers ${response.status}`);
    else if (!/^image\/|manifest\+json|application\/json/.test(type)) fail(`${file} is served as "${type}"`);
  }
  if (problems.length === before) ok(`icons and share tags on every page; ${named.size} files they name are served`);

  const game = catalog.games.find((entry) => entry.ci && entry.ci.shot && entry.status !== 'untested') || catalog.games[0];
  if (!game) return;
  const response = await fetch(`${base}/play/?g=${game.slug}`);
  const html = await response.text();
  const lacking = [['cross-origin-opener-policy', 'same-origin'], ['cross-origin-embedder-policy', 'require-corp']]
    .filter(([name, value]) => response.headers.get(name) !== value).map(([name]) => name);
  if (lacking.length) fail(`/play/?g=${game.slug} lacks ${lacking.join(' and ')}: the player cannot use threads`);
  if (!local && !/script-src 'self' 'wasm-unsafe-eval';/.test(response.headers.get('content-security-policy') || '')) fail(`/play/?g=${game.slug} lacks the player's Content-Security-Policy`);
  const title = decode(metaContent(html, 'property="og:title"') || '');
  if (title.startsWith(game.title)) {
    const image = decode(metaContent(html, 'property="og:image"') || '');
    const shot = image && await head(image);
    if (!shot || shot.status !== 200) fail(`the preview of /play/?g=${game.slug} names a picture that answers ${shot ? shot.status : 'nothing'}`);
    else ok(`a link to one game previews it ("${title}", ${new URL(image).pathname})`);
  } else if (new URL(base).hostname === 'n-ga.ge') {
    fail(`/play/?g=${game.slug} previews as "${title}", not as the game: is the share Worker deployed?`);
  } else {
    notes.push(`a link to one game previews as the site ("${title}"): ${new URL(base).hostname} has no share Worker in front of it`);
  }
}

// --- 2. the multiplayer relay -----------------------------------------------------

const RELAY_WAIT = 15000;

// One connection to a room, as the player's page makes it. Node's WebSocket
// takes the Origin header a browser would send; the relay admits no other
// page than the site's. next() resolves to { text }, { bytes } or { end }.
function relaySocket(code, query, origin) {
  const address = `${base.replace(/^http/, 'ws')}/net/room/${code}?${new URLSearchParams(query)}`;
  const ws = new WebSocket(address, { headers: { Origin: origin } });
  ws.binaryType = 'arraybuffer';
  const queue = [];
  let waiting = null;
  const deliver = (message) => {
    if (!waiting) { queue.push(message); return; }
    clearTimeout(waiting.timer);
    const { resolve } = waiting;
    waiting = null;
    resolve(message);
  };
  ws.addEventListener('message', (event) => deliver(typeof event.data === 'string' ? { text: event.data } : { bytes: [...new Uint8Array(event.data)] }));
  ws.addEventListener('error', () => deliver({ end: 'the connection failed' }));
  ws.addEventListener('close', (event) => deliver({ end: `the connection was closed with code ${event.code}` }));
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => {
      waiting = { resolve, timer: setTimeout(() => { waiting = null; resolve({ end: `nothing arrived within ${RELAY_WAIT / 1000} s` }); }, RELAY_WAIT) };
    })),
    send: (data) => ws.send(data),
    close: () => { try { ws.close(); } catch { /* never opened */ } },
  };
}

// The next message of a connection as JSON, which must be of the kind `t`.
async function relayMessage(socket, who, t) {
  const message = await socket.next();
  let data = null;
  try { data = JSON.parse(message.text); } catch { /* not a text frame */ }
  if (data?.t !== t) throw new Error(`${who} expected "${t}" and got ${message.end || (message.text ?? `a binary frame of ${message.bytes.length} bytes`)}`);
  return data;
}

async function relayFrame(socket, who, expected) {
  const message = await socket.next();
  if (JSON.stringify(message.bytes) !== JSON.stringify(expected)) {
    throw new Error(`${who} expected the frame [${expected}] and got ${message.end || message.text || `[${message.bytes}]`}`);
  }
}

async function checkRelay() {
  // 404 is what Pages, or a dev server without the relay, answers under /net/.
  let health = null;
  let status = 'does not answer';
  try {
    const response = await fetch(`${base}/net/health`);
    const body = await response.text();
    status = `answers ${response.status}`;
    if (response.status === 200) {
      status += ` with ${body.slice(0, 60).replace(/\s+/g, ' ').trim() || 'an empty body'}`;
      try { health = JSON.parse(body); } catch { /* not the relay */ }
    }
  } catch (error) {
    status = `cannot be reached (${error.cause?.message || error.message})`;
  }
  if (health?.ok !== true || health?.v !== 1) {
    fail(`the multiplayer relay is not deployed: /net/health ${status} (expected 200 {"ok":true,"v":1}). On Cloudflare the relay is the Worker in cloudflare/net-worker/, which a production deployment publishes; locally it is part of the dev server (tools/web/devserver.py)`);
    return;
  }
  const list = await fetch(`${base}/net/rooms`).then(async (response) => (response.status === 200 ? (await response.json()).rooms : null)).catch(() => null);
  if (!Array.isArray(list)) fail('the multiplayer relay: /net/rooms does not answer with a list of rooms');

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from({ length: 6 }, () => alphabet[randomInt(32)]).join('');
  const origin = new URL(base).origin;
  const sockets = [];
  const connect = (query, from = origin) => sockets[sockets.push(relaySocket(code, query, from)) - 1];
  try {
    const host = connect({ v: 1, name: 'sitecheck host', create: 1, game: 'sitecheck' });
    const hello = await relayMessage(host, 'the creator of a room', 'hello');
    if (hello.id !== 1 || hello.room !== code || hello.public !== false) throw new Error(`the creator of a room got an unexpected hello: ${JSON.stringify(hello)}`);
    const guest = connect({ v: 1, name: 'sitecheck guest' });
    const joined = await relayMessage(guest, 'a member joining the room', 'hello');
    if (joined.id !== 2 || joined.peers?.[0]?.id !== 1) throw new Error(`a member joining the room got an unexpected hello: ${JSON.stringify(joined)}`);
    await relayMessage(host, 'the creator, when a member joined,', 'join');
    guest.send(new Uint8Array([1, 0x6e, 0x67, 0x61]));
    await relayFrame(host, 'the creator', [2, 0x6e, 0x67, 0x61]);
    host.send(new Uint8Array([0, 0x67, 0x65]));
    await relayFrame(guest, 'the member', [1, 0x67, 0x65]);
    guest.close();
    await relayMessage(host, 'the creator, when the member left,', 'leave');
    // Only the site's own pages may open a room. A dev server takes any
    // local page, so there is no rule to check there.
    const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(base).hostname);
    if (!local) {
      const stranger = connect({ v: 1, name: 'sitecheck stranger' }, 'https://sitecheck.invalid');
      const answer = await stranger.next();
      if (!answer.end) throw new Error(`a page of another site (Origin https://sitecheck.invalid) was let into the room; the relay must refuse its upgrade`);
    }
    ok(local ? 'the multiplayer relay answers, and two connections exchange frames in a room (a dev server has no origin rule to check)'
      : 'the multiplayer relay answers, two connections exchange frames in a room, and a page of another site is refused');
  } catch (error) {
    fail(`the multiplayer relay at /net/: ${error.message}`);
  } finally {
    for (const socket of sockets) socket.close();
  }
}

// --- 3. the front page ------------------------------------------------------------

async function checkFrontPage(browser, catalog) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const links = await page.$$eval('a[href*="/play/?g="]', (as) => [...new Set(as.map((a) => new URL(a.href).searchParams.get('g')))]);
  const listed = catalog.games.filter((game) => game.status !== 'untested').map((game) => game.slug);
  const missing = listed.filter((slug) => !links.includes(slug));
  const extra = links.filter((slug) => !listed.includes(slug));
  if (missing.length) fail(`the front page lacks ${missing.length} tested games: ${missing.slice(0, 5).join(', ')}`);
  if (extra.length) fail(`the front page lists ${extra.length} games it should not: ${extra.slice(0, 5).join(', ')}`);
  if (errors.length) fail(`the front page has errors: ${errors.slice(0, 3).join('; ')}`);
  if (!missing.length && !extra.length && !errors.length) ok(`the front page lists the ${listed.length} tested games`);
  await page.screenshot({ path: path.join(outDir, 'front-page.png') });
  await page.close();
  return listed;
}

// --- 4. one game ---------------------------------------------------------------------

async function checkGame(browser, entry) {
  const result = { slug: entry.slug, title: entry.title, status: entry.status, started: false, firstFrameMs: null, drawn: false, likeness: null, pass: false, note: '' };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  try {
    const opened = Date.now();
    await page.goto(`${base}/play/?g=${encodeURIComponent(entry.slug)}`);
    await page.waitForFunction(() => window.eka2l1Page && window.eka2l1Page.app && window.eka2l1Page.emu.frames() > 0, null, { timeout: startTimeout });
    result.started = true;
    result.firstFrameMs = Date.now() - opened;
    // Give it time to put a picture up, then look a few times: a fade or a
    // blank moment between two logos is not a fault.
    for (let attempt = 0; attempt < 6 && !(result.drawn && result.likeness !== null && result.likeness >= SHOWN_AT); attempt++) {
      await pause(attempt ? 2000 : 4000);
      // Paused for the two pictures, so that a game that is moving is compared
      // with itself and not with its next frame.
      await page.evaluate(() => window.eka2l1.request('POST', '/v1/emulator/pause'));
      await pause(400);
      const guest = Buffer.from(await page.evaluate(async () => Array.from((await window.eka2l1.request('GET', '/v1/screenshot')).body)));
      if (picture(guest).blank) {
        await page.evaluate(() => window.eka2l1.request('POST', '/v1/emulator/resume'));
        continue;
      }
      result.drawn = true;
      await page.evaluate(() => { for (const id of ['overlay', 'setup']) { const e = document.getElementById(id); if (e) { e.dataset.was = String(e.hidden); e.hidden = true; } } });
      const shown = await page.locator('#canvas').screenshot();
      await page.evaluate(() => { for (const id of ['overlay', 'setup']) { const e = document.getElementById(id); if (e && e.dataset.was !== undefined) e.hidden = e.dataset.was === 'true'; } });
      await page.evaluate(() => window.eka2l1.request('POST', '/v1/emulator/resume'));
      const alike = likeness(shown, guest);
      if (alike !== null && (result.likeness === null || alike > result.likeness)) {
        result.likeness = alike;
        fs.writeFileSync(path.join(outDir, `${entry.slug}.png`), shown);
      }
    }
  } catch (error) {
    const status = await page.evaluate(() => document.getElementById('status')?.textContent || '').catch(() => '');
    result.note = `${String(error.message).split('\n')[0]}${status ? ` (page says: ${status})` : ''}`;
  }
  if (errors.length && !result.note) result.note = errors.slice(0, 2).join('; ');
  await checkEnhancement(result.started ? page : null, entry.slug).catch((error) => fail(`${entry.slug}: its enhancement profile could not be checked: ${String(error.message).split('\n')[0]}`));
  await context.close();

  const works = result.started && result.drawn && result.likeness !== null && result.likeness >= SHOWN_AT;
  if (entry.status === 'broken') {
    result.pass = true;
    if (works) result.note = `listed as not working, but it starts and shows a picture${result.note ? `; ${result.note}` : ''}`;
  } else {
    result.pass = works;
    if (!works && !result.note) {
      result.note = !result.started ? 'did not start' : !result.drawn ? 'started, but its screen stayed one colour'
        : `the page does not show what the game draws (likeness ${result.likeness})`;
    }
  }
  return result;
}

// A game whose entry names an enhancement profile: /catalog/enhance/ must
// have it, and the page must have loaded it into the emulator. `page` is the
// game's page when it started, else null. Whether the picture is right is not
// looked at here.
async function checkEnhancement(page, slug) {
  const entry = await fetch(`${base}/catalog/games/${slug}.json`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  const engine = entry?.enhance?.engine;
  if (!engine) return null;
  const address = `/catalog/enhance/${engine}.json`;
  const response = await fetch(base + address).catch(() => null);
  const profile = response?.status === 200 ? await response.json().catch(() => null) : null;
  if (!profile) return fail(`${slug} names the enhancement profile ${engine}, but ${address} ${response ? `answers ${response.status}${response.status === 200 ? ' with something that is not JSON' : ''}` : 'cannot be reached'}`);
  if (profile.engine !== engine || !Array.isArray(profile.images)) return fail(`${address} is not a profile of the engine ${engine}`);
  if (!page) return ok(`${slug}: its enhancement profile ${engine} is published (the game did not start, so the page was not asked about it)`);

  const state = await page.waitForFunction(() => window.eka2l1Page.enhance && window.eka2l1Page.enhance.state !== 'loading' && window.eka2l1Page.enhance.state, null, { timeout: 20000 })
    .then((handle) => handle.jsonValue()).catch(() => null);
  const emulator = await page.evaluate(async () => {
    const answer = await window.eka2l1.request('GET', '/v1/enhance');
    return answer.ok ? answer.json() : { http: answer.status };
  }).catch((error) => ({ http: String(error.message).split('\n')[0] }));
  if (!state) return fail(`${slug}: the page did not take up the enhancement profile ${engine} its entry names`);
  if (emulator.available !== true || emulator.engine !== engine) {
    return fail(`${slug}: the emulator does not hold the enhancement profile ${engine} (the page says "${state}", GET /v1/enhance ${emulator.http ? `answers ${emulator.http}` : `says ${JSON.stringify({ available: emulator.available, engine: emulator.engine })}`})`);
  }
  // `scale` is in the answer once the emulator can draw a game's 3D itself.
  return ok(`${slug}: its enhancement profile ${engine} is published and loaded${emulator.active ? ', and matches the game\'s code' : ''}`
    + (emulator.scale === undefined ? '; this emulator only captures, so the 3D resolution setting says it is not available' : ''));
}

// --- 5. a second visit ----------------------------------------------------------------

async function checkReturn(slug) {
  const profile = fs.mkdtempSync(path.join(outDir, 'profile-'));
  const options = mode === 'chrome'
    ? { executablePath: chrome || undefined, headless: true, args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] }
    : { headless: true };
  try {
    const timings = [];
    for (const visit of ['first', 'second']) {
      const context = await chromium.launchPersistentContext(profile, options);
      const page = context.pages()[0] || await context.newPage();
      let downloads = 0;
      page.on('response', (response) => { if (new URL(response.url()).pathname.startsWith('/assets/')) downloads += 1; });
      const opened = Date.now();
      await page.goto(`${base}/play/?g=${encodeURIComponent(slug)}`);
      await page.waitForFunction(() => window.eka2l1Page && window.eka2l1Page.app && window.eka2l1Page.emu.frames() > 0, null, { timeout: startTimeout });
      timings.push({ visit, ms: Date.now() - opened, downloads });
      await pause(3000); // let the page finish storing what it downloaded
      await context.close();
    }
    const [first, second] = timings;
    if (second.downloads > 0) fail(`a second visit to ${slug} downloaded ${second.downloads} game files again: the download cache is not used`);
    else ok(`a second visit to ${slug} starts from the device (${(first.ms / 1000).toFixed(1)} s the first time, ${(second.ms / 1000).toFixed(1)} s the second, no downloads)`);
    return timings;
  } catch (error) {
    fail(`visiting ${slug} twice: ${String(error.message).split('\n')[0]}`);
    return null;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// --- run -------------------------------------------------------------------------------

console.log(`checking ${base} with ${mode}`);
const catalog = await (await fetch(`${base}/catalog/index.json`)).json();
await checkPages();
await checkShareTags(catalog);
await checkRelay();
const browser = await launch();
const listed = await checkFrontPage(browser, catalog);
const wanted = typeof args.games === 'string' ? args.games.split(',').map((slug) => slug.trim()).filter(Boolean)
  : args.all ? catalog.games.map((game) => game.slug) : listed;
const bySlug = new Map(catalog.games.map((game) => [game.slug, game]));
const results = [];
for (const slug of wanted) {
  const entry = bySlug.get(slug);
  if (!entry) { fail(`${slug} is not in the catalogue`); continue; }
  const result = await checkGame(browser, entry);
  results.push(result);
  const seconds = result.firstFrameMs === null ? '-' : (result.firstFrameMs / 1000).toFixed(1);
  console.log(`${result.pass ? 'ok   ' : 'FAIL '} ${slug}: listed ${entry.status}; first frame ${seconds} s, likeness ${result.likeness ?? '-'}${result.note ? `; ${result.note}` : ''}`);
  if (!result.pass) problems.push(`${slug}: ${result.note}`);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ base, mode, commit: catalog.commit || null, results, problems, notes }, null, 1));
}
await browser.close();
const returning = results.find((result) => result.pass && result.status !== 'broken');
const visits = returning ? await checkReturn(returning.slug) : null;

const lines = [`# Site check: ${base}`, '', `Catalogue commit ${catalog.commit || 'unknown'}, browser ${mode}.`, '',
  `${results.filter((r) => r.pass).length} of ${results.length} games did what their entry says.`, '',
  '| Game | Listed as | Started | First frame | Page shows it | Result | Note |', '|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.title} | ${r.status} | ${r.started ? 'yes' : 'no'} | ${r.firstFrameMs === null ? '-' : `${(r.firstFrameMs / 1000).toFixed(1)} s`} | ${r.likeness === null ? '-' : r.likeness} | ${r.pass ? 'pass' : 'FAIL'} | ${r.note.replace(/\|/g, '/')} |`),
  '', problems.length ? `## Problems\n\n${problems.map((p) => `- ${p}`).join('\n')}` : 'No problems found.',
  notes.length ? `\n## Notes\n\n${notes.map((n) => `- ${n}`).join('\n')}` : ''];
fs.writeFileSync(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ base, mode, commit: catalog.commit || null, results, visits, problems, notes }, null, 1));
console.log(`\n${problems.length ? `${problems.length} problems` : 'everything passed'}; details in ${outDir}`);
process.exit(problems.length ? 1 : 0);
