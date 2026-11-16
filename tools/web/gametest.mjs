// TEMPORARY stand-in for unit 5's per-game test runner, used once to prove the
// CI matrix. It does not start the emulator: it checks that the job has the
// player and a working browser, takes a screenshot, and writes a result.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const slug = arg('--game');
const out = arg('--out');
const started = Date.now();
fs.mkdirSync(out, { recursive: true });
const entry = JSON.parse(fs.readFileSync(`catalog/games/${slug}.json`, 'utf8'));
const wasm = fs.statSync('eka2l1/build/web/bin/eka2l1_web.wasm').size;
const fetched = fs.existsSync(`testdata/games/${slug}.zip`) && fs.existsSync('testdata/NGAGE.ROM');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 352, height: 416 } });
await page.setContent(`<body style="background:#123;color:#fff;font:20px sans-serif">${entry.title}<br>stand-in</body>`);
await page.screenshot({ path: path.join(out, `${slug}.png`) });
const version = browser.version();
await browser.close();

// Two games fail on purpose, to show that the others and the status job go on.
const pass = fetched && !['ashen', 'pandemonium'].includes(slug);
fs.writeFileSync(path.join(out, `${slug}.json`), JSON.stringify({
  slug, pass, expect: 'boots', reached: pass ? 'boots' : 'broken',
  seconds: (Date.now() - started) / 1000, shot: `${slug}.png`,
  ...(pass ? {} : { error: 'stand-in failure' }),
}, null, 2));
console.log(`${slug}: ${pass ? 'pass' : 'FAIL'} (stand-in; player wasm ${wasm} bytes, chromium ${version}, cores ${(await import('node:os')).cpus().length})`);
process.exit(pass ? 0 : 1);
