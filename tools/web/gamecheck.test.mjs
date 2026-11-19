// Tests for gamecheck.mjs: node --test tools/web/gamecheck.test.mjs (or npm test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PERF_NUMBERS, SHOWN_AT, checkScript, difference, gameQuery, likeness, perfFrom, picture, platformOf, scriptMs, stepTiming, targetLevel, verdict } from './gamecheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEYS = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'schema.json'), 'utf8')).$defs.key.enum;

// A width x height PNG; paint(x, y) returns [r, g, b].
function png(width, height, paint) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      image.data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return PNG.sync.write(image);
}

test('an entry with a test passes when it reaches at least the expected level', () => {
  const entry = { status: 'ingame', test: { expect: 'menu', script: [] } };
  assert.deepEqual(verdict(entry, 'menu'), { expect: 'menu', pass: true, better: false });
  assert.deepEqual(verdict(entry, 'ingame'), { expect: 'menu', pass: true, better: true });
  assert.deepEqual(verdict(entry, 'boots'), { expect: 'menu', pass: false, better: false });
  assert.deepEqual(verdict(entry, 'broken'), { expect: 'menu', pass: false, better: false });
});

test('an entry without a test is only looked at', () => {
  const entry = { status: 'untested', test: null };
  assert.deepEqual(verdict(entry, 'boots'), { expect: null, pass: true, better: false });
  assert.deepEqual(verdict(entry, 'broken'), { expect: null, pass: true, better: false });
  assert.equal(targetLevel(entry), 'boots');
});

test('a broken entry passes while broken and says when it did better', () => {
  const entry = { status: 'broken', test: null };
  assert.deepEqual(verdict(entry, 'broken'), { expect: 'broken', pass: true, better: false });
  assert.deepEqual(verdict(entry, 'boots'), { expect: 'broken', pass: true, better: true });
  // Its script, when it has one, is still replayed to see how far it gets.
  const scripted = { status: 'broken', test: { expect: 'menu', script: [] } };
  assert.equal(targetLevel(scripted), 'menu');
  assert.deepEqual(verdict(scripted, 'menu'), { expect: 'broken', pass: true, better: true });
});

test('a run that could not be carried out never passes', () => {
  for (const entry of [{ status: 'untested', test: null }, { status: 'broken', test: null }, { status: 'ingame', test: { expect: 'ingame', script: [] } }]) {
    assert.equal(verdict(entry, null).pass, false);
  }
});

test('scripts are checked before they are replayed', () => {
  checkScript([{ wait: 6000 }, { key: 'ok', hold: 120, wait: 2500, repeat: 4 }, { key: 'star' }, {}], KEYS);
  assert.throws(() => checkScript([{ wait: 1 }, { key: 'fire' }], KEYS), /test\.script\[1\]: unknown key "fire"/);
  assert.throws(() => checkScript([{ key: 'ok', presses: 2 }], KEYS), /unknown field "presses"/);
  assert.throws(() => checkScript([{ key: 'ok', repeat: 0 }], KEYS), /"repeat" must be/);
  assert.throws(() => checkScript([{ wait: '100' }], KEYS), /"wait" must be/);
  assert.throws(() => checkScript({ key: 'ok' }, KEYS), /not a list/);
  assert.throws(() => checkScript(['ok'], KEYS), /not an object/);
});

test('step defaults and script length', () => {
  assert.deepEqual(stepTiming({ key: 'ok' }), { key: 'ok', hold: 120, wait: 600, repeat: 1 });
  assert.deepEqual(stepTiming({ wait: 500 }), { key: null, hold: 0, wait: 500, repeat: 1 });
  assert.deepEqual(stepTiming({ key: 'ok', wait: 0, hold: 50, repeat: 3 }), { key: 'ok', hold: 50, wait: 0, repeat: 3 });
  assert.equal(scriptMs([{ wait: 6000 }, { key: 'ok', wait: 2500, repeat: 4 }]), 6000 + 4 * 2620);
});

test('the Shadowkey entry has a script the runner accepts', () => {
  const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'games', 'shadowkey.json'), 'utf8'));
  checkScript(entry.test.script, KEYS);
  assert.ok(scriptMs(entry.test.script) > 0);
});

test('a single colour is blank, a picture is not', () => {
  assert.equal(picture(png(176, 208, () => [0, 0, 0])).blank, true);
  assert.equal(picture(png(176, 208, () => [255, 255, 255])).blank, true);
  // A handful of stray pixels is still blank.
  assert.equal(picture(png(176, 208, (x, y) => (y === 0 && x < 20 ? [255, 0, 0] : [0, 0, 0]))).blank, true);
  // A line of text on a plain background is a picture.
  const text = picture(png(176, 208, (x, y) => (y >= 100 && y < 108 && x >= 40 && x < 136 && (x + y) % 2 ? [255, 255, 255] : [0, 0, 0])));
  assert.equal(text.blank, false);
  assert.equal(text.colours, 2);
  const noise = picture(png(176, 208, (x, y) => [x, y, (x * y) & 255]));
  assert.equal(noise.blank, false);
  assert.ok(noise.dominant < 0.01);
  assert.deepEqual([noise.width, noise.height], [176, 208]);
});

test('bytes that are not a PNG count as blank', () => {
  const result = picture(Buffer.from('not a png'));
  assert.equal(result.blank, true);
  assert.ok(result.invalid);
});

test('difference is the share of changed pixels', () => {
  const base = png(100, 100, (x, y) => [x, y, 0]);
  assert.equal(difference(base, base), 0);
  assert.equal(difference(base, png(100, 100, (x, y) => (y < 25 ? [0, 0, 255] : [x, y, 0]))), 0.25);
  assert.equal(difference(base, png(50, 100, (x, y) => [x, y, 0])), 1);
  assert.equal(difference(base, Buffer.from('junk')), 1);
});

// A made-up 176x208 game screen: a bright block, a gradient and a dark band.
const screen = (x, y) => (y < 40 ? [20, 20, 30] : x > 40 && x < 120 && y > 70 && y < 150 ? [230, 220, 90] : [Math.floor(x / 2), 60, Math.floor(y / 2)]);

test('a page that shows the game is like the emulator screenshot', () => {
  const guest = png(176, 208, screen);
  // The canvas scales the screen 3.3x and centres it between black bars.
  const scale = 3.3;
  const shown = png(900, Math.round(208 * scale), (x, y) => {
    const gx = Math.floor((x - (900 - 176 * scale) / 2) / scale);
    return gx < 0 || gx >= 176 ? [0, 0, 0] : screen(gx, Math.floor(y / scale));
  });
  assert.ok(likeness(shown, guest) > 0.95);
  // Darker (an overlay) or a little offset in time is still the same picture.
  const dim = png(900, Math.round(208 * scale), (x, y) => {
    const gx = Math.floor((x - (900 - 176 * scale) / 2) / scale);
    return gx < 0 || gx >= 176 ? [0, 0, 0] : screen(gx, Math.floor(y / scale)).map((value) => Math.floor(value * 0.3));
  });
  assert.ok(likeness(dim, guest) >= SHOWN_AT);
});

test('a page of one colour, or of something else, is not like the game', () => {
  const guest = png(176, 208, screen);
  assert.equal(likeness(png(900, 686, () => [255, 0, 255]), guest), 0);
  // Magenta between black bars: the bars are outside the picture, and the
  // sliver of them at its edges does not make it look like the game.
  assert.ok(likeness(png(900, 686, (x) => (x < 160 || x > 740 ? [0, 0, 0] : [255, 0, 255])), guest) < 0.3);
  assert.ok(likeness(png(900, 686, (x, y) => ((x + y) % 97 < 40 ? [200, 200, 200] : [10, 10, 10])), guest) < SHOWN_AT);
});

test('nothing to compare gives null', () => {
  assert.equal(likeness(png(900, 686, screen), png(176, 208, () => [0, 0, 0])), null);
  assert.equal(likeness(Buffer.from('no'), png(176, 208, screen)), null);
});

test('a game starts with the firmware of its platform', () => {
  assert.equal(platformOf({}), 'ngage');
  assert.equal(platformOf({ platform: 'ngage2' }), 'ngage2');
  assert.equal(gameQuery({ slug: 'x' }, 'x'), '?fw=/local/NGAGE.ROM&game=/local/games/x.zip&persist=0');
  assert.equal(gameQuery({ platform: 'ngage2' }, 'y'),
    '?device=/local/devices/rm-409.zip&app=/local/ngage2/ngage-1.40.1557.sis&game=/local/games/y.zip&persist=0');
});

// A diagnostics report as the player of today makes it (diag/core.js): the
// session section has the frame rates, the sections behind them are not there.
const report = (extra = {}) => ({
  kind: 'eka2l1-web-diagnostics',
  v: 1,
  generated: '2026-11-18T10:00:00.000Z',
  page: { address: 'http://127.0.0.1:8520/', hidden: false },
  game: { uid: '0x101FD3F6', name: 'Elder Scrolls', slug: null },
  session: { upS: 119, running: true, paused: false, emulatorAnswers: true, samples: 120, measuredS: 30 },
  findings: [],
  sections: {
    session: {
      title: 'Session',
      data: { state: 'running', frames: 1473, fps: 9.0107, fpsAverage: 10.199998300000322, fpsWorst: 7.964319847085206, measuredS: 30.000004999999888 },
      findings: [],
    },
    browser: { title: 'Browser and device', data: { ok: true, cores: 16 }, findings: [] },
  },
  series: { t: [0, 1], fps: [null, 10], running: [1, 1], hidden: [0, 0] },
  ...extra,
});

test('the perf block of a report without the measuring sections has the frame rates', () => {
  assert.deepEqual(perfFrom(report()), { measuredS: 30, fps: 10.2, fpsWorst: 8, findings: [] });
});

test('the perf block takes the numbers the table names and the codes of the findings', () => {
  // The sections that will have these are not written: the paths are made up
  // here, which is also how the table is extended once they are.
  const numbers = [
    ...PERF_NUMBERS.filter((entry) => entry.paths.length),
    { name: 'cpuLoad', digits: 2, paths: ['sections.speed.data.cpu.busyShare'] },
    { name: 'graphicsMs', digits: 1, paths: ['sections.graphics.data.msPerFrame', 'sections.graphics.data.frameMs'] },
    { name: 'heapMB', digits: 0, paths: ['sections.memory.data.heap.usedMB'] },
    { name: 'underruns', digits: 0, paths: ['sections.audio.data.underruns'] },
  ];
  const full = report({
    findings: [
      { code: 'cpu-bound', level: 'bad', section: 'speed', title: 'The device is too slow for this game.' },
      { code: 'software-rendering', level: 'warn', section: 'graphics', title: 'The browser draws on the processor.' },
      { code: 'software-rendering', level: 'warn', section: 'graphics', title: 'Twice.' },
    ],
  });
  full.sections.speed = { title: 'Speed', data: { cpu: { busyShare: 0.97431 } }, findings: ['cpu-bound'] };
  full.sections.graphics = { title: 'Picture', data: { frameMs: 3.4567 }, findings: ['software-rendering'] };
  full.sections.memory = { title: 'Memory and storage', data: { heap: { usedMB: 201.6 } }, findings: [] };
  assert.deepEqual(perfFrom(full, numbers), {
    measuredS: 30, fps: 10.2, fpsWorst: 8, cpuLoad: 0.97, graphicsMs: 3.5, heapMB: 202, findings: ['cpu-bound', 'software-rendering'],
  });
  // The table as it stands leaves out what it has no path for.
  assert.deepEqual(perfFrom(full), { measuredS: 30, fps: 10.2, fpsWorst: 8, findings: ['cpu-bound', 'software-rendering'] });
});

test('a report made before anything could be measured gives a block without rates', () => {
  const early = report({ game: null, session: { upS: 2, running: false, paused: false, emulatorAnswers: false, samples: 2, measuredS: 0 } });
  early.sections.session.data = { state: 'none', frames: 0, fps: null, fpsAverage: null, fpsWorst: null, measuredS: 0 };
  assert.deepEqual(perfFrom(early), { measuredS: 0, findings: [] });
});

test('what is not a diagnostics report gives no perf block', () => {
  for (const nothing of [null, undefined, '', 'eka2l1-web-diagnostics', 7, [], {}, { kind: 'something-else', findings: [] }, { session: { measuredS: 30 } }]) {
    assert.equal(perfFrom(nothing), null);
  }
});

test('a broken report gives the block of what can be read and never throws', () => {
  const kind = 'eka2l1-web-diagnostics';
  assert.deepEqual(perfFrom({ kind }), { measuredS: 0, findings: [] });
  assert.deepEqual(perfFrom({ kind, session: null, sections: null, findings: null }), { measuredS: 0, findings: [] });
  assert.deepEqual(perfFrom({ kind, session: 'gone', sections: [1, 2], findings: 'none' }), { measuredS: 0, findings: [] });
  // Numbers that are not numbers, and findings that are not findings.
  const odd = report({
    session: { measuredS: '30' },
    findings: [null, 'cpu-bound', { code: 7 }, { code: 'Not A Code' }, { code: 'x'.repeat(41) }, { level: 'bad' }, { code: 'game-crashed' }],
  });
  odd.sections.session.data = { fpsAverage: '12', fpsWorst: null, measuredS: 12.4 };
  assert.deepEqual(perfFrom(odd), { measuredS: 12, findings: ['game-crashed'] });
  // The error of a section that failed stands where its data would.
  const failed = report();
  failed.sections.session = { title: 'Session', data: null, findings: [], error: 'boom' };
  assert.deepEqual(perfFrom(failed), { measuredS: 30, findings: [] });
  // A path never leaves the report's own fields.
  assert.deepEqual(perfFrom(report(), [{ name: 'odd', digits: 0, paths: ['sections.constructor.length', 'sections.toString.length', '__proto__.x'] }]), { measuredS: 0, findings: [] });
  // A table that is itself wrong must not fail a run.
  assert.equal(perfFrom(report(), [{ name: 'fps' }]), null);
  // Never more codes than a status file should carry.
  const many = report({ findings: Array.from({ length: 100 }, (_, i) => ({ code: `code-${i}` })) });
  assert.equal(perfFrom(many).findings.length, 32);
});

test('the table of numbers is well formed', () => {
  const names = PERF_NUMBERS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.includes('findings'));
  for (const entry of PERF_NUMBERS) {
    assert.match(entry.name, /^[a-zA-Z][a-zA-Z0-9]*$/);
    assert.ok(Number.isInteger(entry.digits) && entry.digits >= 0 && entry.digits <= 3);
    assert.ok(Array.isArray(entry.paths) && entry.paths.every((path) => typeof path === 'string' && path));
  }
});
