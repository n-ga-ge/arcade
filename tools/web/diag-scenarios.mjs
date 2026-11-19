// The scenarios of the diagnostics harness (diag.mjs) and the parts of it that
// need no browser: the table of scenarios, reading a list of them, the
// verdict on a run, and the summary. Kept apart so they can be tested by
// themselves (diag-scenarios.test.mjs).
//
// A scenario is a condition and what the diagnostics must say under it:
//
//   what          one line for the summary: the visitor's situation it stands for
//   options       the condition, as options of diag.mjs (so `--cpu 30` here is
//                 { cpu: '30' }, and the same run can be made by hand)
//   expect        finding codes the report must have. While the sections that
//                 make them are not all there, a missing one is only reported
//                 ("not produced"); with --strict it fails the scenario
//   absent        finding codes the report must not have: always a failure
//   absentLevels  levels no finding of the report may have, whatever its code
//
// The codes are those of the player's shell/diag/codes.js (docs/diagnostics.md,
// "Findings"). To change what a scenario expects, change its lines here: the
// test checks the table against the codes.

// The levels of a finding, worst first, as codes.js has them.
export const LEVELS = ['bad', 'warn', 'info'];

// A finding code, as codes.js writes them.
export const CODE = /^[a-z]+(-[a-z]+)*$/;

// 'a, b,,c' as ['a', 'b', 'c'].
export const list = (value) => (value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : []);

// --device: the names tools/web/suite.mjs uses, and Playwright's device each
// stands for (viewport, touch, a mobile user agent: Chromium's emulation).
export const DEVICES = {
  phone: 'Pixel 7',
  'phone-landscape': 'Pixel 7 landscape',
  iphone: 'iPhone 14',
  tablet: 'iPad (gen 7)',
  'tablet-landscape': 'iPad (gen 7) landscape',
};

// Findings that say the player or the game is broken. No scenario breaks
// anything, so none may show them.
const BROKEN = ['browser-unsupported', 'game-crashed', 'emulator-stopped', 'context-lost', 'audio-unavailable'];
// The finding each condition is there to provoke. A scenario that does not
// set the condition must not show its finding: that is what tells a finding
// that means something from one that is always there.
const SLOW = ['cpu-bound'];
const SOFTWARE = ['software-rendering'];
const UNDRAWN = ['no-animation-frames'];
const HIDDEN = ['tab-was-hidden'];
const SILENT = ['audio-suspended'];

export const SCENARIOS = {
  baseline: {
    what: 'The game as this machine runs it: nothing is wrong.',
    options: {},
    expect: [],
    absent: [...BROKEN, ...SLOW, ...SOFTWARE, ...UNDRAWN, ...HIDDEN, ...SILENT],
    absentLevels: ['bad'],
  },
  cpu60: {
    what: 'A device a little too slow: the browser gets 60% of one processor core.',
    options: { cpu: '60', 'cpu-from': 'play' },
    // Between enough and too little: whether the game falls behind depends on
    // the game and the machine, so nothing is expected either way.
    expect: [],
    absent: [...BROKEN, ...SOFTWARE, ...UNDRAWN, ...HIDDEN, ...SILENT],
  },
  cpu30: {
    what: 'A device far too slow: the browser gets 30% of one processor core.',
    options: { cpu: '30', 'cpu-from': 'play' },
    expect: ['cpu-bound'],
    // A game held back by the processor is not one that draws as fast as it wants.
    absent: [...BROKEN, 'game-limited', ...SOFTWARE, ...UNDRAWN, ...HIDDEN, ...SILENT],
  },
  software: {
    what: 'A browser without a usable GPU: WebGL is drawn on the processor.',
    options: { browser: 'chrome-software' },
    expect: ['software-rendering'],
    absent: [...BROKEN, ...UNDRAWN, ...HIDDEN, ...SILENT],
  },
  hidden: {
    what: 'The visitor went to another tab after playing: the page is hidden and has paused the game.',
    options: { hidden: true },
    // A hidden tab gets no animation frames either, but its game is paused
    // and draws nothing, by a timer or otherwise: whether that is worth a
    // finding is the graphics section's to say, so it is neither expected
    // nor unwanted here. The page also stops the sound of a paused game:
    // that is not a browser that has not let sound start (audio-suspended).
    expect: ['tab-was-hidden'],
    absent: [...BROKEN, ...SLOW, ...SOFTWARE, ...SILENT],
  },
  undrawn: {
    what: 'The browser does not draw the page and still calls it visible (a covered window on some systems): the game goes on, drawn by a timer.',
    options: { undrawn: true },
    expect: ['no-animation-frames'],
    absent: [...BROKEN, ...SOFTWARE, ...HIDDEN, ...SILENT],
  },
  phone: {
    what: "The player as a phone lays it out (Chromium's emulation of a Pixel 7; the processor is still this machine's).",
    options: { device: 'phone' },
    expect: [],
    absent: [...BROKEN, ...SLOW, ...SOFTWARE, ...UNDRAWN, ...HIDDEN, ...SILENT],
    absentLevels: ['bad'],
  },
  nosound: {
    what: 'The visitor has not clicked or pressed anything yet, so the browser keeps sound off.',
    options: { nosound: true },
    expect: ['audio-suspended'],
    absent: [...BROKEN, ...SLOW, ...SOFTWARE, ...UNDRAWN, ...HIDDEN],
  },
  stall: {
    what: "The page's own thread is held up for a third of every second; the emulator's threads are not.",
    options: { block: '300' },
    expect: ['main-thread-stalls'],
    // Only the page's thread is held up, so the game itself must not be found
    // slow. (Chrome's throttling, --throttle, slows that thread too, but on a
    // quiet machine the page has too little to do for it to stall.)
    absent: [...BROKEN, ...SLOW, ...SOFTWARE, ...UNDRAWN, ...HIDDEN, ...SILENT],
  },
};

// Options of diag.mjs that make the condition. A scenario sets its own, so
// none of them, and no --expect or --absent, can be given beside --scenario.
export const CONDITION_OPTIONS = ['browser', 'cpu', 'cpu-from', 'cores', 'throttle', 'block', 'hidden', 'undrawn', 'device', 'nosound'];
export const BROWSER_NAMES = ['chrome', 'chrome-software'];

// What is wrong with a condition, as the message for the command line, or
// null. `options` are diag.mjs's options by name, values as they are typed.
export function conditionProblem(options) {
  if (options.browser !== undefined && !BROWSER_NAMES.includes(options.browser)) return `unknown browser: ${options.browser}`;
  for (const name of ['cpu', 'cores', 'throttle', 'block']) {
    if (options[name] !== undefined && !(Number(options[name]) > 0)) return `--${name} must be a positive number`;
  }
  if (options.cores !== undefined && !Number.isInteger(Number(options.cores))) return '--cores must be a whole number';
  if (options.block !== undefined && Number(options.block) >= 1000) return '--block must be less than 1000: it is milliseconds of every second';
  if (options['cpu-from'] !== undefined && !['start', 'play'].includes(options['cpu-from'])) return `--cpu-from is start or play, not ${options['cpu-from']}`;
  if (options['cpu-from'] !== undefined && options.cpu === undefined) return '--cpu-from needs --cpu';
  if (options.hidden && options.undrawn) return '--hidden already takes the animation frames away: give it or --undrawn, not both';
  if (options.device !== undefined && !Object.hasOwn(DEVICES, options.device)) return `unknown device: ${options.device} (there are: ${Object.keys(DEVICES).join(', ')})`;
  return null;
}

// The names --scenario asks for, in the order given and each once. 'all' is
// every scenario of the table, in its order. Throws on a name the table lacks.
export function parseScenarios(value, table = SCENARIOS) {
  const names = list(value);
  if (!names.length) throw new Error(`--scenario needs a name (there are: ${Object.keys(table).join(', ')}, or all)`);
  const chosen = [];
  for (const name of names) {
    const some = name === 'all' ? Object.keys(table) : [name];
    if (name !== 'all' && !Object.hasOwn(table, name)) throw new Error(`unknown scenario: ${name} (there are: ${Object.keys(table).join(', ')}, or all)`);
    for (const one of some) {
      if (!chosen.includes(one)) chosen.push(one);
    }
  }
  return chosen;
}

// What is wrong with a table of scenarios, as a list of sentences (empty when
// it is sound). `codes` is the object of codes.js when it is at hand, and
// `levels` its list of levels; without them only the form is checked.
export function tableProblems(table, { codes = null, levels = LEVELS } = {}) {
  const problems = [];
  for (const [name, scenario] of Object.entries(table)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name === 'all') problems.push(`${name}: not a name for a scenario`);
    if (!scenario.what) problems.push(`${name}: says nothing about what it stands for ("what")`);
    for (const field of ['expect', 'absent']) {
      if (!Array.isArray(scenario[field])) {
        problems.push(`${name}: "${field}" is not a list`);
        continue;
      }
      for (const code of scenario[field]) {
        if (!CODE.test(code)) problems.push(`${name}: "${code}" in "${field}" is not a finding code`);
        else if (codes && !Object.hasOwn(codes, code)) problems.push(`${name}: "${code}" in "${field}" is not a code of codes.js`);
      }
      if (new Set(scenario[field]).size !== scenario[field].length) problems.push(`${name}: "${field}" names a code twice`);
    }
    for (const code of (Array.isArray(scenario.expect) ? scenario.expect : [])) {
      if (Array.isArray(scenario.absent) && scenario.absent.includes(code)) problems.push(`${name}: "${code}" is both expected and unwanted`);
    }
    if (scenario.absentLevels !== undefined && !Array.isArray(scenario.absentLevels)) problems.push(`${name}: "absentLevels" is not a list`);
    for (const level of (Array.isArray(scenario.absentLevels) ? scenario.absentLevels : [])) {
      if (!levels.includes(level)) problems.push(`${name}: "${level}" is not a level`);
    }
    for (const option of Object.keys(scenario.options || {})) {
      if (!CONDITION_OPTIONS.includes(option)) problems.push(`${name}: "${option}" is not an option that makes a condition`);
    }
    const problem = conditionProblem(scenario.options || {});
    if (problem) problems.push(`${name}: ${problem}`);
  }
  return problems;
}

// Why the page was not under the condition the options asked for, from what
// the page showed after the play, or null when it was. Only the conditions
// the tool makes inside the page can fail to take without anything else
// failing: a hidden page and one without animation frames.
//   seen  { hidden, visibility, animationFrames, paused, hiddenSamples,
//           reportHidden }: the document's own words, the animation frames
//           the page's thread got in a second, whether the page paused the
//           game, how many of the last samples of the report say "hidden",
//           and what the report says of the page
export function conditionMissed(options, seen) {
  if (options.hidden) {
    const lacks = [];
    // These two are what the tool set, read back: they catch a page that
    // undid it, not a browser that drew the page all the same.
    if (seen.hidden !== true || seen.visibility !== 'hidden') lacks.push('the document does not say "hidden"');
    if (seen.animationFrames !== 0) lacks.push(`it got ${seen.animationFrames} animation frames in a second`);
    // The page's answer to visibilitychange, and the diagnostics' own sampler.
    if (!seen.paused) lacks.push('the page did not pause the game, so visibilitychange did not reach it');
    if (!(seen.hiddenSamples > 0) || !seen.reportHidden) lacks.push('the report does not say it was hidden');
    return lacks.length ? `the page was not hidden: ${lacks.join('; ')}` : null;
  }
  if (options.undrawn && seen.animationFrames !== 0) return `the page was not undrawn: it got ${seen.animationFrames} animation frames in a second`;
  return null;
}

// A scenario's options as they are typed: { cpu: '30', hidden: true } is
// "--cpu 30 --hidden". Nothing set is "(nothing)".
export function conditionText(options) {
  const parts = Object.entries(options || {}).filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([name, value]) => (value === true ? `--${name}` : `--${name} ${value}`));
  return parts.length ? parts.join(' ') : '(nothing)';
}

// The verdict on one run.
//   expected  { expect, absent, absentLevels }: a scenario, or a single run's
//             --expect and --absent
//   seen      { findings: [{ code, level }], error, skipped }: what the report
//             held; `error` when the run could not be carried out, `skipped`
//             (a reason) when the machine cannot make the condition
//   strict    whether a missing expected finding fails
// Returns { verdict, missing, unwanted }: 'skipped', 'fail' or 'pass';
// `missing` are the expected codes the report lacks (with a 'pass' they are
// the ones "not produced"), `unwanted` the findings it must not have.
// A run that could not be carried out never passes, whatever was expected:
// otherwise a browser that did not start would look like a game with nothing
// wrong.
export function judge(expected, seen, strict) {
  if (seen.skipped) return { verdict: 'skipped', missing: [], unwanted: [] };
  if (seen.error) return { verdict: 'fail', missing: [], unwanted: [] };
  const findings = seen.findings || [];
  const codes = findings.map((finding) => finding.code);
  const missing = (expected.expect || []).filter((code) => !codes.includes(code));
  const unwanted = [];
  for (const finding of findings) {
    const banned = (expected.absent || []).includes(finding.code) || (expected.absentLevels || []).includes(finding.level);
    if (banned && !unwanted.includes(finding.code)) unwanted.push(finding.code);
  }
  return { verdict: unwanted.length || (strict && missing.length) ? 'fail' : 'pass', missing, unwanted };
}

// The verdict in words, for the summary and the tool's own output. A missing
// expected finding is "missing" where it fails the run (a strict one) and
// "not produced" where it does not, whatever else failed it.
export function verdictText(result) {
  if (result.verdict === 'skipped') return `skipped: ${result.skipped}`;
  if (result.error) return `FAIL: ${result.error}`;
  const causes = [];
  if (result.unwanted.length) causes.push(`unwanted ${result.unwanted.join(', ')}`);
  if (result.strict && result.missing.length) causes.push(`missing ${result.missing.join(', ')}`);
  const beside = !result.strict && result.missing.length ? ` (not produced: ${result.missing.join(', ')})` : '';
  return result.verdict === 'fail' ? `FAIL: ${causes.join('; ')}${beside}` : `pass${beside}`;
}

// 0 when no scenario failed (a skipped one did not fail), else 1.
export function exitCode(results) {
  return results.some((result) => result.verdict === 'fail') ? 1 : 0;
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const oneDecimal = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : null);

// The frame rate a run measured, for the summary: "17.3 (worst 12.0) over 30 s".
export function speedText(measured) {
  const fps = measured ? oneDecimal(measured.fps) : null;
  if (fps === null) return 'not measured';
  const worst = oneDecimal(measured.fpsWorst);
  return `${fps}${worst === null ? '' : ` (worst ${worst})`} over ${Math.round(measured.seconds || 0)} s`;
}

// What the page itself showed of the condition, in words: the proof that the
// condition was there, whatever the diagnostics made of it.
export function seenText(result) {
  const parts = [];
  const seen = result.measured;
  if (result.condition && result.condition.quota) parts.push(`the browser's cgroup has the quota "${result.condition.quota}" (microseconds of each period)`);
  if (seen) {
    if (typeof seen.animationFrames === 'number') parts.push(`the page's own thread got ${seen.animationFrames} animation frames in a second`);
    if (seen.sound) parts.push(`its sound was ${seen.sound}`);
    if (seen.renderer) parts.push(`WebGL is drawn by ${seen.renderer}${seen.softwareRenderer ? ' (on the processor)' : ''}`);
    if (typeof seen.hidden === 'boolean') parts.push(seen.hidden ? 'the page was told it is hidden' : 'the page was told it is visible');
    if (seen.paused) parts.push('the game was paused');
    if (seen.hiddenSamples > 0) parts.push(`the last ${seen.hiddenSamples} samples of the report say "hidden"`);
    if (typeof seen.load === 'number') parts.push(`the machine's load was ${seen.load.toFixed(1)}${seen.threads ? ` on ${seen.threads} processor threads` : ''}`);
    if (result.condition && (result.condition.hidden || result.condition.undrawn)) parts.push("the emulator's animation frames were switched off");
  }
  return parts.join('; ');
}

// summary.md: one row per scenario, then what the reader must know to read it.
//   run      { game, version (the browser's), strict, when, planned (the
//            names of all scenarios of the run, when some are still to come) }
//   results  one per scenario, as diag.mjs writes them to result.json
export function summary(run, results) {
  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  const ahead = (run.planned || []).filter((name) => !results.some((result) => result.scenario === name));
  const lines = [
    `# Diagnostics scenarios: ${run.game}`,
    '',
    ...(ahead.length ? [`**Unfinished.** Not run yet, or never: ${ahead.join(', ')}.`, ''] : []),
    `${run.when}${run.version ? `, Chrome ${run.version}` : ''}. ${results.length} scenarios: ${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped.`
      + (run.strict ? ' Strict: an expected finding that is missing fails its scenario.'
        : ' Not strict: an expected finding that is missing is reported as "not produced" and does not fail its scenario (--strict makes it).'),
    '',
    '| Scenario | Condition | Frames per second | Findings | Expected | Verdict |',
    '|---|---|---|---|---|---|',
  ];
  for (const result of results) {
    lines.push(`| ${[
      result.scenario,
      `\`${conditionText(result.options)}\``,
      result.verdict === 'skipped' ? '' : speedText(result.measured),
      result.findings.length ? result.findings.map((code) => `${code}${result.levels && result.levels[code] ? ` (${result.levels[code]})` : ''}`).join(', ')
        : result.verdict === 'skipped' || result.error ? '' : 'none',
      result.expect.length ? result.expect.join(', ') : 'nothing',
      verdictText(result),
    ].map(cell).join(' | ')} |`);
  }
  lines.push('');
  for (const result of results) {
    const banned = [...(result.absentLevels || []).map((level) => `any finding of level "${level}"`), ...(result.absent || [])];
    const seen = seenText(result);
    lines.push(`- **${result.scenario}** (files in \`${result.scenario}/\`): ${result.what}`
      + ` Must not have: ${banned.length ? banned.join(', ') : 'nothing'}.`
      + (seen ? ` Seen: ${seen}.` : '')
      + ((result.warnings || []).length ? ` Warning: ${result.warnings.join('; ')}.` : ''));
  }
  lines.push('',
    'Frames per second are the average (and the worst second) of the last stretch of play, from the report\'s `session` section. '
    + 'They say how the condition changed the game\'s speed on this machine at this moment, and little else: a busy machine lowers them all.',
    '',
    'Look at each `page.png`: it must show the game in play. A run whose key script was lost on the way measures a menu.',
    '');
  return lines.join('\n');
}

// What `cpu.max` of a cgroup says about a quota of `percent` of one core:
// true when it is applied. The file reads "<quota> <period>" in microseconds,
// or "max <period>" when there is no quota.
export function quotaApplied(cpuMax, percent) {
  const match = /^(\d+) (\d+)\s*$/.exec(String(cpuMax || ''));
  if (!match || !(Number(match[2]) > 0)) return false;
  return Math.abs((Number(match[1]) * 100) / Number(match[2]) - percent) < 0.5;
}
