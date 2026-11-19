// Draws the composition (tools/demo/comp.html, copied into <work> next to the
// footage it reads) frame by frame in headless Chrome.
//
//   node tools/demo/render.mjs stills <dir> <t> [<t> ...]   PNGs of chosen moments; t = -1 is the poster
//   node tools/demo/render.mjs video <out.mp4>               every frame, piped to ffmpeg (H.264, CRF 16, silent)
//
// Every frame is a pure function of its time (render(t) in comp.html), and
// each waits for its images to decode, so a slow machine only renders slower.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, ROOT, WORK, launch } from './common.mjs';

const FPS = 30;
const DURATION = 38;   // keep in step with comp.html and music.py
const [mode, out, ...times] = process.argv.slice(2);
if (!['stills', 'video'].includes(mode) || !out) throw new Error('usage: render.mjs stills <dir> <t>... | video <out.mp4>');

fs.copyFileSync(path.join(ROOT, 'tools', 'demo', 'comp.html'), path.join(WORK, 'comp.html'));
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark' });
page.on('pageerror', (error) => console.log('pageerror', error.message));
await page.goto(`file://${path.join(WORK, 'comp.html')}`);
await page.evaluate(() => window.ready);
const frame = async (t) => {
  await page.evaluate((v) => window.render(v), t);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

if (mode === 'stills') {
  fs.mkdirSync(out, { recursive: true });
  for (const t of times) {
    await frame(Number(t));
    await page.screenshot({ path: path.join(out, `t${Number(t).toFixed(2)}.png`) });
  }
} else {
  const ff = spawn(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < DURATION * FPS; i++) {
    await frame(i / FPS);
    const png = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise((resolve) => ff.stdin.once('drain', resolve));
    if (i % 150 === 0) console.log(`frame ${i} of ${DURATION * FPS}`);
  }
  ff.stdin.end();
  await new Promise((resolve) => ff.on('close', resolve));
}
await browser.close();
