#!/usr/bin/env node
// Draws the site's icons and its share image from two sources, so that they
// all match: site/favicon.svg (the memory card with the "n") and the pixel
// wordmark in site/index.html's masthead.
//
//   . tools/env.sh && node tools/site/brand.mjs [--out site] [--only og]
//
// Writes into site/ (the files are committed; the site build only copies them):
//   favicon.ico            16, 32 and 48 pixels, for whatever asks for /favicon.ico
//   apple-touch-icon.png   180 pixels on the masthead's dark plate (iOS fills transparency with black)
//   icon-192.png, icon-512.png   the web app manifest's icons, transparent
//   icon-maskable-512.png  the card inside the manifest's safe zone, on the plate
//   og.png                 1200x630, the picture a link to the site shows in chats and social posts
//
// Rendered in Chrome for Testing (.toolchain/chrome) or Playwright's Chromium.
// Text in og.png is set in Ubuntu Sans, which is installed on this machine;
// on a machine without it the picture falls back to another sans and should
// not be committed. Run it again after changing favicon.svg or the wordmark.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const out = path.resolve(flag('--out') || path.join(root, 'site'));
const only = flag('--only');

const favicon = fs.readFileSync(path.join(root, 'site', 'favicon.svg'), 'utf8');
const front = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
const wordmark = front.match(/<svg class="wordmark"[\s\S]*?<\/svg>/);
if (!wordmark) { console.error('no <svg class="wordmark"> in site/index.html'); process.exit(1); }

const PLATE = '#1c1f25';
const INK = '#f1efe8';
const DIM = '#a9aeb9';
const SIGNAL = '#ff7a1a';
const iconUrl = 'data:image/svg+xml;base64,' + Buffer.from(favicon).toString('base64');

// One square icon: the card drawn at `inset` of the side, on `ground` (or transparent).
const icon = (size, { ground = null, inset = 1 } = {}) => `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${ground || 'transparent'}; }
  body { display: grid; place-items: center; }
  img { width: ${Math.round(size * inset)}px; height: ${Math.round(size * inset)}px; image-rendering: pixelated; }
</style></head><body><img src="${iconUrl}"></body></html>`;

// The share image: the masthead, enlarged. Dark plate with the dot matrix
// fading in to the right, the wordmark, the front page's lede, and a stack of
// memory cards whose screen shows the signal bars of the status labels.
const og = `<!doctype html><html><head><style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative; font-family: "Ubuntu Sans", "Ubuntu", system-ui, sans-serif; color: ${INK};
    background-color: ${PLATE};
    background-image: linear-gradient(90deg, ${PLATE} 30%, transparent 85%), radial-gradient(circle at 2px 2px, rgb(255 255 255 / .16) 2px, transparent 2.6px);
    background-size: auto, 14px 14px;
  }
  body::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 14px; background: ${SIGNAL}; }
  .text { position: absolute; left: 84px; top: 128px; width: 700px; }
  .wordmark { display: block; width: 510px; height: 119px; }
  .wm-ink { fill: ${INK}; } .wm-dot { fill: ${SIGNAL}; }
  h1 { margin: 56px 0 0; font-size: 57px; line-height: 1.08; font-weight: 750; letter-spacing: -.015em; }
  p { margin: 30px 0 0; font: 600 21px/1.4 "Ubuntu Sans Mono", "Ubuntu Mono", ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; color: ${DIM}; }
  p b { color: ${SIGNAL}; font-weight: inherit; }
  .cards { position: absolute; right: 84px; top: 112px; width: 270px; height: 360px; }
  .card { position: absolute; inset: 0; clip-path: polygon(0 0, calc(100% - 58px) 0, 100% 58px, 100% 100%, 0 100%); }
  .back2 { background: #3b414d; transform: translate(-56px, 34px) rotate(-9deg); }
  .back1 { background: #5b6270; transform: translate(-28px, 16px) rotate(-4deg); }
  .front { background: ${SIGNAL}; }
  .label { position: absolute; left: 27px; right: 27px; top: 27px; height: 224px; background: #0c1114; box-shadow: inset 0 0 0 6px #23272f; display: grid; place-items: center; }
  .label svg { width: 132px; height: 113px; fill: ${SIGNAL}; }
  .pins { position: absolute; left: 27px; right: 27px; bottom: 24px; height: 50px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  .pins i { background: #c45a0a; }
</style></head><body>
  <div class="text">
    ${wordmark[0].replace(/ width="\d+" height="\d+"/, '')}
    <h1>N-Gage games,<br>playable in the browser.</h1>
    <p>Pick a card <b>&rsaquo;</b> play</p>
  </div>
  <div class="cards" aria-hidden="true">
    <div class="card back2"></div>
    <div class="card back1"></div>
    <div class="card front">
      <div class="label"><svg viewBox="0 0 14 12"><path d="M0 8h3v4H0zM5.5 4h3v8h-3zM11 0h3v12h-3z"/></svg></div>
      <div class="pins"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>
  </div>
</body></html>`;

// favicon.ico: an ICO directory holding PNG images, which every browser that
// still asks for the file reads.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at); header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2); header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const TOOLCHAIN = process.env.EKA2L1_TOOLCHAIN || '';
const chromeRoot = path.join(TOOLCHAIN, 'chrome', 'chrome');
const exe = TOOLCHAIN && fs.existsSync(chromeRoot) ? path.join(chromeRoot, fs.readdirSync(chromeRoot).sort().pop(), 'chrome-linux64', 'chrome') : undefined;
const browser = await chromium.launch({ executablePath: exe, headless: true });
async function render(html, width, height = width) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: 'png', omitBackground: true });
  await page.close();
  return png;
}
const write = (name, data) => { fs.writeFileSync(path.join(out, name), data); console.log(`${path.join(out, name)}  ${data.length} bytes`); };

fs.mkdirSync(out, { recursive: true });
try {
  if (!only || only === 'og') write('og.png', await render(og, 1200, 630));
  if (!only || only === 'icons') {
    write('icon-192.png', await render(icon(192), 192));
    write('icon-512.png', await render(icon(512), 512));
    // iOS rounds the corners itself; 4/5 of the side keeps the card clear of them.
    write('apple-touch-icon.png', await render(icon(180, { ground: PLATE, inset: 0.6 }), 180));
    // A maskable icon must keep its content inside the middle circle of 80%.
    write('icon-maskable-512.png', await render(icon(512, { ground: PLATE, inset: 0.55 }), 512));
    const sizes = [16, 32, 48];
    write('favicon.ico', ico(await Promise.all(sizes.map(async (size) => ({ size, png: await render(icon(size), size) })))));
  }
} finally {
  await browser.close();
}
