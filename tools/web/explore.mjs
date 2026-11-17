// Interactive exploration session for the web build: boots the game in headless
// Chrome and then takes commands over HTTP on 127.0.0.1:8091, so a person or a
// script can press keys and look at screenshots one step at a time.
//
//   node tools/web/explore.mjs [--game SLUG] [--script] [--port 8080] [--control-port 8091] [--out DIR]
//                              [--gameplay] [--query "..."] [--log "*:warn"]
//
//   --game SLUG      load testdata/games/<SLUG>.zip (see tools/games/pack.py); default is Shadowkey
//   --script         after the game starts, replay "test.script" from catalog/games/<SLUG>.json
//   --port           the dev server's port (tools/web/devserver.py)
//   --control-port   the port this tool listens on
//   --gameplay       Shadowkey only: its key script into the first room
//
// The page's console (emulator log lines included) is written to DIR/console.log.
// If the game does not start within 90 s the tool says so and still serves
// commands, so the page can be inspected with /pageshot, /eval and /api.
//
//   curl 'http://127.0.0.1:8091/key?name=lsk&hold=120&wait=800'   press an N-Gage key
//   curl 'http://127.0.0.1:8091/script'                           replay the catalogue script (re-read from disk)
//   curl 'http://127.0.0.1:8091/frames?ms=1500'                   frames presented in that time
//   curl 'http://127.0.0.1:8091/status'                           page status line and running app
//   curl 'http://127.0.0.1:8091/shot?name=menu'                   guest screenshot -> DIR/menu.png
//   curl 'http://127.0.0.1:8091/api?method=GET&target=/v1/apps'   control API call
//   curl 'http://127.0.0.1:8091/api?raw=1&target=/v1/screenshot'  the same, the body as it is (status in X-Status)
//   curl 'http://127.0.0.1:8091/eval' --data 'return document.title'
//   curl 'http://127.0.0.1:8091/quit'
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, i, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
// Set by tools/env.sh. Without it (CI) Playwright's own browsers are used.
const TOOLCHAIN = process.env.EKA2L1_TOOLCHAIN || '';
const outDir = path.resolve(String(args.out || 'explore'));
const port = Number(args.port || 8080);
const controlPort = Number(args['control-port'] || 8091);
const slug = typeof args.game === 'string' ? args.game : null;
const catalogFile = slug ? path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'catalog', 'games', `${slug}.json`) : null;
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = path.join(TOOLCHAIN, 'chrome', 'chrome');
const exe = TOOLCHAIN && fs.existsSync(root) ? path.join(root, fs.readdirSync(root).sort().pop(), 'chrome-linux64', 'chrome') : undefined;
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleLog = fs.createWriteStream(path.join(outDir, 'console.log'));
page.on('console', (message) => consoleLog.write(`[${message.type()}] ${message.text()}\n`));
page.on('pageerror', (error) => { console.log('[pageerror]', error.message); consoleLog.write(`[pageerror] ${error.message}\n`); });
const defaultQuery = `fw=/local/NGAGE.ROM&game=/local/${slug ? `games/${slug}.zip` : 'shadowkey.zip'}${args.log ? `&log=${encodeURIComponent(args.log)}` : ''}`;
await page.goto(`http://127.0.0.1:${port}/?${args.query !== undefined ? args.query : defaultQuery}`);
const pageStatus = () => page.evaluate(() => ({
  status: document.getElementById('status')?.textContent || '',
  app: window.eka2l1Page && window.eka2l1Page.app ? window.eka2l1Page.app : null,
  frames: window.eka2l1Page && window.eka2l1Page.emu && window.eka2l1Page.emu.module ? window.eka2l1Page.emu.frames() : -1,
}));
let started = true;
try {
  await page.waitForFunction(() => window.eka2l1Page && window.eka2l1Page.app, null, { timeout: 90000 });
} catch {
  started = false;
  console.log('game did not start:', JSON.stringify(await pageStatus()));
}

// Keys go straight to the emulator by N-Gage name, bypassing page bindings.
const key = async (name, hold = 120) => {
  await page.evaluate(async ([n, h]) => {
    const { KEYS } = await import('./eka2l1-client.js');
    window.eka2l1.key(KEYS[n], true);
    await new Promise((resolve) => setTimeout(resolve, h));
    window.eka2l1.key(KEYS[n], false);
  }, [name, hold]);
};

if (args.gameplay) {
  await sleep(6000);
  for (let i = 0; i < 4; i++) { await key('ok'); await sleep(2500); }
  for (let i = 0; i < 11; i++) { await key('ok'); await sleep(2000); }
  for (let i = 0; i < 4; i++) { await key('down'); await sleep(250); }
  await sleep(1000); await key('ok'); await sleep(4000);
  await key('down'); await sleep(1000); await key('ok'); await sleep(12000);
}

// One step of a catalogue script: { key, hold, wait, repeat } or { wait }.
const runScript = async () => {
  const game = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  if (!game.test || !Array.isArray(game.test.script)) throw new Error(`${slug} has no test.script`);
  for (const step of game.test.script) {
    for (let i = 0; i < (step.repeat || 1); i++) {
      if (step.key) await key(step.key, step.hold || 120);
      await sleep(step.wait !== undefined ? step.wait : (step.key ? 600 : 0));
    }
  }
  return game.test.script.length;
};
if (args.script && started) {
  if (!slug) throw new Error('--script needs --game');
  console.log(`script done: ${await runScript()} steps`);
}
console.log(started ? 'ready' : 'ready (game not running)');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    let out = 'ok';
    if (url.pathname === '/key') {
      for (let i = 0; i < Number(q.repeat || 1); i++) { await key(q.name, Number(q.hold || 120)); await sleep(Number(q.wait || 600)); }
    } else if (url.pathname === '/shot') {
      const bytes = await page.evaluate(async () => Array.from((await window.eka2l1.request('GET', '/v1/screenshot')).body));
      const file = path.join(outDir, `${q.name || 'shot'}.png`);
      fs.writeFileSync(file, Buffer.from(bytes));
      out = file;
    } else if (url.pathname === '/script') {
      out = `script done: ${await runScript()} steps`;
    } else if (url.pathname === '/frames') {
      const before = (await pageStatus()).frames;
      await sleep(Number(q.ms || 1500));
      out = String((await pageStatus()).frames - before);
    } else if (url.pathname === '/status') {
      out = JSON.stringify(await pageStatus());
    } else if (url.pathname === '/pageshot') {
      const file = path.join(outDir, `${q.name || 'page'}.png`);
      await page.screenshot({ path: file });
      out = file;
    } else if (url.pathname === '/api' && q.raw) {
      // The response as it is: the body's bytes, the status in a header. For
      // tools (tools/re/dbg.py); the form below is for reading by eye.
      const r = await page.evaluate(async ([m, t, b]) => {
        const r = await window.eka2l1.request(m, t, b || null);
        let binary = '';
        for (let i = 0; i < r.body.length; i += 0x8000) binary += String.fromCharCode.apply(null, r.body.subarray(i, i + 0x8000));
        return { status: r.status, type: r.type, body: btoa(binary) };
      }, [q.method || 'GET', q.target, body]);
      res.setHeader('X-Status', String(r.status));
      res.setHeader('Content-Type', r.type || 'application/octet-stream');
      res.end(Buffer.from(r.body, 'base64'));
      return;
    } else if (url.pathname === '/api') {
      out = await page.evaluate(async ([m, t, b]) => {
        const r = await window.eka2l1.request(m, t, b || null);
        return `${r.status} ${r.type.startsWith('application/json') || r.type.startsWith('text/') ? r.text() : r.body.length + ' bytes'}`;
      }, [q.method || 'GET', q.target, body]);
    } else if (url.pathname === '/eval') {
      out = JSON.stringify(await page.evaluate(`(async () => { ${body} })()`));
    } else if (url.pathname === '/quit') {
      res.end('bye\n');
      await browser.close();
      process.exit(0);
    }
    res.end(String(out) + '\n');
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error && error.message ? error.message : error) + '\n');
  }
}).listen(controlPort, '127.0.0.1');
