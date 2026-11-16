// The test one CI job runs for one game: start the game in a browser, replay
// the key script from its catalogue entry and say how far it got.
//
//   node tools/web/gametest.mjs --game <slug> --out <dir> [options]
//
//   --game SLUG        catalog/games/<SLUG>.json and <assets>/games/<SLUG>.zip
//   --out DIR          where <SLUG>.json (the result) and <SLUG>.png (the
//                      emulator's last screenshot) are written
//   --browser NAME     chrome-software (default): Playwright's own Chromium with
//                      software rendering, which is what a CI container has;
//                      chrome: the toolchain's Chrome on this machine's GPU
//   --port N           port for the dev server this tool starts (default: a free one)
//   --bin DIR          web build to test (default: eka2l1/build/web/bin of this
//                      checkout, else of $ARCADE_MAIN)
//   --assets DIR       folder with NGAGE.ROM and games/<slug>.zip (default:
//                      testdata/ of this checkout, else of $ARCADE_MAIN)
//   --entry FILE       read the catalogue entry from FILE instead (to try a
//                      changed script without editing the catalogue)
//   --time-limit SEC   give up after this long (default: start-up timeout +
//                      script length + a margin)
//   --verbose          print the page console while it runs
//
// Levels, from what a machine can check:
//   broken   the game did not install or launch, the page reported an error,
//            the wasm aborted, the game exited, or it never drew a picture
//   boots    it launched, frames advance, and the emulator's own screenshot
//            is not blank
//   menu, ingame   the level its script expects ("test.expect"), when after
//            the whole script the game still runs, frames still advance (by
//            themselves or when a key is pressed) and the screen is not
//            blank; for ingame the picture must also change by itself or when
//            a direction key is pressed
// This shows that the game is alive on a real screen after its script. It
// cannot tell which screen that is: a script that stops short of play, on an
// animated title screen, still reaches the level it names.
// An entry with a test passes when it reaches at least "test.expect". An entry
// without one gets a boot check and always passes. An entry listed as broken
// passes while it stays broken, and the result says when it did better. A run
// that could not be carried out (no browser, missing files, the emulator or
// the firmware did not come up, the browser or its page process died) has
// "reached": null and fails whatever the entry says.
//
// Exit code 0 on pass, 1 on fail, 2 when the command line is wrong. It always
// ends: every wait has a limit and the browser and the server are stopped.
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScript, difference, picture, scriptMs, stepTiming, targetLevel, verdict, rank } from './gamecheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPTIONS = { game: 'value', out: 'value', browser: 'value', port: 'value', bin: 'value', assets: 'value', entry: 'value', 'time-limit': 'value', verbose: 'flag' };

function usage(message) {
  console.error(`${message}\nusage: node tools/web/gametest.mjs --game <slug> --out <dir> [--browser chrome-software|chrome] [--port N] [--bin DIR] [--assets DIR] [--entry FILE] [--time-limit SEC] [--verbose]`);
  process.exit(2);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, '');
  if (!process.argv[i].startsWith('--') || !OPTIONS[name]) usage(`unknown argument: ${process.argv[i]}`);
  if (OPTIONS[name] === 'flag') { args[name] = true; continue; }
  if (i + 1 >= process.argv.length) usage(`--${name} needs a value`);
  args[name] = process.argv[++i];
}
if (!args.out) usage('--out is required');
if (!args.game && args.entry) {
  // The game is the one the entry names. Read now: without a name there is
  // nowhere to write a result.
  try {
    args.game = JSON.parse(fs.readFileSync(args.entry, 'utf8')).slug;
  } catch (error) {
    usage(`cannot read ${args.entry}: ${error.message}`);
  }
}
if (!args.game) usage('--game is required');
// The name becomes part of file names and of a URL.
if (typeof args.game !== 'string' || !/^[a-z0-9-]+$/.test(args.game)) usage(`not a game name: ${args.game}`);
if (args.browser && !['chrome-software', 'chrome'].includes(args.browser)) usage(`unknown browser: ${args.browser}`);
for (const name of ['port', 'time-limit']) {
  if (args[name] !== undefined && !(Number(args[name]) > 0)) usage(`--${name} must be a positive number`);
}

// Set by tools/env.sh. A worktree has neither the web build nor testdata/; the
// main checkout does.
const MAIN = process.env.ARCADE_MAIN || ROOT;
const firstWith = (file, ...folders) => folders.find((folder) => fs.existsSync(path.join(folder, file))) || folders[0];
const binDir = path.resolve(args.bin || firstWith('eka2l1_web.wasm', path.join(ROOT, 'eka2l1', 'build', 'web', 'bin'), path.join(MAIN, 'eka2l1', 'build', 'web', 'bin')));
const assetsDir = path.resolve(args.assets || firstWith('NGAGE.ROM', path.join(ROOT, 'testdata'), path.join(MAIN, 'testdata')));
const outDir = path.resolve(args.out);
const browserName = args.browser || 'chrome-software';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a game with no script is watched: at least BOOT_MIN_MS, so a crash
// shortly after launch is seen, and up to BOOT_MAX_MS for its first picture.
const BOOT_MIN_MS = 15000;
const BOOT_MAX_MS = 45000;
// One question to the page, and the page's script starting after the load.
// Generous: the CI machine is slow and shared.
const ANSWER_MS = 30000;
const PAGE_MS = 30000;
// A picture counts as changed when more than this share of its pixels differ.
const CHANGED_SHARE = 0.001;
const CONSOLE_KEPT = 200;
const CONSOLE_TAIL = 40;

// --- the result ----------------------------------------------------------------

const started = Date.now();
const run = {
  slug: args.game,
  entry: null,
  phase: 'reading the catalogue entry',
  gameLoaded: false, // the page has downloaded the game: from here on, failures are the game's
  reached: null,
  error: null,
  startMs: null,
  readyMs: null,
  frames: null,
  version: null,
  renderer: null,
  checks: {},
  shot: null, // the last screenshot worth keeping
  shotBlank: true,
  console: [],
};
let browser = null;
let server = null;
let finished = false;

// A failure with its consequence: 'setup' means the test could not be carried
// out, 'broken' means the game is.
class Problem extends Error {
  constructor(message, level, cause = null) {
    super(message);
    this.level = level;
    this.cause = cause; // the page's own error, when a question to it failed
  }
}
const problem = (message, cause = null) => new Problem(message, run.gameLoaded ? 'broken' : 'setup', cause);
const setupProblem = (message) => new Problem(message, 'setup');
const firstLine = (error) => String(error && error.message ? error.message : error).split('\n')[0];
// A question that failed for a reason that may pass (the page was mid-load),
// as opposed to one that got no answer at all.
const passing = (error) => error instanceof Problem && Boolean(error.cause) && !error.cause.timedOut;

// Rejects as soon as something fatal happens (page crash, reported error,
// game exit, ...), so that no wait outlives the game. See guard().
let failNow;
const fatal = new Promise((_, reject) => { failNow = reject; });
fatal.catch(() => {});
const guard = (promise) => Promise.race([promise, fatal]);
const pause = (ms) => guard(sleep(ms));

function withTimeout(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`), { timedOut: true })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function commit() {
  // Forgejo and GitHub Actions both set GITHUB_SHA.
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function finish() {
  if (finished) return;
  finished = true;

  const entry = run.entry || { status: 'untested', test: null };
  const { expect, pass, better } = verdict(entry, run.reached);
  let error = run.error;
  if (!pass && !error) error = `expected ${expect}, reached ${run.reached}`;

  const result = {
    slug: run.slug,
    title: run.entry ? run.entry.title : null,
    expect,
    reached: run.reached,
    pass,
    seconds: Math.round((Date.now() - started) / 1000),
    startMs: run.startMs,
    readyMs: run.readyMs,
    frames: run.frames,
    browser: browserName,
    browserVersion: run.version,
    renderer: run.renderer,
    commit: commit(),
    checks: run.checks,
  };
  if (better) {
    result.better = true;
    result.note = `listed as ${expect}, reached ${run.reached}: the catalogue entry can be updated`;
  }
  if (error) {
    result.error = error;
    result.console = run.console.slice(-CONSOLE_TAIL);
  }

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const shotFile = path.join(outDir, `${run.slug}.png`);
    // Never leave an older run's picture next to this result.
    fs.rmSync(shotFile, { force: true });
    if (run.shot) fs.writeFileSync(shotFile, run.shot);
    fs.writeFileSync(path.join(outDir, `${run.slug}.json`), JSON.stringify(result, null, 2) + '\n');
  } catch (writeError) {
    console.error(`could not write the result to ${outDir}: ${writeError.message}`);
    result.pass = false;
  }

  const level = run.reached === null ? 'not run' : `reached ${run.reached}`;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${run.slug}  ${level}${expect ? ` (expected ${expect})` : ''} in ${result.seconds} s${better ? '  BETTER than listed' : ''}${error ? `  ${error}` : ''}`);

  // Closing can hang when the browser is stuck; exiting kills what is left
  // (Playwright ends its browsers when this process exits).
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
  if (server) server.kill('SIGKILL');
  process.exit(result.pass ? 0 : 1);
}

function failed(error) {
  if (finished) return;
  const level = error instanceof Problem ? error.level : 'setup';
  run.error = firstLine(error);
  run.reached = level === 'broken' ? 'broken' : null;
}

process.on('exit', () => { if (server) server.kill('SIGKILL'); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    failed(setupProblem(`interrupted by ${signal} while ${run.phase}`));
    finish();
  });
}

// --- server and browser --------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Starts tools/web/devserver.py and resolves to its port once it serves.
async function startServer() {
  // A port this tool picked can be taken by someone else before the server
  // binds it, so that is tried again; a port the caller asked for is not.
  for (let attempt = 1; ; attempt++) {
    const port = args.port ? Number(args.port) : await freePort();
    const child = spawn('python3', ['-I', path.join(ROOT, 'tools', 'web', 'devserver.py'), '--bin', binDir, '--assets', assetsDir, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let exited = false;
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-2000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-2000); });
    child.on('error', (error) => { exited = true; output += String(error.message); });
    child.on('exit', () => { exited = true; });
    server = child;

    // The server says "serving ..." once it has the port. Waiting for that line
    // rather than for an answer on the port matters: an answer could come from
    // someone else's server that was already there, with another build.
    const until = Date.now() + 30000;
    while (Date.now() < until && !exited && !/^serving /m.test(output)) await sleep(50);
    if (!exited && /^serving /m.test(output)) return port;

    child.kill('SIGKILL');
    server = null;
    const reason = output.trim().split('\n').pop() || 'it said nothing';
    if (args.port || attempt >= 3) throw setupProblem(`the dev server did not start on port ${port}: ${reason}`);
  }
}

function toolchainChrome() {
  const root = path.join(process.env.EKA2L1_TOOLCHAIN || '', 'chrome', 'chrome');
  // Newest version last: "linux-131" after "linux-99".
  const versions = process.env.EKA2L1_TOOLCHAIN && fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const chrome = versions.length ? path.join(root, versions.pop(), 'chrome-linux64', 'chrome') : null;
  if (!chrome || !fs.existsSync(chrome)) throw new Error('the toolchain has no Chrome (source tools/env.sh, or use --browser chrome-software)');
  return chrome;
}

// Signals are handled here (see above), so that an interrupted run still
// writes its result; Playwright still ends the browser when this process exits.
const LAUNCH = { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };

const BROWSERS = {
  // Playwright's Chromium drawing WebGL2 on the CPU (SwiftShader). Asked for by
  // name, so a run on a laptop with a GPU renders the same way CI does, and so
  // a Chromium that no longer falls back to software by itself still gets it.
  'chrome-software': () => chromium.launch({ ...LAUNCH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }),
  // The toolchain's Chrome for Testing on the machine's GPU, as in suite.mjs.
  chrome: async () => chromium.launch({ ...LAUNCH, executablePath: toolchainChrome(), args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] }),
};

// --- the page --------------------------------------------------------------------

let page = null;

const ask = (fn, arg, what = 'the page') => guard(withTimeout(page.evaluate(fn, arg), ANSWER_MS, what).catch((error) => {
  throw problem(`${what} failed while ${run.phase}: ${firstLine(error)}`, error);
}));

// What the page says about itself. With `session`, also what the emulator says
// about the launched game (only once the game runs: before that the emulator
// is busy installing and would answer late).
const probe = (session = false) => ask(async (wantSession) => {
  const p = window.eka2l1Page || null;
  const status = document.getElementById('status');
  const up = Boolean(p && p.emu && p.emu.module);
  const out = {
    loaded: Boolean(p),
    status: status ? status.textContent : '',
    error: Boolean(status && status.classList.contains('error')),
    app: p && p.app ? p.app.name : null,
    frames: up ? p.emu.frames() : -1,
    session: null,
  };
  if (wantSession && up) {
    const res = await p.emu.request('GET', '/v1/session');
    if (res.ok) out.session = res.json();
  }
  return out;
}, session);

// The emulator's own screenshot: the guest's screen, whatever the page shows.
async function guestShot(keep = true) {
  const bytes = await ask(async () => {
    const res = await window.eka2l1.request('GET', '/v1/screenshot');
    return res.status === 200 ? Array.from(res.body) : null;
  }, null, 'screenshot');
  if (!bytes) return null;
  const png = Buffer.from(bytes);
  const seen = picture(png);
  // Keep the newest real picture; a blank one only while there is nothing better.
  if (keep && (!seen.blank || run.shotBlank)) {
    run.shot = png;
    run.shotBlank = seen.blank;
  }
  return { png, ...seen };
}

const watch = { running: false, sawFrames: false, sawPicture: false, lastFrames: -1 };

// Runs for the whole test, beside the script: notices when the page reports an
// error or the game exits, and whether the game ever drew a picture.
async function watcher() {
  let lastShotAt = 0;
  let misses = 0;
  while (!finished) {
    try {
      const state = await probe(watch.running);
      misses = 0;
      if (state.error) throw problem(`the page reported: ${state.status}`);
      if (watch.running) {
        const session = state.session;
        if (session && session.state && !['running', 'launching'].includes(session.state)) {
          const exit = session.lastExit && session.lastExit.fatal ? ` (${session.lastExit.fatal})` : '';
          throw problem(`the game ${session.state === 'crashed' ? 'crashed' : `ended (${session.state})`}${exit} while ${run.phase}`);
        }
        if (watch.lastFrames >= 0 && state.frames > watch.lastFrames) watch.sawFrames = true;
        watch.lastFrames = state.frames;
        run.frames = state.frames;
        if (!watch.sawPicture && Date.now() - lastShotAt >= 3000) {
          lastShotAt = Date.now();
          const shot = await guestShot();
          if (shot && !shot.blank) watch.sawPicture = true;
        }
      }
    } catch (error) {
      // The page can fail to answer once (mid-load); it must not stay silent.
      if (!passing(error) || ++misses >= 5) {
        failNow(error instanceof Problem ? error : setupProblem(firstLine(error)));
        return;
      }
    }
    await sleep(watch.running ? 1000 : 250);
  }
}

async function waitRunning(timeoutMs) {
  const opened = Date.now();
  let state = { status: '', frames: -1, app: null, loaded: false };
  for (;;) {
    state = await probe().catch((error) => { if (passing(error)) return state; throw error; });
    if (run.readyMs === null && state.frames >= 0) run.readyMs = Date.now() - opened;
    if (state.app && state.frames > 0) {
      run.startMs = Date.now() - opened;
      return;
    }
    const waited = Date.now() - opened;
    // The page's own script runs within moments of the load; without it there
    // is no player here to wait for.
    if (!state.loaded && waited > Math.min(timeoutMs, PAGE_MS)) throw problem(`the player page did not load within ${Math.round(waited / 1000)} s`);
    if (waited > timeoutMs) {
      const what = state.app ? `${state.app} was launched but drew no frame` : `the game did not start (status: "${state.status}")`;
      throw problem(`${what} within ${Math.round(timeoutMs / 1000)} s`);
    }
    await pause(100);
  }
}

// Frames presented since the counter read `first`, waiting up to `windowMs`;
// returns as soon as there are two.
async function framesSince(first, windowMs) {
  const until = Date.now() + windowMs;
  let now = (await probe()).frames;
  while (Date.now() < until && now - first < 2) {
    await pause(250);
    now = (await probe()).frames;
  }
  return now - first;
}

// A screenshot that is not blank, trying for a while: a fade between two
// screens is black for a moment.
async function steadyShot(tries, gapMs) {
  let shot = null;
  for (let i = 0; i < tries; i++) {
    if (i) await pause(gapMs);
    shot = await guestShot();
    if (shot && !shot.blank) return shot;
  }
  return shot;
}

// Does the picture change by itself, or when a direction key is pressed? A
// game in play does one or the other; a screen that is stuck does neither.
async function pictureChanges(before, press) {
  // These pictures are evidence only: the one kept as the game's thumbnail is
  // from before the keys were pressed.
  await pause(2000);
  let after = await guestShot(false);
  if (after && difference(before.png, after.png) > CHANGED_SHARE) return 'by itself';
  for (const key of ['left', 'right', 'up', 'down']) {
    await press(key, 300);
    await pause(700);
    after = await guestShot(false);
    if (after && difference(before.png, after.png) > CHANGED_SHARE) return `after ${key}`;
  }
  return null;
}

// --- the test --------------------------------------------------------------------

async function test() {
  // The catalogue entry.
  const entryFile = path.resolve(args.entry || path.join(ROOT, 'catalog', 'games', `${args.game}.json`));
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
  } catch (error) {
    throw setupProblem(`cannot read the catalogue entry ${entryFile}: ${error.message}`);
  }
  if (!entry || typeof entry !== 'object' || typeof entry.slug !== 'string') throw setupProblem(`${entryFile} is not a catalogue entry`);
  run.entry = entry;

  const script = entry.test ? entry.test.script : null;
  if (entry.test) {
    const keys = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'schema.json'), 'utf8')).$defs.key.enum;
    try {
      checkScript(script, keys);
      if (rank(entry.test.expect) < 0) throw new Error(`test.expect is "${entry.test.expect}"`);
    } catch (error) {
      throw setupProblem(`${entryFile}: ${error.message}`);
    }
  }
  const startTimeout = entry.test && entry.test.timeoutMs > 0 ? entry.test.timeoutMs : 90000;

  // The backstop behind every other limit.
  const limitMs = args['time-limit'] ? Number(args['time-limit']) * 1000 : startTimeout + (script ? Math.round(scriptMs(script) * 1.5) : BOOT_MAX_MS) + 150000;
  setTimeout(() => {
    failed(new Problem(`time limit of ${Math.round(limitMs / 1000)} s reached while ${run.phase}`, 'setup'));
    finish();
  }, limitMs).unref();

  for (const [file, hint] of [[path.join(binDir, 'eka2l1_web.wasm'), 'build it with tools/ci/build-web.sh or pass --bin'],
    [path.join(assetsDir, 'NGAGE.ROM'), 'fetch it with tools/assets/fetch.py or pass --assets'],
    [path.join(assetsDir, 'games', `${run.slug}.zip`), 'fetch it with tools/assets/fetch.py, pack it with tools/games/pack.py, or pass --assets']]) {
    if (!fs.existsSync(file)) throw setupProblem(`missing ${file}: ${hint}`);
  }

  run.phase = 'starting the dev server';
  const port = await startServer();

  run.phase = 'starting the browser';
  try {
    browser = await withTimeout(BROWSERS[browserName](), 60000, 'browser launch');
  } catch (error) {
    throw setupProblem(`could not start ${browserName}: ${firstLine(error)}`);
  }
  run.version = browser.version();
  // A browser that goes away is not the game's doing.
  browser.on('disconnected', () => { if (!finished) failNow(setupProblem(`the browser went away while ${run.phase}`)); });

  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // The page console, for the result of a failed run. A line that repeats the
  // one before it except for its numbers (a periodic status line) replaces it,
  // so that the last lines kept are not all the same message.
  let lastShape = null;
  let repeats = 0;
  const record = (line) => {
    if (args.verbose) console.log(`  ${line.slice(0, 400)}`);
    const text = line.length > 400 ? `${line.slice(0, 400)}…` : line;
    const shape = text.replace(/\d+/g, '#');
    if (shape === lastShape) {
      repeats++;
      run.console[run.console.length - 1] = `${text}  (${repeats} lines like this)`;
      return;
    }
    lastShape = shape;
    repeats = 1;
    run.console.push(text);
    if (run.console.length > CONSOLE_KEPT) run.console.shift();
  };
  page.on('console', (message) => record(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => {
    record(`[pageerror] ${error.message}`);
    failNow(problem(`uncaught error in the page while ${run.phase}: ${firstLine(error)}`));
  });
  // Nor is a page whose process dies: a game that fails traps inside the wasm
  // (an uncaught error, above). A dead renderer is a browser fault or a machine
  // out of memory, and must not pass for a game that is listed as broken.
  page.on('crash', () => { record('[crash]'); failNow(setupProblem(`the page's process died while ${run.phase}`)); });
  // Once the page has the game's bytes, the firmware is installed and the
  // emulator works: whatever fails after that is about this game.
  const gamePath = `/local/games/${run.slug}.zip`;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== gamePath) return;
    if (response.ok()) response.finished().then((error) => { if (!error) run.gameLoaded = true; }, () => {});
  });

  run.phase = 'loading the player';
  const url = `http://127.0.0.1:${port}/?fw=/local/NGAGE.ROM&game=${gamePath}&persist=0`;
  const response = await guard(page.goto(url, { timeout: 60000 })).catch((error) => {
    throw error instanceof Problem ? error : setupProblem(`the player page did not load: ${firstLine(error)}`);
  });
  if (!response || !response.ok()) throw setupProblem(`the player page did not load (HTTP ${response ? response.status() : 'no response'})`);
  watcher();

  run.phase = 'starting the game';
  await waitRunning(startTimeout);
  const since = Date.now();
  watch.running = true;
  run.renderer = await ask(() => {
    const support = window.eka2l1Page.support;
    return support && support.webgl ? support.webgl.renderer : null;
  }).catch(() => null);

  // Keys go straight to the emulator by N-Gage name: the page's own bindings
  // differ per game.
  const codes = await ask(async () => (await import('./eka2l1-client.js')).KEYS, null, 'key table');
  const press = async (key, hold) => {
    await ask(([code]) => window.eka2l1.key(code, true), [codes[key]], 'key down');
    await pause(hold);
    await ask(([code]) => window.eka2l1.key(code, false), [codes[key]], 'key up');
  };

  if (script) {
    for (const [index, raw] of script.entries()) {
      const step = stepTiming(raw);
      run.phase = `replaying script step ${index + 1} of ${script.length}`;
      for (let i = 0; i < step.repeat; i++) {
        if (step.key) await press(step.key, step.hold);
        await pause(step.wait);
      }
    }
  }
  // A game with no script is watched for a while. One whose script was too
  // short to see a picture gets the same patience before it is called blank.
  run.phase = script ? 'waiting for a picture after the script' : 'watching the game boot';
  const least = script ? 0 : BOOT_MIN_MS;
  while (Date.now() - since < BOOT_MAX_MS && !(Date.now() - since >= least && watch.sawPicture && watch.sawFrames)) await pause(500);

  // How far did it get? Still here means: installed, launched, no reported
  // error, no abort, not exited.
  run.phase = script ? 'checking the screen after the script' : 'checking the screen';
  const target = targetLevel(entry);
  const shot = await steadyShot(5, 1500);
  let counted = (await probe()).frames;
  let advancing = await framesSince(counted, 6000);
  let nudged = false;
  if (advancing < 1) {
    // The counter only moves when the game draws, and a screen that waits for
    // a key draws nothing. Move down and back up: a game that is alive redraws,
    // one that hangs does not.
    nudged = true;
    counted = (await probe()).frames;
    await press('down', 120);
    await pause(400);
    await press('up', 120);
    advancing = await framesSince(counted, 4000);
  }
  if (advancing > 0) watch.sawFrames = true;
  if (shot && !shot.blank) watch.sawPicture = true;
  run.frames = (await probe()).frames;
  run.checks = { framesAtEnd: advancing, nudged, screen: shot ? { colours: shot.colours, dominant: shot.dominant } : null };

  if (!watch.sawPicture || !watch.sawFrames) {
    run.reached = 'broken';
    run.error = !watch.sawPicture ? 'the game runs but its screen stayed blank (one colour)' : 'the game stopped drawing: no new frame, not even after a key';
    return;
  }
  run.reached = 'boots';
  if (rank(target) <= rank('boots')) return;

  if (advancing < 1 || !shot || shot.blank) {
    run.error = `expected ${target}: after the script ${advancing < 1 ? 'no new frame was drawn, not even after a key' : 'the screen is blank (one colour)'}`;
    return;
  }
  run.reached = target === 'ingame' ? 'menu' : target;
  if (target !== 'ingame') return;

  run.phase = 'checking that the picture changes';
  // After a nudge the screen may have moved on: compare against how it looks now.
  const changes = await pictureChanges(nudged ? (await guestShot(false)) || shot : shot, press);
  run.checks.changes = changes;
  if (changes) run.reached = 'ingame';
  else run.error = 'expected ingame: after the script the picture neither changed in 2 s nor after left, right, up or down';
}

try {
  await test();
} catch (error) {
  failed(error);
}
await finish();
