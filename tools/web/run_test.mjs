// Headless smoke test for the EKA2L1 web build.
//
//   node run_test.mjs [--query "fw=/local/NGAGE.ROM&game=/local/shadowkey.zip"] [--seconds 40]
//                     [--shot out.png] [--keys "ok:2500,ok:2500,down"] [--log out.log] [--gameplay]
//
// Loads the page from the dev server (tools/web/devserver.py), prints console
// output, optionally plays a key script, then saves a canvas screenshot and
// reports frame counts.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, i, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const port = args.port || 8080;
const query = args.query !== undefined ? args.query : 'fw=/local/NGAGE.ROM&game=/local/shadowkey.zip';
const seconds = Number(args.seconds || 40);
const shot = args.shot || 'web_shot.png';
const logPath = args.log || null;

const KEYS = { ok: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', lsk: 'KeyQ', rsk: 'KeyW' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 800 } });

const lines = [];
const record = (line) => { lines.push(line); if (!args.quiet) console.log(line); };
page.on('console', (message) => record(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => record(`[pageerror] ${error.message}`));
page.on('crash', () => record('[crash] page crashed'));
page.on('worker', (worker) => worker.on('close', () => record('[worker closed]')));

const started = Date.now();
await page.goto(`http://127.0.0.1:${port}/?${query}`);

const status = async () => page.evaluate(() => ({
  status: document.getElementById('status').textContent,
  frames: window.eka2l1 && window.eka2l1.module ? window.eka2l1.frames() : -1,
}));

const press = async (name, hold = 120) => {
  await page.keyboard.down(KEYS[name] || name);
  await sleep(hold);
  await page.keyboard.up(KEYS[name] || name);
};

// Wait for the app to be launched (status shows its name) or the time to run out.
let last = {};
while ((Date.now() - started) / 1000 < seconds) {
  await sleep(1000);
  last = await status();
  if (args.until && last.status.includes(args.until)) break;
}
record(`[test] after ${((Date.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(last)}`);

if (args.reload) {
  // Second visit in the same profile: persisted data should make this fast and
  // download-free.
  const requested = [];
  page.on('request', (request) => { if (request.url().includes('/local/')) requested.push(request.url()); });
  const saveStart = Date.now();
  await page.evaluate(() => window.eka2l1.save());
  record(`[test] save pass took ${((Date.now() - saveStart) / 1000).toFixed(1)}s`);
  const t0 = Date.now();
  await page.reload();
  let again = {};
  while ((Date.now() - t0) / 1000 < seconds) {
    await sleep(500);
    again = await status().catch(() => ({ status: '' }));
    if (args.until && again.status && again.status.includes(args.until) && again.frames > 0) break;
  }
  record(`[test] reload: ${((Date.now() - t0) / 1000).toFixed(1)}s to ${JSON.stringify(again)}; downloads after reload: ${requested.length} ${requested.join(' ')}`);
}

if (args.keys) {
  for (const step of String(args.keys).split(',')) {
    const [name, wait] = step.split(':');
    await press(name.trim());
    await sleep(Number(wait || 600));
  }
}

if (args.gameplay) {
  // Same path the native baseline script takes into the first room.
  await sleep(6000);
  for (let i = 0; i < 4; i++) { await press('ok'); await sleep(2500); }
  for (let i = 0; i < 11; i++) { await press('ok'); await sleep(2000); }
  for (let i = 0; i < 4; i++) { await press('down'); await sleep(250); }
  await sleep(1000); await press('ok'); await sleep(4000);
  await press('down'); await sleep(1000); await press('ok'); await sleep(12000);
}

if (args.measure) {
  const secs = Number(args.measure);
  await page.keyboard.down('ArrowLeft');
  const a = await status();
  const t0 = Date.now();
  await sleep(secs * 1000);
  const b = await status();
  await page.keyboard.up('ArrowLeft');
  record(`[test] fps while turning: ${((b.frames - a.frames) / ((Date.now() - t0) / 1000)).toFixed(1)}`);
}

// Dismiss the sound prompt (a click is a user gesture, and is not a guest key).
await page.mouse.click(5, 5);
await sleep(500);
await page.locator('#canvas').screenshot({ path: shot });

// Audio: is the worklet attached, and is the mixer feeding the ring?
const audio = await page.evaluate(async () => {
  if (!window.eka2l1 || !window.eka2l1.module) return { context: 'no module' };
  const emu = window.eka2l1;
  const ring = emu.module._eka2l1_web_audio_ring() >>> 2;
  const words = () => new Uint32Array(emu.module.wasmMemory.buffer);
  const floats = () => new Float32Array(emu.module.wasmMemory.buffer);
  const before = words()[ring + 1];
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const w = words();
  let peak = 0;
  const data = w[ring + 5] >>> 2;
  for (let i = 0; i < w[ring + 2] * 2; i++) peak = Math.max(peak, Math.abs(floats()[data + i]));
  return { context: emu.audio ? emu.audio.state : 'none', rate: w[ring + 3], attached: w[ring + 4], framesPerSecond: (w[ring + 1] - before) >>> 0, peak: Number(peak.toFixed(3)) };
});
record(`[test] audio: ${JSON.stringify(audio)}`);

// The guest picture as the emulator sees it, independent of page compositing.
const guest = await page.evaluate(async () => {
  const res = await window.eka2l1.request('GET', '/v1/screenshot');
  return { status: res.status, type: res.type, bytes: Array.from(res.body) };
});
if (guest.status === 200) {
  fs.writeFileSync(shot.replace(/\.png$/, '') + '_guest.png', Buffer.from(guest.bytes));
} else {
  record(`[test] guest screenshot failed: ${guest.status} ${Buffer.from(guest.bytes).toString()}`);
}
record(`[test] final: ${JSON.stringify(await status())} screenshot: ${shot}`);
if (logPath) fs.writeFileSync(logPath, lines.join('\n') + '\n');
await browser.close();
