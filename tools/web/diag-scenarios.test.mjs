// Tests for diag-scenarios.mjs: node --test tools/web/diag-scenarios.test.mjs (or npm test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODE, CONDITION_OPTIONS, DEVICES, LEVELS, SCENARIOS, conditionMissed, conditionProblem, conditionText, exitCode, judge, list, parseScenarios, quotaApplied, seenText, speedText, summary,
  tableProblems, verdictText } from './diag-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The player's list of finding codes. It is in the fork, which a worktree
// may not have checked out: the table is then checked for its form only.
const CODES_FILE = path.join(ROOT, 'eka2l1', 'src', 'emu', 'web', 'shell', 'diag', 'codes.js');
const player = fs.existsSync(CODES_FILE) ? await import(pathToFileURL(CODES_FILE).href) : null;

const finding = (code, level = 'warn') => ({ code, level });
// A result as diag.mjs makes it, for the summary.
const result = (scenario, more = {}) => ({
  scenario,
  what: SCENARIOS[scenario].what,
  options: SCENARIOS[scenario].options,
  expect: SCENARIOS[scenario].expect,
  absent: SCENARIOS[scenario].absent,
  absentLevels: SCENARIOS[scenario].absentLevels || [],
  verdict: 'pass',
  measured: { fps: 18.4, fpsWorst: 15, seconds: 30, animationFrames: 60, sound: 'running', renderer: 'ANGLE (Intel)', softwareRenderer: false, hidden: false },
  condition: { quota: null },
  findings: [],
  levels: {},
  missing: [],
  unwanted: [],
  skipped: null,
  error: null,
  ...more,
});

test('the table of scenarios is sound', () => {
  assert.deepEqual(tableProblems(SCENARIOS, player ? { codes: player.CODES, levels: player.LEVELS } : {}), []);
  for (const name of ['baseline', 'cpu60', 'cpu30', 'software', 'hidden', 'undrawn', 'phone', 'nosound', 'stall']) assert.ok(SCENARIOS[name], name);
});

test('the table says what each condition is there for', () => {
  assert.deepEqual(SCENARIOS.cpu30.expect, ['cpu-bound']);
  assert.deepEqual(SCENARIOS.software.expect, ['software-rendering']);
  assert.deepEqual(SCENARIOS.hidden.expect, ['tab-was-hidden']);
  assert.deepEqual(SCENARIOS.undrawn.expect, ['no-animation-frames']);
  assert.deepEqual(SCENARIOS.nosound.expect, ['audio-suspended']);
  assert.deepEqual(SCENARIOS.cpu60.expect, []);
  assert.deepEqual(SCENARIOS.baseline.expect, []);
  // The finding a condition provokes is unwanted where the condition is not.
  for (const [code, owner] of [['cpu-bound', 'cpu30'], ['software-rendering', 'software'], ['no-animation-frames', 'undrawn'], ['tab-was-hidden', 'hidden'],
    ['audio-suspended', 'nosound']]) {
    assert.ok(SCENARIOS.baseline.absent.includes(code), `baseline must not have ${code}`);
    assert.ok(!SCENARIOS[owner].absent.includes(code), `${owner} may have ${code}`);
  }
  assert.deepEqual(SCENARIOS.baseline.absentLevels, ['bad']);
  // cpu60 says nothing about speed either way.
  assert.ok(!SCENARIOS.cpu60.absent.includes('cpu-bound'));
});

test('a broken table is told apart', () => {
  const problems = (scenario, known) => tableProblems({ one: { what: 'x', options: {}, expect: [], absent: [], ...scenario } }, known);
  assert.deepEqual(problems({}), []);
  assert.match(problems({ expect: ['Cpu Bound'] })[0], /not a finding code/);
  assert.match(problems({ expect: ['cpu-bound'], absent: ['cpu-bound'] })[0], /both expected and unwanted/);
  assert.match(problems({ absent: ['a-b', 'a-b'] })[0], /twice/);
  assert.match(problems({ expect: ['cpu-bund'] }, { codes: { 'cpu-bound': 'speed' } })[0], /not a code of codes\.js/);
  // The levels are checked without the player's list too.
  assert.match(problems({ absentLevels: ['awful'] })[0], /not a level/);
  assert.match(problems({ absentLevels: ['Bad'] })[0], /not a level/);
  assert.match(problems({ absentLevels: 'bad' })[0], /"absentLevels" is not a list/);
  if (player) assert.deepEqual(LEVELS, player.LEVELS);
  assert.match(problems({ options: { seconds: '5' } })[0], /not an option that makes a condition/);
  assert.match(problems({ options: { cpu: 'half' } })[0], /--cpu must be a positive number/);
  assert.match(problems({ what: '' })[0], /says nothing/);
  assert.match(problems({ expect: 'cpu-bound' })[0], /not a list/);
  assert.match(tableProblems({ all: { what: 'x', options: {}, expect: [], absent: [] } })[0], /not a name/);
});

test('a list of scenarios is read in the order given, each once', () => {
  assert.deepEqual(parseScenarios('all'), Object.keys(SCENARIOS));
  assert.deepEqual(parseScenarios('cpu30, baseline'), ['cpu30', 'baseline']);
  assert.deepEqual(parseScenarios('hidden,hidden,baseline,hidden'), ['hidden', 'baseline']);
  assert.deepEqual(parseScenarios('cpu30,all').slice(0, 2), ['cpu30', 'baseline']);
  assert.equal(parseScenarios('cpu30,all').length, Object.keys(SCENARIOS).length);
  assert.throws(() => parseScenarios('baseline,slow'), /unknown scenario: slow \(there are: baseline, .*or all\)/);
  assert.throws(() => parseScenarios(''), /needs a name/);
  assert.throws(() => parseScenarios(' , '), /needs a name/);
  // An object's own names only: "constructor" is not a scenario.
  assert.throws(() => parseScenarios('constructor'), /unknown scenario/);
});

test('lists and codes', () => {
  assert.deepEqual(list('a, b,,c '), ['a', 'b', 'c']);
  assert.deepEqual(list(undefined), []);
  assert.ok(CODE.test('no-animation-frames'));
  assert.ok(!CODE.test('No-frames'));
  assert.ok(!CODE.test('cpu--bound'));
});

test('a condition is checked as the command line gives it', () => {
  assert.equal(conditionProblem({}), null);
  assert.equal(conditionProblem({ cpu: '30', 'cpu-from': 'play', cores: '2', throttle: '6', browser: 'chrome-software', device: 'phone', hidden: true, nosound: true }), null);
  assert.match(conditionProblem({ browser: 'safari' }), /unknown browser/);
  assert.match(conditionProblem({ cpu: '0' }), /--cpu must be a positive number/);
  assert.match(conditionProblem({ throttle: 'x' }), /--throttle must be/);
  assert.match(conditionProblem({ cores: '1.5' }), /whole number/);
  assert.match(conditionProblem({ cpu: '30', 'cpu-from': 'later' }), /start or play/);
  assert.match(conditionProblem({ 'cpu-from': 'play' }), /needs --cpu/);
  assert.match(conditionProblem({ device: 'watch' }), /unknown device: watch \(there are: phone, /);
  assert.match(conditionProblem({ device: 'constructor' }), /unknown device/);
  assert.match(conditionProblem({ hidden: true, undrawn: true }), /not both/);
  assert.equal(conditionProblem({ undrawn: true }), null);
  // Other options of the tool are not its business.
  assert.equal(conditionProblem({ game: 'shadowkey', seconds: '-1' }), null);
  for (const name of Object.keys(DEVICES)) assert.equal(conditionProblem({ device: name }), null);
  assert.ok(CONDITION_OPTIONS.includes('cpu-from'));
});

test('a hidden page that was not hidden is told', () => {
  const hidden = { hidden: true, visibility: 'hidden', animationFrames: 0, paused: true, hiddenSamples: 10, reportHidden: true };
  assert.equal(conditionMissed({ hidden: true }, hidden), null);
  // What the foundation's --hidden gave: another page in front, and nothing changed for this one.
  assert.equal(conditionMissed({ hidden: true }, { hidden: false, visibility: 'visible', animationFrames: 61, paused: false, hiddenSamples: 0, reportHidden: false }),
    'the page was not hidden: the document does not say "hidden"; it got 61 animation frames in a second; '
    + 'the page did not pause the game, so visibilitychange did not reach it; the report does not say it was hidden');
  assert.match(conditionMissed({ hidden: true }, { ...hidden, paused: false }), /^the page was not hidden: the page did not pause the game/);
  assert.match(conditionMissed({ hidden: true }, { ...hidden, hiddenSamples: 0 }), /^the page was not hidden: the report does not say it was hidden$/);
  assert.match(conditionMissed({ hidden: true }, { ...hidden, reportHidden: false }), /the report does not say it was hidden/);
  assert.match(conditionMissed({ hidden: true }, { ...hidden, animationFrames: 3 }), /it got 3 animation frames in a second$/);
  assert.equal(conditionMissed({ undrawn: true }, { hidden: false, animationFrames: 0 }), null);
  assert.equal(conditionMissed({ undrawn: true }, { hidden: false, animationFrames: 58 }), 'the page was not undrawn: it got 58 animation frames in a second');
  // Any other condition is not judged here.
  assert.equal(conditionMissed({ cpu: '30' }, { hidden: false, animationFrames: 60 }), null);
  assert.equal(conditionMissed({}, { hidden: false, animationFrames: 60 }), null);
});

test('a condition is written as it is typed', () => {
  assert.equal(conditionText({}), '(nothing)');
  assert.equal(conditionText({ cpu: '30', 'cpu-from': 'play' }), '--cpu 30 --cpu-from play');
  assert.equal(conditionText({ hidden: true, nosound: false }), '--hidden');
  assert.equal(conditionText(undefined), '(nothing)');
});

test('an expected finding that is missing fails only a strict run', () => {
  const expected = { expect: ['cpu-bound'], absent: ['game-limited'] };
  assert.deepEqual(judge(expected, { findings: [] }, false), { verdict: 'pass', missing: ['cpu-bound'], unwanted: [] });
  assert.deepEqual(judge(expected, { findings: [] }, true), { verdict: 'fail', missing: ['cpu-bound'], unwanted: [] });
  assert.deepEqual(judge(expected, { findings: [finding('cpu-bound', 'bad'), finding('timers-late')] }, true), { verdict: 'pass', missing: [], unwanted: [] });
});

test('an unwanted finding fails either way', () => {
  const expected = { expect: [], absent: ['cpu-bound', 'audio-suspended'] };
  for (const strict of [false, true]) {
    assert.deepEqual(judge(expected, { findings: [finding('game-limited', 'info'), finding('cpu-bound', 'bad')] }, strict), { verdict: 'fail', missing: [], unwanted: ['cpu-bound'] });
    assert.deepEqual(judge(expected, { findings: [finding('game-limited', 'info')] }, strict), { verdict: 'pass', missing: [], unwanted: [] });
  }
});

test('a level can be unwanted whatever the code', () => {
  const expected = { expect: [], absent: ['audio-suspended'], absentLevels: ['bad'] };
  assert.deepEqual(judge(expected, { findings: [finding('memory-near-limit', 'bad'), finding('audio-suspended', 'info'), finding('save-slow', 'warn')] }, false),
    { verdict: 'fail', missing: [], unwanted: ['memory-near-limit', 'audio-suspended'] });
  // Named once, though it is unwanted for its code and for its level.
  assert.deepEqual(judge({ absent: ['cpu-bound'], absentLevels: ['bad'] }, { findings: [finding('cpu-bound', 'bad')] }, false).unwanted, ['cpu-bound']);
  assert.equal(judge(expected, { findings: [finding('save-slow', 'warn')] }, true).verdict, 'pass');
});

test('a run that could not be carried out never passes, and a skipped one did not fail', () => {
  for (const strict of [false, true]) {
    assert.deepEqual(judge({ expect: [], absent: [] }, { findings: [], error: 'the browser went away' }, strict), { verdict: 'fail', missing: [], unwanted: [] });
    assert.deepEqual(judge({ expect: ['cpu-bound'], absent: [] }, { findings: [], skipped: 'no user systemd' }, strict), { verdict: 'skipped', missing: [], unwanted: [] });
  }
  assert.equal(exitCode([{ verdict: 'pass' }, { verdict: 'skipped' }]), 0);
  assert.equal(exitCode([{ verdict: 'pass' }, { verdict: 'fail' }, { verdict: 'skipped' }]), 1);
  assert.equal(exitCode([]), 0);
});

test('the verdict in words', () => {
  assert.equal(verdictText({ verdict: 'pass', missing: [], unwanted: [] }), 'pass');
  assert.equal(verdictText({ verdict: 'pass', missing: ['cpu-bound'], unwanted: [] }), 'pass (not produced: cpu-bound)');
  assert.equal(verdictText({ verdict: 'fail', strict: true, missing: ['cpu-bound'], unwanted: [] }), 'FAIL: missing cpu-bound');
  assert.equal(verdictText({ verdict: 'fail', strict: true, missing: ['a-b'], unwanted: ['c-d', 'e-f'] }), 'FAIL: unwanted c-d, e-f; missing a-b');
  // Without --strict the missing finding is not what failed the run.
  assert.equal(verdictText({ verdict: 'fail', strict: false, missing: ['a-b'], unwanted: ['c-d'] }), 'FAIL: unwanted c-d (not produced: a-b)');
  assert.equal(verdictText({ verdict: 'pass', strict: true, missing: [], unwanted: [] }), 'pass');
  assert.equal(verdictText({ verdict: 'fail', missing: [], unwanted: [], error: 'the game did not start within 90 s (while starting the game)' }),
    'FAIL: the game did not start within 90 s (while starting the game)');
  assert.equal(verdictText({ verdict: 'skipped', missing: [], unwanted: [], skipped: 'no user systemd' }), 'skipped: no user systemd');
});

test('the quota is read from cpu.max', () => {
  assert.equal(quotaApplied('30000 100000\n', 30), true);
  assert.equal(quotaApplied('50000 100000', 50), true);
  assert.equal(quotaApplied('15000 50000', 30), true);
  assert.equal(quotaApplied('max 100000\n', 30), false);
  assert.equal(quotaApplied('50000 100000', 30), false);
  assert.equal(quotaApplied('', 30), false);
  assert.equal(quotaApplied(undefined, 30), false);
  assert.equal(quotaApplied('30000 0', 30), false);
});

test('the speed and what was seen, in words', () => {
  assert.equal(speedText({ fps: 17.26, fpsWorst: 12, seconds: 29.9 }), '17.3 (worst 12.0) over 30 s');
  assert.equal(speedText({ fps: 5, fpsWorst: null, seconds: 30 }), '5.0 over 30 s');
  assert.equal(speedText({ fps: null }), 'not measured');
  assert.equal(speedText(null), 'not measured');
  assert.equal(seenText(result('baseline')), "the page's own thread got 60 animation frames in a second; its sound was running; WebGL is drawn by ANGLE (Intel); the page was told it is visible");
  assert.match(seenText(result('cpu30', { condition: { quota: '30000 100000' } })), /^the browser's cgroup has the quota "30000 100000"/);
  assert.match(seenText(result('software', { measured: { animationFrames: 0, sound: 'not started', renderer: 'SwiftShader', softwareRenderer: true, hidden: true } })),
    /0 animation frames.*sound was not started.*SwiftShader \(on the processor\).*told it is hidden$/);
  assert.match(seenText(result('hidden', { measured: { animationFrames: 0, hidden: true, paused: true, hiddenSamples: 10 }, condition: { hidden: true } })),
    /0 animation frames in a second; the page was told it is hidden; the game was paused; the last 10 samples of the report say "hidden"; the emulator's animation frames were switched off$/);
  assert.match(seenText(result('undrawn', { condition: { undrawn: true } })), /told it is visible; the emulator's animation frames were switched off$/);
  assert.equal(seenText({ measured: null }), '');
  assert.match(seenText(result('baseline', { measured: { animationFrames: 60, load: 12.34, threads: 16 } })), /; the machine's load was 12\.3 on 16 processor threads$/);
});

test('the summary has a row and a line for every scenario', () => {
  const results = [
    result('baseline'),
    result('cpu30', { measured: { fps: 5.5, fpsWorst: 4, seconds: 30 }, condition: { quota: '30000 100000' }, missing: ['cpu-bound'] }),
    result('software', { verdict: 'fail', findings: ['software-rendering', 'audio-suspended'], levels: { 'software-rendering': 'warn', 'audio-suspended': 'info' }, unwanted: ['audio-suspended'] }),
    result('cpu60', { verdict: 'skipped', skipped: 'no user systemd | none', measured: null }),
    result('hidden', { verdict: 'fail', error: 'the browser went away (while playing)', measured: null }),
  ];
  const text = summary({ game: 'shadowkey', strict: false, when: '2026-11-18T10:00:00Z', version: '157.0' }, results);
  const rows = text.split('\n').filter((line) => line.startsWith('| ')).slice(1);
  assert.equal(rows.length, results.length);
  assert.match(text, /^# Diagnostics scenarios: shadowkey\n\n2026-11-18T10:00:00Z, Chrome 157\.0\. 5 scenarios: 2 passed, 2 failed, 1 skipped\. Not strict/);
  assert.equal(rows[0], '| baseline | `(nothing)` | 18.4 (worst 15.0) over 30 s | none | nothing | pass |');
  assert.equal(rows[1], '| cpu30 | `--cpu 30 --cpu-from play` | 5.5 (worst 4.0) over 30 s | none | cpu-bound | pass (not produced: cpu-bound) |');
  assert.equal(rows[2], '| software | `--browser chrome-software` | 18.4 (worst 15.0) over 30 s | software-rendering (warn), audio-suspended (info) | software-rendering | FAIL: unwanted audio-suspended |');
  // A cell cannot end the row early, and a run with nothing to show has empty cells.
  assert.equal(rows[3], '| cpu60 | `--cpu 60 --cpu-from play` |  |  | nothing | skipped: no user systemd \\| none |');
  assert.equal(rows[4], '| hidden | `--hidden` | not measured |  | tab-was-hidden | FAIL: the browser went away (while playing) |');
  for (const row of rows) assert.equal(row.replace(/\\\|/g, '').split('|').length, 8, row);
  assert.match(text, /- \*\*baseline\*\* \(files in `baseline\/`\): The game as this machine runs it: nothing is wrong\. Must not have: any finding of level "bad", browser-unsupported, /);
  assert.match(text, /- \*\*cpu30\*\*.*Seen: the browser's cgroup has the quota "30000 100000"/);
  assert.match(summary({ game: 'shadowkey', strict: true, when: 'now' }, results), /^now\. 5 scenarios.*Strict: an expected finding that is missing fails/m);
  assert.doesNotMatch(text, /Unfinished|Warning/);
  // A run that is cut short says what is still to come, and a picture that could not be taken is named.
  const partial = summary({ game: 'shadowkey', strict: false, when: 'now', planned: ['baseline', 'cpu30', 'phone', 'stall'] },
    [result('baseline'), result('cpu30', { warnings: ['no page.png: Timeout 20000ms exceeded'] })]);
  assert.match(partial, /^\*\*Unfinished\.\*\* Not run yet, or never: phone, stall\.$/m);
  assert.match(partial, /- \*\*cpu30\*\*.*Warning: no page\.png: Timeout 20000ms exceeded\.$/m);
  assert.doesNotMatch(summary({ game: 'shadowkey', strict: false, when: 'now', planned: ['baseline'] }, [result('baseline')]), /Unfinished/);
});
