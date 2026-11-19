// Plays one game into gameplay with its catalogue key script, then records the
// game for a few seconds while holding the keys in PLAY below.
//
//   node tools/demo/capture.mjs <slug> [--seconds 7] [--port 8080 | --site https://n-ga.ge] [--stills4x]
//
// --port   the bare player of a local dev server (tools/web/devserver.py),
//          which loads the game from testdata/ (default 8080)
// --site   a site's player instead, /play/?g=<slug>; its 3D resolution is set
//          to 4× in the player's saved settings, so an enhanced game draws its
//          3D at 4× (the bare player has no catalogue and does not)
// --stills4x  with --site: before recording, save the same pose at the game's
//          own resolution and at 4× as <work>/sk-1x.png and <work>/sk-4x.png
//
// Output: <work>/clips/<slug>/{frames,times.json,rect.json}; then
// python3 -I tools/demo/cfr.py <work>/clips/<slug>.
import path from 'node:path';
import { WORK, entry, hideSoundHint, keyboard, launch, options, pause, playScript, running, cast } from './common.mjs';

const args = options();
const slug = args._[0];
if (!slug) throw new Error('usage: capture.mjs <slug> [--seconds N] [--port N | --site URL] [--stills4x]');
const seconds = Number(args.seconds || 7);
const out = path.join(WORK, 'clips', slug);

// What is held while recording: a loop of [keys held together, milliseconds].
const PLAY = {
  'rayman-3': [[['right'], 1400], [['right', '5'], 300], [['right'], 900], [[], 200], [['left'], 500], [['right', '5'], 300], [['right'], 1200]],
  sonicn: [[['right'], 1800], [['right', '5'], 300], [['right'], 1500], [[], 150]],
  'super-monkey-ball': [[['up'], 2200], [['up', 'left'], 500], [['up'], 1500], [['up', 'right'], 400]],
  'crash-nitro-kart': [[['5'], 900], [['5', 'left'], 500], [['5'], 700], [['5', 'right'], 600], [['5', '2'], 200]],
  glimmerati: [[['5'], 1200], [['5', 'left'], 500], [['5'], 800], [['5', 'right'], 500]],
  'tony-hawks-pro-skater': [[['up'], 900], [['up', '5'], 700], [['up'], 500], [['left'], 300]],
  // A short turn each way: the room, a wall, the room again.
  shadowkey: [[['right'], 450], [[], 700], [['left'], 450], [[], 700]],
};

const browser = await launch();
// 720 wide: the bare player's canvas is then 704, four times the screen's 176.
const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
page.on('pageerror', (error) => console.log('pageerror', error.message));
if (args.site) {
  await page.addInitScript(() => {
    try { localStorage.setItem('eka2l1.settings.v1', JSON.stringify({ display: { enhance: '4', enhanceFilter: 'nearest' } })); } catch { /* defaults */ }
  });
  await page.goto(`${String(args.site).replace(/\/+$/, '')}/play/?g=${slug}`);
} else {
  await page.goto(`http://127.0.0.1:${args.port || 8080}/?fw=/local/NGAGE.ROM&game=/local/games/${slug}.zip&persist=0`);
}
await running(page);
const { key, press } = await keyboard(page);
console.log(`${slug}: running, replaying its script`);
await playScript(press, entry(slug).test.script);
await hideSoundHint(page);
await pause(500);

if (args.stills4x) {
  const shot = async (file) => {
    const r = await page.evaluate(() => { const b = document.querySelector('#canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const h = r.w * 208 / 176;   // the picture inside the canvas, less a row at each edge
    await page.screenshot({ path: path.join(WORK, file), clip: { x: r.x, y: r.y + (r.h - h) / 2 + 1, width: r.w, height: h - 2 } });
  };
  const scale = (s) => page.evaluate(async (v) => (await window.eka2l1.request('PATCH', '/v1/enhance', JSON.stringify({ scale: v }))).status, s);
  await scale(0); await pause(1500); await shot('sk-1x.png');
  await scale(4); await pause(2500); await shot('sk-4x.png');
}

const stop = await cast(page, out);
const steps = PLAY[slug] || [[[], 1000]];
const until = Date.now() + seconds * 1000;
let held = new Set();
for (let i = 0; Date.now() < until; i = (i + 1) % steps.length) {
  const [keys, ms] = steps[i];
  const next = new Set(keys);
  for (const k of held) if (!next.has(k)) await key(k, false);
  for (const k of next) if (!held.has(k)) await key(k, true);
  held = next;
  await pause(Math.min(ms, until - Date.now()));
}
for (const k of held) await key(k, false);
await stop();
await browser.close();
