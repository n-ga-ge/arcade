// Plays a game in a browser under a chosen condition and keeps what the
// player's diagnostics say about it: the tool for reproducing "the game runs
// badly on my machine" on this one, and the test of the diagnostics themselves.
//
//   node tools/web/diag.mjs --game <slug> --out <dir> [options]               one run
//   node tools/web/diag.mjs --game <slug> --out <dir> --scenario a,b [...]    named scenarios
//
//   --game SLUG        catalog/games/<SLUG>.json and <assets>/games/<SLUG>.zip
//   --out DIR          where the results are written (see below)
//   --seconds N        how long the game is played before the report is read
//                      (default 30; the diagnostics measure over 30 seconds)
//   --keys a,b         N-Gage keys held in turn, a second each, while it is
//                      played, so that the game keeps drawing (default: left)
//   --idle             press nothing while it is played
//   --stretch F        make every wait of the key script F times as long, and
//                      give the browser and the game F times as long to
//                      start, for a machine too busy to keep up (look at
//                      page.png: it must show the game in play)
//   --query STRING     more page parameters, e.g. "diag=1&log=*:info"
//   --hook FILE        a module whose default export is called once the game
//                      is in play and before it is measured, with { page,
//                      press, sleep, evaluate }: for conditions this tool has
//                      no option for
//   --port N           port for the dev server this tool starts (default: a free one)
//   --bin DIR          web build to use (default: eka2l1/build/web/bin of this
//                      checkout, else of $ARCADE_MAIN)
//   --shell DIR        page sources laid over that build (devserver.py --shell)
//   --assets DIR       folder with the firmware (NGAGE.ROM; for an N-Gage 2.0
//                      game the phone's device zip and the N-Gage
//                      application) and games/<slug>.zip (default: testdata/
//                      of this checkout, else of $ARCADE_MAIN)
//   --verbose          print the page console while it runs
//
// The condition of one run:
//
//   --browser NAME     chrome (default): the toolchain's Chrome on this
//                      machine's GPU; chrome-software: Playwright's Chromium
//                      drawing on the processor, as a machine without a GPU does
//   --cpu PERCENT      give the whole browser at most PERCENT of one processor
//                      core (a cgroup quota, set with systemd-run --user): a
//                      slow device. The emulator needs about one core, so 50
//                      is a device half as fast as it needs. It takes a user
//                      systemd that has the cpu controller; where there is
//                      none (a container) the run fails and says so
//   --cpu-from WHEN    start (default): the quota holds from the moment the
//                      browser starts, so loading, starting and the key script
//                      are slow too (give --stretch for the script; the start
//                      gets 100/PERCENT times as long by itself); play: it is
//                      set once the
//                      game is in play, so only what is measured is slow
//   --cores N          let the browser use only N processor cores (taskset)
//   --throttle N       slow the page's own thread down N times (Chrome's CPU
//                      throttling, which does not reach workers, so it does
//                      not slow the emulator: for a page that stalls)
//   --hidden           make the page a tab in the background once the game
//                      has been played, and read the report there ten seconds
//                      later. Headless Chrome hides no page whatever is put
//                      in front of it, so the page is shown what a hidden tab
//                      sees: the document says "hidden", visibilitychange
//                      fires, and neither the emulator nor the page's own
//                      thread gets animation frames. The page then pauses the
//                      game, as it does for a lone player; the rates in the
//                      report are those of the play before. A run in which
//                      that did not take fails: "the page was not hidden"
//   --undrawn          give the emulator and the page no animation frames while
//                      the game is played and let it go on (the emulator's own
//                      test switch): a page the browser does not draw and still
//                      calls visible, as some systems treat a covered window.
//                      The emulator then draws by its timer. It is also what
//                      a hidden tab in a multiplayer room gets
//   --device NAME      lay the page out as a phone or tablet does (Chromium's
//                      emulation: viewport, touch, a mobile user agent; the
//                      processor is still this machine's): phone,
//                      phone-landscape, iphone, tablet, tablet-landscape
//   --nosound          do not click the page, so the browser never lets sound
//                      start (without this the page is clicked once)
//   --expect a,b       finding codes the report must have
//   --absent a,b       finding codes the report must not have
//
// Scenarios:
//
//   --scenario a,b     run these scenarios one after another instead of one
//                      run; "all" is every one. A scenario is a condition
//                      from the options above and the findings it must and
//                      must not produce; the table is in diag-scenarios.mjs:
//                      baseline, cpu60, cpu30, software, hidden, undrawn,
//                      phone, nosound, stall. The condition options, --expect
//                      and --absent cannot be given with it
//   --strict           fail a scenario whose expected finding is missing.
//                      Without it that is only reported ("not produced"),
//                      for a build whose diagnostics are not complete; an
//                      unwanted finding fails either way
//
// A scenario whose condition this machine cannot make (no user systemd with
// the cpu controller for --cpu) is skipped and not failed.
//
// The game is brought into play with the key script of its catalogue entry
// (test.script), as the per-game test does; a game without one is measured
// where it starts.
//
// Written to --out (with --scenario: to <out>/<scenario>/ for each):
//   report.json   the diagnostics report (the player's "Download report")
//   report.txt    the same as the player copies it to the clipboard
//   dialog.png    the Diagnostics dialog as the visitor sees it, still under
//                 the condition
//   page.png      the page before the dialog was opened (under --hidden: the
//                 paused game)
//   console.log   the page console
//   result.json   { pass, verdict ("pass", "fail", "skipped"), scenario, game,
//                   browser, version, condition, seconds,
//                   measured: { fps, fpsWorst, seconds } from the report's
//                     session section, and what the page itself showed of the
//                     condition: animationFrames (of its own thread, in one
//                     second), sound (the state of its audio), renderer,
//                     softwareRenderer, hidden, visibility, paused,
//                     hiddenSamples (how many of the report's last samples
//                     say "hidden"); and load, the
//                     machine's one-minute load average while it was played
//                     (the browser's own work is about 1.5 of it), beside
//                     threads, the processor threads it has,
//                   findings: [codes], levels: { code: level },
//                   expect, absent, absentLevels, strict,
//                   missing: [codes], unwanted: [codes], warnings (a picture
//                   that could not be taken, a play shorter than what is
//                   measured), skipped, error }
// and with --scenario, to --out itself:
//   summary.md    a table: scenario, condition, frames per second, findings,
//                 expected, verdict; then what each scenario stands for and
//                 what the page showed of its condition
//   results.json  { game, strict, planned: [names], complete, passed,
//                   failed, skipped (counts), pass (nothing failed and at
//                   least one scenario passed), scenarios: [every result.json] }
// Both are written anew after every scenario; until the last one they say
// that the run is unfinished, and `pass` is false.
//
// Exit code 0 when the report was read and what was expected holds (with
// --scenario: when no scenario failed; skipped ones do not fail, so a run in
// which all were skipped exits 0 too, says "Nothing was judged" and has
// `pass: false` in results.json), 1 when not, 2 when the command line is
// wrong. Frame rates measured while other heavy programs run say little;
// provoke a condition with a wide margin.
import { chromium, devices } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORM_FILES, checkScript, gameQuery, platformOf, scriptMs, stepTiming } from './gamecheck.mjs';
import { CODE, CONDITION_OPTIONS, DEVICES, SCENARIOS, conditionMissed, conditionProblem, exitCode, judge, list, parseScenarios, quotaApplied, summary, tableProblems, verdictText }
  from './diag-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPTIONS = {
  game: 'value', out: 'value', scenario: 'value', strict: 'flag', browser: 'value', seconds: 'value', keys: 'value', idle: 'flag', stretch: 'value',
  cpu: 'value', 'cpu-from': 'value', cores: 'value', throttle: 'value', hidden: 'flag', undrawn: 'flag', device: 'value', nosound: 'flag',
  query: 'value', hook: 'value', expect: 'value', absent: 'value', port: 'value', bin: 'value', shell: 'value', assets: 'value', verbose: 'flag',
};

function usage(message) {
  console.error(`${message}\nusage: node tools/web/diag.mjs --game <slug> --out <dir> [--seconds N] [--keys a,b | --idle] [--stretch F] [--query STRING] [--hook FILE]`
    + ' [--port N] [--bin DIR] [--shell DIR] [--assets DIR] [--verbose]\n'
    + '       one run:   [--browser chrome|chrome-software] [--cpu PERCENT [--cpu-from start|play]] [--cores N] [--throttle N] [--hidden | --undrawn]'
    + ` [--device ${Object.keys(DEVICES).join('|')}] [--nosound] [--expect a,b] [--absent a,b]\n`
    + `       scenarios: --scenario ${Object.keys(SCENARIOS).join(',')} | all  [--strict]`);
  process.exit(2);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, '');
  if (!process.argv[i].startsWith('--') || !Object.hasOwn(OPTIONS, name)) usage(`unknown argument: ${process.argv[i]}`);
  if (OPTIONS[name] === 'flag') { args[name] = true; continue; }
  if (i + 1 >= process.argv.length) usage(`--${name} needs a value`);
  args[name] = process.argv[++i];
}
if (!args.out) usage('--out is required');
if (!args.game) usage('--game is required');
if (!/^[a-z0-9-]+$/.test(args.game)) usage(`not a game name: ${args.game}`);
for (const name of ['seconds', 'port', 'stretch']) {
  if (args[name] !== undefined && !(Number(args[name]) > 0)) usage(`--${name} must be a positive number`);
}
const badCondition = conditionProblem(args);
if (badCondition) usage(badCondition);
for (const code of [...list(args.expect), ...list(args.absent)]) {
  if (!CODE.test(code)) usage(`not a finding code: ${code}`);
}
let scenarioNames = null;
if (args.scenario !== undefined) {
  for (const name of [...CONDITION_OPTIONS, 'expect', 'absent']) {
    if (args[name] !== undefined) usage(`--${name} cannot be given with --scenario: a scenario sets its own condition and expectations`);
  }
  try {
    scenarioNames = parseScenarios(args.scenario);
  } catch (error) {
    usage(error.message);
  }
  const problems = tableProblems(SCENARIOS);
  if (problems.length) throw new Error(`the table of scenarios in diag-scenarios.mjs is wrong: ${problems.join('; ')}`);
} else if (args.strict) {
  usage('--strict belongs to --scenario: a single run always fails on a missing --expect');
}

const MAIN = process.env.ARCADE_MAIN || ROOT;
const firstWith = (file, ...folders) => folders.find((folder) => fs.existsSync(path.join(folder, file))) || folders[0];
const binDir = path.resolve(args.bin || firstWith('eka2l1_web.wasm', path.join(ROOT, 'eka2l1', 'build', 'web', 'bin'), path.join(MAIN, 'eka2l1', 'build', 'web', 'bin')));
const assetsDir = path.resolve(args.assets || firstWith('NGAGE.ROM', path.join(ROOT, 'testdata'), path.join(MAIN, 'testdata')));
const outDir = path.resolve(args.out);
const seconds = Number(args.seconds || 30);
const keys = args.idle ? [] : list(args.keys || 'left');
const stretch = Number(args.stretch || 1);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (error) => String(error && error.message ? error.message : error).split('\n')[0];
const withTimeout = (promise, ms, what) => {
  let timer = null;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

const ANSWER_MS = 30000;
// What one run writes into its folder.
const RUN_FILES = ['report.json', 'report.txt', 'dialog.png', 'page.png', 'console.log', 'result.json', 'browser-limited.sh'];
// --hidden: how long the page stays hidden before the report is read.
const HIDDEN_MS = 10000;
// A condition this machine cannot make: such a scenario is skipped.
class Unavailable extends Error {}

let server = null;
let current = null; // the run in progress: { abort(error) }
let interrupted = null;

process.on('exit', () => { if (server) server.kill('SIGKILL'); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = signal;
    if (current) current.abort(new Error(`interrupted by ${signal}`));
  });
}

// --- server and browser --------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Starts tools/web/devserver.py and resolves to its port once it says it serves
// (an answer on the port could come from someone else's server).
async function startServer() {
  for (let attempt = 1; ; attempt++) {
    const port = args.port ? Number(args.port) : await freePort();
    const options = ['--bin', binDir, '--assets', assetsDir, ...(args.shell ? ['--shell', path.resolve(args.shell)] : [])];
    const child = spawn('python3', ['-I', path.join(ROOT, 'tools', 'web', 'devserver.py'), ...options, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let exited = false;
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-2000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-2000); });
    child.on('error', (error) => { exited = true; output += String(error.message); });
    child.on('exit', () => { exited = true; });
    server = child;
    const until = Date.now() + 30000;
    while (Date.now() < until && !exited && !/^serving /m.test(output)) await sleep(50);
    if (!exited && /^serving /m.test(output)) {
      // A server that goes away later (somebody's kill, on a machine shared
      // with other work) ends the run that needs it, with the reason; the
      // next run starts another.
      child.on('exit', (code, signal) => {
        if (server !== child) return;
        server = null;
        if (current) current.abort(new Error(`the dev server went away (${signal || `exit code ${code}`})`));
      });
      return port;
    }
    child.kill('SIGKILL');
    server = null;
    if (args.port || attempt >= 3) throw new Error(`the dev server did not start on port ${port}: ${output.trim().split('\n').pop() || 'it said nothing'}`);
  }
}

function toolchainChrome() {
  const root = path.join(process.env.EKA2L1_TOOLCHAIN || '', 'chrome', 'chrome');
  const versions = process.env.EKA2L1_TOOLCHAIN && fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const chrome = versions.length ? path.join(root, versions.pop(), 'chrome-linux64', 'chrome') : null;
  if (!chrome || !fs.existsSync(chrome)) throw new Error('the toolchain has no Chrome (source tools/env.sh, or use --browser chrome-software)');
  return chrome;
}

const command = (name, parameters) => execFileSync(name, parameters, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
const complaint = (error) => String((error && error.stderr) || (error && error.message) || error).trim().split('\n').pop();

// --cpu: why this machine cannot hold a program to a share of a processor
// core, or null when it can. Asked once: a scope under a quota of 50% is
// started and must find that quota in its own cgroup. systemd accepts a quota
// it cannot apply (no cpu controller for the user's services), so starting the
// scope proves nothing by itself.
let quotaAnswer;
function quotaProblem() {
  if (quotaAnswer !== undefined) return quotaAnswer;
  const needs = '--cpu needs a user systemd that can limit the processor (cgroup v2 with the cpu controller, as a desktop session has and a container has not)';
  try {
    const seen = command('systemd-run', ['--user', '--scope', '-q', '-p', 'CPUQuota=50%', '--', 'sh', '-c',
      'cat "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/cpu.max"']);
    quotaAnswer = quotaApplied(seen, 50) ? null : `${needs}: a quota of 50% was accepted and not applied (cpu.max says "${seen.trim()}")`;
  } catch (error) {
    quotaAnswer = `${needs}: ${error && error.code === 'ENOENT' ? 'there is no systemd-run' : `systemd-run --user --scope failed (${complaint(error)})`}`;
  }
  return quotaAnswer;
}

// --cores: why the browser cannot be pinned to the first N cores, or null.
function coresProblem(count) {
  // taskset takes a range that reaches past the last core and pins to what there is.
  if (count > os.availableParallelism()) return `--cores ${count} cannot be done here: this machine has ${os.availableParallelism()}`;
  try {
    command('taskset', ['-c', `0-${count - 1}`, 'true']);
    return null;
  } catch (error) {
    return `--cores ${count} cannot be done here: ${error && error.code === 'ENOENT' ? 'there is no taskset' : `taskset failed (${complaint(error)})`}`;
  }
}

// The quota of the scope the browser runs in, as its cgroup has it ("30000
// 100000": 30 ms of every 100).
function scopeQuota(unit) {
  const group = command('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', `${unit}.scope`]).trim();
  if (!group) throw new Error(`the browser's scope ${unit} is gone`);
  return fs.readFileSync(path.join('/sys/fs/cgroup', group, 'cpu.max'), 'utf8').trim();
}

// Reads the quota back and fails when it is not the one asked for. That is
// a run that failed, not a machine that cannot do it: quotaProblem() has
// shown by then that it can.
function checkedQuota(unit, percent) {
  const seen = scopeQuota(unit);
  if (!quotaApplied(seen, percent)) throw new Error(`the quota of ${percent}% was not applied to the browser (cpu.max says "${seen}")`);
  return seen;
}

// --cpu and --cores: the browser is started through a script that puts it,
// and with it every process and thread it starts, into a scope of its own
// (under a processor quota from the start unless --cpu-from play) and on the
// first N cores. `state.unit` is then the scope's name.
let scopes = 0;
function limited(executable, options, folder, state) {
  if (!options.cpu && !options.cores) return executable;
  fs.mkdirSync(folder, { recursive: true });
  const wrapper = path.join(folder, 'browser-limited.sh');
  let prefix = '';
  if (options.cpu) {
    state.unit = `n-ga-ge-diag-${process.pid}-${++scopes}`;
    const quota = options['cpu-from'] === 'play' ? '' : `-p CPUQuota=${Number(options.cpu)}% `;
    prefix += `systemd-run --user --scope -q --unit=${state.unit} ${quota}-- `;
  }
  if (options.cores) prefix += `taskset -c 0-${Number(options.cores) - 1} `;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${prefix}'${executable.replace(/'/g, `'\\''`)}' "$@"\n`, { mode: 0o755 });
  return wrapper;
}

const LAUNCH = { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
const BROWSERS = {
  chrome: (limit) => chromium.launch({ ...LAUNCH, executablePath: limit(toolchainChrome()), args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] }),
  'chrome-software': (limit) => chromium.launch({ ...LAUNCH, executablePath: limit(chromium.executablePath()), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }),
};

// --throttle: Chrome's CPU throttling. It slows the thread of the page only:
// asked of a worker, Chrome answers "only supported for pages".
async function throttle(page, rate) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}

// --- what every run shares -------------------------------------------------------

// Reads the game's entry, checks the files and starts the dev server. Throws
// with the reason, said once for every run that then cannot be made.
async function prepare() {
  let phase = 'reading the catalogue entry';
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'games', `${args.game}.json`), 'utf8'));
    const script = entry.test ? entry.test.script : null;
    const allKeys = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'schema.json'), 'utf8')).$defs.key.enum;
    if (script) checkScript(script, allKeys);
    for (const key of keys) {
      if (!allKeys.includes(key)) usage(`not an N-Gage key: ${key}`);
    }
    const hook = args.hook ? (await import(pathToFileURL(path.resolve(args.hook)).href)).default : null;
    if (args.hook && typeof hook !== 'function') usage(`${args.hook} has no default export to call`);
    const startTimeout = entry.test && entry.test.timeoutMs > 0 ? entry.test.timeoutMs : 90000;

    phase = 'looking for the files';
    for (const [file, hint] of [[path.join(binDir, 'eka2l1_web.wasm'), 'build it with tools/ci/build-web.sh or pass --bin'],
      ...Object.values(PLATFORM_FILES[platformOf(entry)]).map((firmware) => [path.join(assetsDir, ...firmware.split('/')), 'pass --assets']),
      [path.join(assetsDir, 'games', `${args.game}.zip`), 'pass --assets']]) {
      if (!fs.existsSync(file)) throw new Error(`missing ${file}: ${hint}`);
    }

    phase = 'starting the dev server';
    const port = await startServer();
    // The longest a run may take: twice what it plans to, and five minutes
    // for the browser, the download and the pictures.
    const limitMs = 300000 + startTimeout + 2 * ((script ? scriptMs(script) * stretch : 0) + seconds * 1000);
    return { script, hook, startTimeout, port, limitMs, address: gameQuery(entry, args.game) };
  } catch (error) {
    throw new Error(`${firstLine(error)} (while ${phase})`);
  }
}

// --- one run ---------------------------------------------------------------------

// Plays the game once and judges the report.
//   run   { out, options, expect, absent, absentLevels, strict, scenario }
//         `options` are this tool's options by name: the command line's, with
//         a scenario's laid over them. `scenario` is null for a single run,
//         else { name, what, options }
//   prepared  what prepare() resolved to, or the error it threw
// Resolves to the result, which is also written to <out>/result.json. Never
// throws: a run that could not be made is a result with `error` or `skipped`.
async function play(run, prepared) {
  const { options } = run;
  const browserName = options.browser || 'chrome';
  const consoleLines = [];
  const result = {
    pass: false,
    verdict: 'fail',
    scenario: run.scenario ? run.scenario.name : null,
    ...(run.scenario ? { what: run.scenario.what, options: run.scenario.options } : {}),
    game: args.game,
    browser: browserName,
    version: null,
    condition: {
      cpu: options.cpu ? Number(options.cpu) : null,
      cpuFrom: options.cpu ? options['cpu-from'] || 'start' : null,
      quota: null, // what the browser's cgroup says once the quota is set
      throttle: options.throttle ? Number(options.throttle) : 1,
      cores: options.cores ? Number(options.cores) : null,
      hidden: Boolean(options.hidden),
      undrawn: Boolean(options.undrawn),
      device: options.device || null,
      sound: !options.nosound,
      keys,
      query: args.query || '',
      hook: args.hook ? path.resolve(args.hook) : null,
    },
    seconds,
    measured: null,
    findings: [],
    levels: {},
    expect: run.expect,
    absent: run.absent,
    absentLevels: run.absentLevels,
    strict: run.strict,
    missing: [],
    unwanted: [],
    warnings: [], // what went wrong beside the verdict: a picture that could not be taken, a play too short
    skipped: null,
    error: null,
  };
  const state = { phase: 'starting', browser: null, unit: null, abort: null, over: false };
  const aborted = new Promise((resolve, reject) => { state.abort = reject; });
  aborted.catch(() => {});
  let found = [];

  async function body() {
    fs.mkdirSync(run.out, { recursive: true });
    // Never leave an older run's files beside this result.
    for (const name of RUN_FILES) fs.rmSync(path.join(run.out, name), { force: true });
    if (prepared instanceof Error) throw prepared;
    if (interrupted) throw new Error(`interrupted by ${interrupted}`);
    const { script, hook, address } = prepared;
    // How much longer the browser, the download and the start of the game
    // may take: --stretch says the machine is that slow, and a quota that
    // holds from the browser's start makes them that much slower again.
    const slow = stretch * (options.cpu && options['cpu-from'] !== 'play' ? Math.max(1, 100 / Number(options.cpu)) : 1);
    const startTimeout = prepared.startTimeout * slow;
    if (!server) {
      state.phase = 'starting the dev server again';
      prepared.port = await startServer();
    }
    const { port } = prepared;

    state.phase = 'starting the browser';
    const cannot = (options.cpu && quotaProblem()) || (options.cores && coresProblem(Number(options.cores)));
    if (cannot) throw new Unavailable(cannot);
    const launching = BROWSERS[browserName]((executable) => limited(executable, options, run.out, state));
    try {
      state.browser = await withTimeout(launching, 60000 * slow, 'browser launch');
    } catch (error) {
      launching.then((late) => late.close()).catch(() => {});
      throw error;
    }
    const browser = state.browser;
    if (state.over) {
      // The run ended (a signal, its time limit) while the browser was
      // starting: nobody will close this one.
      browser.close().catch(() => {});
      throw new Error('the run was over before the browser was up');
    }
    result.version = browser.version();
    browser.on('disconnected', () => state.abort(new Error('the browser went away')));
    if (options.cpu && options['cpu-from'] !== 'play') result.condition.quota = checkedQuota(state.unit, Number(options.cpu));

    const profile = options.device ? { ...devices[DEVICES[options.device]] } : { viewport: { width: 1280, height: 800 } };
    delete profile.defaultBrowserType;
    const context = await browser.newContext(profile);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const page = await context.newPage();
    const view = page.viewportSize();
    page.on('console', (message) => {
      const line = `[${message.type()}] ${message.text()}`;
      consoleLines.push(line);
      if (args.verbose) console.log(`  ${line.slice(0, 400)}`);
    });
    page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));
    page.on('crash', () => state.abort(new Error("the page's process died")));

    const evaluate = (fn, arg, what = 'the page') => withTimeout(page.evaluate(fn, arg), ANSWER_MS, what);

    state.phase = 'loading the player';
    const query = args.query ? `&${args.query.replace(/^[?&]/, '')}` : '';
    const response = await page.goto(`http://127.0.0.1:${port}/${address}${query}`, { timeout: 60000 * slow });
    if (!response || !response.ok()) throw new Error(`the player page did not load (HTTP ${response ? response.status() : 'no response'})`);

    state.phase = 'starting the game';
    const until = Date.now() + startTimeout;
    for (;;) {
      const now = await evaluate(() => {
        const p = window.eka2l1Page;
        const status = document.getElementById('status');
        return { app: Boolean(p && p.app), frames: p && p.emu && p.emu.module ? p.emu.frames() : 0, error: status && status.classList.contains('error') ? status.textContent : null };
      });
      if (now.error) throw new Error(`the page reported: ${now.error}`);
      if (now.app && now.frames > 0) break;
      if (Date.now() > until) throw new Error(`the game did not start within ${Math.round(startTimeout / 1000)} s`);
      await sleep(500);
    }
    if (!await evaluate(() => Boolean(window.eka2l1Page.diag && window.eka2l1Page.diag.report))) throw new Error('this player has no diagnostics (eka2l1Page.diag)');

    const codes = await evaluate(async () => (await import('./eka2l1-client.js')).KEYS, null, 'key table');
    const press = async (key, hold) => {
      await evaluate(([code]) => window.eka2l1.key(code, true), [codes[key]], 'key down');
      await sleep(hold);
      await evaluate(([code]) => window.eka2l1.key(code, false), [codes[key]], 'key up');
    };

    if (script) {
      for (const [index, raw] of script.entries()) {
        const step = stepTiming(raw);
        state.phase = `replaying script step ${index + 1} of ${script.length}`;
        for (let i = 0; i < step.repeat; i++) {
          if (step.key) await press(step.key, step.hold);
          await sleep(step.wait * stretch);
        }
      }
    }

    // Sound needs a gesture of the visitor's; a click on the picture is one.
    if (!options.nosound) {
      state.phase = 'switching sound on';
      await page.mouse.click(Math.round(view.width / 2), Math.min(300, Math.round(view.height / 2))).catch(() => {});
    }

    if (hook) {
      state.phase = 'running the hook';
      await hook({ page, press, sleep, evaluate });
    }
    if (options.cpu && options['cpu-from'] === 'play') {
      state.phase = 'setting the processor quota';
      command('systemctl', ['--user', 'set-property', '--runtime', `${state.unit}.scope`, `CPUQuota=${Number(options.cpu)}%`]);
      result.condition.quota = checkedQuota(state.unit, Number(options.cpu));
    }
    if (options.throttle) {
      state.phase = 'throttling';
      await throttle(page, Number(options.throttle));
    }
    // --hidden and --undrawn. Headless Chrome keeps a page visible and
    // drawn whatever is put in front of it (another page, a minimised
    // window: its own thread and its workers go on getting 60 animation
    // frames a second), so what a browser does to a page it does not show
    // is done to the page here: the animation frames are taken away, the
    // emulator's by its own switch and the page's thread's by leaving its
    // requests unanswered, and for a hidden tab the document says so and
    // tells the page, which then does what it does in a background tab.
    // Like the quota and the throttling, both stay until the browser is
    // closed: the pictures show the page under the condition.
    const undraw = async () => {
      const done = await evaluate(() => {
        const set = window.eka2l1.module._eka2l1_web_debug_animation_frames;
        if (!set) return false;
        set(1);
        // A request is taken and never answered. Handles of requests made
        // before are still the browser's to cancel.
        const cancel = window.cancelAnimationFrame.bind(window);
        let handle = 0x40000000;
        window.requestAnimationFrame = () => ++handle;
        window.cancelAnimationFrame = (given) => { if (given < 0x40000000) cancel(given); };
        return true;
      });
      if (!done) throw new Error('this build has no switch for its animation frames (_eka2l1_web_debug_animation_frames)');
    };
    const hide = () => evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (options.undrawn) {
      state.phase = 'taking the animation frames away';
      await undraw();
    }

    // The diagnostics measure the last 30 seconds of play. A condition that
    // begins with the play and lasts less mixes with the play before it.
    if (seconds < 30 && (options.throttle || options.undrawn || (options.cpu && options['cpu-from'] === 'play'))) {
      result.warnings.push(`played ${seconds} s under the condition, and the diagnostics measure the last 30: the rates mix in the play before it`);
    }

    state.phase = 'playing';
    // What else the machine was doing: frame rates measured beside other
    // heavy work say little, and this is how a reader tells.
    const loadBefore = os.loadavg()[0];
    const end = Date.now() + seconds * 1000;
    for (let turn = 0; Date.now() < end; turn++) {
      if (keys.length) await press(keys[turn % keys.length], Math.min(1000, Math.max(100, end - Date.now())));
      else await sleep(Math.min(1000, Math.max(100, end - Date.now())));
    }

    if (options.hidden) {
      state.phase = 'hiding the page';
      await undraw();
      await hide();
      await sleep(HIDDEN_MS);
    }

    // What the page itself shows of the condition, whatever the diagnostics
    // make of it: the animation frames its own thread gets in a second, the
    // state of its sound, what draws WebGL.
    state.phase = 'looking at the page';
    const seen = await evaluate(() => new Promise((resolve) => {
      let frames = 0;
      let counting = true;
      const count = () => {
        if (!counting) return;
        frames++;
        requestAnimationFrame(count);
      };
      requestAnimationFrame(count);
      setTimeout(() => {
        counting = false;
        const support = window.eka2l1Page.support || {};
        const webgl = support.webgl || {};
        resolve({
          animationFrames: frames,
          sound: window.eka2l1 && window.eka2l1.audio ? window.eka2l1.audio.state : 'not started',
          renderer: webgl.renderer || null,
          softwareRenderer: Boolean(webgl.software),
          hidden: document.hidden,
          visibility: document.visibilityState,
          paused: Boolean(window.eka2l1Page.paused),
        });
      }, 1000);
    }), null, 'the page');

    state.phase = 'reading the report';
    const { report, text } = await evaluate(async () => {
      const made = await window.eka2l1Page.diag.report();
      const { formatText } = await import('./diag/report.js');
      return { report: made, text: formatText(made) };
    }, null, 'the report');
    fs.writeFileSync(path.join(run.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(run.out, 'report.txt'), text.endsWith('\n') ? text : `${text}\n`);
    found = (report.findings || []).map((finding) => ({ code: finding.code, level: finding.level }));
    const session = report.sections && report.sections.session && report.sections.session.data ? report.sections.session.data : {};
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
    // How many of the last samples of the diagnostics themselves say "hidden".
    const hiddenSeries = report.series && Array.isArray(report.series.hidden) ? report.series.hidden : [];
    let hiddenSamples = 0;
    while (hiddenSamples < hiddenSeries.length && hiddenSeries[hiddenSeries.length - 1 - hiddenSamples]) hiddenSamples++;
    result.measured = { fps: number(session.fpsAverage), fpsWorst: number(session.fpsWorst), seconds: number(session.measuredS), ...seen, hiddenSamples,
      load: number(Math.max(loadBefore, os.loadavg()[0])), threads: os.availableParallelism() };

    // A condition that did not take is a run that could not be made: it must
    // not pass, and must not look like a finding the diagnostics missed.
    const not = conditionMissed(options, { ...seen, hiddenSamples, reportHidden: Boolean(report.page && report.page.hidden) });
    if (not) throw new Error(not);

    // The report is read and the verdict rests on it. The pictures are for
    // the reader: one that cannot be taken (a page starved by the condition
    // answers late) is a warning, not a failed run.
    state.phase = 'taking the pictures';
    const picture = async (name, take) => {
      try {
        await take();
      } catch (error) {
        result.warnings.push(`no ${name}: ${firstLine(error)}`);
      }
    };
    await picture('page.png', () => page.screenshot({ path: path.join(run.out, 'page.png'), timeout: 20000 }));
    await picture('dialog.png', async () => {
      await evaluate(() => window.eka2l1Page.diag.open(), null, 'the dialog');
      await sleep(1200); // one refresh
      // The dialog scrolls; the picture shows all of it.
      const height = await evaluate(() => {
        const dialog = document.getElementById('info');
        dialog.style.maxHeight = 'none';
        dialog.style.margin = '8px auto';
        return dialog.scrollHeight;
      });
      await page.setViewportSize({ width: view.width, height: Math.min(6000, Math.max(view.height, height + 60)) });
      await page.locator('#info').screenshot({ path: path.join(run.out, 'dialog.png'), timeout: 20000 });
    });
  }

  current = state;
  // A quota from the browser's start slows all of it; see `slow` in body().
  const quotaFactor = options.cpu && options['cpu-from'] !== 'play' ? Math.max(1, 100 / Number(options.cpu)) : 1;
  const limitMs = prepared instanceof Error ? 60000 : prepared.limitMs * quotaFactor;
  try {
    await withTimeout(Promise.race([body(), aborted]), limitMs, 'the run');
  } catch (error) {
    // A scenario whose condition cannot be made here is skipped; a single
    // run that asked for that condition has failed.
    if (error instanceof Unavailable && run.scenario) result.skipped = firstLine(error);
    else result.error = prepared instanceof Error ? firstLine(error) : `${firstLine(error)} (while ${state.phase})`;
  }
  current = null;
  state.over = true;
  // The browser goes first: what is still on its way in body() then fails
  // and ends, and writes nothing into the folder after this.
  if (state.browser) await Promise.race([state.browser.close().catch(() => {}), sleep(5000)]);
  if (state.unit) {
    try {
      command('systemctl', ['--user', 'kill', '--signal=KILL', `${state.unit}.scope`]);
    } catch {
      // The scope ended with the browser, as it should.
    }
  }

  result.findings = found.map((finding) => finding.code);
  result.levels = Object.fromEntries(found.map((finding) => [finding.code, finding.level]));
  Object.assign(result, judge(run, { findings: found, error: result.error, skipped: result.skipped }, run.strict));
  result.pass = result.verdict === 'pass';
  try {
    fs.mkdirSync(run.out, { recursive: true });
    fs.writeFileSync(path.join(run.out, 'console.log'), consoleLines.join('\n') + '\n');
    fs.writeFileSync(path.join(run.out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  } catch (writeError) {
    console.error(`could not write to ${run.out}: ${writeError.message}`);
    result.error = result.error || `could not write to ${run.out}: ${writeError.message}`;
    result.skipped = null;
    result.verdict = 'fail';
    result.pass = false;
  }

  const head = `${{ pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' }[result.verdict]}  ${run.scenario ? `${run.scenario.name}  ` : ''}${args.game}`;
  if (result.skipped) console.log(`${head}  ${result.skipped}`);
  else {
    console.log(`${head}  ${result.findings.length ? result.findings.join(', ') : 'no findings'}`
      + (result.missing.length ? `  ${run.strict ? 'MISSING' : 'NOT PRODUCED'} ${result.missing.join(', ')}` : '')
      + (result.unwanted.length ? `  UNWANTED ${result.unwanted.join(', ')}` : '')
      + (result.error ? `  ${result.error}` : ''));
  }
  for (const warning of result.warnings) console.log(`      warning: ${warning}`);
  return result;
}

// --- all of it -------------------------------------------------------------------

async function main() {
  const prepared = await prepare().catch((error) => error);

  if (!scenarioNames) {
    const result = await play({ out: outDir, options: args, expect: list(args.expect), absent: list(args.absent), absentLevels: [], strict: true, scenario: null }, prepared);
    return result.pass ? 0 : 1;
  }

  fs.mkdirSync(outDir, { recursive: true });
  // Never leave an older run's files beside this one's: its summary, and what
  // it wrote for scenarios this run may not get to or does not include.
  for (const name of ['summary.md', 'results.json']) fs.rmSync(path.join(outDir, name), { force: true });
  for (const name of Object.keys(SCENARIOS)) {
    const folder = path.join(outDir, name);
    for (const file of RUN_FILES) fs.rmSync(path.join(folder, file), { force: true });
    try {
      fs.rmdirSync(folder);
    } catch {
      // Not there, or it holds something that is not this tool's.
    }
  }
  const strict = Boolean(args.strict);
  const when = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const results = [];
  for (const name of scenarioNames) {
    const scenario = SCENARIOS[name];
    const expected = { expect: scenario.expect, absent: scenario.absent, absentLevels: scenario.absentLevels || [], strict };
    if (interrupted) {
      results.push({ pass: false, verdict: 'fail', scenario: name, what: scenario.what, options: scenario.options, game: args.game, measured: null, findings: [], levels: {},
        ...expected, missing: [], unwanted: [], warnings: [], skipped: null, error: `not run: interrupted by ${interrupted}` });
    } else {
      // The scenario's options over the command line's: the condition is the
      // scenario's, the rest (the game, the time, the keys) the caller's.
      results.push(await play({ out: path.join(outDir, name), options: { ...args, ...scenario.options }, ...expected,
        scenario: { name, what: scenario.what, options: scenario.options } }, prepared));
    }
    // Written after every scenario, so that a run that is cut short leaves
    // what it had; until the last one it says so and does not say "pass".
    const version = (results.find((result) => result.version) || {}).version || null;
    const complete = results.length === scenarioNames.length;
    const tally = Object.fromEntries(['pass', 'fail', 'skipped'].map((verdict) => [verdict, results.filter((result) => result.verdict === verdict).length]));
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ game: args.game, strict, when, planned: scenarioNames, complete,
      passed: tally.pass, failed: tally.fail, skipped: tally.skipped,
      // Nothing failed and something was judged: a run in which every
      // scenario was skipped has shown nothing.
      pass: complete && !interrupted && tally.fail === 0 && tally.pass > 0, scenarios: results }, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'summary.md'), summary({ game: args.game, strict, when, version, planned: scenarioNames }, results));
  }
  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped; ${path.join(outDir, 'summary.md')}`
    + (count('pass') + count('fail') === 0 ? '\nNothing was judged: every scenario was skipped.' : ''));
  for (const result of results) {
    if (result.verdict !== 'pass' || result.missing.length) console.log(`  ${result.scenario}: ${verdictText(result)}`);
  }
  return interrupted ? 1 : exitCode(results);
}

main().then((code) => {
  if (server) server.kill('SIGKILL');
  process.exit(code);
}, (error) => {
  console.error(error);
  if (server) server.kill('SIGKILL');
  process.exit(1);
});
