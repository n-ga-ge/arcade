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
