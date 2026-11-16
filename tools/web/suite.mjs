// Browser test suite for the EKA2L1 web build.
//
//   node suite.mjs [--browsers chrome,firefox] [--tests boot,gameplay,...] [--devices desktop,phone,...]
//                  [--out results] [--port 8080] [--headed]
//
// Needs the dev server (tools/web/devserver.py) and testdata/ (firmware + game).
// Each test gets a fresh browser profile unless it says otherwise. Results go to
// <out>/results.json, <out>/summary.md and screenshots next to them.
//
// Tests:
//   support   capability detection, including the WebGPU probe; no-isolation page
//   boot      cold load by URL: time to emulator ready and to the game running
//   gameplay  scripted keys into in-world 3D, then frame rate and pacing while turning
//   audio     worklet attached and the mixer producing signal at the context's rate
//   persist   guest C: file + installed game survive a reload, with no downloads
//   session   pause/resume, hidden-tab pause, restart, heap growth across restarts
//   gamepad   a (mocked) standard gamepad drives the game into 3D
//   touch     on-screen controls drive the game into 3D; layout fits the viewport
//   controls  game layout picked automatically, rebinding by keyboard and gamepad, reset
//   display   every scaling filter renders, resolutions resize the canvas, speed holds
//   urlload   "Load from URL" and the site's one-click Play button
//   saves     an in-game save is exported, deleted, imported back and survives a reload
import { chromium, firefox, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, i, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

// Set by tools/env.sh. Without it (CI) Playwright's own browsers are used.
const TOOLCHAIN = process.env.EKA2L1_TOOLCHAIN || '';
const port = args.port || 8080;
const base = `http://127.0.0.1:${port}`;
const query = 'fw=/local/NGAGE.ROM&game=/local/shadowkey.zip';
const outDir = path.resolve(String(args.out || 'results'));
const GAME = 'Elder Scrolls';
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const root = path.join(TOOLCHAIN, 'chrome', 'chrome');
  if (!fs.existsSync(root)) return null;
  const version = fs.readdirSync(root).sort().pop();
  return version ? path.join(root, version, 'chrome-linux64', 'chrome') : null;
}

const chromeWith = (flags) => () => chromium.launch({
  executablePath: findChrome(),
  headless: !args.headed,
  args: ['--autoplay-policy=no-user-gesture-required', ...flags],
});

const BROWSERS = {
  // Google Chrome (Chrome for Testing build) in its current headless mode, which
  // is the real browser without a window. Headless picks a software rasteriser
  // unless told otherwise, so this configuration asks for the machine's GPU
  // (WebGL2 through ANGLE's GL backend) and turns on WebGPU, which Chrome on
  // Linux still keeps behind a flag.
  chrome: {
    launch: chromeWith(['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan']),
    mobileEmulation: true,
  },
  // The same browser with no GPU: WebGL2 on the SwiftShader software renderer.
  // This is the floor for machines without usable graphics drivers.
  'chrome-software': {
    launch: chromeWith([]),
    mobileEmulation: true,
  },
  firefox: {
    launch: () => firefox.launch({
      headless: !args.headed,
      firefoxUserPrefs: { 'media.autoplay.default': 0, 'dom.webgpu.enabled': true, 'gfx.webrender.all': true },
    }),
    mobileEmulation: false,
  },
};

// Viewports the layout is checked against. Phone and tablet profiles turn on
// touch and a mobile user agent (Chromium only; Firefox cannot emulate those).
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { ...devices['Pixel 7'] },
  'phone-landscape': { ...devices['Pixel 7 landscape'] },
  iphone: { ...devices['iPhone 14'], defaultBrowserType: undefined },
  tablet: { ...devices['iPad (gen 7)'], defaultBrowserType: undefined },
  'tablet-landscape': { ...devices['iPad (gen 7) landscape'], defaultBrowserType: undefined },
};

// --- page helpers ------------------------------------------------------------

async function open(browser, { device = 'desktop', url = `${base}/?${query}`, init = null } = {}) {
  const profile = { ...DEVICES[device] };
  delete profile.defaultBrowserType;
  const context = await browser.newContext(profile);
  const page = await context.newPage();
  const log = [];
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') log.push(`[${message.type()}] ${message.text()}`); });
  page.on('pageerror', (error) => log.push(`[pageerror] ${error.message}`));
  page.on('crash', () => log.push('[crash]'));
  if (args.verbose) {
    page.on('console', (message) => console.log(`  [${message.type()}] ${message.text().slice(0, 240)}`));
    page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message.slice(0, 240)}`));
  }
  if (init) await page.addInitScript(init);
  const started = Date.now();
  await page.goto(url);
  return { context, page, log, started };
}

const state = (page) => page.evaluate(() => {
  const p = window.eka2l1Page || {};
  return {
    status: document.getElementById('status').textContent,
    running: Boolean(p.app),
    paused: Boolean(p.paused),
    frames: p.emu && p.emu.module ? p.emu.frames() : -1,
    stats: p.emu && p.emu.module ? p.emu.stats() : null,
    keysSent: p.input ? p.input.sent : 0,
  };
});

async function waitRunning(page, timeoutMs = 90000) {
  const started = Date.now();
  let readyAt = null;
  for (;;) {
    const s = await state(page).catch(() => ({ status: '', frames: -1 }));
    if (readyAt === null && s.frames >= 0) readyAt = Date.now() - started;
    if (s.running && s.frames > 0) return { ms: Date.now() - started, readyMs: readyAt, state: s };
    if (Date.now() - started > timeoutMs) throw new Error(`game did not start within ${timeoutMs} ms (status: ${s.status})`);
    await sleep(100);
  }
}

async function framesAdvance(page, ms = 1500) {
  const a = (await state(page)).frames;
  await sleep(ms);
  return (await state(page)).frames - a;
}

async function guestShot(page, file) {
  const shot = await page.evaluate(async () => {
    const res = await window.eka2l1.request('GET', '/v1/screenshot');
    return { status: res.status, bytes: Array.from(res.body) };
  });
  if (shot.status === 200) fs.writeFileSync(file, Buffer.from(shot.bytes));
  return shot.status === 200;
}

// The same route the native baseline script takes from launch into the first
// room, expressed as N-Gage key names; `press(name, holdMs)` supplies the device.
async function toGameplay(press) {
  await sleep(6000);
  for (let i = 0; i < 4; i++) { await press('ok'); await sleep(2500); }
  for (let i = 0; i < 11; i++) { await press('ok'); await sleep(2000); }
  for (let i = 0; i < 4; i++) { await press('down'); await sleep(250); }
  await sleep(1000); await press('ok'); await sleep(4000);
  await press('down'); await sleep(1000); await press('ok'); await sleep(12000);
}

const KEYBOARD = { ok: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const keyboardPress = (page) => async (name, hold = 120) => {
  await page.keyboard.down(KEYBOARD[name]);
  await sleep(hold);
  await page.keyboard.up(KEYBOARD[name]);
};

// Frame rate and pacing over `seconds`, sampled every 250 ms.
async function measure(page, seconds, hold) {
  await hold(true);
  await sleep(500);
  const samples = [];
  const first = await state(page);
  let last = first;
  let lastTime = Date.now();
  const startTime = lastTime;
  while (Date.now() - startTime < seconds * 1000) {
    await sleep(250);
    const now = await state(page);
    const t = Date.now();
    samples.push(((now.frames - last.frames) * 1000) / (t - lastTime));
    last = now;
    lastTime = t;
  }
  await hold(false);

  const elapsed = (lastTime - startTime) / 1000;
  const frames = last.frames - first.frames;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    fps: Number((frames / elapsed).toFixed(1)),
    fpsMin: Number(sorted[0].toFixed(1)),
    fpsP10: Number(sorted[Math.floor(sorted.length * 0.1)].toFixed(1)),
    graphicsMsPerFrame: Number(((last.stats.graphicsBusyMs - first.stats.graphicsBusyMs) / Math.max(1, frames)).toFixed(3)),
    heapMB: Math.round(last.stats.heapMB),
    heapUsedMB: Math.round(last.stats.heapUsedMB),
    series: samples.map((v) => Math.round(v)).join(' '),
  };
}

// --- tests -------------------------------------------------------------------

const TESTS = {
  async support(browser, name) {
    const { context, page } = await open(browser, { url: `${base}/?persist=0` });
    await page.waitForFunction(() => window.eka2l1Page && window.eka2l1Page.support, null, { timeout: 30000 });
    const support = await page.evaluate(() => window.eka2l1Page.support);
    await context.close();

    // Without the isolation headers the page must say so instead of hanging.
    const blocked = await open(browser, { url: `${base}/noiso/?${query}` });
    await blocked.page.waitForFunction(() => document.getElementById('status').classList.contains('error'), null, { timeout: 30000 }).catch(() => {});
    const message = await blocked.page.evaluate(() => document.getElementById('status').textContent);
    await blocked.context.close();

    const missing = support.required.filter((item) => !item.ok).map((item) => item.name);
    return {
      pass: support.ok && /cross-origin isolation/i.test(message),
      required: missing.length ? `missing: ${missing.join(', ')}` : 'all present',
      webgl2: support.webgl.renderer,
      hardwareWebGL: !support.webgl.software,
      webgpu: support.webgpu.working ? `working (${support.webgpu.adapter}${support.webgpu.fallback ? ', fallback' : ''}, ${support.webgpu.renderMs} ms)`
        : `unavailable: ${support.webgpu.error}`,
      optionalMissing: support.optional.filter((item) => !item.ok).map((item) => item.name).join(', ') || 'none',
      noIsolationMessage: message.slice(0, 160),
    };
  },

  async boot(browser, name) {
    const { context, page, log } = await open(browser);
    const run = await waitRunning(page);
    await sleep(3000);
    await page.locator('#canvas').screenshot({ path: path.join(outDir, `${name}-boot.png`) });
    const guest = await guestShot(page, path.join(outDir, `${name}-boot-guest.png`));
    const advancing = await framesAdvance(page);
    await context.close();
    return { pass: advancing > 0 && guest, emulatorReadyMs: run.readyMs, gameRunningMs: run.ms, framesIn1500ms: advancing, errors: log.length };
  },

  async gameplay(browser, name) {
    const { context, page, log } = await open(browser);
    await waitRunning(page);
    await page.mouse.click(5, 5); // user gesture: unlocks audio
    const press = keyboardPress(page);
    await toGameplay(press);
    const perf = await measure(page, 30, (down) => (down ? page.keyboard.down('ArrowLeft') : page.keyboard.up('ArrowLeft')));
    await guestShot(page, path.join(outDir, `${name}-gameplay-guest.png`));
    await page.locator('#canvas').screenshot({ path: path.join(outDir, `${name}-gameplay.png`) });

    const audio = await page.evaluate(async () => {
      const emu = window.eka2l1;
      const ring = emu.module._eka2l1_web_audio_ring() >>> 2;
      const words = () => new Uint32Array(emu.module.wasmMemory.buffer);
      const before = words()[ring + 1];
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const w = words();
      const floats = new Float32Array(emu.module.wasmMemory.buffer);
      const data = w[ring + 5] >>> 2;
      let peak = 0;
      for (let i = 0; i < w[ring + 2] * 2; i++) peak = Math.max(peak, Math.abs(floats[data + i]));
      return { context: emu.audio ? emu.audio.state : 'none', contextRate: emu.audio ? emu.audio.sampleRate : 0, attached: w[ring + 4],
        mixedPerSecond: (w[ring + 1] - before) >>> 0, peak: Number(peak.toFixed(3)) };
    });
    await context.close();

    const audioOk = audio.context === 'running' && audio.attached === 1 && Math.abs(audio.mixedPerSecond - audio.contextRate) < audio.contextRate * 0.05 && audio.peak > 0;
    return { pass: perf.fps >= 17 && audioOk, ...perf, audio: audioOk ? `ok (${audio.contextRate} Hz, peak ${audio.peak})` : JSON.stringify(audio), errors: log.length };
  },

  async persist(browser, name) {
    const { context, page, log } = await open(browser);
    const first = await waitRunning(page);

    // Leaving while the first storage pass is still copying must not leave a
    // half-written install behind: the next visit has to come up either way.
    await page.reload();
    const interrupted = await waitRunning(page).then((run) => `runs after ${run.ms} ms`, (error) => `broken: ${error.message}`);

    // A file on the guest's C: drive stands in for a save game: same drive,
    // same storage path.
    const marker = `saved-${Date.now()}`;
    await page.evaluate(async (text) => {
      const res = await window.eka2l1.request('PUT', '/v1/files?path=' + encodeURIComponent('C:/eka2l1test/save.dat'), text);
      if (!res.ok) throw new Error(res.text());
      await window.eka2l1.save();
    }, marker);

    const requested = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/local/')) requested.push(request.url()); });
    const t0 = Date.now();
    await page.reload();
    const second = await waitRunning(page);
    const back = await page.evaluate(async () => {
      const res = await window.eka2l1.request('GET', '/v1/files?path=' + encodeURIComponent('C:/eka2l1test/save.dat'));
      return res.ok ? res.text() : `error ${res.status}`;
    });
    await context.close();

    return { pass: back === marker && requested.length === 0 && interrupted.startsWith('runs'), firstVisitMs: first.ms, reloadDuringFirstSave: interrupted, reloadMs: Date.now() - t0 - 0, restoreToRunningMs: second.ms,
      saveFileRestored: back === marker, downloadsOnReload: requested.length, errors: log.length };
  },

  async session(browser, name) {
    const { context, page, log } = await open(browser);
    await waitRunning(page);
    await sleep(4000);
    const heapStart = (await state(page)).stats.heapMB;

    // Pause button.
    await page.click('#btn-pause');
    await sleep(800);
    const whilePaused = await framesAdvance(page, 2000);
    await page.click('#btn-pause');
    const afterResume = await framesAdvance(page, 2500);

    // Hidden tab: the page pauses by itself and resumes when shown again.
    const setVisibility = (value) => page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    await setVisibility('hidden');
    await sleep(800);
    const whileHidden = await framesAdvance(page, 2000);
    await setVisibility('visible');
    const afterShown = await framesAdvance(page, 2500);

    // Restart the game three times.
    const restarts = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await page.click('#btn-menu');
      await page.click('#m-restart');
      await page.waitForFunction(() => window.eka2l1Page.app && document.getElementById('status').textContent === window.eka2l1Page.app.name, null, { timeout: 60000 });
      await sleep(3000);
      restarts.push({ ms: Date.now() - t0 - 3000, advancing: await framesAdvance(page, 2000) });
    }
    await guestShot(page, path.join(outDir, `${name}-session-guest.png`));
    const heapEnd = (await state(page)).stats.heapMB;
    await context.close();

    const pass = whilePaused === 0 && afterResume > 0 && whileHidden === 0 && afterShown > 0 && restarts.every((r) => r.advancing > 0);
    return { pass, framesWhilePaused: whilePaused, framesAfterResume: afterResume, framesWhileHidden: whileHidden, framesAfterShown: afterShown,
      restarts: restarts.map((r) => `${r.ms} ms/${r.advancing}f`).join(', '), heapStartMB: Math.round(heapStart), heapAfter3RestartsMB: Math.round(heapEnd), errors: log.length };
  },

  async gamepad(browser, name) {
    // Playwright cannot plug in a controller, so the Gamepad API is replaced by
    // one the test steers. Everything downstream of navigator.getGamepads() is
    // the page's real code.
    const init = () => {
      const pad = { id: 'Test pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
      window.__pad = pad;
      window.__padButton = (index, down) => { pad.buttons[index] = { pressed: down, touched: down, value: down ? 1 : 0 }; pad.timestamp = performance.now(); };
      window.__padAxis = (index, value) => { pad.axes[index] = value; pad.timestamp = performance.now(); };
      Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
    };
    const { context, page, log } = await open(browser, { init });
    await waitRunning(page);

    const BUTTON = { ok: 0, up: 12, down: 13, left: 14, right: 15 };
    const press = async (key, hold = 120) => {
      await page.evaluate(([b, d]) => window.__padButton(b, d), [BUTTON[key], true]);
      await sleep(hold);
      await page.evaluate(([b, d]) => window.__padButton(b, d), [BUTTON[key], false]);
    };
    await toGameplay(press);

    // Turn with the left stick rather than the d-pad.
    const perf = await measure(page, 8, (down) => page.evaluate((v) => window.__padAxis(0, v), down ? -1 : 0));
    const s = await state(page);
    const pads = await page.evaluate(() => window.eka2l1Page.gamepads || 0);
    await guestShot(page, path.join(outDir, `${name}-gamepad-guest.png`));
    await context.close();
    return { pass: pads === 1 && s.keysSent >= 40 && perf.fps >= 15, gamepadsDetected: pads, keyTransitions: s.keysSent, fpsTurningWithStick: perf.fps, errors: log.length };
  },

  async touch(browser, name, device) {
    const { context, page, log } = await open(browser, { device, url: `${base}/?${query}&touch=1` });
    await waitRunning(page);

    // Layout: the picture and both control clusters are on screen, nothing
    // overlaps the picture, and the page does not scroll.
    const layout = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
      const vw = window.innerWidth, vh = window.innerHeight;
      const inside = (r) => r.w > 0 && r.h > 0 && r.x >= -1 && r.y >= -1 && r.r <= vw + 1 && r.b <= vh + 1;
      const overlap = (a, b) => a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;
      const stage = box(document.getElementById('stage'));
      // The drawn picture is letterboxed inside the stage.
      const scale = Math.min(stage.w / 176, stage.h / 208);
      const picture = { w: 176 * scale, h: 208 * scale };
      picture.x = stage.x + (stage.w - picture.w) / 2; picture.y = stage.y + (stage.h - picture.h) / 2;
      picture.r = picture.x + picture.w; picture.b = picture.y + picture.h;
      const controls = [...document.querySelectorAll('.pad .key, #dpad')].map(box);
      return {
        viewport: `${vw}x${vh}`,
        picture: `${Math.round(picture.w)}x${Math.round(picture.h)}`,
        scale: Number(scale.toFixed(2)),
        controlsVisible: controls.every(inside),
        controlsClearOfPicture: controls.every((c) => !overlap(c, picture)),
        smallestControl: Math.round(Math.min(...controls.map((c) => Math.min(c.w, c.h)))),
        scrolls: document.documentElement.scrollHeight > vh + 1 || document.documentElement.scrollWidth > vw + 1,
        touchClass: document.body.classList.contains('touch'),
      };
    });
    await page.screenshot({ path: path.join(outDir, `${name}-${device}-layout.png`) });

    // Drive the game with the on-screen controls through pointer events, the
    // same events a finger produces.
    const pointer = async (selector, type, at = null) => page.evaluate(([sel, t, pos]) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * (pos ? pos[0] : 0.5), y = r.top + r.height * (pos ? pos[1] : 0.5);
      el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    }, [selector, type, at]);

    const DPAD = { up: [0.5, 0.1], down: [0.5, 0.9], left: [0.1, 0.5], right: [0.9, 0.5] };
    const press = async (key, hold = 120) => {
      if (key === 'ok') {
        await pointer('.pad-left [data-key="ok"]', 'pointerdown');
        await sleep(hold);
        await pointer('.pad-left [data-key="ok"]', 'pointerup');
      } else {
        await pointer('#dpad', 'pointerdown', DPAD[key]);
        await sleep(hold);
        await pointer('#dpad', 'pointerup', DPAD[key]);
      }
    };

    // One real tap first, through the browser's own touch input, where the
    // profile has a touch screen.
    let realTap = 'not available';
    if (DEVICES[device].hasTouch) {
      const before = (await state(page)).keysSent;
      await page.locator('.pad-left [data-key="ok"]').tap();
      await sleep(300);
      realTap = (await state(page)).keysSent - before >= 2 ? 'delivered' : 'lost';
    }

    await toGameplay(press);
    const perf = await measure(page, 8, (down) => pointer('#dpad', down ? 'pointerdown' : 'pointerup', DPAD.left));
    await page.screenshot({ path: path.join(outDir, `${name}-${device}-gameplay.png`) });
    await context.close();

    const layoutOk = layout.controlsVisible && layout.controlsClearOfPicture && !layout.scrolls && layout.touchClass && layout.smallestControl >= 40 && layout.scale >= 1;
    return { pass: layoutOk && perf.fps >= 15 && realTap !== 'lost', ...layout, realTap, fpsTurning: perf.fps, heapMB: perf.heapMB, errors: log.length };
  },

  async controls(browser, name) {
    const init = () => {
      const pad = { id: 'Test pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
      window.__padButton = (index, down) => { pad.buttons[index] = { pressed: down, touched: down, value: down ? 1 : 0 }; };
      Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
    };
    const { context, page, log } = await open(browser, { init });
    await waitRunning(page);

    // Record every key the emulator is sent, by scan code.
    await page.evaluate(() => {
      window.__sent = [];
      const original = window.eka2l1.key.bind(window.eka2l1);
      window.eka2l1.key = (scancode, down) => { window.__sent.push([scancode, down]); original(scancode, down); };
    });
    const sentBy = async (code) => {
      await page.evaluate(() => { window.__sent.length = 0; });
      await page.keyboard.down(code); await sleep(80); await page.keyboard.up(code); await sleep(80);
      return page.evaluate(() => window.__sent.map(([scancode, down]) => `${scancode.toString(16)}${down ? '+' : '-'}`).join(' '));
    };
    const openControls = async () => { await page.click('#btn-menu'); await page.click('#m-controls'); };
    const closeDialog = (id) => page.evaluate((d) => document.getElementById(d).close(), id);

    // The game's own layout is chosen automatically: W walks, A strafes.
    await openControls();
    const layout = await page.evaluate(() => document.querySelector('#profile-select option:checked').textContent);
    const rows = await page.evaluate(() => document.querySelectorAll('#bindings tbody tr').length);
    const actions = await page.evaluate(() => [...document.querySelectorAll('#bindings tbody tr td:nth-child(2)')].map((td) => td.textContent).filter(Boolean).length);
    await closeDialog('controls');
    const w = await sentBy('KeyW');
    const a = await sentBy('KeyA');

    // Bind P to OK by keyboard, use it, then remove it.
    const before = await sentBy('KeyP');
    await openControls();
    await page.click('#bindings .chip.add[data-device="keyboard"][data-key="ok"]');
    await page.keyboard.press('KeyP');
    await page.waitForSelector('#bindings .chip[data-device="keyboard"][data-key="ok"][data-input="KeyP"]');
    await closeDialog('controls');
    const bound = await sentBy('KeyP');

    // The binding is remembered across a reload.
    await page.reload();
    await waitRunning(page);
    await page.evaluate(() => {
      window.__sent = [];
      const original = window.eka2l1.key.bind(window.eka2l1);
      window.eka2l1.key = (scancode, down) => { window.__sent.push([scancode, down]); original(scancode, down); };
    });
    const afterReload = await sentBy('KeyP');

    // Bind a gamepad button (R3) to the map key.
    await openControls();
    await page.click('#bindings .chip.add[data-device="gamepad"][data-key="9"]');
    await sleep(200);
    await page.evaluate(() => window.__padButton(11, true));
    await page.waitForSelector('#bindings .chip[data-device="gamepad"][data-key="9"][data-input="b11"]');
    await page.evaluate(() => window.__padButton(11, false));
    const padLabel = await page.evaluate(() => document.querySelector('#bindings .chip[data-device="gamepad"][data-key="9"][data-input="b11"]').textContent);

    // Reset returns the layout to its defaults.
    await page.click('#controls-reset');
    const resetHint = await page.evaluate(() => document.getElementById('controls-hint').textContent);
    await closeDialog('controls');
    const afterReset = await sentBy('KeyP');

    // The guide lists the game's actions.
    await page.click('#btn-menu'); await page.click('#m-guide');
    const guide = await page.evaluate(() => document.getElementById('guide-body').textContent);
    await context.close();

    const pass = /Shadowkey/.test(layout) && rows === 20 && actions >= 17 && w === '10+ 10-' && a === '34+ 34-'
      && before === '' && bound === 'a7+ a7-' && afterReload === 'a7+ a7-' && padLabel === 'R3' && /defaults/.test(resetHint)
      && afterReset === '' && /Move forward/.test(guide) && /Side step left/.test(guide) && /FSR 2/.test(guide);
    return { pass, layout, rows, actionsListed: actions, keyW: w, keyA: a, pBefore: before || 'nothing', pBound: bound, pAfterReload: afterReload,
      gamepadBinding: padLabel, pAfterReset: afterReset || 'nothing', guideHasActions: /Move forward/.test(guide), errors: log.length };
  },

  async display(browser, name) {
    const { context, page, log } = await open(browser);
    await waitRunning(page);
    await page.mouse.click(5, 5);
    await toGameplay(keyboardPress(page)); // a still scene, redrawn every frame

    const shot = async () => PNG.sync.read(await page.locator('#canvas').screenshot());
    const brightness = (png) => { let sum = 0; for (let i = 0; i < png.data.length; i += 4) sum += png.data[i] + png.data[i + 1] + png.data[i + 2]; return sum / (png.data.length / 4) / 3; };
    const difference = (x, y) => { let sum = 0; const n = Math.min(x.data.length, y.data.length); for (let i = 0; i < n; i += 4) sum += Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]); return sum / (n / 4) / 3; };

    await page.click('#btn-menu'); await page.click('#m-display');
    const filters = await page.evaluate(() => [...document.querySelectorAll('#filter-select option')].map((option) => option.value));
    const resolutions = await page.evaluate(() => [...document.querySelectorAll('#resolution-select option')].map((option) => option.value));

    // Every filter, at the resolution that matches the display.
    await page.selectOption('#resolution-select', 'auto');
    const results = {};
    let reference = null;
    let smooth = null;
    const failed = [];
    for (const filter of filters) {
      await page.selectOption('#filter-select', filter);
      await page.evaluate(() => document.getElementById('display').close());
      await sleep(1500);
      const png = await shot();
      if (filter === 'nearest') reference = png;
      if (filter === 'linear') smooth = png;
      const lit = brightness(png);
      const diff = reference && filter !== 'nearest' ? difference(reference, png) : 0;
      // A shader that failed to compile falls back to plain smoothing, so a
      // shader filter must differ from that too.
      const versusSmooth = smooth && filter !== 'linear' && filter !== 'nearest' ? difference(smooth, png) : 1;
      results[filter] = `${lit.toFixed(0)}/${diff.toFixed(1)}/${versusSmooth.toFixed(2)}`;
      if (lit < 15 || (filter !== 'nearest' && diff < 0.05) || versusSmooth < 0.02) failed.push(filter);
      if (filter === 'fsr' || filter === 'fsr_sharp' || filter === 'nearest') fs.writeFileSync(path.join(outDir, `${name}-display-${filter}.png`), PNG.sync.write(png));
      await page.click('#btn-menu'); await page.click('#m-display');
    }

    // Speed with the heaviest filter at display resolution.
    await page.selectOption('#filter-select', 'fsr_sharp');
    await page.evaluate(() => document.getElementById('display').close());
    const heavy = await measure(page, 8, (down) => (down ? page.keyboard.down('ArrowLeft') : page.keyboard.up('ArrowLeft')));
    await page.click('#btn-menu'); await page.click('#m-display');

    // Each resolution resizes the canvas.
    const sizes = {};
    let sizesOk = true;
    for (const resolution of resolutions) {
      await page.selectOption('#resolution-select', resolution);
      await sleep(900);
      const size = await page.evaluate(() => ({ want: window.eka2l1Page.surface, got: [document.getElementById('canvas').width, document.getElementById('canvas').height] }));
      sizes[resolution] = `${size.got[0]}x${size.got[1]}`;
      if (size.got[0] !== size.want.width || size.got[1] !== size.want.height) sizesOk = false;
      if (resolution !== 'auto' && size.got[0] !== 176 * Number(resolution)) sizesOk = false;
    }

    // The choice is kept for the next visit.
    await page.selectOption('#filter-select', 'fsr');
    await page.selectOption('#resolution-select', '4');
    await page.reload();
    await waitRunning(page);
    await sleep(1500);
    const kept = await page.evaluate(() => window.eka2l1Page.surface);
    await page.evaluate(() => { localStorage.removeItem('eka2l1.settings.v1'); });
    await context.close();

    const pass = failed.length === 0 && sizesOk && heavy.fps >= 15 && kept.filter === 'fsr' && kept.width === 704;
    return { pass, filters: filters.length, broken: failed.join(',') || 'none', brightnessVsNearestVsSmooth: JSON.stringify(results), sizes: JSON.stringify(sizes),
      fpsFsrSharp: heavy.fps, graphicsMsFsrSharp: heavy.graphicsMsPerFrame, keptAfterReload: `${kept.filter} ${kept.width}x${kept.height}`, errors: log.length };
  },

  async urlload(browser, name) {
    // No parameters: the page offers the loader. Type the URLs and press the button.
    const { context, page, log } = await open(browser, { url: `${base}/` });
    await page.waitForSelector('#setup:not([hidden])', { timeout: 60000 });
    const playHidden = await page.evaluate(() => document.getElementById('btn-play').hidden);
    await page.fill('#fw-url', `${base}/local/NGAGE.ROM`);
    await page.fill('#game-url', `${base}/local/shadowkey.zip`);
    const t0 = Date.now();
    await page.click('#btn-load-url');
    await waitRunning(page);
    const loadMs = Date.now() - t0;
    const address = await page.evaluate(() => location.search);
    const linked = address.includes('game=') && address.includes('fw=');

    // The address now starts the game by itself.
    await page.reload();
    const again = await waitRunning(page);

    // A bad URL is reported, and the loader comes back.
    await page.click('#btn-menu'); await page.click('#m-load');
    await page.waitForSelector('#setup:not([hidden])');
    const fwAsked = await page.evaluate(() => !document.getElementById('fw-url-row').hidden);
    await page.fill('#game-url', `${base}/local/missing.zip`);
    await page.click('#btn-load-url');
    await page.waitForFunction(() => document.getElementById('status').classList.contains('error'), null, { timeout: 30000 });
    const badMessage = await page.evaluate(() => document.getElementById('status').textContent);
    const setupBack = await page.evaluate(() => !document.getElementById('setup').hidden);
    await context.close();

    // A site config offers one-click Play.
    const site = await open(browser, { url: 'about:blank' });
    await site.page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ title: 'Shadowkey', fw: '/local/NGAGE.ROM', game: '/local/shadowkey.zip' }) }));
    await site.page.goto(`${base}/`);
    await site.page.waitForSelector('#btn-play:not([hidden])', { timeout: 60000 });
    const playLabel = await site.page.evaluate(() => document.getElementById('btn-play').textContent);
    await site.page.click('#btn-play');
    await waitRunning(site.page);
    const playAdvances = await framesAdvance(site.page);
    await site.context.close();

    const pass = playHidden && linked && again.ms < 30000 && !fwAsked && /download failed \(404\)/.test(badMessage) && setupBack
      && playLabel === 'Play Shadowkey' && playAdvances > 0;
    return { pass, loadMs, addressUpdated: linked, reloadStartsGameMs: again.ms, firmwareAskedAgain: fwAsked, badUrlMessage: badMessage.slice(0, 60),
      loaderReturns: setupBack, playButton: playLabel, playRuns: playAdvances > 0, errors: log.length };
  },

  async saves(browser, name) {
    const { context, page, log } = await open(browser);
    await waitRunning(page);
    await page.mouse.click(5, 5);
    const press = keyboardPress(page);
    await toGameplay(press);

    const SAVE = 'C:/System/Apps/6R51/game00.sav';
    const readSave = () => page.evaluate(async (file) => {
      const res = await window.eka2l1.request('GET', '/v1/files?path=' + encodeURIComponent(file));
      return res.ok ? Array.from(res.body) : null;
    }, SAVE);
    const menuKey = async (code, wait = 700) => { await page.keyboard.down(code); await sleep(120); await page.keyboard.up(code); await sleep(wait); };

    // Save from the game's own menu: menu, Save Game, first slot, dismiss, back.
    const beforeSave = await readSave();
    await menuKey('Backspace', 1500);
    await menuKey('ArrowDown');
    await menuKey('Enter', 1500);
    await menuKey('Enter', 3000);
    await guestShot(page, path.join(outDir, `${name}-saves-guest.png`));
    await menuKey('Enter', 1500);
    await menuKey('Enter', 2000);
    const saved = await readSave();

    // Export through the Saves panel.
    await page.click('#btn-menu'); await page.click('#m-saves');
    await page.waitForSelector('#saves[open]');
    const listed = await page.evaluate(() => [...document.querySelectorAll('#save-list tbody tr td:first-child')].map((td) => td.textContent));
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#saves-export')]);
    const zipPath = path.join(outDir, `${name}-saves-export.zip`);
    await download.saveAs(zipPath);
    const zipList = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n');
    const zipped = Array.from(execFileSync('unzip', ['-p', zipPath, 'System/Apps/6R51/game00.sav']));

    // Lose the save, then import the export.
    await page.evaluate(async () => {
      for (const file of ['game00.sav', 'current.sav']) {
        await window.eka2l1.request('DELETE', '/v1/files?path=' + encodeURIComponent('C:/System/Apps/6R51/' + file));
      }
    });
    const gone = await readSave();
    await page.setInputFiles('#save-import-file', zipPath);
    await page.waitForFunction(() => /Imported/.test(document.getElementById('saves-status').textContent), null, { timeout: 30000 });
    const importMessage = await page.evaluate(() => document.getElementById('saves-status').textContent);
    const restored = await readSave();

    // A zip that tries to write outside the save folder is refused.
    const evil = path.join(outDir, `${name}-saves-evil.zip`);
    fs.rmSync(evil, { force: true });
    const stage = fs.mkdtempSync(path.join(outDir, 'evil-'));
    fs.mkdirSync(path.join(stage, 'System', 'Data'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'System', 'Data', 'x.dat'), 'x');
    execFileSync('zip', ['-q', '-r', evil, 'System'], { cwd: stage });
    fs.rmSync(stage, { recursive: true, force: true });
    await page.setInputFiles('#save-import-file', evil);
    await page.waitForFunction(() => /no files under/.test(document.getElementById('saves-status').textContent), null, { timeout: 30000 });
    const outside = await page.evaluate(async () => (await window.eka2l1.request('GET', '/v1/files?path=' + encodeURIComponent('C:/System/Data/x.dat'))).status);
    fs.rmSync(evil, { force: true });
    await page.evaluate(() => document.getElementById('saves').close());

    // The save is still there after a reload (stored by the import).
    await page.reload();
    await waitRunning(page);
    const afterReload = await readSave();
    await context.close();

    const same = (x, y) => Boolean(x && y && x.length === y.length && x.every((v, i) => v === y[i]));
    const pass = beforeSave === null && Boolean(saved) && saved.length > 1000 && listed.includes('6R51/game00.sav') && zipList.includes('System/Apps/6R51/game00.sav')
      && same(saved, zipped) && gone === null && same(saved, restored) && outside === 404 && same(saved, afterReload);
    return { pass, inGameSaveBytes: saved ? saved.length : 0, listedFiles: listed.length, zipEntries: zipList.length, exportMatches: same(saved, zipped),
      deleted: gone === null, importMessage: importMessage.slice(0, 40), importRestores: same(saved, restored), outsidePathRefused: outside === 404,
      survivesReload: same(saved, afterReload), errors: log.length };
  },
};

// --- runner ------------------------------------------------------------------

const browsers = String(args.browsers || 'chrome,firefox').split(',');
const tests = String(args.tests || 'support,boot,gameplay,persist,session,gamepad,touch,controls,display,urlload,saves').split(',');
const touchDevices = String(args.devices || 'phone,phone-landscape,iphone,tablet,tablet-landscape').split(',');

const results = [];
for (const browserName of browsers) {
  const config = BROWSERS[browserName];
  const browser = await config.launch();
  const version = browser.version();

  for (const test of tests) {
    // Touch layouts run once per device profile where the browser can emulate
    // them, and once on a desktop-sized window otherwise.
    const variants = test === 'touch' ? (config.mobileEmulation ? touchDevices : ['desktop']) : [null];
    for (const device of variants) {
      const label = device ? `${test}:${device}` : test;
      const started = Date.now();
      let outcome;
      try {
        outcome = await TESTS[test](browser, browserName, device);
      } catch (error) {
        outcome = { pass: false, error: String(error && error.message ? error.message : error).split('\n')[0] };
      }
      const record = { browser: `${browserName} ${version}`, test: label, seconds: Math.round((Date.now() - started) / 1000), ...outcome };
      results.push(record);
      console.log(`${record.pass ? 'PASS' : 'FAIL'}  ${record.browser}  ${label}  ${JSON.stringify(outcome)}`);
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    }
  }

  await browser.close();
}

const lines = ['| Browser | Test | Result | Details |', '|---|---|---|---|'];
for (const r of results) {
  const { browser, test, pass, seconds, ...rest } = r;
  lines.push(`| ${browser} | ${test} | ${pass ? 'pass' : 'FAIL'} | ${Object.entries(rest).map(([k, v]) => `${k}: ${v}`).join('; ')} |`);
}
fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n') + '\n');
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed; details in ${outDir}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
