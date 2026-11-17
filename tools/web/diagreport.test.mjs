// Tests for diagreport.mjs: node --test tools/web/diagreport.test.mjs (or npm test).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCHEMA_FILE, checkReport, compare, formatCompare, formatText, isText, lineValues, load, validate, viewOfReport, viewOfText } from './diagreport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'diagreport.mjs');
const FORK = path.join(HERE, '..', '..', 'eka2l1', 'src', 'emu', 'web', 'shell', 'diag', 'report.js');
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CPU = { code: 'cpu-bound', level: 'bad', title: 'This device is too slow for this game', detail: 'The processor was busy 99% of the time.', advice: 'Close other programs.', section: 'speed' };
const CAP = { code: 'game-limited', level: 'info', title: 'The game draws as fast as it wants to', section: 'speed' };

// A report as the player makes it. `change(report)` damages or varies it.
function report(change) {
  const made = {
    kind: 'eka2l1-web-diagnostics',
    v: 1,
    generated: '2026-11-18T10:00:00.000Z',
    page: { address: 'https://example.org/play/', hidden: false },
    game: { uid: '0x101FD3F6', name: 'Elder Scrolls', slug: 'shadowkey' },
    session: { upS: 95, running: true, paused: false, emulatorAnswers: true, samples: 5, measuredS: 4 },
    findings: [{ ...CPU }, { ...CAP }],
    sections: {
      session: { title: 'Session', data: { state: 'running', fps: 19.8349, fpsAverage: 18.5, canvas: { width: 352, height: 416, filter: 'nearest' } }, findings: [] },
      speed: {
        title: 'Speed',
        data: { busyShare: 0.9876, late: [1, 2, 3, 6], threads: [{ name: 'os', busyMs: 1200 }, { name: 'graphics', busyMs: 300 }], note: 'a, b = c', mode: 'mode=fast', list: '1, 2', digits: '12', word: 'yes' },
        findings: ['cpu-bound', 'game-limited'],
      },
      browser: { title: 'Browser and device', data: { ok: true, cores: 8, userAgent: UA }, findings: [] },
    },
    series: { t: [0, 1, 2, 3, 4], fps: [null, 19.8, 20, 12.2, 20], running: [0, 1, 1, 1, 1], hidden: [0, 0, 0, 0, 0] },
    redacted: { roomCodes: 0, names: 0, bluetoothAddresses: 0, addressQueries: 0, homeFolders: 0 },
  };
  if (change) change(made);
  return made;
}

const problemsOf = (change) => checkReport(report(change), SCHEMA).map((problem) => `${problem.at} ${problem.message}`);

test('a report as the player makes it is valid, with or without what redaction adds', () => {
  assert.deepEqual(problemsOf(), []);
  assert.deepEqual(problemsOf((r) => { delete r.redacted; }), []);
  assert.deepEqual(problemsOf((r) => { r.game = null; r.findings = []; r.sections = {}; r.series = { t: [], fps: [], running: [], hidden: [] }; r.session.samples = 0; r.session.upS = null; }), []);
  // A section's data is its own, and a field the format does not know is no fault.
  assert.deepEqual(problemsOf((r) => { r.sections.speed.data = [1, 'two', null]; r.sections.browser.data = null; r.sections.browser.error = 'failed'; r.later = { x: 1 }; }), []);
});

test('a damaged report is refused with the place and what is wrong there', () => {
  const cases = [
    [(r) => { r.kind = 'something-else'; }, 'kind is "something-else", expected "eka2l1-web-diagnostics"'],
    [(r) => { r.v = 2; }, 'v is 2, expected 1'],
    [(r) => { delete r.series; }, 'the report has no "series"'],
    [(r) => { r.generated = 'yesterday'; }, /^generated is "yesterday", which does not look as it must/],
    [(r) => { r.page.address = 'https://example.org/play/?room=ABCDEF'; }, /^page\.address is "https:\/\/example\.org\/play\/\?room=ABCDEF", which does not look as it must/],
    [(r) => { r.page = 'https://example.org/'; }, 'page is a string, expected an object'],
    [(r) => { r.game = { uid: 1 }; }, 'game has no "name"'],
    [(r) => { r.session.samples = '5'; }, 'session.samples is a string, expected an integer'],
    [(r) => { r.session.measuredS = -1; }, 'session.measuredS is -1, less than 0'],
    [(r) => { delete r.session.emulatorAnswers; }, 'session has no "emulatorAnswers"'],
    [(r) => { r.findings[1].level = 'terrible'; }, 'findings[1].level is "terrible", which is not one of "bad", "warn", "info"'],
    [(r) => { r.findings[0].code = 'CPU bound'; }, /^findings\[0\]\.code is "CPU bound", which does not look as it must/],
    [(r) => { delete r.findings[0].title; }, 'findings[0] has no "title"'],
    [(r) => { r.findings = {}; }, 'findings is an object, expected an array'],
    [(r) => { r.sections.speed = null; }, 'sections.speed is null, expected an object'],
    [(r) => { delete r.sections.browser.data; }, 'sections.browser has no "data"'],
    [(r) => { r.sections['My Section'] = { title: 'x', data: 1, findings: [] }; }, /^sections has a field named "My Section", which is not a name it may have/],
    [(r) => { r.series.fps[2] = 'fast'; }, 'series.fps[2] is a string, expected a number or null'],
    [(r) => { r.series.running[1] = 2; }, 'series.running[1] is 2, which is not one of 0, 1'],
    [(r) => { r.redacted.names = -1; }, 'redacted.names is -1, less than 0'],
    // What a schema cannot say.
    [(r) => { r.series.fps.pop(); }, 'series has lists of different lengths (t 5, fps 4, running 5, hidden 5)'],
    [(r) => { r.session.samples = 9; }, 'session.samples is 9, but the series has 5 samples'],
    [(r) => { r.series.t[3] = 1.5; }, 'series.t[3] is 1.5, earlier than the sample before it (2)'],
    [(r) => { r.findings.reverse(); }, 'findings[1] is "bad" after a "info": the findings are not worst first'],
    [(r) => { r.findings[0].section = 'audio'; }, 'findings[0] comes from the section "audio", which the report does not have'],
    // A name every object has is still not a section.
    [(r) => { r.findings[0].section = 'constructor'; }, 'findings[0] comes from the section "constructor", which the report does not have'],
    [(r) => { r.sections.speed.findings = ['game-limited']; }, 'findings[0] is "cpu-bound", which its section "speed" does not list'],
    [(r) => { r.findings.pop(); }, 'sections.speed.findings lists "game-limited", which is not among the report\'s findings'],
  ];
  for (const [change, expected] of cases) {
    const problems = problemsOf(change);
    assert.ok(problems.some((problem) => (expected instanceof RegExp ? expected.test(problem) : problem === expected)), `expected ${expected}, got ${JSON.stringify(problems)}`);
  }
  // Every problem is told, not the first alone.
  assert.equal(problemsOf((r) => { r.v = 2; r.kind = 'x'; delete r.page; }).length, 3);
  for (const junk of [null, 5, 'text', []]) assert.equal(checkReport(junk, SCHEMA).length, 1);
});

test('validate: a schema that refers to what it does not define is an error of the schema', () => {
  assert.throws(() => validate({}, { $ref: '#/$defs/missing' }), /does not define/);
});

test('the text form: the same as the player makes', () => {
  const text = formatText(report());
  const lines = text.split('\n');
  assert.equal(lines[0], 'EKA2L1 web diagnostics v1 | 2026-11-18T10:00:00.000Z | Elder Scrolls (shadowkey, uid 0x101FD3F6) | Chrome 131 on Linux');
  for (const expected of ['[bad] cpu-bound (speed): This device is too slow for this game', '== Speed [speed] ==', 'busyShare: 0.988', 'late: 1, 2, 3, 6',
    'threads[0]: name=os, busyMs=1200', 'note: a, b = c', 'canvas: width=352, height=416, filter=nearest', 'fps: - 19.8 20 12.2 20']) {
    assert.ok(lines.includes(expected), `no line "${expected}" in\n${text}`);
  }
  assert.ok(isText(text));
  assert.ok(isText(`\n\n  ${text}`));
  assert.ok(!isText(JSON.stringify(report())));
  assert.ok(!isText('Some other text | with | bars | in it'));
});

test('the copy of the text form is the fork\'s', { skip: fs.existsSync(FORK) ? false : 'the fork is not checked out' }, async () => {
  const shared = (source) => {
    const from = source.indexOf('// >>> the text form, shared with the reader');
    const to = source.indexOf('// <<< the text form, shared with the reader');
    assert.ok(from >= 0 && to > from, 'the marks are missing');
    return source.slice(from, to);
  };
  assert.equal(shared(fs.readFileSync(TOOL, 'utf8')), shared(fs.readFileSync(FORK, 'utf8')),
    'tools/web/diagreport.mjs and the fork\'s shell/diag/report.js differ between the marks: copy the fork\'s part over');
  const fork = await import(pathToFileURL(FORK).href);
  assert.equal(formatText(report()), fork.formatText(report()));
  assert.equal(formatText(report(), 900), fork.formatText(report(), 900));
});

test('lineValues: what one line of the text holds', () => {
  assert.deepEqual(lineValues('fps', '19.83'), [['fps', 19.83]]);
  assert.deepEqual(lineValues('n', '-3'), [['n', -3]]);
  assert.deepEqual(lineValues('tiny', '1.2e-7'), [['tiny', 1.2e-7]]);
  assert.deepEqual(lineValues('ok', 'yes'), [['ok', true]]);
  assert.deepEqual(lineValues('ok', 'no'), [['ok', false]]);
  assert.deepEqual(lineValues('slug', '-'), [['slug', null]]);
  assert.deepEqual(lineValues('state', 'running'), [['state', 'running']]);
  assert.deepEqual(lineValues('empty', '""'), [['empty', '']]);
  assert.deepEqual(lineValues('list', '(none)'), []);
  assert.deepEqual(lineValues('object', '(empty)'), []);
  assert.deepEqual(lineValues('events', '30 items, 18 left out here'), []);
  assert.deepEqual(lineValues('canvas', 'width=352, height=416, filter=nearest, fill=-'), [['canvas.width', 352], ['canvas.height', 416], ['canvas.filter', 'nearest'], ['canvas.fill', null]]);
  assert.deepEqual(lineValues('item', 'text="a, b = c", ok=yes, quote="say \\"hi\\""'), [['item.text', 'a, b = c'], ['item.ok', true], ['item.quote', 'say "hi"']]);
  assert.deepEqual(lineValues('late', '1, 2, 3, 6'), [['late (mean)', 3]]);
  assert.deepEqual(lineValues('many', '100 values, min 0, mean 49.5, max 99; the last 30: 70, 71'), [['many (mean)', 49.5]]);
  assert.deepEqual(lineValues('words', '40 values; the last 30: a, b'), []);
  // A sentence stays a sentence.
  assert.deepEqual(lineValues('note', 'slow, and x=1 was not it'), [['note', 'slow, and x=1 was not it']]);
  assert.deepEqual(lineValues('userAgent', UA), [['userAgent', UA]]);
});

test('the text read back holds what the file holds', () => {
  const made = report();
  const file = viewOfReport(made);
  const text = viewOfText(formatText(made));
  assert.equal(text.source, 'text');
  assert.equal(text.complete, true);
  assert.equal(text.cut, null);
  for (const name of ['v', 'generated', 'game', 'browser']) assert.equal(text[name], file[name], name);
  assert.deepEqual(text.findings, file.findings);
  assert.deepEqual(text.findings.map((finding) => finding.code), ['cpu-bound', 'game-limited']);
  assert.deepEqual(text.sections, file.sections);
  assert.deepEqual([...text.values.keys()].sort(), [...file.values.keys()].sort());
  for (const [name, value] of file.values) {
    const read = text.values.get(name);
    if (typeof value === 'number') assert.ok(Math.abs(read - value) <= Math.abs(value) * 0.01 + 1e-9, `${name}: ${read} for ${value}`);
    else assert.equal(read, value, name);
  }
  assert.equal(file.values.get('speed.busyShare'), 0.9876);
  // A text that looks like something else is still one value.
  assert.equal(text.values.get('speed.mode'), 'mode=fast');
  assert.equal(text.values.get('speed.list'), '1, 2');
  // A part that failed is told on a line that is not a value.
  const failed = viewOfText(formatText(report((r) => { r.sections.audio = { title: 'Sound', data: null, findings: [], error: 'audio: undefined' }; })));
  assert.deepEqual([...failed.values.keys()].filter((name) => name.startsWith('audio.')), []);
  assert.equal(file.values.get('speed.late (mean)'), 3);
  assert.equal(file.values.get('speed.threads[1].busyMs'), 300);
  assert.equal(file.values.get('session.canvas.width'), 352);
  assert.equal(file.values.get('series.fps (mean)'), 18);
  assert.equal(file.values.get('series.fps (min)'), 12.2);
  // The two of them compare as equal.
  const same = compare(file, text);
  assert.deepEqual([same.gained, same.lost, same.numbers, same.others, same.onlyA, same.onlyB], [[], [], [], [], [], []]);
});

test('the text read back: cut to fit, cut off, pasted with other lines around it', () => {
  const made = report((r) => { r.sections.speed.data.counters = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`counter${i}`, i])); });
  const cut = viewOfText(formatText(made, 2500));
  assert.match(cut.cut, /^Cut to fit 2500 characters/);
  assert.equal(cut.complete, true);
  assert.deepEqual(cut.findings.map((finding) => finding.code), ['cpu-bound', 'game-limited']);
  assert.equal(cut.values.get('series.fps (mean)'), 18);
  const half = viewOfText(formatText(report()).split('\n').slice(0, 12).join('\n'));
  assert.equal(half.complete, false);
  assert.deepEqual(half.findings.map((finding) => finding.code), ['cpu-bound', 'game-limited']);
  // As it comes out of a message: Windows line ends, a greeting before it is not read.
  assert.equal(viewOfText(formatText(report()).replace(/\n/g, '\r\n')).values.get('speed.busyShare'), 0.988);
  assert.equal(viewOfText('Hello, here is my report'), null);
});

test('compare: findings gained and lost, numbers changed by more than a share, other values', () => {
  const a = viewOfReport(report((r) => { r.findings = [{ ...CAP }]; r.sections.speed.findings = ['game-limited']; }));
  const b = viewOfReport(report((r) => {
    r.findings = [{ ...CPU }];
    r.sections.speed.findings = ['cpu-bound'];
    r.sections.session.data.fps = 6.2; // 19.83 -> 6.2
    r.sections.session.data.fpsAverage = 17; // -8%: not told
    r.sections.session.data.state = 'paused';
    r.sections.speed.data.busyShare = 0;
    r.sections.speed.data.threads[1].busyMs = 900;
    r.sections.speed.data.extra = 1;
    delete r.sections.browser;
    r.sections.audio = { title: 'Sound', data: { underruns: 4 }, findings: [] };
    r.series.fps = [null, 6, 6.2, 5.8, 6];
  }));
  const result = compare(a, b);
  assert.deepEqual(result.gained.map((finding) => finding.code), ['cpu-bound']);
  assert.deepEqual(result.lost.map((finding) => finding.code), ['game-limited']);
  assert.deepEqual(result.both, []);
  assert.deepEqual(result.numbers.map((entry) => entry.path), ['session.fps', 'speed.busyShare', 'speed.threads[1].busyMs', 'series.fps (mean)', 'series.fps (min)']);
  assert.equal(result.numbers[2].change, 2);
  assert.ok(Math.abs(result.numbers[0].change + 0.687) < 0.001);
  assert.deepEqual(result.others, [{ path: 'session.state', a: 'running', b: 'paused' }]);
  assert.deepEqual(result.onlyA, ['browser.ok', 'browser.cores', 'browser.userAgent']);
  assert.deepEqual(result.onlyB, ['speed.extra', 'audio.underruns']);
  // A number that was 0 has no share to change by: it is told whatever it became.
  const zero = compare(b, a);
  assert.deepEqual(zero.numbers.find((entry) => entry.path === 'speed.busyShare'), { path: 'speed.busyShare', a: 0, b: 0.9876, change: null });
  // The share decides.
  assert.ok(compare(a, b, 0.05).numbers.some((entry) => entry.path === 'session.fpsAverage'));
  assert.deepEqual(compare(a, b, 5).numbers, []);
  assert.deepEqual(compare(b, a, 5).numbers.map((entry) => entry.path), ['speed.busyShare']);

  const text = formatCompare(a, b, result, ['plain.json', 'slow.json']);
  for (const expected of [
    'A: plain.json',
    'B: slow.json',
    '  only in B: [bad] cpu-bound (speed): This device is too slow for this game',
    '  only in A: [info] game-limited (speed): The game draws as fast as it wants to',
    'Numbers that changed by more than 20%',
    '  session.fps: 19.83 -> 6.2 (-69%)',
    '  speed.busyShare: 0.988 -> 0 (-100%)',
    '  speed.threads[1].busyMs: 300 -> 900 (+200%)',
    '  series.fps (mean): 18 -> 6 (-67%)',
    'Other values that differ',
    '  session.state: running -> paused',
    'Only in A',
    '  the section browser',
    'Only in B',
    '  the section audio',
    '  speed.extra: 1',
  ]) assert.ok(text.split('\n').includes(expected), `no line "${expected}" in\n${text}`);
  assert.ok(!text.includes('browser.cores'));
});

test('compare: two of the same', () => {
  const view = viewOfReport(report());
  const text = formatCompare(view, view, compare(view, view));
  assert.ok(text.includes('  the same in both\n  in both: cpu-bound, game-limited'));
  assert.ok(text.includes('Numbers that changed by more than 20%\n  none'));
  assert.ok(!text.includes('Other values'));
  const none = viewOfReport(report((r) => { r.findings = []; r.sections.speed.findings = []; }));
  assert.ok(formatCompare(none, none, compare(none, none)).includes('  none in either'));
});

test('compare: a long list of differences is cut unless all are asked for', () => {
  const counters = (factor) => (r) => { r.sections.speed.data.counters = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`counter${i}`, (i + 1) * factor])); };
  const a = viewOfReport(report(counters(1)));
  const b = viewOfReport(report(counters(2)));
  const result = compare(a, b);
  assert.equal(result.numbers.length, 100);
  assert.ok(formatCompare(a, b, result).includes('  ... and 40 more numbers (--all prints them)'));
  assert.ok(formatCompare(a, b, result, ['A', 'B'], { all: true }).includes('speed.counters.counter99: 100 -> 200 (+100%)'));
});

test('load: the file, the text, and what is neither', () => {
  assert.equal(load('a', JSON.stringify(report()), SCHEMA).view.source, 'file');
  assert.equal(load('a', formatText(report()), SCHEMA).view.source, 'text');
  assert.match(load('a', 'Hello', SCHEMA).problems[0].message, /is neither a report's JSON .* nor its text form/);
  assert.equal(load('a', JSON.stringify(report((r) => { r.v = 3; })), SCHEMA).view, null);
});

test('the command: exit codes and what is printed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagreport-'));
  try {
    const write = (name, content) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
      return file;
    };
    const run = (...args) => spawnSync(process.execPath, [TOOL, ...args.flat()], { encoding: 'utf8', input: '', timeout: 30000 });
    const good = write('good.json', report());
    const slow = write('slow.json', report((r) => { r.sections.session.data.fps = 5; r.findings = [{ ...CPU }]; r.sections.speed.findings = ['cpu-bound']; }));
    const bad = write('bad.json', report((r) => { r.findings[0].level = 'terrible'; }));
    const text = write('good.txt', formatText(report()));

    let result = run(good);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^VALID {2}.*good\.json: a report of Elder Scrolls \(shadowkey, uid 0x101FD3F6\), 2 findings, 3 sections\n\nEKA2L1 web diagnostics v1 \|/);
    assert.ok(result.stdout.endsWith(formatText(report())));

    result = run(good, '--quiet');
    assert.equal(result.status, 0);
    assert.equal(result.stdout.split('\n').length, 2);

    result = run(bad);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^INVALID {2}.*bad\.json: 1 problem\n {2}findings\[0\]\.level is "terrible", which is not one of "bad", "warn", "info"\n$/);

    result = run(write('broken.json', '{"kind": '));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is neither a report's JSON/);

    result = run(text);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^TEXT {2}.*good\.txt: the text form of a report of Elder Scrolls .*, read loosely and not checked\n {2}made 2026-11-18T10:00:00\.000Z in Chrome 131 on Linux\n {2}findings: cpu-bound \[bad\], game-limited \[info\]\n {2}session: /);

    result = spawnSync(process.execPath, [TOOL, '-'], { encoding: 'utf8', input: JSON.stringify(report()), timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^VALID {2}standard input:/);

    result = run('--compare', good, slow);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('  only in A: [info] game-limited (speed): The game draws as fast as it wants to'));
    assert.ok(result.stdout.includes('  session.fps: 19.83 -> 5 (-75%)'));
    assert.ok(!result.stdout.includes('speed.busyShare'));

    // The text of one against the file of the other.
    result = run('--compare', text, slow, '--share', '0.5');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('  session.fps: 19.83 -> 5 (-75%)'));
    assert.ok(result.stdout.includes('from the text form'));

    result = run('--compare', good, bad);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bad\.json: 1 problem/);

    for (const args of [[], [good, slow], ['--compare', good], ['--compare', good, slow, bad], ['--nonsense', good], [good, '--share'], [good, '--share', 'x'], ['--compare', '-', '-'],
      [path.join(dir, 'missing.json')]]) {
      result = run(args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node tools\/web\/diagreport\.mjs/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
