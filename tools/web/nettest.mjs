// Multiplayer test of the player: the emulated Bluetooth between two pages.
//
//   node tools/web/nettest.mjs --out <dir> [options]
//
// Two pages of one headless browser each run an emulator, and this script is
// the relay between them: it takes every frame one emulator hands its page
// (Module.eka2l1OnNetSend) and gives it to the other
// (_eka2l1_web_net_receive), in order, and tells both that the link is up and
// who is in the room (_eka2l1_web_net_link, _eka2l1_web_net_peer). No relay
// server and none of the page's own multiplayer code is involved, so this
// tests the emulator's side alone: the exports, the Bluetooth sockets, device
// inquiry and service discovery. What each emulator makes of it is read from
// the control API, GET /v1/net.
//
// Tiers:
//   0  Two linked emulators learn each other's Bluetooth address and name, and
//      again after one's link went down and came back, after the page's
//      Restart on one of them, and when a guest starts long after the others
//      announced themselves. Needs no game knowledge: any game that starts
//      will do.
//   1  One page, not linked: Barakel started with Multiplayer:Yes, and Rayman 3
//      with "Host Game" chosen, listen on an RFCOMM channel (the emulator's
//      log of guest operations shows it), keep drawing, raise no error in the
//      page and start no link thread. Before Bluetooth worked without a link
//      the first stopped the emulator ("RuntimeError: null function") and the
//      second panicked, because the phone's Bluetooth switch read as off.
//   2  One game hosted on page A and joined on page B by key scripts (see
//      SESSIONS below): the host listens on a port that is not service
//      discovery (L2CAP port 1), both sides hold open connections, and with
//      both guests paused the bytes one end sent on each are the bytes the
//      other end received; no sequence error and no malformed frame was
//      counted; and when A is told that B left, A's connections close with
//      KErrDisconnected (-36) while its game keeps drawing. Guest screenshots
//      of both pages are written (tier2-a.png, tier2-b.png, and
//      tier2-a-after.png once B has left): look at them, the counters cannot
//      tell a match from an error message.
//   3  Tier 2 again, but nothing is done by this script: page A hosts a room
//      in the player's own Multiplayer dialog, page B opens the invite link
//      (room=CODE), and the frames cross the room relay of the dev server
//      (/net/). This is the whole path a visitor's game takes, short of the
//      deployed relay. B leaves by closing its tab. Screenshots are
//      tier3-a.png, tier3-b.png and tier3-a-after.png. Needs a player with
//      the Multiplayer dialog and a dev server with the relay.
//
//   --out DIR          results: nettest.json, the pages' consoles, screenshots
//   --tier LIST        which tiers to run, e.g. 0 or 0,2 (default: 0,1,2,3)
//   --game SLUG        the game for tiers 0, 2 and 3 (default: rayman-3); tiers
//                      2 and 3 need an entry in SESSIONS
//   --browser NAME     chrome-software (default, Playwright's Chromium drawing
//                      on the CPU) or chrome (the toolchain's Chrome on the GPU)
//   --port N           port for the dev server this tool starts (default: a free one)
//   --bin DIR          web build to test (default: eka2l1/build/web/bin of this
//                      checkout, else of $ARCADE_MAIN)
//   --assets DIR       folder with NGAGE.ROM and games/<slug>.zip (default:
//                      testdata/ of this checkout, else of $ARCADE_MAIN)
//   --time-limit SEC   give up after this long (default 2400)
//   --log FILTER       the emulator's log filter (default *:warn), e.g. "*:info";
//                      the log is part of each page's console
//   --verbose          print the pages' consoles while it runs
//
// To work out a key script, or to look at what two linked games do, run it as
// a server instead of a test:
//
//   --serve PORT       start the pages, link them, then take commands over
//                      HTTP on 127.0.0.1:PORT until /quit
//   --pages 1          with --serve: one page only
//   --unlinked         with --serve: do not bring the link up
//
//   curl 'http://127.0.0.1:PORT/key?page=a&name=ok&hold=200&wait=1000'
//   curl 'http://127.0.0.1:PORT/shot?page=b&name=lobby'     guest screenshot -> DIR/lobby.png
//   curl 'http://127.0.0.1:PORT/net?page=a'                 GET /v1/net of that emulator
//   curl 'http://127.0.0.1:PORT/frames?page=a&ms=2000'      frames presented in that time
//   curl 'http://127.0.0.1:PORT/link'  /unlink              bring the link up or down on both
//   curl 'http://127.0.0.1:PORT/leave?page=a'               tell page a that the other left
//   curl 'http://127.0.0.1:PORT/restart?page=a'             the page's own Restart
//   curl 'http://127.0.0.1:PORT/console?page=a'             the last lines of its console
//   curl 'http://127.0.0.1:PORT/api?page=a&method=GET&target=/v1/session'   a control API call
//   curl 'http://127.0.0.1:PORT/quit'
//
// Exit code 0 when every tier that ran passed, 1 when one failed, 2 when the
// command line is wrong. A test run always ends: every wait has a limit, and
// the browser and the dev server are stopped. A server run ends with /quit.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPTIONS = { out: 'value', tier: 'value', game: 'value', browser: 'value', port: 'value', bin: 'value', assets: 'value',
  'time-limit': 'value', serve: 'value', pages: 'value', unlinked: 'flag', log: 'value', verbose: 'flag' };

function usage(message) {
  console.error(`${message}\nusage: node tools/web/nettest.mjs --out <dir> [--tier 0,1,2,3] [--game SLUG] [--browser chrome-software|chrome] [--port N] [--bin DIR] [--assets DIR] [--time-limit SEC] [--log FILTER] [--verbose] [--serve PORT [--pages 1] [--unlinked]]`);
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
if (args.browser && !['chrome-software', 'chrome'].includes(args.browser)) usage(`unknown browser: ${args.browser}`);
for (const name of ['port', 'time-limit', 'serve']) {
  if (args[name] !== undefined && !(Number(args[name]) > 0)) usage(`--${name} must be a positive number`);
}
if (args.pages !== undefined && !['1', '2'].includes(args.pages)) usage('--pages must be 1 or 2');
const tiers = String(args.tier === undefined ? '0,1,2,3' : args.tier).split(',').map((text) => text.trim());
if (!tiers.length || tiers.some((tier) => !['0', '1', '2', '3'].includes(tier))) usage(`--tier takes 0, 1, 2 and 3: ${args.tier}`);
const game = args.game || 'rayman-3';
// The name becomes part of file names and of a URL.
if (!/^[a-z0-9-]+$/.test(game)) usage(`not a game name: ${game}`);

// Set by tools/env.sh. A worktree has neither the web build nor testdata/; the
// main checkout does.
const MAIN = process.env.ARCADE_MAIN || ROOT;
const firstWith = (file, ...folders) => folders.find((folder) => fs.existsSync(path.join(folder, file))) || folders[0];
const binDir = path.resolve(args.bin || firstWith('eka2l1_web.wasm', path.join(ROOT, 'eka2l1', 'build', 'web', 'bin'), path.join(MAIN, 'eka2l1', 'build', 'web', 'bin')));
const assetsDir = path.resolve(args.assets || firstWith('NGAGE.ROM', path.join(ROOT, 'testdata'), path.join(MAIN, 'testdata')));
const outDir = path.resolve(args.out);
const browserName = args.browser || 'chrome-software';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (error) => String(error && error.message ? error.message : error).split('\n')[0];

const START_MS = 150000; // a game from an empty page to its first frame
const ANSWER_MS = 30000; // one question to a page
const KERR_DISCONNECTED = -36;

// --- what the games need ---------------------------------------------------------
//
// Key scripts in the catalogue's form, { key, hold, wait, repeat }, with one
// addition: `until`, a test of the emulator's GET /v1/net that ends the
// repeats of a step as soon as it holds. A script starts once the game has
// drawn its first frame. Two emulators on a loaded machine run at half speed
// and lose a key press now and then, so the scripts avoid presses that do
// harm when one before them was lost, and each stage is checked in /v1/net
// before the next begins. A tier whose script missed is tried a second time
// with fresh pages.

const event = (op, protocol, result) => (state) => (state.events || []).some((e) => e.op === op && e.protocol === protocol && e.result === result);
// Port 1 of L2CAP is the phone's own service discovery server, not the game.
const gamePort = (entry) => !(entry.protocol === 'l2cap' && entry.port === 1);
const hosting = (state) => (state.listeners || []).some(gamePort);

// Rayman 3: any key ends the intro, the next opens the main menu. Back (7)
// is harmless there and returns to it from the screen after, with the cursor
// on the first entry: so two presses of each leave the menu in a known state
// whether the game was still in its intro or already on the title screen.
const RAYMAN_MENU = [
  { wait: 10000 },
  { key: '5', hold: 300, wait: 3000, repeat: 2 },
  { key: '7', hold: 300, wait: 2500, repeat: 2 },
  { key: 'down', hold: 300, wait: 2000 }, // Multiplayer
  { key: '5', hold: 300, wait: 3500 }, // -> Host Game / Join Game
];
const RAYMAN_HOST = [...RAYMAN_MENU, { key: '5', hold: 300, wait: 4000, repeat: 3, until: hosting }];

// Tier 1: with the link down, the game must survive its own Bluetooth calls.
// `expect` is the entry of /v1/net's events that shows the game got there.
const SOLO = {
  // The menu comes up with "Multiplayer:Yes". OK does nothing while the game
  // loads, then chooses Play and New Adventure, which is where it listens.
  barakel: {
    script: [{ wait: 5000 }, { key: 'ok', hold: 300, wait: 4000, repeat: 60, until: event('listen', 'rfcomm', 0) }],
    expect: event('listen', 'rfcomm', 0),
    what: 'a listen on an RFCOMM channel',
  },
  // "Host Game".
  'rayman-3': {
    script: RAYMAN_HOST,
    expect: event('listen', 'rfcomm', 0),
    what: 'a listen on an RFCOMM channel',
  },
};

// Tier 2. `host` is replayed on page A until it has a listener that is not
// service discovery; `join` on page B; `joined` is what A's /v1/net must then
// show; `start` is replayed on A until both hold an open connection; `play`,
// on A, only takes the two games further before the screenshots.
const SESSIONS = {
  // The joiner looks for devices, asks the host's service discovery for the
  // game's channel, connects and hangs up at once: that only tells the host
  // who it is. When the host starts, it connects back to the joiner on two
  // RFCOMM channels, one for each direction.
  'rayman-3': {
    host: RAYMAN_HOST,
    join: [
      ...RAYMAN_MENU,
      { key: 'down', hold: 300, wait: 2000 }, // Join Game
      { key: '5', hold: 300, wait: 4000, repeat: 3, until: (state) => state.totals.inquiries > 0 }, // "1 host(s) found"
      { wait: 4000 },
      { key: '5', hold: 300, wait: 4000, repeat: 4, until: event('connect', 'rfcomm', 0) }, // select the host
    ],
    joined: event('accept', 'rfcomm', 0),
    start: [{ wait: 3000 }, { key: '5', hold: 300, wait: 5000, repeat: 4, until: (state) => open(state).some(gamePort) }],
    // Capture the Flag, its settings, the arena: then the match begins.
    play: [{ wait: 3000 }, { key: '5', hold: 300, wait: 6000, repeat: 3 }, { wait: 8000 }],
  },
};

// --- the run ---------------------------------------------------------------------

const started = Date.now();
const results = [];
let browser = null;
let server = null;
let serverPort = 0;
let ended = false;

function withTimeout(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function end(code) {
  if (ended) return;
  ended = true;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'nettest.json'), JSON.stringify({
      pass: code === 0, seconds: Math.round((Date.now() - started) / 1000), browser: browserName,
      browserVersion: browser ? browser.version() : null, bin: binDir, tiers: results,
    }, null, 2) + '\n');
  } catch (error) {
    console.error(`could not write the result to ${outDir}: ${error.message}`);
    code = code || 1;
  }
  // Closing can hang when the browser is stuck; exiting kills what is left.
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
  if (server) server.kill('SIGKILL');
  process.exit(code);
}

process.on('exit', () => { if (server) server.kill('SIGKILL'); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { console.error(`interrupted by ${signal}`); end(1); });
}

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

// Starts tools/web/devserver.py and resolves to its port once it serves, the
// way gametest.mjs does.
async function startServer() {
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

    // "serving ..." is the server's own word that it has the port: an answer
    // on the port could come from somebody else's server, with another build.
    const until = Date.now() + 30000;
    while (Date.now() < until && !exited && !/^serving /m.test(output)) await sleep(50);
    if (!exited && /^serving /m.test(output)) return port;

    child.kill('SIGKILL');
    server = null;
    const reason = output.trim().split('\n').pop() || 'it said nothing';
    if (args.port || attempt >= 3) throw new Error(`the dev server did not start on port ${port}: ${reason}`);
  }
}

function toolchainChrome() {
  const root = path.join(process.env.EKA2L1_TOOLCHAIN || '', 'chrome', 'chrome');
  const versions = process.env.EKA2L1_TOOLCHAIN && fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const chrome = versions.length ? path.join(root, versions.pop(), 'chrome-linux64', 'chrome') : null;
  if (!chrome || !fs.existsSync(chrome)) throw new Error('the toolchain has no Chrome (source tools/env.sh, or use --browser chrome-software)');
  return chrome;
}

const LAUNCH = { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
const BROWSERS = {
  'chrome-software': () => chromium.launch({ ...LAUNCH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }),
  chrome: async () => chromium.launch({ ...LAUNCH, executablePath: toolchainChrome(), args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] }),
};

// --- one page with one emulator ----------------------------------------------------

class Player {
  constructor(label, id, name) {
    this.label = label; // 'a' or 'b', for file names and messages
    this.id = id; // its id in the room, as a relay would give it
    this.name = name; // the device name the other side's game shows
    this.context = null;
    this.page = null;
    this.console = [];
    this.errors = []; // uncaught errors in the page: any one fails the tier
    this.other = null;
    this.sent = 0; // frames the emulator handed its page
    this.muted = false; // the relay loses what this page sends
    this.chain = Promise.resolve(); // delivery of its frames to the other, in order
    this.codes = null;
    this.slug = null;
  }

  record(line) {
    if (args.verbose) console.log(`  ${this.label}: ${line.slice(0, 300)}`);
    this.console.push(line.length > 600 ? `${line.slice(0, 600)}…` : line);
    if (this.console.length > 2000) this.console.shift();
  }

  ask(fn, arg, what = 'the page') {
    return withTimeout(this.page.evaluate(fn, arg), ANSWER_MS, `${what} (page ${this.label})`);
  }

  // A fresh browser context per page, so that each is the visible tab of its
  // own window: the player pauses the emulator of a hidden tab.
  // `query` is added to the address; `settings` is what the page finds saved
  // from an earlier visit (the player's name in a room, for tier 3).
  async open(slug, query = '', settings = null) {
    this.slug = slug;
    this.context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    this.page = await this.context.newPage();
    this.page.on('console', (message) => this.record(`[${message.type()}] ${message.text()}`));
    this.page.on('pageerror', (error) => { this.record(`[pageerror] ${error.message}`); this.errors.push(firstLine(error)); });
    this.page.on('crash', () => { this.record('[crash]'); this.errors.push("the page's process died"); });

    // The page's end of the relay. Bytes cross to this script as base64.
    await this.page.exposeFunction('__nettestSend', (dst, base64) => {
      this.sent++;
      const other = this.other;
      if (!other || !other.page || this.muted || (dst !== 0 && dst !== other.id)) return;
      // One chain per direction: a frame is handed over only after the one
      // before it, whatever the browser does with two calls at once.
      this.chain = this.chain.then(() => other.receive(this.id, base64)).catch((error) => {
        other.record(`[nettest] could not deliver a frame: ${firstLine(error)}`);
      });
    });

    if (settings) {
      await this.page.addInitScript((saved) => {
        try { localStorage.setItem('eka2l1.settings.v1', JSON.stringify(saved)); } catch { /* the page then uses its defaults */ }
      }, settings);
    }
    const url = `http://127.0.0.1:${serverPort}/?fw=/local/NGAGE.ROM&game=/local/games/${slug}.zip&persist=0${args.log ? `&log=${encodeURIComponent(args.log)}` : ''}${query}`;
    const response = await this.page.goto(url, { timeout: 60000 });
    if (!response || !response.ok()) throw new Error(`page ${this.label} did not load (HTTP ${response ? response.status() : 'no response'})`);
  }

  // Resolves when the game has presented a frame. With `bridge` this script
  // becomes the page's relay; without, the page's own multiplayer code keeps
  // the emulator's frames.
  async running(timeoutMs = START_MS, bridge = true) {
    const opened = Date.now();
    for (;;) {
      const state = await this.ask(() => {
        const p = window.eka2l1Page || null;
        const status = document.getElementById('status');
        const up = Boolean(p && p.emu && p.emu.module);
        return { status: status ? status.textContent : '', error: Boolean(status && status.classList.contains('error')),
          app: p && p.app ? p.app.name : null, frames: up ? p.emu.frames() : -1 };
      }).catch(() => ({ status: '', error: false, app: null, frames: -1 }));
      if (state.error) throw new Error(`page ${this.label} reported: ${state.status}`);
      if (this.errors.length) throw new Error(`page ${this.label}: ${this.errors[0]}`);
      if (state.app && state.frames > 0) break;
      if (Date.now() - opened > timeoutMs) throw new Error(`${this.slug} did not start on page ${this.label} within ${Math.round(timeoutMs / 1000)} s (status: "${state.status}")`);
      await sleep(250);
    }
    this.codes = await this.ask(async () => (await import('./eka2l1-client.js')).KEYS, null, 'key table');

    // The emulator's frames for the other player leave through this callback.
    // The module is reached the way the page itself holds it; the page's own
    // sources are not involved.
    const supported = await this.ask((own) => {
      const module = window.eka2l1.module;
      if (typeof module._eka2l1_web_net_link !== 'function') return false;
      if (!own) return true;
      module.eka2l1OnNetSend = (dst, bytes) => {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        window.__nettestSend(dst, btoa(binary));
      };
      return true;
    }, bridge, 'installing the send callback');
    if (!supported) throw new Error('this build has no multiplayer exports (_eka2l1_web_net_link)');
  }

  receive(src, base64) {
    return this.ask(([from, text]) => {
      const module = window.eka2l1.module;
      const binary = atob(text);
      const at = module._malloc(binary.length);
      const heap = new Uint8Array(module.wasmMemory.buffer, at, binary.length);
      for (let i = 0; i < binary.length; i++) heap[i] = binary.charCodeAt(i);
      module._eka2l1_web_net_receive(from, at, binary.length);
      module._free(at);
    }, [src, base64], 'delivering a frame');
  }

  // The link comes up for this page, as member `id` under `name`; or down.
  link(up = true) {
    return this.ask(([id, name]) => {
      const module = window.eka2l1.module;
      const size = module.lengthBytesUTF8(name) + 1;
      const at = module._malloc(size);
      module.stringToUTF8(name, at, size);
      module._eka2l1_web_net_link(id, at);
      module._free(at);
    }, [up ? this.id : 0, this.name], 'link');
  }

  peer(id, present) {
    return this.ask(([peer, there]) => window.eka2l1.module._eka2l1_web_net_peer(peer, there ? 1 : 0), [id, present], 'peer');
  }

  async net() {
    const text = await this.ask(async () => {
      const response = await window.eka2l1.request('GET', '/v1/net');
      return response.status === 200 ? new TextDecoder().decode(response.body) : null;
    }, null, 'GET /v1/net');
    if (!text) throw new Error(`page ${this.label}: GET /v1/net failed (a build without multiplayer?)`);
    return JSON.parse(text);
  }

  frames() {
    return this.ask(() => window.eka2l1Page.emu.frames(), null, 'frames');
  }

  // Frames presented within `ms`.
  async framesIn(ms) {
    const first = await this.frames();
    await sleep(ms);
    return (await this.frames()) - first;
  }

  visible() {
    return this.ask(() => document.visibilityState, null, 'visibility');
  }

  async session() {
    return this.ask(async () => {
      const response = await window.eka2l1.request('GET', '/v1/session');
      return response.ok ? response.json() : null;
    }, null, 'GET /v1/session');
  }

  async press(key, hold = 200) {
    if (!(key in this.codes)) throw new Error(`no such key: ${key}`);
    await this.ask(([code]) => window.eka2l1.key(code, true), [this.codes[key]], 'key down');
    await sleep(hold);
    await this.ask(([code]) => window.eka2l1.key(code, false), [this.codes[key]], 'key up');
  }

  async play(script) {
    for (const step of script) {
      for (let i = 0; i < (step.repeat || 1); i++) {
        if (step.until && step.until(await this.net())) break;
        if (step.key) await this.press(step.key, step.hold || 200);
        await sleep(step.wait === undefined ? 1000 : step.wait);
        if (this.errors.length) throw new Error(`page ${this.label}: ${this.errors[0]}`);
      }
    }
  }

  // The page's own Restart: the guest is torn down and the game launched again.
  // Returns when the new guest has drawn; whether the game then carries on is
  // the game's affair (Rayman 3 does not: it stays on its loading picture
  // after a Restart, with or without multiplayer).
  async restart() {
    await withTimeout(this.page.evaluate(() => window.eka2l1Page.restart()), 120000, `restart (page ${this.label})`);
    const before = await this.frames();
    const deadline = Date.now() + START_MS;
    while ((await this.frames()) - before < 2) {
      if (Date.now() > deadline) throw new Error(`${this.slug} drew nothing after a restart on page ${this.label}`);
      await sleep(250);
    }
  }

  // Stops or resumes the guest. While it is stopped it sends nothing.
  emulator(verb) {
    return this.ask(async (what) => (await window.eka2l1.request('POST', `/v1/emulator/${what}`)).status, verb, verb);
  }

  // The emulator's own screenshot of the guest's screen.
  async shot(name) {
    const bytes = await this.ask(async () => {
      const response = await window.eka2l1.request('GET', '/v1/screenshot');
      return response.status === 200 ? Array.from(response.body) : null;
    }, null, 'screenshot');
    if (!bytes) return null;
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return file;
  }

  saveConsole(name) {
    fs.writeFileSync(path.join(outDir, `${name}.log`), this.console.join('\n') + '\n');
  }

  async close() {
    if (this.context) await Promise.race([this.context.close().catch(() => {}), sleep(5000)]);
    this.context = null;
    this.page = null;
  }
}

// Two pages with the same game, each the other's relay.
async function pair(slug) {
  const a = new Player('a', 1, 'Ann');
  const b = new Player('b', 2, 'Bo');
  a.other = b;
  b.other = a;
  // One after the other: two emulators starting at once take longer than twice one.
  try {
    await a.open(slug);
    await a.running();
    await b.open(slug);
    await b.running();
  } catch (error) {
    // Nobody else knows these pages: an emulator left running would slow the next tier.
    await a.close();
    await b.close();
    throw error;
  }
  return [a, b];
}

// Two pages with the same game in one room of the dev server's relay, by the
// player's own means: A hosts in the Multiplayer dialog, B opens the invite link.
async function pairThroughPage(slug) {
  const health = await fetch(`http://127.0.0.1:${serverPort}/net/health`).then((response) => response.ok, () => false);
  if (!health) throw new Error('the dev server has no room relay at /net/ (tools/web/relay.py)');
  const a = new Player('a', 1, 'Ann');
  const b = new Player('b', 2, 'Bo');
  a.other = b;
  b.other = a;
  try {
    await a.open(slug, '', { multiplayer: { name: a.name } });
    await a.running(START_MS, false);
    if (!(await a.ask(() => Boolean(document.getElementById('m-multiplayer') && document.getElementById('mp-host'))))) throw new Error('this player has no Multiplayer dialog');
    await a.page.click('#btn-menu', { timeout: 10000 });
    await a.page.click('#m-multiplayer', { timeout: 10000 });
    await a.page.click('#mp-host', { timeout: 10000 });
    const code = await until(() => a.ask(() => document.getElementById('mp-room-code').textContent.trim()), (text) => /^[A-Z2-9]{6}$/.test(text), 20000, 200);
    if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error(`hosting gave no room code (the dialog says: "${await a.ask(() => document.getElementById('mp-notice').textContent.trim())}")`);
    a.room = code;
    a.invite = await a.ask(() => document.getElementById('mp-link').value);
    await a.page.screenshot({ path: path.join(outDir, 'tier3-dialog.png') });
    await a.ask(() => document.getElementById('multiplayer').close());

    await b.open(slug, `&room=${code}`, { multiplayer: { name: b.name } });
    await b.running(START_MS, false);
  } catch (error) {
    await a.close();
    await b.close();
    throw error;
  }
  return [a, b];
}

async function linkUp(a, b) {
  await a.link(true);
  await b.link(true);
  await a.peer(b.id, true);
  await b.peer(a.id, true);
}

// Polls `read` until `ok(value)` or the time is up; returns the last value.
async function until(read, ok, ms, gap = 500) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(gap);
    value = await read();
  }
  return value;
}

const open = (state) => (state.connections || []).filter((conn) => conn.state === 'open');

// --- the tiers ---------------------------------------------------------------------

// Each returns { pass, detail, ... }; throwing fails the tier with the message.
// A Miss is a key script that did not get the game where it should be, which
// on a loaded machine can be a lost key press: such a tier is run once more.
class Miss extends Error {}

const names = (events) => JSON.stringify((events || []).map((e) => `${e.op}${e.protocol ? ` ${e.protocol} ${e.port}` : ''} ${e.result}`));
const pageErrors = (...players) => players.flatMap((player) => [...player.errors, ...(player.console.some((line) => /RuntimeError/.test(line)) ? ['RuntimeError in the console'] : [])]);

async function tier0() {
  const [a, b] = await pair(game);
  try {
    const visible = [await a.visible(), await b.visible()];
    if (visible.some((state) => state !== 'visible')) throw new Error(`a page is not visible (${visible.join(', ')}): its emulator would be paused`);

    const before = [await a.net(), await b.net()];
    if (before.some((state) => state.link.up || state.link.thread)) throw new Error('an emulator that was never linked has a link, or a thread for one');

    await linkUp(a, b);
    const knows = (state, other) => (state.peers || []).some((peer) => peer.id === other.id && peer.address && peer.name === other.name);
    const has = (state, other, address) => (state.peers || []).some((peer) => peer.id === other.id && peer.address === address && peer.name === other.name);
    const na = await until(() => a.net(), (state) => knows(state, b), 15000);
    const nb = await until(() => b.net(), (state) => knows(state, a), 15000);

    const problems = [];
    if (!knows(na, b)) problems.push(`A does not know B: ${JSON.stringify(na.peers)}`);
    if (!knows(nb, a)) problems.push(`B does not know A: ${JSON.stringify(nb.peers)}`);
    if (!na.link.up || na.link.self !== a.id || !nb.link.up || nb.link.self !== b.id) problems.push('a link is not up under its own id');
    if (!has(na, b, nb.address)) problems.push(`A does not have ${nb.address} for B: ${JSON.stringify(na.peers)}`);
    if (!has(nb, a, na.address)) problems.push(`B does not have ${na.address} for A: ${JSON.stringify(nb.peers)}`);
    if (na.address === nb.address) problems.push('both emulators have the same Bluetooth address');

    // The link goes down and comes up again under the same guest, as when the
    // page loses its relay for a moment: A forgot the room and must learn it again.
    await a.link(false);
    const down = await until(() => a.net(), (state) => !state.link.up && !(state.peers || []).length, 10000);
    if (down.link.up || (down.peers || []).length) problems.push('A kept its room after the link went down');
    await a.link(true);
    await a.peer(b.id, true);
    const ua = await until(() => a.net(), (state) => has(state, b, nb.address), 15000);
    const ub = await until(() => b.net(), (state) => has(state, a, na.address), 15000);
    if (!has(ua, b, nb.address)) problems.push(`after its link came back A does not know B: ${JSON.stringify(ua.peers)}`);
    if (!has(ub, a, na.address)) problems.push(`after A's link came back B does not know A: ${JSON.stringify(ub.peers)}`);

    // The page's Restart builds a new guest, with a new Bluetooth device, while
    // the link stays up: both must find each other again.
    await a.restart();
    const ra = await until(() => a.net(), (state) => state.attached && state.address !== na.address && has(state, b, nb.address), 20000);
    const rb = await until(() => b.net(), (state) => has(state, a, ra.address), 20000);
    if (!ra.link.up || !ra.attached) problems.push('A lost the link over a restart');
    if (ra.address === na.address) problems.push('A kept its Bluetooth address over a restart');
    if (!has(ra, b, nb.address)) problems.push(`after its restart A does not know B: ${JSON.stringify(ra.peers)}`);
    if (!has(rb, a, ra.address)) problems.push(`after A's restart B does not have A's new address ${ra.address}: ${JSON.stringify(rb.peers)}`);

    // A guest that starts when the others announced themselves long ago, with
    // nobody there to hear it: the relay loses everything while the link
    // comes up, then works, and A starts over. A's announcement must be
    // answered although B said who it was before.
    await a.link(false);
    await b.link(false);
    a.muted = true;
    b.muted = true;
    await linkUp(a, b);
    await sleep(1500);
    await a.chain;
    await b.chain;
    const deaf = [await a.net(), await b.net()];
    if (deaf.some((state) => (state.peers || []).some((peer) => peer.address))) problems.push('an emulator learned an address through a relay that delivered nothing');
    a.muted = false;
    b.muted = false;
    await a.restart();
    const la = await until(() => a.net(), (state) => state.attached && has(state, b, nb.address), 20000);
    const lb = await until(() => b.net(), (state) => has(state, a, la.address), 20000);
    if (!has(la, b, nb.address)) problems.push(`a guest that started late does not learn who is there: ${JSON.stringify(la.peers)}`);
    if (!has(lb, a, la.address)) problems.push(`a guest that started late is not known to the others: ${JSON.stringify(lb.peers)}`);

    for (const [label, state] of [['A', la], ['B', lb]]) {
      if (state.totals.badFrames) problems.push(`${label} counted ${state.totals.badFrames} malformed frames`);
    }
    a.saveConsole('tier0-a');
    b.saveConsole('tier0-b');
    problems.push(...pageErrors(a, b).map((error) => `page error: ${error}`));

    return { pass: !problems.length, detail: problems.join('; ') || `A ${na.address} "${a.name}" and B ${nb.address} "${b.name}" know each other; again after A's link came back, after A restarted (as ${ra.address}) and after it started late (as ${la.address})`,
      a: { address: la.address, peers: la.peers, totals: la.totals }, b: { address: lb.address, peers: lb.peers, totals: lb.totals }, relayed: a.sent + b.sent };
  } finally {
    await a.close();
    await b.close();
  }
}

async function solo(slug) {
  const plan = SOLO[slug];
  const player = new Player(slug, 1, 'Ann');
  try {
    await player.open(slug);
    await player.running();
    await player.play(plan.script);

    // The game called Bluetooth, and is still there some time later.
    const state = await until(() => player.net(), plan.expect, 15000);
    const found = plan.expect(state);
    if (!found && !pageErrors(player).length) {
      await player.shot(`tier1-${slug}`);
      player.saveConsole(`tier1-${slug}`);
      throw new Miss(`${slug}: the script did not get the game to its Bluetooth call (${plan.what}); events ${names(state.events)}`);
    }
    await sleep(8000);
    const frames = await player.framesIn(5000);
    const session = await player.session();
    const after = await player.net();
    await player.shot(`tier1-${slug}`);
    player.saveConsole(`tier1-${slug}`);

    const problems = [];
    if (!found) problems.push(`no Bluetooth operation in the events (${plan.what}): ${names(state.events)}`);
    if (frames < 2) problems.push(`the game stopped drawing (${frames} frames in 5 s)`);
    if (session && session.state && session.state !== 'running') problems.push(`the game is ${session.state}${session.lastExit && session.lastExit.fatal ? ` (${session.lastExit.fatal})` : ''}`);
    problems.push(...pageErrors(player).map((error) => `page error: ${error}`));
    if (after.link.thread) problems.push('an unlinked emulator started the link thread');

    const listening = (after.listeners || []).map((entry) => `${entry.protocol} ${entry.port}`).join(', ');
    return { pass: !problems.length, slug, frames, listeners: after.listeners, events: after.events,
      detail: `${slug}: ${problems.join('; ') || `listens on ${listening}; ${frames} frames in 5 s, no link thread`}` };
  } finally {
    await player.close();
  }
}

async function tier1() {
  const parts = [];
  for (const slug of Object.keys(SOLO)) {
    // One emulator at a time.
    let part;
    for (let attempt = 1; attempt <= 2; attempt++) {
      part = await solo(slug).catch((error) => ({ pass: false, slug, miss: error instanceof Miss, detail: firstLine(error).startsWith(slug) ? firstLine(error) : `${slug}: ${firstLine(error)}` }));
      part.attempts = attempt;
      if (!part.miss) break;
    }
    parts.push(part);
  }
  return { pass: parts.every((part) => part.pass), detail: parts.map((part) => part.detail).join(' | '), games: parts };
}

// `throughPage`: tier 3, where the page and the dev server's relay do what
// this script does in tier 2.
async function tier2(throughPage = false) {
  const plan = SESSIONS[game];
  if (!plan) throw new Error(`no host and join scripts for ${game} in SESSIONS (tools/web/nettest.mjs)`);
  const tier = throughPage ? 'tier3' : 'tier2';

  const [a, b] = throughPage ? await pairThroughPage(game) : await pair(game);
  const stuck = async (what, state) => {
    await a.shot(`${tier}-a`);
    await b.shot(`${tier}-b`);
    a.saveConsole(`${tier}-a`);
    b.saveConsole(`${tier}-b`);
    const error = pageErrors(a, b)[0];
    return error ? new Error(`${what}: ${error}`) : new Miss(`${what}; events ${names(state.events)} (see ${tier}-a.png and ${tier}-b.png)`);
  };
  try {
    if (!throughPage) await linkUp(a, b);
    const met = (state) => state.link.up && (state.peers || []).some((peer) => peer.address);
    const ma = await until(() => a.net(), met, 30000);
    const mb = await until(() => b.net(), met, 30000);
    if (!met(ma) || !met(mb)) throw new Error(`the two emulators did not meet${throughPage ? ` in room ${a.room}` : ''}: A ${JSON.stringify({ link: ma.link, peers: ma.peers })}, B ${JSON.stringify({ link: mb.link, peers: mb.peers })}`);
    if (throughPage && (ma.link.self !== a.id || mb.link.self !== b.id || ma.link.name !== a.name || mb.link.name !== b.name)) throw new Error(`the page linked the emulators under other ids or names: A ${JSON.stringify(ma.link)}, B ${JSON.stringify(mb.link)}`);

    // Host on A.
    await a.play(plan.host);
    const hosted = await until(() => a.net(), hosting, 20000);
    const listener = (hosted.listeners || []).find(gamePort);
    if (!listener) throw await stuck('the host opened no listener', hosted);

    // Join on B.
    await b.play(plan.join);
    const joined = await until(() => a.net(), plan.joined, 30000);
    if (!plan.joined(joined)) throw await stuck('the host did not see the joiner', await b.net());

    // Start, until each side holds an open connection that is the game's own.
    if (plan.start) await a.play(plan.start);
    const data = (state) => open(state).filter(gamePort);
    const ready = await until(() => a.net(), (state) => data(state).length > 0, 30000);
    if (!data(ready).length) throw await stuck('no connection stayed open between the two', ready);
    await until(() => b.net(), (state) => data(state).length > 0, 15000);
    if (plan.play) await a.play(plan.play);

    // Compare the two ends with both guests stopped: nothing is sent then, and
    // what was on its way has arrived.
    await a.emulator('pause');
    await b.emulator('pause');
    await sleep(1000);
    await a.chain;
    await b.chain;
    await sleep(500);
    const na = await a.net();
    const nb = await b.net();
    await a.shot(`${tier}-a`);
    await b.shot(`${tier}-b`);
    await a.emulator('resume');
    await b.emulator('resume');

    const problems = [];
    const ca = data(na);
    const cb = data(nb);
    if (!ca.length) problems.push('A has no open connection');
    if (!cb.length) problems.push('B has no open connection');
    let bytes = 0;
    for (const conn of ca) {
      const far = cb.find((other) => other.id === conn.id && other.initiator !== conn.initiator && other.protocol === conn.protocol && other.port === conn.port);
      if (!far) { problems.push(`A's connection ${conn.id} has no other end on B`); continue; }
      if (far.rxBytes !== conn.txBytes) problems.push(`A sent ${conn.txBytes} bytes on ${conn.protocol} ${conn.port}, B received ${far.rxBytes}`);
      if (far.txBytes !== conn.rxBytes) problems.push(`B sent ${far.txBytes} bytes on ${conn.protocol} ${conn.port}, A received ${conn.rxBytes}`);
      bytes += conn.txBytes + conn.rxBytes;
    }
    if (ca.length !== cb.length) problems.push(`A has ${ca.length} open connections, B has ${cb.length}`);
    if (ca.length && !bytes) problems.push('the connections are open but carried no data');
    for (const [label, state] of [['A', na], ['B', nb]]) {
      if (state.totals.seqErrors) problems.push(`${label} counted ${state.totals.seqErrors} sequence errors`);
      if (state.totals.badFrames) problems.push(`${label} counted ${state.totals.badFrames} malformed frames`);
    }

    // B leaves the room: as far as A is told, or by closing its tab.
    if (throughPage) await b.close();
    else await a.peer(b.id, false);
    const dropped = (state) => (state.events || []).some((e) => e.op === 'close' && e.result === KERR_DISCONNECTED);
    const after = await until(() => a.net(), dropped, 15000);
    if (!dropped(after)) problems.push(`A's connection did not close with ${KERR_DISCONNECTED} after B left: ${names((after.events || []).slice(-6))}`);
    if (open(after).some((conn) => conn.peer === b.id)) problems.push('A still has an open connection to B after B left');
    await sleep(4000);
    const frames = await a.framesIn(5000);
    if (frames < 2) problems.push(`A stopped drawing after B left (${frames} frames in 5 s)`);
    const session = await a.session();
    if (session && session.state && session.state !== 'running') problems.push(`A's game is ${session.state} after B left`);
    await a.shot(`${tier}-a-after`);
    a.saveConsole(`${tier}-a`);
    b.saveConsole(`${tier}-b`);
    problems.push(...pageErrors(a, b).map((error) => `page error: ${error}`));

    const carried = ca.map((conn) => `${conn.protocol} ${conn.port}: A sent ${conn.txBytes}, received ${conn.rxBytes}`).join('; ');
    return { pass: !problems.length, listener, connectionsA: ca, connectionsB: cb, totalsA: na.totals, totalsB: nb.totals,
      eventsA: after.events, eventsB: nb.events, framesAfter: frames, relayed: a.sent + b.sent, room: a.room, invite: a.invite,
      detail: problems.join('; ') || `${game}${throughPage ? `, hosted in the page's dialog (room ${a.room}) and joined by its link, through the dev server's relay` : ''}: the host listened on ${listener.protocol} ${listener.port}; open on both sides and equal at both ends: ${carried}; closed with ${KERR_DISCONNECTED} when B left, ${frames} frames in 5 s after` };
  } finally {
    await a.close();
    await b.close();
  }
}

// --- the server mode ---------------------------------------------------------------

async function serve() {
  const count = Number(args.pages || 2);
  const a = new Player('a', 1, 'Ann');
  const b = count === 2 ? new Player('b', 2, 'Bo') : null;
  if (b) { a.other = b; b.other = a; }
  const players = { a, b };
  for (const player of [a, b]) {
    if (!player) continue;
    await player.open(game);
    await player.running().catch((error) => console.log(`${firstLine(error)}; the page can still be looked at`));
  }
  if (b && !args.unlinked) await linkUp(a, b);
  else if (!args.unlinked) await a.link(true);

  const control = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const q = Object.fromEntries(url.searchParams);
    const player = players[q.page || 'a'];
    const send = (value, code = 200) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value, null, 1) + '\n');
    };
    try {
      if (url.pathname === '/quit') { send({ ok: true }); await end(0); return; }
      if (url.pathname === '/link') { if (b) await linkUp(a, b); else await a.link(true); send({ ok: true }); return; }
      if (url.pathname === '/unlink') { for (const p of [a, b]) if (p) await p.link(false); send({ ok: true }); return; }
      if (!player) { send({ error: `no page ${q.page}` }, 404); return; }
      if (url.pathname === '/key') {
        for (let i = 0; i < Number(q.repeat || 1); i++) {
          await player.press(q.name, Number(q.hold || 200));
          await sleep(Number(q.wait || 800));
        }
        send({ ok: true, frames: await player.frames() });
      } else if (url.pathname === '/shot') {
        send({ file: await player.shot(q.name || `shot-${player.label}`) });
      } else if (url.pathname === '/net') {
        send(await player.net());
      } else if (url.pathname === '/frames') {
        send({ frames: await player.framesIn(Number(q.ms || 2000)), errors: player.errors });
      } else if (url.pathname === '/leave') {
        await player.peer(player.other.id, false);
        send({ ok: true });
      } else if (url.pathname === '/restart') {
        await player.restart();
        send({ ok: true, frames: await player.frames() });
      } else if (url.pathname === '/console') {
        send(player.console.slice(-Number(q.lines || 40)));
      } else if (url.pathname === '/api') {
        // Any control API request; the body of the answer as text.
        send(await player.ask(async ([method, target]) => {
          const result = await window.eka2l1.request(method, target);
          return { status: result.status, body: new TextDecoder().decode(result.body).slice(0, 20000) };
        }, [q.method || 'GET', q.target], 'api'));
      } else if (url.pathname === '/session') {
        send(await player.session());
      } else {
        send({ error: 'unknown command' }, 404);
      }
    } catch (error) {
      send({ error: firstLine(error) }, 500);
    }
  });
  control.listen(Number(args.serve), '127.0.0.1', () => console.log(`ready: commands on http://127.0.0.1:${args.serve}/ (see the top of tools/web/nettest.mjs)`));
}

// --- main --------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, hint] of [[path.join(binDir, 'eka2l1_web.wasm'), 'build it with tools/ci/build-web.sh or pass --bin'],
    [path.join(assetsDir, 'NGAGE.ROM'), 'fetch it with tools/assets/fetch.py or pass --assets']]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}: ${hint}`);
  }
  const needed = new Set();
  if (args.serve || tiers.includes('0') || tiers.includes('2') || tiers.includes('3')) needed.add(game);
  if (!args.serve && tiers.includes('1')) Object.keys(SOLO).forEach((slug) => needed.add(slug));
  for (const slug of needed) {
    const zip = path.join(assetsDir, 'games', `${slug}.zip`);
    if (!fs.existsSync(zip)) throw new Error(`missing ${zip}: fetch it with tools/assets/fetch.py, pack it with tools/games/pack.py, or pass --assets`);
  }

  serverPort = await startServer();
  browser = await withTimeout(BROWSERS[browserName](), 60000, 'browser launch');
  browser.on('disconnected', () => { if (!ended) { console.error('the browser went away'); end(1); } });

  if (args.serve) {
    await serve();
    return;
  }

  const limit = Number(args['time-limit'] || 2400) * 1000;
  setTimeout(() => { console.error(`time limit of ${limit / 1000} s reached`); end(1); }, limit).unref();

  const run = { 0: tier0, 1: tier1, 2: () => tier2(false), 3: () => tier2(true) };
  let failed = false;
  for (const tier of ['0', '1', '2', '3'].filter((name) => tiers.includes(name))) {
    const since = Date.now();
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await run[tier]();
      } catch (error) {
        result = { pass: false, miss: error instanceof Miss, detail: firstLine(error) };
      }
      result.attempts = result.attempts || attempt;
      if (!result.miss) break;
      if (attempt === 1) console.log(`      tier ${tier}: ${result.detail}; trying once more`);
    }
    const seconds = Math.round((Date.now() - since) / 1000);
    results.push({ tier: Number(tier), seconds, ...result });
    failed = failed || !result.pass;
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  tier ${tier}  in ${seconds} s  ${result.detail}`);
  }
  await end(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(firstLine(error));
  end(1);
});
