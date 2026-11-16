// Interactive exploration session for the web build: boots the game in headless
// Chrome and then takes commands over HTTP on 127.0.0.1:8091, so a person or a
// script can press keys and look at screenshots one step at a time.
//
//   node explore.mjs [--gameplay] [--query "..."] [--out DIR]
//   curl 'http://127.0.0.1:8091/key?name=lsk&hold=120&wait=800'   press an N-Gage key
//   curl 'http://127.0.0.1:8091/shot?name=menu'                   guest screenshot -> DIR/menu.png
//   curl 'http://127.0.0.1:8091/api?method=GET&target=/v1/apps'   control API call
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
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = path.join(TOOLCHAIN, 'chrome', 'chrome');
const exe = path.join(root, fs.readdirSync(root).sort().pop(), 'chrome-linux64', 'chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
await page.goto(`http://127.0.0.1:8080/?${args.query !== undefined ? args.query : 'fw=/local/NGAGE.ROM&game=/local/shadowkey.zip'}`);
await page.waitForFunction(() => window.eka2l1Page && window.eka2l1Page.app, null, { timeout: 90000 });

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
console.log('ready');

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
    } else if (url.pathname === '/pageshot') {
      const file = path.join(outDir, `${q.name || 'page'}.png`);
      await page.screenshot({ path: file });
      out = file;
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
}).listen(8091, '127.0.0.1');
