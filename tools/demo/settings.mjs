// The player's own dialogs, from a site: the game under several scaling
// filters with the Display dialog for each, a key added in the Controls
// dialog, and the Saves dialog.
//
//   node tools/demo/settings.mjs [--site https://n-ga.ge] [--game sonicn]
//
// Output in <work>/settings/: filter-<id>/ (recordings, for cfr.py),
// display-<id>.png, controls-{0,1,2}.png (before, "Press a key…", after),
// controls-plus.json and controls-box.json (where the + is, for the cursor),
// saves.png, menu.png. Element shots are at 1.5× for sharp text.
import fs from 'node:fs';
import path from 'node:path';
import { WORK, cast, entry, hideSoundHint, keyboard, launch, options, pause, playScript, running } from './common.mjs';

const args = options();
const site = String(args.site || 'https://n-ga.ge').replace(/\/+$/, '');
const slug = args.game || 'sonicn';
const out = path.join(WORK, 'settings');
fs.mkdirSync(out, { recursive: true });
// The filters shown, in the order the video switches them (ids of #filter-select).
const FILTERS = ['nearest', 'xbrz_freescale', 'fsr', 'CRT-Lottes', 'mmpx'];

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
await page.goto(`${site}/play/?g=${slug}`);
await running(page);
const { key, press } = await keyboard(page);
await playScript(press, entry(slug).test.script);
await hideSoundHint(page);
console.log(`${slug}: in the game`);

// Records while the player runs right and jumps (Sonic N's keys).
async function record(name, ms) {
  const stop = await cast(page, path.join(out, name));
  for (const until = Date.now() + ms; Date.now() < until;) {
    await key('right', true); await pause(1500); await press('5', 250); await pause(300); await key('right', false); await pause(150);
  }
  await stop();
}
const dialog = async (id) => { await page.click('#btn-menu'); await pause(400); await page.click(`#${id}`); await pause(700); };

for (const filter of FILTERS) {
  await dialog('m-display');
  await page.selectOption('#filter-select', filter); await pause(900);
  await page.locator('#display').screenshot({ path: path.join(out, `display-${filter}.png`) });
  await page.keyboard.press('Escape'); await pause(400);
  await record(`filter-${filter}`, 3200);
}

await dialog('m-controls');
await page.locator('#controls').screenshot({ path: path.join(out, 'controls-0.png') });
const plus = page.locator('#controls button', { hasText: '+' }).first();   // keyboard, first row
fs.writeFileSync(path.join(out, 'controls-plus.json'), JSON.stringify(await plus.boundingBox()));
fs.writeFileSync(path.join(out, 'controls-box.json'), JSON.stringify(await page.locator('#controls').boundingBox()));
await plus.click(); await pause(600);
await page.locator('#controls').screenshot({ path: path.join(out, 'controls-1.png') });
await page.keyboard.press('KeyI'); await pause(600);
await page.locator('#controls').screenshot({ path: path.join(out, 'controls-2.png') });
await page.keyboard.press('Escape'); await pause(400);

await dialog('m-saves');
await page.locator('#saves').screenshot({ path: path.join(out, 'saves.png') });
await page.keyboard.press('Escape'); await pause(300);
await page.click('#btn-menu'); await pause(500);
await page.locator('#menu').screenshot({ path: path.join(out, 'menu.png') });
await browser.close();
