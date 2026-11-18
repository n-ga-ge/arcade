#!/usr/bin/env python3
"""Write <work>/mpcap.mjs: a copy of tools/web/nettest.mjs whose tier 3 also
records what the demo video shows of multiplayer.

  python3 -I tools/demo/mpcap.py
  CAST_DIR=<work>/mp node <work>/mpcap.mjs --out <work>/mp-out --tier 3 \\
      --game rayman-3 --site http://127.0.0.1:<port> --browser chrome

Tier 3 is the whole path a visitor takes: page A hosts a room in the player's
Multiplayer dialog, page B opens the invite link, and the two games play over
the site's relay. Run it against a local build of the site
(tools/web/devserver.py --site dist <port>), not the deployed one, so that no
test room shows up in the public "Open rooms" list. Added to the test:

  - page A is recorded while it clicks Menu, Multiplayer and "Host a room"
    (mp/host/), ticks "List this room publicly" and is shot with the dialog
    open (mp/host-dialog.png, mp/host-dialog-el.png: the dialog alone)
  - the front page is shot with the room listed (mp/front-rooms.png and
    mp/front-rooms-el.png: the "Open rooms" section)
  - page B is shot once it has joined (mp/joiner-arrived.png, which has the
    "<code> · 2 players" chip at its top right)
  - once the match runs, both pages are recorded for about 12 seconds while
    both players move (mp/match-a/, mp/match-b/)

The dialog shows the invite link with the local address; the composition
covers it with the site's own form of the link. The players are named Ann
and Bo, the test's own names. When nettest.mjs changes so that a piece below
no longer matches, this stops and says which one: adjust the piece.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.abspath(os.environ.get("DEMO_WORK") or os.path.join(ROOT, "demo-work"))

PIECES = [
    # The copy lives in <work>, outside the checkout's tools/, so it names the
    # Playwright that tools/env.sh links into the checkout, and the checkout.
    ("import { chromium, firefox } from 'playwright';",
     f"import {{ chromium, firefox }} from '{ROOT}/node_modules/playwright/index.mjs';"),
    ("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');",
     f"const ROOT = {ROOT!r};"),
    # Pages the size of the player in a laptop's window, text at 1.5x.
    ("newContext({ viewport: { width: 900, height: 700 } });",
     "newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });"),
    ("class Player {", r"""// --- demo video: the screencast recorder ------------------------------------------
const CAST = process.env.CAST_DIR;
async function cast(page, name) {
  const dir = path.join(CAST, name, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const times = [];
  cdp.on('Page.screencastFrame', (f) => {
    fs.writeFileSync(path.join(dir, `f${String(times.length).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    times.push(f.metadata.timestamp);
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  console.log('recording', name);
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(200);
    fs.writeFileSync(path.join(CAST, name, 'times.json'), JSON.stringify(times));
    const rect = await page.evaluate(() => { const r = document.querySelector('#canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    fs.writeFileSync(path.join(CAST, name, 'rect.json'), JSON.stringify(rect));
    console.log('recorded', name, times.length, 'frames');
  };
}
const hideSoundHint = (page) => page.evaluate(() => { const o = document.getElementById('overlay'); if (o) o.hidden = true; });

class Player {"""),
    # Hosting: slowly, and recorded.
    ("""    await a.page.click('#btn-menu', { timeout: 10000 });
    await a.page.click('#m-multiplayer', { timeout: 10000 });
    await a.page.click('#mp-host', { timeout: 10000 });
    const code = await until(""", """    await sleep(6000);
    await hideSoundHint(a.page);
    const stopHost = await cast(a.page, 'host');
    await sleep(1200);
    await a.page.click('#btn-menu', { timeout: 10000 });
    await sleep(1300);
    await a.page.click('#m-multiplayer', { timeout: 10000 });
    await sleep(1800);
    await a.page.click('#mp-host', { timeout: 10000 });
    const code = await until("""),
    # The listed room, the dialog, the front page.
    ("""    await a.page.screenshot({ path: path.join(outDir, 'tier3-dialog.png') });
    await a.ask(() => document.getElementById('multiplayer').close());""", """    await sleep(1500);
    await a.page.click('#mp-public', { timeout: 10000 }).catch((e) => console.log('List this room publicly:', e.message));
    await sleep(2500);
    await stopHost();
    await a.page.screenshot({ path: path.join(CAST, 'host-dialog.png') });
    await a.page.locator('#multiplayer').screenshot({ path: path.join(CAST, 'host-dialog-el.png') });
    const front = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: 'dark' })).newPage();
    await front.goto(`${site}/`);
    await sleep(5000);
    await front.screenshot({ path: path.join(CAST, 'front-rooms.png') });
    await front.locator('#rooms').screenshot({ path: path.join(CAST, 'front-rooms-el.png') }).catch((e) => console.log('Open rooms:', e.message));
    await front.context().close();
    await a.ask(() => document.getElementById('multiplayer').close());"""),
    ("""    await b.open(slug, `&room=${code}`, { multiplayer: { name: b.name } });
    await b.running(START_MS, false);""", """    await b.open(slug, `&room=${code}`, { multiplayer: { name: b.name } });
    await b.running(START_MS, false);
    await sleep(3000);
    await b.page.screenshot({ path: path.join(CAST, 'joiner-arrived.png') });"""),
    # The match, on both pages.
    ("""    if (plan.playing) {
      const state = await until(() => a.net(), plan.playing, 30000);""", """    await hideSoundHint(a.page); await hideSoundHint(b.page);
    {
      const stopA = await cast(a.page, 'match-a');
      const stopB = await cast(b.page, 'match-b');
      const moves = (p, d) => p.play([
        { key: d, hold: 1400, wait: 150 }, { key: '5', hold: 300, wait: 300 }, { key: d === 'right' ? 'left' : 'right', hold: 900, wait: 150 },
        { key: '7', hold: 200, wait: 400 }, { key: d, hold: 1600, wait: 150 }, { key: '5', hold: 300, wait: 600 },
        { key: 'up', hold: 900, wait: 150 }, { key: d, hold: 1500, wait: 150 }, { key: '7', hold: 200, wait: 400 },
        { key: 'down', hold: 800, wait: 150 }, { key: d === 'right' ? 'left' : 'right', hold: 1500, wait: 300 }]);
      await Promise.all([moves(a, 'right'), moves(b, 'left')]);
      await stopA(); await stopB();
    }
    if (plan.playing) {
      const state = await until(() => a.net(), plan.playing, 30000);"""),
]

source = open(os.path.join(ROOT, "tools", "web", "nettest.mjs"), encoding="utf-8").read()
for old, new in PIECES:
    if source.count(old) != 1:
        sys.exit(f"mpcap.py: tools/web/nettest.mjs no longer has this exactly once:\n{old}")
    source = source.replace(old, new)
os.makedirs(WORK, exist_ok=True)
with open(os.path.join(WORK, "mpcap.mjs"), "w", encoding="utf-8") as f:
    f.write(source)
print(os.path.join(WORK, "mpcap.mjs"))
