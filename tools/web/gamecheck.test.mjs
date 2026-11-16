// Tests for gamecheck.mjs: node --test tools/web/gamecheck.test.mjs (or npm test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { checkScript, difference, picture, scriptMs, stepTiming, targetLevel, verdict } from './gamecheck.mjs';

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
