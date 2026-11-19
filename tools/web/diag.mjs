// Plays a game in a browser under a chosen condition and keeps what the
// player's diagnostics say about it: the tool for reproducing "the game runs
// badly on my machine" on this one, and the test of the diagnostics themselves.
//
//   node tools/web/diag.mjs --game <slug> --out <dir> [options]
//
//   --game SLUG        catalog/games/<SLUG>.json and <assets>/games/<SLUG>.zip
//   --out DIR          where the results are written (see below)
//   --browser NAME     chrome (default): the toolchain's Chrome on this
//                      machine's GPU; chrome-software: Playwright's Chromium
//                      drawing on the processor, as a machine without a GPU does
//   --seconds N        how long the game is played before the report is read
//                      (default 30; the diagnostics measure over 30 seconds)
//   --keys a,b         N-Gage keys held in turn, a second each, while it is
//                      played, so that the game keeps drawing (default: left)
//   --idle             press nothing while it is played
//   --stretch F        make every wait of the key script F times as long, for
//                      a machine too busy to keep up with it (look at
//                      page.png: it must show the game in play)
//   --cpu PERCENT      give the whole browser at most PERCENT of one processor
//                      core (a cgroup quota, set with systemd-run --user): a
//                      slow device. The emulator needs about one core, so 50
//                      is a device half as fast as it needs
//   --cores N          let the browser use only N processor cores (taskset)
//   --throttle N       slow the page's own thread down N times (Chrome's CPU
//                      throttling, which does not reach workers, so it does
//                      not slow the emulator: for a page that stalls)
//   --hidden           put the page in the background while it is played, as
//                      when the visitor looks at another tab. Headless Chrome
//                      keeps every page visible and drawn, so there the page
//                      is told it is hidden and the emulator's test switch
//                      takes its animation frames away, which is what a
//                      browser does to a hidden page
//   --query STRING     more page parameters, e.g. "diag=1&log=*:info"
//   --hook FILE        a module whose default export is called once the game
//                      is in play and before it is measured, with { page,
//                      press, sleep, evaluate }: for conditions this tool has
//                      no option for
//   --expect a,b       finding codes the report must have
//   --absent a,b       finding codes the report must not have
//   --port N           port for the dev server this tool starts (default: a free one)
//   --bin DIR          web build to use (default: eka2l1/build/web/bin of this
//                      checkout, else of $ARCADE_MAIN)
//   --shell DIR        page sources laid over that build (devserver.py --shell)
//   --assets DIR       folder with NGAGE.ROM and games/<slug>.zip (default:
//                      testdata/ of this checkout, else of $ARCADE_MAIN)
//   --verbose          print the page console while it runs
//
// The game is brought into play with the key script of its catalogue entry
// (test.script), as the per-game test does; a game without one is measured
// where it starts.
//
// Written to --out:
//   report.json   the diagnostics report (the player's "Download report")
//   report.txt    the same as the player copies it to the clipboard
//   dialog.png    the Diagnostics dialog as the visitor sees it
//   page.png      the page before the dialog was opened
//   console.log   the page console
//   result.json   { pass, game, browser, version, condition, seconds,
//                   findings: [codes], missing: [codes], unwanted: [codes], error }
//
// Exit code 0 when the report was read and --expect and --absent hold, 1 when
// not, 2 when the command line is wrong. Frame rates measured while other
// heavy programs run say little; provoke a condition with a wide margin.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkScript, stepTiming } from './gamecheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPTIONS = {
  game: 'value', out: 'value', browser: 'value', seconds: 'value', keys: 'value', idle: 'flag', throttle: 'value', cpu: 'value', cores: 'value', stretch: 'value',
  hidden: 'flag', query: 'value', hook: 'value', expect: 'value', absent: 'value', port: 'value', bin: 'value', shell: 'value',
  assets: 'value', verbose: 'flag',
};

function usage(message) {
  console.error(`${message}\nusage: node tools/web/diag.mjs --game <slug> --out <dir> [--browser chrome|chrome-software] [--seconds N] [--keys a,b | --idle] [--stretch F]`
    + ' [--cpu PERCENT] [--cores N] [--throttle N] [--hidden] [--query STRING] [--hook FILE] [--expect a,b] [--absent a,b] [--port N] [--bin DIR] [--shell DIR] [--assets DIR] [--verbose]');
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
if (!args.game) usage('--game is required');
if (!/^[a-z0-9-]+$/.test(args.game)) usage(`not a game name: ${args.game}`);
if (args.browser && !['chrome', 'chrome-software'].includes(args.browser)) usage(`unknown browser: ${args.browser}`);
for (const name of ['seconds', 'throttle', 'cpu', 'cores', 'port', 'stretch']) {
  if (args[name] !== undefined && !(Number(args[name]) > 0)) usage(`--${name} must be a positive number`);
}
const list = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []);
const CODE = /^[a-z]+(-[a-z]+)*$/;
for (const code of [...list(args.expect), ...list(args.absent)]) {
  if (!CODE.test(code)) usage(`not a finding code: ${code}`);
}

const MAIN = process.env.ARCADE_MAIN || ROOT;
const firstWith = (file, ...folders) => folders.find((folder) => fs.existsSync(path.join(folder, file))) || folders[0];
const binDir = path.resolve(args.bin || firstWith('eka2l1_web.wasm', path.join(ROOT, 'eka2l1', 'build', 'web', 'bin'), path.join(MAIN, 'eka2l1', 'build', 'web', 'bin')));
const assetsDir = path.resolve(args.assets || firstWith('NGAGE.ROM', path.join(ROOT, 'testdata'), path.join(MAIN, 'testdata')));
const outDir = path.resolve(args.out);
const browserName = args.browser || 'chrome';
const seconds = Number(args.seconds || 30);
const keys = args.idle ? [] : list(args.keys || 'left');
const stretch = Number(args.stretch || 1);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (error) => String(error && error.message ? error.message : error).split('\n')[0];
const withTimeout = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${what} took longer than ${Math.round(ms / 1000)} s`); })]);

const ANSWER_MS = 30000;
const consoleLines = [];
const result = {
  pass: false,
  game: args.game,
  browser: browserName,
  version: null,
  condition: {
    cpu: args.cpu ? Number(args.cpu) : null,
    throttle: args.throttle ? Number(args.throttle) : 1,
    cores: args.cores ? Number(args.cores) : null,
    hidden: Boolean(args.hidden),
    keys,
    query: args.query || '',
    hook: args.hook ? path.resolve(args.hook) : null,
  },
  seconds,
  findings: [],
  missing: [],
  unwanted: [],
  error: null,
};
let phase = 'starting';
let browser = null;
let server = null;
let finished = false;

async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) result.error = `${firstLine(error)} (while ${phase})`;
  result.pass = !result.error && !result.missing.length && !result.unwanted.length;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'console.log'), consoleLines.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  } catch (writeError) {
    console.error(`could not write to ${outDir}: ${writeError.message}`);
    result.pass = false;
  }
  const found = result.findings.length ? result.findings.join(', ') : 'no findings';
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${args.game}  ${found}`
    + (result.missing.length ? `  MISSING ${result.missing.join(', ')}` : '')
    + (result.unwanted.length ? `  UNWANTED ${result.unwanted.join(', ')}` : '')
    + (result.error ? `  ${result.error}` : ''));
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
  if (server) server.kill('SIGKILL');
  process.exit(result.pass ? 0 : 1);
}

process.on('exit', () => { if (server) server.kill('SIGKILL'); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => finish(new Error(`interrupted by ${signal}`)));

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

// Starts tools/web/devserver.py and resolves to its port once it says it serves
// (an answer on the port could come from someone else's server).
async function startServer() {
  for (let attempt = 1; ; attempt++) {
    const port = args.port ? Number(args.port) : await freePort();
    const options = ['--bin', binDir, '--assets', assetsDir, ...(args.shell ? ['--shell', path.resolve(args.shell)] : [])];
    const child = spawn('python3', ['-I', path.join(ROOT, 'tools', 'web', 'devserver.py'), ...options, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let exited = false;
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-2000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-2000); });
    child.on('error', (error) => { exited = true; output += String(error.message); });
    child.on('exit', () => { exited = true; });
    server = child;
    const until = Date.now() + 30000;
    while (Date.now() < until && !exited && !/^serving /m.test(output)) await sleep(50);
    if (!exited && /^serving /m.test(output)) return port;
    child.kill('SIGKILL');
    server = null;
    if (args.port || attempt >= 3) throw new Error(`the dev server did not start on port ${port}: ${output.trim().split('\n').pop() || 'it said nothing'}`);
  }
}

function toolchainChrome() {
  const root = path.join(process.env.EKA2L1_TOOLCHAIN || '', 'chrome', 'chrome');
  const versions = process.env.EKA2L1_TOOLCHAIN && fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const chrome = versions.length ? path.join(root, versions.pop(), 'chrome-linux64', 'chrome') : null;
  if (!chrome || !fs.existsSync(chrome)) throw new Error('the toolchain has no Chrome (source tools/env.sh, or use --browser chrome-software)');
  return chrome;
}

// --cpu and --cores: the browser is started through a script that puts it,
// and with it every process and thread it starts, under a processor quota
// and on the first N cores.
function limited(executable) {
  if (!args.cpu && !args.cores) return executable;
  fs.mkdirSync(outDir, { recursive: true });
  const wrapper = path.join(outDir, 'browser-limited.sh');
  const quota = args.cpu ? `systemd-run --user --scope -q -p CPUQuota=${Number(args.cpu)}% -- ` : '';
  const pin = args.cores ? `taskset -c 0-${Number(args.cores) - 1} ` : '';
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quota}${pin}'${executable.replace(/'/g, `'\\''`)}' "$@"\n`, { mode: 0o755 });
  return wrapper;
}

const LAUNCH = { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
const BROWSERS = {
  chrome: () => chromium.launch({ ...LAUNCH, executablePath: limited(toolchainChrome()), args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] }),
  'chrome-software': () => chromium.launch({ ...LAUNCH, executablePath: limited(chromium.executablePath()), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }),
};

// --throttle: Chrome's CPU throttling. It slows the thread of the page only:
// asked of a worker, Chrome answers "only supported for pages".
async function throttle(page, rate) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}

// --hidden where the browser does not hide the page: runs in the page. What a
// hidden page sees (the document says so, a visibilitychange event) and what
// its emulator gets (no animation frames).
function pretendHidden(hidden) {
  if (hidden) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  } else {
    delete document.visibilityState;
    delete document.hidden;
  }
  const module = window.eka2l1 && window.eka2l1.module;
  if (module && module._eka2l1_web_debug_animation_frames) module._eka2l1_web_debug_animation_frames(hidden ? 1 : 0);
  document.dispatchEvent(new Event('visibilitychange'));
}

// --- the run ---------------------------------------------------------------------

async function main() {
  const entryFile = path.join(ROOT, 'catalog', 'games', `${args.game}.json`);
  const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
  const script = entry.test ? entry.test.script : null;
  const allKeys = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'schema.json'), 'utf8')).$defs.key.enum;
  if (script) checkScript(script, allKeys);
  for (const key of keys) {
    if (!allKeys.includes(key)) usage(`not an N-Gage key: ${key}`);
  }
  const hook = args.hook ? (await import(pathToFileURL(path.resolve(args.hook)).href)).default : null;
  if (args.hook && typeof hook !== 'function') usage(`${args.hook} has no default export to call`);
  const startTimeout = entry.test && entry.test.timeoutMs > 0 ? entry.test.timeoutMs : 90000;

  for (const [file, hint] of [[path.join(binDir, 'eka2l1_web.wasm'), 'build it with tools/ci/build-web.sh or pass --bin'],
    [path.join(assetsDir, 'NGAGE.ROM'), 'pass --assets'], [path.join(assetsDir, 'games', `${args.game}.zip`), 'pass --assets']]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}: ${hint}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // Never leave an older run's files beside this result.
  for (const name of ['report.json', 'report.txt', 'dialog.png', 'page.png']) fs.rmSync(path.join(outDir, name), { force: true });

  phase = 'starting the dev server';
  const port = await startServer();

  phase = 'starting the browser';
  browser = await withTimeout(BROWSERS[browserName](), 60000, 'browser launch');
  result.version = browser.version();
  browser.on('disconnected', () => finish(new Error('the browser went away')));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
  page.on('console', (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    consoleLines.push(line);
    if (args.verbose) console.log(`  ${line.slice(0, 400)}`);
  });
  page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));
  page.on('crash', () => finish(new Error("the page's process died")));

  const evaluate = (fn, arg, what = 'the page') => withTimeout(page.evaluate(fn, arg), ANSWER_MS, what);

  phase = 'loading the player';
  const query = args.query ? `&${args.query.replace(/^[?&]/, '')}` : '';
  const response = await page.goto(`http://127.0.0.1:${port}/?fw=/local/NGAGE.ROM&game=/local/games/${args.game}.zip&persist=0${query}`, { timeout: 60000 });
  if (!response || !response.ok()) throw new Error(`the player page did not load (HTTP ${response ? response.status() : 'no response'})`);

  phase = 'starting the game';
  const until = Date.now() + startTimeout;
  for (;;) {
    const state = await evaluate(() => {
      const p = window.eka2l1Page;
      const status = document.getElementById('status');
      return { app: Boolean(p && p.app), frames: p && p.emu && p.emu.module ? p.emu.frames() : 0, error: status && status.classList.contains('error') ? status.textContent : null };
    });
    if (state.error) throw new Error(`the page reported: ${state.error}`);
    if (state.app && state.frames > 0) break;
    if (Date.now() > until) throw new Error(`the game did not start within ${Math.round(startTimeout / 1000)} s`);
    await sleep(500);
  }
  if (!await evaluate(() => Boolean(window.eka2l1Page.diag && window.eka2l1Page.diag.report))) throw new Error('this player has no diagnostics (eka2l1Page.diag)');

  const codes = await evaluate(async () => (await import('./eka2l1-client.js')).KEYS, null, 'key table');
  const press = async (key, hold) => {
    await evaluate(([code]) => window.eka2l1.key(code, true), [codes[key]], 'key down');
    await sleep(hold);
    await evaluate(([code]) => window.eka2l1.key(code, false), [codes[key]], 'key up');
  };

  if (script) {
    for (const [index, raw] of script.entries()) {
      const step = stepTiming(raw);
      phase = `replaying script step ${index + 1} of ${script.length}`;
      for (let i = 0; i < step.repeat; i++) {
        if (step.key) await press(step.key, step.hold);
        await sleep(step.wait * stretch);
      }
    }
  }

  // Sound needs a gesture of the visitor's; a click on the picture is one.
  phase = 'switching sound on';
  await page.mouse.click(640, 300).catch(() => {});

  if (hook) {
    phase = 'running the hook';
    await hook({ page, press, sleep, evaluate });
  }
  if (args.throttle) {
    phase = 'throttling';
    await throttle(page, Number(args.throttle));
  }
  let other = null;
  let pretended = false;
  if (args.hidden) {
    phase = 'hiding the page';
    other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await sleep(500);
    pretended = await evaluate(() => document.visibilityState === 'visible');
    if (pretended) await evaluate(pretendHidden, true);
  }

  phase = 'playing';
  const end = Date.now() + seconds * 1000;
  for (let turn = 0; Date.now() < end; turn++) {
    if (keys.length) await press(keys[turn % keys.length], Math.min(1000, Math.max(100, end - Date.now())));
    else await sleep(Math.min(1000, Math.max(100, end - Date.now())));
  }

  phase = 'reading the report';
  const { report, text } = await evaluate(async () => {
    const made = await window.eka2l1Page.diag.report();
    const { formatText } = await import('./diag/report.js');
    return { report: made, text: formatText(made) };
  }, null, 'the report');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'report.txt'), text.endsWith('\n') ? text : `${text}\n`);
  result.findings = (report.findings || []).map((finding) => finding.code);
  result.missing = list(args.expect).filter((code) => !result.findings.includes(code));
  result.unwanted = list(args.absent).filter((code) => result.findings.includes(code));

  phase = 'taking the pictures';
  if (other) {
    if (pretended) await evaluate(pretendHidden, false);
    await page.bringToFront();
    await other.close();
  }
  await page.screenshot({ path: path.join(outDir, 'page.png'), timeout: 20000 }).catch((error) => consoleLines.push(`[tool] no page.png: ${firstLine(error)}`));
  await evaluate(() => window.eka2l1Page.diag.open(), null, 'the dialog');
  await sleep(1200); // one refresh
  // The dialog scrolls; the picture shows all of it.
  const height = await evaluate(() => {
    const dialog = document.getElementById('info');
    dialog.style.maxHeight = 'none';
    dialog.style.margin = '8px auto';
    return dialog.scrollHeight;
  });
  await page.setViewportSize({ width: 1280, height: Math.min(6000, Math.max(800, height + 60)) });
  await page.locator('#info').screenshot({ path: path.join(outDir, 'dialog.png'), timeout: 20000 }).catch((error) => consoleLines.push(`[tool] no dialog.png: ${firstLine(error)}`));
}

main().then(() => finish(), (error) => finish(error));
