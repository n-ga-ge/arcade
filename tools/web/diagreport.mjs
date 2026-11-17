// Reads a diagnostics report of the player (docs/diagnostics.md): checks it,
// prints it as text, and says what differs between two.
//
//   node tools/web/diagreport.mjs <report>                     check one and print it
//   node tools/web/diagreport.mjs --compare <a> <b>            what differs between two
//
//   <report>      a report.json (the player's "Download report", or what
//                 tools/web/diag.mjs writes), or the text the player's "Copy
//                 report" makes, saved to a file; "-" reads standard input
//   --compare     print the findings one report has and the other has not,
//                 the numbers that changed by more than a share, and the
//                 other values that differ
//   --share N     that share, as a fraction of the first report's number
//                 (default 0.2: a fifth)
//   --all         with --compare: every difference, not the first 60 of a kind
//   --full        print the text without the limit of 20000 characters that
//                 the player's "Copy report" keeps to
//   --quiet       print only the verdict and what is wrong
//
// A JSON report is checked against tools/web/diag-report.schema.json (the
// envelope: what a section keeps in its `data` is its own) and against the
// rules a schema cannot say: the series' lists are equally long, the findings
// are worst first and belong to sections that list them. The text form is
// recognised by its first line and read loosely: the findings, the numbers of
// the sections and the series. It is not checked, because it is cut to fit a
// message; ask for the file when it matters.
//
// Exit code 0 when every report given is a valid one, 1 when one is not (the
// problems are printed, each with the place it is at), 2 when the command
// line is wrong or a file cannot be read.
//
// The pure parts are exported and tested in diagreport.test.mjs. Nothing is
// imported from the emulator's fork, so this runs in a checkout without the
// submodule; the text form is a copy of the fork's shell/diag/report.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = path.join(HERE, 'diag-report.schema.json');
export const LEVELS = ['bad', 'warn', 'info'];

// --- checking ----------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// A field of an object, and never what every object inherits ("constructor").
const own = (object, name) => (isObject(object) && Object.prototype.hasOwnProperty.call(object, name) ? object[name] : undefined);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const quote = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
};
const article = (word) => (word === 'null' ? 'null' : /^[aeio]/.test(word) ? `an ${word}` : `a ${word}`);

// The problems of `value` against `schema`, as a list of { at, message }.
// Understands the part of JSON Schema that diag-report.schema.json uses:
// type, const, enum, pattern, minimum, required, properties,
// additionalProperties, propertyNames (pattern), items, $ref to "#/$defs/x".
export function validate(value, schema, root = schema, at = '') {
  const here = at || 'the report';
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = own(root.$defs, name);
    if (!target) throw new Error(`the schema refers to ${schema.$ref}, which it does not define`);
    return validate(value, target, root, at);
  }
  const problems = [];
  const kind = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = [schema.type].flat();
    if (!allowed.includes(kind) && !(kind === 'integer' && allowed.includes('number'))) {
      return [{ at: here, message: `is ${article(kind)}, expected ${allowed.map(article).join(' or ')}` }];
    }
  }
  if (schema.const !== undefined && value !== schema.const) problems.push({ at: here, message: `is ${quote(value)}, expected ${quote(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value)) problems.push({ at: here, message: `is ${quote(value)}, which is not one of ${schema.enum.map(quote).join(', ')}` });
  if (schema.pattern && kind === 'string' && !new RegExp(schema.pattern).test(value)) problems.push({ at: here, message: `is ${quote(value)}, which does not look as it must (${schema.pattern})` });
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) problems.push({ at: here, message: `is ${value}, less than ${schema.minimum}` });
  if (kind === 'array' && schema.items) {
    value.forEach((item, index) => problems.push(...validate(item, schema.items, root, `${at}[${index}]`)));
  }
  if (kind === 'object') {
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) problems.push({ at: here, message: `has no "${name}"` });
    }
    for (const [name, item] of Object.entries(value)) {
      const inner = at ? `${at}.${name}` : name;
      if (schema.propertyNames && schema.propertyNames.pattern && !new RegExp(schema.propertyNames.pattern).test(name)) {
        problems.push({ at: here, message: `has a field named ${quote(name)}, which is not a name it may have (${schema.propertyNames.pattern})` });
      }
      const known = own(schema.properties, name);
      if (known) problems.push(...validate(item, known, root, inner));
      else if (schema.additionalProperties === false) problems.push({ at: here, message: `has a field "${name}" that the format does not know` });
      else if (isObject(schema.additionalProperties)) problems.push(...validate(item, schema.additionalProperties, root, inner));
    }
  }
  return problems;
}

// Everything wrong with a report: the schema, then what a schema cannot say.
export function checkReport(report, schema) {
  const problems = validate(report, schema);
  if (problems.length || !isObject(report)) return problems;
  const add = (at, message) => problems.push({ at, message });

  const lengths = ['t', 'fps', 'running', 'hidden'].map((name) => report.series[name].length);
  if (new Set(lengths).size > 1) add('series', `has lists of different lengths (t ${lengths[0]}, fps ${lengths[1]}, running ${lengths[2]}, hidden ${lengths[3]})`);
  else if (lengths[0] !== report.session.samples) add('session.samples', `is ${report.session.samples}, but the series has ${lengths[0]} samples`);
  const backwards = report.series.t.findIndex((t, index, list) => index > 0 && t < list[index - 1]);
  if (backwards > 0) add(`series.t[${backwards}]`, `is ${report.series.t[backwards]}, earlier than the sample before it (${report.series.t[backwards - 1]})`);

  report.findings.forEach((finding, index) => {
    const at = `findings[${index}]`;
    const section = own(report.sections, finding.section);
    if (!section) add(at, `comes from the section "${finding.section}", which the report does not have`);
    else if (!section.findings.includes(finding.code)) add(at, `is "${finding.code}", which its section "${finding.section}" does not list`);
    if (index > 0 && LEVELS.indexOf(finding.level) < LEVELS.indexOf(report.findings[index - 1].level)) {
      add(at, `is "${finding.level}" after a "${report.findings[index - 1].level}": the findings are not worst first`);
    }
  });
  for (const [id, section] of Object.entries(report.sections)) {
    for (const code of section.findings) {
      if (!report.findings.some((finding) => finding.code === code && finding.section === id)) add(`sections.${id}.findings`, `lists "${code}", which is not among the report's findings`);
    }
  }
  return problems;
}

// --- the text form -------------------------------------------------------------------
//
// A copy of the part of the fork's src/emu/web/shell/diag/report.js between
// the same two marks, where the format is described. The player makes the
// text with that file and this tool with this copy, and the two must be
// alike: diagreport.test.mjs compares them when the fork is checked out.

// >>> the text form, shared with the reader
export const TEXT_LIMIT = 20000;

const TEXT_HEAD = 'EKA2L1 web diagnostics';
const TEXT_END = '== End of report (text for reading; "Download report" saves the file with everything) ==';

const isLeaf = (value) => value === null || typeof value !== 'object';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function oneLine(text) {
  return String(text).replace(/\s*[\r\n]+\s*/g, ' / ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

export function showNumber(value) {
  if (!Number.isFinite(value)) return '-';
  if (Number.isInteger(value)) return String(value);
  const size = Math.abs(value);
  return String(Number(size >= 100 ? value.toFixed(1) : size >= 1 ? value.toFixed(2) : value.toPrecision(3)));
}

function showLeaf(value, longest) {
  if (value === null || value === undefined) return '-';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'number') return showNumber(value);
  const text = oneLine(value);
  if (text === '') return '""';
  return text.length > longest ? `${text.slice(0, longest)}… (+${text.length - longest} characters)` : text;
}

// A text that is a line's whole value: quoted when it could be read back as
// something else (a small object, a list of numbers, a list's size).
const READS_AS = /^[A-Za-z_$][\w$-]*=|^-?\d[^,]*(, -?\d[^,]*)+$|^"|^\d+ (values|items)\b|^\((none|empty)\)$/;

function showLine(value, longest) {
  const text = showLeaf(value, longest);
  return typeof value === 'string' && text !== '""' && READS_AS.test(text) ? JSON.stringify(text) : text;
}

// A value inside a line that holds several: quoted when it could be taken
// for the line's own punctuation.
function showInline(value, longest) {
  const text = showLeaf(value, longest);
  return typeof value === 'string' && text !== '""' && /[,="]|^\s|\s$/.test(text) ? JSON.stringify(text) : text;
}

function numberStats(list) {
  const numbers = list.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!numbers.length) return null;
  return {
    count: numbers.length,
    min: numbers.reduce((a, b) => Math.min(a, b)),
    mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    max: numbers.reduce((a, b) => Math.max(a, b)),
  };
}

function showList(list, detail) {
  const shown = list.length > detail.values ? list.slice(-detail.values) : list;
  const text = shown.map((value) => showInline(value, Math.min(detail.strings, 80))).join(', ');
  if (shown.length === list.length) return text;
  const stats = list.every((value) => typeof value === 'number') ? numberStats(list) : null;
  return `${list.length} values${stats ? `, min ${showNumber(stats.min)}, mean ${showNumber(stats.mean)}, max ${showNumber(stats.max)}` : ''}`
    + `; the last ${shown.length}: ${text}`;
}

// The lines of one value of a section's data. `detail` is how much is shown:
// { strings, values, items }, the longest text, the most values of a list of
// plain values, the most items of a list of objects.
function dataLines(path, value, detail, out, depth = 0) {
  const name = path || 'value';
  if (isLeaf(value) || depth > 40) {
    out.push(`${name}: ${isLeaf(value) ? showLine(value, detail.strings) : '(nested too deep)'}`);
  } else if (Array.isArray(value)) {
    if (!value.length) {
      out.push(`${name}: (none)`);
    } else if (value.every(isLeaf)) {
      out.push(`${name}: ${showList(value, detail)}`);
    } else {
      const head = value.length > detail.items ? Math.min(2, detail.items - 1) : value.length;
      const tail = value.length > detail.items ? detail.items - head : 0;
      for (let i = 0; i < head; i++) dataLines(`${name}[${i}]`, value[i], detail, out, depth + 1);
      if (value.length > detail.items) out.push(`${name}: ${value.length} items, ${value.length - head - tail} left out here`);
      for (let i = value.length - tail; i < value.length; i++) dataLines(`${name}[${i}]`, value[i], detail, out, depth + 1);
    }
  } else {
    const entries = Object.entries(value);
    if (!entries.length) {
      out.push(`${name}: (empty)`);
      return;
    }
    if (path && entries.length <= 8 && entries.every(([, item]) => isLeaf(item))) {
      const inline = entries.map(([key, item]) => `${key}=${showInline(item, detail.strings)}`).join(', ');
      if (inline.length <= 140) {
        out.push(`${path}: ${inline}`);
        return;
      }
    }
    for (const [key, item] of entries) dataLines(path ? `${path}.${key}` : key, item, detail, out, depth + 1);
  }
}

// "Chrome 131 on Linux" from a user agent; the whole of it is in the report.
export function browserName(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'unknown browser';
  const version = (pattern) => {
    const match = pattern.exec(userAgent);
    return match ? match[1] : null;
  };
  const browsers = [['Edge', /Edg(?:e|A|iOS)?\/(\d+)/], ['Opera', /OPR\/(\d+)/], ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:HeadlessChrome|Chrome|CriOS)\/(\d+)/], ['Safari', /Version\/(\d+)[\d.]* .*Safari/]];
  const systems = [['Android', /Android/], ['iOS', /iPhone|iPad|iPod/], ['Windows', /Windows/], ['ChromeOS', /CrOS/], ['macOS', /Mac OS X|Macintosh/], ['Linux', /Linux|X11/]];
  const browser = browsers.map(([name, pattern]) => [name, version(pattern)]).find(([, found]) => found);
  const system = systems.find(([, pattern]) => pattern.test(userAgent));
  if (!browser) return oneLine(userAgent).slice(0, 80);
  return `${browser[0]} ${browser[1]}${/HeadlessChrome\//.test(userAgent) ? ' (headless)' : ''}${system ? ` on ${system[0]}` : ''}`;
}

// The first text under a key of this name, wherever a section keeps it.
function findText(value, key, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 8) return null;
  if (!Array.isArray(value) && typeof value[key] === 'string') return value[key];
  for (const item of Object.values(value)) {
    const found = findText(item, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function gameName(game) {
  if (game === null || typeof game !== 'object') return 'no game';
  const uid = typeof game.uid === 'number' ? `0x${game.uid.toString(16).toUpperCase().padStart(8, '0')}` : game.uid ? String(game.uid) : null;
  const tag = [game.slug, uid ? `uid ${uid}` : null].filter(Boolean).join(', ');
  return `${oneLine(game.name || game.slug || 'a game without a name')}${tag ? ` (${tag})` : ''}`;
}

function headLines(report) {
  const session = report.session !== null && typeof report.session === 'object' ? report.session : {};
  const page = report.page !== null && typeof report.page === 'object' ? report.page : {};
  const sections = report.sections !== null && typeof report.sections === 'object' ? report.sections : {};
  const lines = [[`${TEXT_HEAD} v${showLeaf(report.v, 10)}`, showLeaf(report.generated, 40), gameName(report.game),
    browserName(findText(sections.browser, 'userAgent') || findText(sections, 'userAgent'))].join(' | ')];
  const state = session.running ? 'running' : session.paused ? 'paused' : report.game ? 'not running' : 'no game running';
  lines.push(`Session: ${state}, up ${showLeaf(session.upS, 10)} s, ${showLeaf(session.samples, 10)} samples, rates measured over ${showLeaf(session.measuredS, 10)} s of play.`
    + ` Page: ${showLeaf(page.address, 200)}${page.hidden ? ' (in the background)' : ''}.`);
  if (session.emulatorAnswers === false) lines.push("The emulator's own counters are missing: this build does not have them.");
  const taken = report.redacted !== null && typeof report.redacted === 'object' ? report.redacted : null;
  if (taken && taken.failed) {
    lines.push('Everything but this head was taken out, because what identifies the visitor could not be removed.');
  } else if (taken) {
    const parts = [[taken.roomCodes, 'room code', 'room codes'], [taken.names, 'name', 'names'], [taken.bluetoothAddresses, 'Bluetooth address', 'Bluetooth addresses'],
      [taken.addressQueries, 'address query', 'address queries'], [taken.homeFolders, 'home folder', 'home folders']]
      .filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
    if (parts.length) lines.push(`Taken out before this left the browser: ${parts.join(', ')}.`);
  }
  return lines;
}

// `depth`: 'full', 'brief' (no advice) or 'titles'.
function findingLines(findings, depth) {
  const list = Array.isArray(findings) ? findings.filter((finding) => finding !== null && typeof finding === 'object') : [];
  if (!list.length) return ['Findings: none.'];
  const lines = [`Findings (${list.length}), worst first:`];
  for (const finding of list) {
    lines.push(`[${showLeaf(finding.level, 10)}] ${showLeaf(finding.code, 60)} (${showLeaf(finding.section, 30)}): ${showLeaf(finding.title, 300)}`);
    if (depth !== 'titles' && finding.detail) lines.push(`    ${showLeaf(finding.detail, 1000)}`);
    if (depth === 'full' && finding.advice) lines.push(`    What to do: ${showLeaf(finding.advice, 1000)}`);
  }
  return lines;
}

function sectionLines(id, section, detail, dropped) {
  const part = section !== null && typeof section === 'object' ? section : {};
  const lines = [`== ${showLeaf(part.title || id, 80)} [${id}] ==`];
  if (part.error) lines.push(`(this part failed: ${showLeaf(part.error, 300)})`);
  if (dropped) lines.push('(numbers left out to fit)');
  else if (part.data !== null && part.data !== undefined) dataLines('', part.data, detail, lines);
  return lines;
}

// One list of the series. `keep` is how many of its last values are shown;
// 0 leaves only what sums it up.
function seriesLine(name, list, keep) {
  if (!Array.isArray(list)) return `${name}: ${showLeaf(list, 100)}`;
  if (!list.length) return `${name}: (none)`;
  const stats = numberStats(list);
  if (name === 't' && stats) {
    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      if (typeof list[i] === 'number' && typeof list[i - 1] === 'number' && list[i] - list[i - 1] > 1.5) gaps.push(`${showNumber(list[i] - list[i - 1])} s after ${showNumber(list[i - 1])} s`);
    }
    return `t: ${showNumber(stats.min)} to ${showNumber(stats.max)} s${gaps.length ? `; gaps: ${gaps.slice(0, 12).join(', ')}${gaps.length > 12 ? `, and ${gaps.length - 12} more` : ''}` : ''}`;
  }
  if (list.every((value) => value === 0 || value === 1)) {
    // Runs: "1x90 0x6" is ninety ones, then six zeros.
    const runs = [];
    for (const value of list) {
      if (runs.length && runs[runs.length - 1][0] === value) runs[runs.length - 1][1]++;
      else runs.push([value, 1]);
    }
    const shown = keep > 0 ? runs.slice(-Math.max(keep, 8)) : runs.slice(-8);
    return `${name}: ${shown.length < runs.length ? `(the last ${shown.length} of ${runs.length} runs) ` : ''}${shown.map(([value, count]) => `${value}x${count}`).join(' ')}`;
  }
  const summary = stats ? `${list.length} values, min ${showNumber(stats.min)}, mean ${showNumber(stats.mean)}, max ${showNumber(stats.max)}` : `${list.length} values`;
  if (keep <= 0) return `${name}: ${summary}`;
  const shown = list.slice(-keep);
  const values = shown.map((value) => showInline(value, 20)).join(' ');
  return shown.length < list.length ? `${name}: ${summary}; the last ${shown.length}: ${values}` : `${name}: ${values}`;
}

function seriesLines(series, keep) {
  if (series === null || typeof series !== 'object' || Array.isArray(series)) return [];
  const names = Object.keys(series);
  if (!names.length) return [];
  const count = names.reduce((most, name) => Math.max(most, Array.isArray(series[name]) ? series[name].length : 0), 0);
  return [`== Series: ${plural(count, 'sample')}, one a second, oldest first ==`, ...names.map((name) => seriesLine(name, series[name], keep))];
}

function render(report, shape) {
  const sections = report.sections !== null && typeof report.sections === 'object' && !Array.isArray(report.sections) ? report.sections : {};
  const blocks = [headLines(report), findingLines(report.findings, shape.findings)];
  for (const [id, section] of Object.entries(sections)) blocks.push(sectionLines(id, section, shape, shape.dropped.has(id)));
  const series = seriesLines(report.series, shape.series);
  if (series.length) blocks.push(series);
  const tail = shape.cut.length ? [`Cut to fit ${shape.limit} characters: ${shape.cut.join('; ')}. The downloaded report has everything.`, TEXT_END] : [TEXT_END];
  blocks.push(tail);
  return `${blocks.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

// The report as text for a message, at most `limit` characters long.
export function formatText(report, most = TEXT_LIMIT) {
  const limit = typeof most === 'number' && !Number.isNaN(most) ? most : TEXT_LIMIT;
  try {
    if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('not a report');
    const shape = { strings: 400, values: 30, items: 12, series: Infinity, findings: 'full', dropped: new Set(), cut: [], limit };
    let text = render(report, shape);
    if (text.length <= limit) return text;

    Object.assign(shape, { strings: 160, values: 12, items: 6, series: 30, cut: ['long values and lists are shortened'] });
    text = render(report, shape);
    if (text.length <= limit) return text;

    Object.assign(shape, { strings: 100, values: 6, items: 4, series: 0, cut: ['long values and lists are shortened', 'the series is summed up'] });
    text = render(report, shape);
    if (text.length <= limit) return text;

    // The numbers of whole sections: first of those no finding came from.
    // Of them the smallest that is enough goes, or else the largest.
    const sections = report.sections !== null && typeof report.sections === 'object' && !Array.isArray(report.sections) ? report.sections : {};
    const whole = Object.entries(sections).map(([id, section]) => ({
      id,
      title: showLeaf((section && section.title) || id, 80),
      found: Boolean(section && Array.isArray(section.findings) && section.findings.length),
      size: sectionLines(id, section, shape, false).join('\n').length,
    })).sort((p, q) => p.size - q.size);
    const base = shape.cut;
    const left = [];
    const notes = () => [...base, ...(left.length ? [`the numbers of ${left.join(', ')} are left out`] : [])];
    for (const found of [false, true]) {
      const candidates = whole.filter((entry) => entry.found === found);
      while (candidates.length) {
        const enough = candidates.findIndex((entry) => entry.size >= text.length - limit + 100);
        const [entry] = candidates.splice(enough >= 0 ? enough : candidates.length - 1, 1);
        shape.dropped.add(entry.id);
        left.push(entry.title);
        shape.cut = notes();
        text = render(report, shape);
        if (text.length <= limit) return text;
      }
    }
    for (const [depth, note] of [['brief', 'the advice of the findings is left out'], ['titles', 'the findings are their titles only']]) {
      shape.findings = depth;
      shape.cut = [...notes(), note];
      text = render(report, shape);
      if (text.length <= limit) return text;
    }
    // Still too long (hundreds of findings, or a tiny limit): the end goes.
    const tail = `\n\nCut to fit ${limit} characters: ${[...shape.cut, 'the end is cut off'].join('; ')}. The downloaded report has everything.\n${TEXT_END}\n`;
    const kept = text.slice(0, Math.max(0, limit - tail.length));
    return limit > 0 ? (kept.slice(0, Math.max(kept.lastIndexOf('\n'), 0)) + tail).slice(-limit) : '';
  } catch (error) {
    return `${TEXT_HEAD}: the report could not be written as text (${String(error && error.message ? error.message : error).slice(0, 200)}). Use "Download report".\n`;
  }
}
// <<< the text form, shared with the reader

// --- reading the text back -----------------------------------------------------------

const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/;
const HEAD_LINE = /^EKA2L1 web diagnostics v(\d+) \| (.*?) \| (.*) \| ([^|]*)$/;
const FINDING_LINE = /^\[(bad|warn|info)\] ([a-z]+(?:-[a-z]+)*) \(([a-z]+)\): (.*)$/;
const SECTION_LINE = /^== (.*) \[([a-z]+)\] ==$/;
const SUMMED = /^(\d+) values(?:, min (\S+), mean (\S+), max (\S+))?(?:; the last \d+: .*)?$/;
const PAIR = /([A-Za-z_$][\w$-]*)=("(?:[^"\\]|\\.)*"|[^,]*)(?:, |$)/y;

export const isText = (text) => HEAD_LINE.test(String(text).trimStart().split(/\r?\n/, 1)[0].trim());

function plain(text) {
  if (text === '-') return null;
  if (text === 'yes') return true;
  if (text === 'no') return false;
  if (NUMBER.test(text)) return Number(text);
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return text;
    }
  }
  return text;
}

// The values one line of a section holds, as [path, value] pairs: one for a
// plain value, one per field for a small object, the mean for a list of
// numbers. Loose: a text that happens to look like one of these is taken for it.
export function lineValues(name, text) {
  if (text === '(none)' || text === '(empty)' || /^\d+ items, \d+ left out here$/.test(text)) return [];
  const summed = SUMMED.exec(text);
  if (summed) return summed[3] !== undefined ? [[`${name} (mean)`, Number(summed[3])]] : [];
  const single = plain(text);
  if (single !== text) return [[name, single]];
  const pairs = [];
  PAIR.lastIndex = 0;
  let end = 0;
  for (let match = PAIR.exec(text); match; match = PAIR.exec(text)) {
    pairs.push([`${name}.${match[1]}`, plain(match[2])]);
    end = PAIR.lastIndex;
    if (end >= text.length) break;
  }
  if (pairs.length && end >= text.length) return pairs;
  const items = text.split(', ');
  if (items.length > 1 && items.every((item) => NUMBER.test(item))) return [[`${name} (mean)`, items.reduce((sum, item) => sum + Number(item), 0) / items.length]];
  return [[name, text]];
}

// What a report shows, in the shape the comparison works on, whether it came
// from the file or from the text:
//   { source, v, generated, game, browser, complete, cut, findings: [{ code,
//     level, section, title }], sections: [{ id, title }], values: Map }
// `values` maps "<section>.<path>" to a number, a boolean, a text or null,
// with the paths the text form prints; the series is there as
// "series.fps (mean)" and "series.fps (min)".
export function viewOfText(text) {
  const lines = String(text).replace(/^\s+/, '').split(/\r?\n/);
  const head = HEAD_LINE.exec(lines[0].trim());
  if (!head) return null;
  const view = { source: 'text', v: Number(head[1]), generated: head[2], game: head[3], browser: head[4], complete: false, cut: null,
    findings: [], sections: [], values: new Map() };
  let section = null;
  let series = false;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('== End of report')) {
      view.complete = true;
      break;
    }
    if (line.startsWith('Cut to fit ')) {
      view.cut = line;
      continue;
    }
    const finding = FINDING_LINE.exec(line);
    if (finding) {
      view.findings.push({ level: finding[1], code: finding[2], section: finding[3], title: finding[4] });
      continue;
    }
    if (line.startsWith('== Series')) {
      section = null;
      series = true;
      continue;
    }
    const heading = SECTION_LINE.exec(line);
    if (heading) {
      section = heading[2];
      series = false;
      view.sections.push({ id: section, title: heading[1] });
      continue;
    }
    const at = line.indexOf(': ');
    // Not a value: a finding's detail (indented), a note ("(this part failed: ...)").
    if (at < 1 || /^[\s(]/.test(line) || (!section && !series)) continue;
    const name = line.slice(0, at);
    const value = line.slice(at + 2);
    if (series) {
      if (name.split(' ')[0] !== 'fps') continue;
      const summed = SUMMED.exec(value);
      const numbers = value.split(/\s+/).filter((item) => NUMBER.test(item)).map(Number);
      if (summed && summed[2] !== undefined) {
        view.values.set('series.fps (mean)', Number(summed[3]));
        view.values.set('series.fps (min)', Number(summed[2]));
      } else if (!summed && numbers.length) {
        view.values.set('series.fps (mean)', numbers.reduce((a, b) => a + b, 0) / numbers.length);
        view.values.set('series.fps (min)', Math.min(...numbers));
      }
    } else {
      for (const [key, item] of lineValues(name, value)) view.values.set(`${section}.${key}`, item);
    }
  }
  return view;
}

// The values of a section's data under the paths the text form gives them.
function flatten(path, value, out, depth = 0) {
  if (depth > 40) return;
  if (isLeaf(value)) {
    out.set(path || 'value', typeof value === 'string' ? plain(showLine(value, 400)) : value === undefined ? null : value);
  } else if (Array.isArray(value)) {
    const name = path || 'value';
    if (!value.length) return;
    if (!value.every(isLeaf)) {
      value.forEach((item, index) => flatten(`${name}[${index}]`, item, out, depth + 1));
    } else if (value.length === 1) {
      flatten(name, value[0], out, depth + 1);
    } else if (value.every((item) => typeof item === 'number')) {
      out.set(`${name} (mean)`, numberStats(value).mean);
    } else {
      out.set(name, value.map((item) => showInline(item, 80)).join(', '));
    }
  } else {
    for (const [key, item] of Object.entries(value)) flatten(path ? `${path}.${key}` : key, item, out, depth + 1);
  }
}

export function viewOfReport(report) {
  const sections = isObject(report.sections) ? report.sections : {};
  const view = {
    source: 'file',
    v: report.v,
    generated: report.generated,
    game: gameName(report.game),
    browser: browserName(findText(sections.browser, 'userAgent') || findText(sections, 'userAgent')),
    complete: true,
    cut: null,
    findings: (Array.isArray(report.findings) ? report.findings : []).filter(isObject)
      .map((finding) => ({ level: finding.level, code: finding.code, section: finding.section, title: finding.title })),
    sections: Object.entries(sections).map(([id, section]) => ({ id, title: (section && section.title) || id })),
    values: new Map(),
  };
  for (const [id, section] of Object.entries(sections)) {
    if (!isObject(section) || section.data === null || section.data === undefined) continue;
    const values = new Map();
    flatten('', section.data, values);
    for (const [key, item] of values) view.values.set(`${id}.${key}`, item);
  }
  const fps = numberStats(isObject(report.series) && Array.isArray(report.series.fps) ? report.series.fps : []);
  if (fps) {
    view.values.set('series.fps (mean)', fps.mean);
    view.values.set('series.fps (min)', fps.min);
  }
  return view;
}

// --- comparing -------------------------------------------------------------------------

export const SHARE = 0.2;

// What differs between two views (a first, b second):
//   gained, lost, both   findings b has and a has not, the reverse, and those in both
//   numbers   [{ path, a, b, change }] where the number changed by more than
//             `share` of a's (change is (b - a) / |a|, or null when a is 0)
//   others    [{ path, a, b }] for values that are not both numbers and differ
//   onlyA, onlyB   paths one has and the other has not
export function compare(a, b, share = SHARE) {
  const key = (finding) => `${finding.section}/${finding.code}`;
  const inA = new Set(a.findings.map(key));
  const inB = new Set(b.findings.map(key));
  const result = {
    gained: b.findings.filter((finding) => !inA.has(key(finding))),
    lost: a.findings.filter((finding) => !inB.has(key(finding))),
    both: a.findings.filter((finding) => inB.has(key(finding))),
    numbers: [],
    others: [],
    onlyA: [...a.values.keys()].filter((name) => !b.values.has(name)),
    onlyB: [...b.values.keys()].filter((name) => !a.values.has(name)),
  };
  for (const [name, first] of a.values) {
    if (!b.values.has(name)) continue;
    const second = b.values.get(name);
    if (typeof first === 'number' && typeof second === 'number') {
      if (first === second) continue;
      if (first === 0) result.numbers.push({ path: name, a: first, b: second, change: null });
      else if (Math.abs(second - first) > share * Math.abs(first)) result.numbers.push({ path: name, a: first, b: second, change: (second - first) / Math.abs(first) });
    } else if (showLeaf(first, 400) !== showLeaf(second, 400)) {
      result.others.push({ path: name, a: first, b: second });
    }
  }
  return result;
}

const findingText = (finding) => `[${finding.level}] ${finding.code} (${finding.section}): ${finding.title}`;
const sectionOf = (name) => name.slice(0, name.indexOf('.'));

function capped(lines, all, what) {
  const most = 60;
  if (all || lines.length <= most) return lines;
  return [...lines.slice(0, most), `  ... and ${lines.length - most} more ${what} (--all prints them)`];
}

// The comparison as text. `names` are what to call the two, `options.all`
// lifts the limit on the lists.
export function formatCompare(a, b, result, names = ['A', 'B'], options = {}) {
  const share = options.share === undefined ? SHARE : options.share;
  const describe = (view) => `${view.generated} | ${view.game} | ${view.browser}${view.source === 'text' ? ` | from the text form${view.complete ? '' : ', which is cut off'}${view.cut ? ', which was cut to fit' : ''}` : ''}`;
  const lines = [`A: ${names[0]}`, `   ${describe(a)}`, `B: ${names[1]}`, `   ${describe(b)}`];
  if (a.game !== b.game) lines.push('The two are of different games.');
  if (a.source === 'text' || b.source === 'text') lines.push('The text form holds less than the file: a value missing on one side may only have been cut there.');

  lines.push('', 'Findings');
  if (!result.gained.length && !result.lost.length) lines.push(result.both.length ? '  the same in both' : '  none in either');
  for (const finding of result.gained) lines.push(`  only in B: ${findingText(finding)}`);
  for (const finding of result.lost) lines.push(`  only in A: ${findingText(finding)}`);
  if (result.both.length) lines.push(`  in both: ${result.both.map((finding) => finding.code).join(', ')}`);

  lines.push('', `Numbers that changed by more than ${showNumber(share * 100)}%`);
  if (!result.numbers.length) lines.push('  none');
  lines.push(...capped(result.numbers.map((entry) => {
    const change = entry.change === null ? '' : ` (${entry.change > 0 ? '+' : '-'}${Math.round(Math.abs(entry.change) * 100)}%)`;
    return `  ${entry.path}: ${showNumber(entry.a)} -> ${showNumber(entry.b)}${change}`;
  }), options.all, 'numbers'));

  if (result.others.length) {
    lines.push('', 'Other values that differ');
    lines.push(...capped(result.others.map((entry) => `  ${entry.path}: ${showLeaf(entry.a, 70)} -> ${showLeaf(entry.b, 70)}`), options.all, 'values'));
  }

  for (const [label, only, view, other] of [['A', result.onlyA, a, b], ['B', result.onlyB, b, a]]) {
    if (!only.length) continue;
    const theirs = new Set(other.sections.map((section) => section.id));
    const whole = view.sections.filter((section) => !theirs.has(section.id)).map((section) => section.id);
    const rest = only.filter((name) => !whole.includes(sectionOf(name)));
    lines.push('', `Only in ${label}`);
    if (whole.length) lines.push(`  the section${whole.length === 1 ? '' : 's'} ${whole.join(', ')}`);
    lines.push(...capped(rest.map((name) => `  ${name}: ${showLeaf(view.values.get(name), 70)}`), options.all, 'values'));
  }
  return `${lines.join('\n')}\n`;
}

// --- command line ----------------------------------------------------------------------

function usage(message) {
  console.error(`${message}\nusage: node tools/web/diagreport.mjs <report> [--full] [--quiet]\n       node tools/web/diagreport.mjs --compare <a> <b> [--share N] [--all] [--quiet]`);
  process.exit(2);
}

// Reads one report: { name, view, report, problems, error }.
export function load(name, text, schema) {
  if (isText(text)) return { name, view: viewOfText(text), report: null, problems: [] };
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return { name, view: null, report: null, problems: [{ at: 'the file', message: `is neither a report's JSON (${error.message}) nor its text form (that begins with "EKA2L1 web diagnostics v1 |")` }] };
  }
  const problems = checkReport(report, schema);
  return { name, view: problems.length ? null : viewOfReport(report), report, problems };
}

function main(argv) {
  const flags = { compare: false, all: false, full: false, quiet: false, share: SHARE };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare' || arg === '--all' || arg === '--full' || arg === '--quiet') {
      flags[arg.slice(2)] = true;
    } else if (arg === '--share') {
      if (i + 1 >= argv.length) usage('--share needs a value');
      flags.share = Number(argv[++i]);
      if (!(flags.share >= 0) || !Number.isFinite(flags.share)) usage('--share must be a number of 0 or more, such as 0.2');
    } else if (arg.startsWith('--')) {
      usage(`unknown argument: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (flags.compare && files.length !== 2) usage('--compare takes two reports');
  if (!flags.compare && files.length !== 1) usage(files.length ? 'one report at a time, or --compare with two' : 'no report given');
  if (files.filter((file) => file === '-').length > 1) usage('standard input can be read only once');

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  } catch (error) {
    usage(`cannot read the schema ${SCHEMA_FILE}: ${error.message}`);
  }
  const loaded = files.map((file) => {
    let text;
    try {
      text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
      usage(`cannot read ${file}: ${error.message}`);
    }
    return load(file === '-' ? 'standard input' : file, text, schema);
  });

  let valid = true;
  for (const item of loaded) {
    if (!item.problems.length) continue;
    valid = false;
    console.error(`INVALID  ${item.name}: ${item.problems.length} problem${item.problems.length === 1 ? '' : 's'}`);
    for (const problem of item.problems) console.error(`  ${problem.at} ${problem.message}`);
  }
  if (!valid) process.exit(1);

  if (flags.compare) {
    const [a, b] = loaded;
    const result = compare(a.view, b.view, flags.share);
    if (!flags.quiet) process.stdout.write(formatCompare(a.view, b.view, result, [a.name, b.name], flags));
    else console.log(`VALID  ${a.name}, ${b.name}: ${result.gained.length} findings only in B, ${result.lost.length} only in A, ${result.numbers.length} numbers changed`);
    return;
  }
  const [item] = loaded;
  if (item.report) {
    console.log(`VALID  ${item.name}: a report of ${item.view.game}, ${item.view.findings.length} finding${item.view.findings.length === 1 ? '' : 's'}, ${item.view.sections.length} sections`);
    if (!flags.quiet) process.stdout.write(`\n${formatText(item.report, flags.full ? Infinity : TEXT_LIMIT)}`);
  } else {
    const view = item.view;
    console.log(`TEXT  ${item.name}: the text form of a report of ${view.game}, read loosely and not checked`
      + `${view.complete ? '' : '; its end is missing, so it was cut off when it was pasted'}${view.cut ? '; it was cut to fit when it was copied' : ''}`);
    if (!flags.quiet) {
      console.log(`  made ${view.generated} in ${view.browser}`);
      console.log(view.findings.length ? `  findings: ${view.findings.map((finding) => `${finding.code} [${finding.level}]`).join(', ')}` : '  findings: none');
      for (const section of view.sections) {
        const count = [...view.values.keys()].filter((name) => sectionOf(name) === section.id).length;
        console.log(`  ${section.id}: ${count} value${count === 1 ? '' : 's'} read`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
