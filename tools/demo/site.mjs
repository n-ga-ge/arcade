// What the composition takes from the live front page: its markup (the
// masthead, the search and filters, every game card) in <work>/comp-data.js,
// its style sheet as <work>/site.css, and every card's screenshot in
// <work>/shots/<slug>.png. Scripts are stripped and links emptied: the
// composition only shows the page.
//
//   node tools/demo/site.mjs [--site https://n-ga.ge]
import fs from 'node:fs';
import path from 'node:path';
import { WORK, launch, options } from './common.mjs';

const site = String(options().site || 'https://n-ga.ge').replace(/\/+$/, '');
fs.mkdirSync(path.join(WORK, 'shots'), { recursive: true });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' });
await page.goto(`${site}/`, { waitUntil: 'networkidle' });
const dom = await page.evaluate(() => {
  const strip = (el) => { const copy = el.cloneNode(true); copy.querySelectorAll('script').forEach((s) => s.remove()); return copy.outerHTML; };
  return {
    defs: strip(document.querySelector('svg.defs')),
    masthead: strip(document.querySelector('header.masthead')),
    controls: strip(document.querySelector('#browse')),
    grid: strip(document.querySelector('#grid')),
    css: [...document.styleSheets].map((s) => s.href).find(Boolean),
  };
});
const fix = (html) => html
  .replace(/src="\/catalog\/shots\/([a-z0-9-]+)\.png[^"]*"/g, 'src="shots/$1.png"')
  .replace(/ loading="lazy"| decoding="async"/g, '')
  .replace(/href="\/[^"]*"/g, 'href="#"');
const data = Object.fromEntries(['defs', 'masthead', 'controls', 'grid'].map((k) => [k, fix(dom[k])]));
fs.writeFileSync(path.join(WORK, 'comp-data.js'), `window.DATA = ${JSON.stringify(data)};\n`);

const get = async (url) => { const res = await fetch(url); if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`); return Buffer.from(await res.arrayBuffer()); };
fs.writeFileSync(path.join(WORK, 'site.css'), await get(dom.css));
const slugs = [...data.grid.matchAll(/data-slug="([a-z0-9-]+)"/g)].map((m) => m[1]);
for (const slug of slugs) {
  try { fs.writeFileSync(path.join(WORK, 'shots', `${slug}.png`), await get(`${site}/catalog/shots/${slug}.png`)); }
  catch (error) { console.log(`no screenshot for ${slug}: ${error.message}`); }
}
console.log(`comp-data.js, site.css and ${slugs.length} screenshots in ${WORK}`);
await browser.close();
