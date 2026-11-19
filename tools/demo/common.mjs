// What the demo video's scripts share: where things are, the browser, the
// player's key table, a catalogue entry's key script, and a screencast
// recorder. docs/demo-video.md describes the whole procedure.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Everything the scripts make goes here: footage, frames, stills, the score.
// It holds game footage, so it is ignored by git and must stay out of commits.
export const WORK = path.resolve(process.env.DEMO_WORK || path.join(ROOT, 'demo-work'));
export const FFMPEG = process.env.FFMPEG || path.join(WORK, 'ffmpeg', 'node_modules', 'ffmpeg-static', 'ffmpeg');
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --name value / --flag
export function options(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    out[name] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

// Chrome for Testing from the toolchain, drawing on the GPU, as the suite's "chrome".
export async function launch() {
  const base = path.join(process.env.EKA2L1_TOOLCHAIN || path.join(ROOT, '.toolchain'), 'chrome', 'chrome');
  const version = fs.existsSync(base) ? fs.readdirSync(base).sort().pop() : null;
  const executablePath = version ? path.join(base, version, 'chrome-linux64', 'chrome') : undefined;
  return chromium.launch({ executablePath, headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
}

export const entry = (slug) => JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'games', `${slug}.json`), 'utf8'));

// Resolves once the game has drawn a frame.
export async function running(page, ms = 180000) {
  for (const started = Date.now(); ;) {
    const frames = await page.evaluate(() => { const p = window.eka2l1Page; return p && p.emu && p.emu.module && p.app ? p.emu.frames() : -1; }).catch(() => -1);
    if (frames > 0) return;
    if (Date.now() - started > ms) throw new Error('the game did not start');
    await pause(250);
  }
}

// Key presses by N-Gage key name, straight to the emulator (the page's own
// bindings differ per game). The key table is beside the player's script,
// which on a site is in its per-build folder.
export async function keyboard(page) {
  const codes = await page.evaluate(async () => {
    const app = document.querySelector('script[type="module"][src*="app.js"]');
    return (await import(new URL('eka2l1-client.js', app ? app.src : location.href).href)).KEYS;
  });
  const key = (name, down) => page.evaluate(([code, d]) => window.eka2l1.key(code, d), [codes[name], down]);
  const press = async (name, hold) => { await key(name, true); await pause(hold); await key(name, false); };
  return { key, press };
}

// A catalogue entry's test.script, with the same timing rules as the game test.
export async function playScript(press, script) {
  for (const raw of script) {
    const hold = raw.key ? (raw.hold ?? 120) : 0;
    const wait = raw.wait ?? (raw.key ? 600 : 0);
    for (let i = 0; i < (raw.repeat || 1); i++) {
      if (raw.key) await press(raw.key, hold);
      await pause(wait);
    }
  }
}

// The player's "Click or press a key for sound" would dim the picture.
export const hideSoundHint = (page) => page.evaluate(() => { const o = document.getElementById('overlay'); if (o) o.hidden = true; });

// Records the page with Chrome's screencast: JPEG frames in <dir>/frames, their
// times in <dir>/times.json, the canvas's place in <dir>/rect.json (CSS
// pixels, which is what the screencast's frames are in). cfr.py turns that
// into 30 frames a second. Returns the function that stops it.
export async function cast(page, dir) {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const times = [];
  cdp.on('Page.screencastFrame', (frame) => {
    fs.writeFileSync(path.join(dir, 'frames', `f${String(times.length).padStart(5, '0')}.jpg`), Buffer.from(frame.data, 'base64'));
    times.push(frame.metadata.timestamp);
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await pause(200);
    fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify(times));
    const rect = await page.evaluate(() => { const r = document.querySelector('#canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    fs.writeFileSync(path.join(dir, 'rect.json'), JSON.stringify(rect));
    console.log(`${path.basename(dir)}: ${times.length} frames`);
  };
}
