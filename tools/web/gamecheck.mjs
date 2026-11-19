// The parts of the per-game test (gametest.mjs) that need no browser: the
// status levels, the pass rule, catalogue script checks and what a screenshot
// shows. Kept apart so they can be tested by themselves (gamecheck.test.mjs).
import { PNG } from 'pngjs';

// How far a game gets, worst first. The same names as "status" in the catalogue.
export const LEVELS = ['broken', 'boots', 'menu', 'ingame'];
export const rank = (level) => LEVELS.indexOf(level);

// The level a run of this entry tries to show: what its script is expected to
// reach, or a plain boot check when it has no script.
export function targetLevel(entry) {
  return entry.test && rank(entry.test.expect) >= 0 ? entry.test.expect : 'boots';
}

// Pass or fail for the level a run reached.
//   expect   the level the entry must reach, or null when nothing is expected
//            (an entry with no test is only looked at)
//   better   true when the game did better than the catalogue says, so the
//            entry can be updated
// `reached` is null when the test could not be carried out at all (no browser,
// missing files, the emulator itself did not come up). That never passes,
// whatever the entry expects: otherwise a broken CI machine would look like a
// game that is still broken.
export function verdict(entry, reached) {
  const expect = entry.status === 'broken' ? 'broken' : entry.test ? entry.test.expect : null;
  if (reached === null || rank(reached) < 0) return { expect, pass: false, better: false };
  if (expect === null) return { expect, pass: true, better: false };
  return { expect, pass: rank(reached) >= rank(expect), better: rank(reached) > rank(expect) };
}

// Throws with the place and reason when a script is not one the runner can
// replay. `keys` is the list of key names the catalogue allows.
export function checkScript(script, keys) {
  if (!Array.isArray(script)) throw new Error('test.script is not a list');
  script.forEach((step, index) => {
    const where = `test.script[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${where} is not an object`);
    for (const name of Object.keys(step)) {
      if (!['key', 'hold', 'wait', 'repeat'].includes(name)) throw new Error(`${where}: unknown field "${name}"`);
    }
    if (step.key !== undefined && !keys.includes(step.key)) throw new Error(`${where}: unknown key "${step.key}"`);
    for (const [name, least] of [['hold', 20], ['wait', 0], ['repeat', 1]]) {
      if (step[name] !== undefined && !(Number.isInteger(step[name]) && step[name] >= least)) {
        throw new Error(`${where}: "${name}" must be a whole number of at least ${least}`);
      }
    }
  });
}

// One step as the runner replays it, with the defaults filled in.
export function stepTiming(step) {
  return {
    key: step.key || null,
    hold: step.key ? (step.hold !== undefined ? step.hold : 120) : 0,
    wait: step.wait !== undefined ? step.wait : (step.key ? 600 : 0),
    repeat: step.repeat || 1,
  };
}

export function scriptMs(script) {
  return script.map(stepTiming).reduce((sum, step) => sum + step.repeat * (step.hold + step.wait), 0);
}

// What a PNG shows, as far as "is there a picture" goes. A screen counts as
// blank when (nearly) every pixel has the same colour: a cleared window, or a
// screen nothing was drawn to. The few pixels of slack keep one stray cursor
// or dot from counting as a picture.
export const BLANK_SHARE = 0.999;

export function picture(bytes) {
  let png;
  try {
    png = PNG.sync.read(Buffer.from(bytes));
  } catch (error) {
    return { width: 0, height: 0, colours: 0, dominant: 1, blank: true, invalid: String(error.message || error) };
  }
  const pixels = png.width * png.height;
  const counts = new Map();
  for (let i = 0; i < pixels * 4; i += 4) {
    const colour = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
    counts.set(colour, (counts.get(colour) || 0) + 1);
  }
  let most = 0;
  for (const count of counts.values()) most = Math.max(most, count);
  const dominant = pixels ? most / pixels : 1;
  return { width: png.width, height: png.height, colours: counts.size, dominant: Number(dominant.toFixed(4)), blank: pixels === 0 || dominant >= BLANK_SHARE };
}

// Share of pixels that differ between two screenshots (1 when their sizes differ).
export function difference(first, second) {
  let a;
  let b;
  try {
    a = PNG.sync.read(Buffer.from(first));
    b = PNG.sync.read(Buffer.from(second));
  } catch {
    return 1;
  }
  if (a.width !== b.width || a.height !== b.height) return 1;
  const pixels = a.width * a.height;
  if (!pixels) return 0;
  let differing = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differing++;
  }
  return differing / pixels;
}

// Does the page show what the game draws? `page` is a screenshot of the page's
// canvas, `guest` the emulator's own screenshot taken at the same moment. The
// canvas shows the guest's screen scaled to fit and centred, with bars beside
// or above it, so the comparison is made on that rectangle, on a coarse grid
// of average brightness. Returns the correlation of the two grids, from -1 to
// 1: near 1 when the page shows the game (whatever the scaling filter or the
// brightness), near 0 when it shows something else, and 0 for a page of one
// colour. null when there is nothing to compare (a guest screen of one colour,
// or a picture that cannot be read).
export const SHOWN_AT = 0.6;

export function likeness(page, guest) {
  let a;
  let b;
  try {
    a = PNG.sync.read(Buffer.from(page));
    b = PNG.sync.read(Buffer.from(guest));
  } catch {
    return null;
  }
  if (!a.width || !a.height || b.width < 16 || b.height < 16) return null;
  const columns = Math.max(4, Math.floor(b.width / 8));
  const rows = Math.max(4, Math.floor(b.height / 8));
  const scale = Math.min(a.width / b.width, a.height / b.height);
  const box = { x: (a.width - b.width * scale) / 2, y: (a.height - b.height * scale) / 2, width: b.width * scale, height: b.height * scale };
  const grid = (png, area) => {
    const cells = new Float64Array(columns * rows);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x0 = Math.floor(area.x + (area.width * column) / columns);
        const x1 = Math.max(x0 + 1, Math.floor(area.x + (area.width * (column + 1)) / columns));
        const y0 = Math.floor(area.y + (area.height * row) / rows);
        const y1 = Math.max(y0 + 1, Math.floor(area.y + (area.height * (row + 1)) / rows));
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1 && y < png.height; y++) {
          for (let x = x0; x < x1 && x < png.width; x++) {
            const i = (y * png.width + x) * 4;
            sum += 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
            count++;
          }
        }
        cells[row * columns + column] = count ? sum / count : 0;
      }
    }
    return cells;
  };
  const shown = grid(a, box);
  const drawn = grid(b, { x: 0, y: 0, width: b.width, height: b.height });
  const mean = (cells) => cells.reduce((sum, value) => sum + value, 0) / cells.length;
  const meanShown = mean(shown);
  const meanDrawn = mean(drawn);
  let cross = 0;
  let spreadShown = 0;
  let spreadDrawn = 0;
  for (let i = 0; i < shown.length; i++) {
    cross += (shown[i] - meanShown) * (drawn[i] - meanDrawn);
    spreadShown += (shown[i] - meanShown) ** 2;
    spreadDrawn += (drawn[i] - meanDrawn) ** 2;
  }
  // A guest screen that is (nearly) one brightness has no shape to look for.
  if (Math.sqrt(spreadDrawn / drawn.length) < 2) return null;
  // The same for the page: one colour is not the game (and has no correlation to compute).
  if (Math.sqrt(spreadShown / shown.length) < 0.5) return 0;
  return Number((cross / Math.sqrt(spreadShown * spreadDrawn)).toFixed(3));
}

// What a game of each platform needs below the assets folder, by the page
// parameter that names it: the N-Gage ROM for the original N-Gage, the
// phone's device zip and the N-Gage application for N-Gage 2.0. The same
// paths as FIRMWARE in tools/assets/common.py.
export const PLATFORM_FILES = {
  ngage: { fw: 'NGAGE.ROM' },
  ngage2: { device: 'devices/rm-409.zip', app: 'ngage2/ngage-1.40.1557.sis' },
};

export const platformOf = (entry) => (entry && entry.platform === 'ngage2' ? 'ngage2' : 'ngage');

// The bare player's query string that starts `slug` from files served at
// `base` (`/local/`), without keeping anything between visits.
export function gameQuery(entry, slug, base = '/local/') {
  const files = PLATFORM_FILES[platformOf(entry)];
  const query = Object.entries(files).map(([name, file]) => `${name}=${base}${file}`);
  return `?${[...query, `game=${base}games/${slug}.zip`, 'persist=0'].join('&')}`;
}

// --- what the player's diagnostics said -------------------------------------------
//
// The player measures itself (docs/diagnostics.md), and its report is long.
// The per-game test keeps a few numbers of it as the result's "perf" block, so
// that every CI run says, for every game, how fast it ran on a known machine
// and which findings it produced there.
//
// The numbers to keep. `name` is the field in the block, `paths` where a
// report may have it (dots go into objects; the first path that holds a finite
// number wins, so an old and a new place can stand side by side), `digits` the
// decimals kept. A number the report does not have is left out of the block.
// To keep another number, add a line: nothing else needs to change, here or in
// tools/ci/status.py, which passes every number of the block on.
export const PERF_NUMBERS = [
  // Seconds of play the rates below were measured over; 0 when nothing was.
  { name: 'measuredS', digits: 0, paths: ['session.measuredS', 'sections.session.data.measuredS'] },
  // Frames the game presented per second: on average, and in the worst second.
  { name: 'fps', digits: 1, paths: ['sections.session.data.fpsAverage'] },
  { name: 'fpsWorst', digits: 1, paths: ['sections.session.data.fpsWorst'] },
  // The share of the time the emulated processor was busy, 0 to 1 (speed).
  { name: 'cpuLoad', digits: 2, paths: ['sections.speed.data.busy'] },
  // What the graphics thread spends on a frame, in milliseconds (graphics).
  { name: 'graphicsMs', digits: 1, paths: ['sections.graphics.data.busyMsPerFrame'] },
  // The emulator's memory, in megabytes (memory).
  { name: 'heapMB', digits: 0, paths: ['sections.memory.data.heap.sizeMB'] },
];

export const REPORT_KIND = 'eka2l1-web-diagnostics';
// How many codes a block holds and what a code looks like. tools/ci/status.py
// checks a block against the same two before it publishes it (PERF_FINDINGS
// and PERF_CODE there): change them together.
const PERF_FINDINGS = 32;
const PERF_CODE = /^[a-z0-9-]{1,40}$/;

const own = (value, key) => (value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined);
const at = (value, path) => path.split('.').reduce(own, value);

// The "perf" block for a diagnostics report (what `eka2l1Page.diag.report()`
// resolved to): { measuredS, fps, fpsWorst, ..., findings: [codes] }, with the
// numbers of `numbers` the report has and the code of every finding, worst
// first as the report lists them. null when `report` is not a diagnostics
// report at all (a player without diagnostics, a page that did not answer).
// It never throws: a report with parts missing or of the wrong kind gives the
// block of what could be read.
export function perfFrom(report, numbers = PERF_NUMBERS) {
  try {
    if (own(report, 'kind') !== REPORT_KIND) return null;
    const perf = { measuredS: 0 };
    for (const { name, digits, paths } of numbers) {
      const value = paths.map((path) => at(report, path)).find((found) => typeof found === 'number' && Number.isFinite(found));
      if (value !== undefined) perf[name] = Number(value.toFixed(digits));
    }
    const findings = own(report, 'findings');
    const codes = (Array.isArray(findings) ? findings : []).map((finding) => own(finding, 'code'))
      .filter((code) => typeof code === 'string' && PERF_CODE.test(code));
    perf.findings = [...new Set(codes)].slice(0, PERF_FINDINGS);
    return perf;
  } catch {
    return null;
  }
}
