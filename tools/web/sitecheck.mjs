// Checks a deployed site the way a visitor meets it: the pages and their
// headers, the game files behind the Worker, the front page, and then every
// game, started from its link in a fresh browser.
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
// This is the check that the deployed pieces fit together.
//
// Exit code 0 when everything passed, 1 otherwise.
import { chromium } from 'playwright';
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

  const refused = await head(`${base}/assets/NGAGE.ROM`);
  if (refused.status !== 403) fail(`/assets/NGAGE.ROM answers ${refused.status} to a request that is not from the site (expected 403)`);
  const served = await head(`${base}/assets/NGAGE.ROM`, { 'Sec-Fetch-Site': 'same-origin' });
  if (served.status !== 200) fail(`/assets/NGAGE.ROM answers ${served.status} to the site itself`);
  else ok('game files: served to the site, refused to others');
}

// --- 2. the front page ------------------------------------------------------------

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

// --- 3. one game ---------------------------------------------------------------------

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
      const guest = Buffer.from(await page.evaluate(async () => Array.from((await window.eka2l1.request('GET', '/v1/screenshot')).body)));
      if (picture(guest).blank) continue;
      result.drawn = true;
      await page.evaluate(() => { for (const id of ['overlay', 'setup']) { const e = document.getElementById(id); if (e) { e.dataset.was = String(e.hidden); e.hidden = true; } } });
      const shown = await page.locator('#canvas').screenshot();
      await page.evaluate(() => { for (const id of ['overlay', 'setup']) { const e = document.getElementById(id); if (e && e.dataset.was !== undefined) e.hidden = e.dataset.was === 'true'; } });
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

// --- 4. a second visit ----------------------------------------------------------------

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
