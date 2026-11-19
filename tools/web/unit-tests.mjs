#!/usr/bin/env node
// The tests that need no browser, as `npm test` runs them:
//
//   node tools/web/unit-tests.mjs [SHELL_TESTS_DIR]
//
// Every tools/web/*.test.mjs (the per-game test's rules, the diagnostics
// scenarios, the report reader), and the fork's page tests in
// eka2l1/src/emu/web/shell-tests/ when the submodule is checked out. In a git
// worktree eka2l1/ is empty, so those are left out with a note. A folder given
// as the argument replaces that one, for instance the main checkout's
// (`npm test -- "$ARCADE_MAIN/eka2l1/src/emu/web/shell-tests"`); it must exist.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

if (process.argv.length > 3 || (process.argv[2] || '').startsWith('-')) {
  console.error('usage: node tools/web/unit-tests.mjs [SHELL_TESTS_DIR]');
  process.exit(2);
}

const tests = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(dir, name));

const files = tests(here);
const given = process.argv[2];
const fork = path.join(root, 'eka2l1');
const shellTests = path.resolve(given || path.join(fork, 'src', 'emu', 'web', 'shell-tests'));
if (fs.existsSync(shellTests)) {
  const found = tests(shellTests);
  if (!found.length) {
    console.error(`unit-tests: no *.test.mjs in ${shellTests}`);
    process.exit(2);
  }
  files.push(...found);
} else if (given) {
  console.error(`unit-tests: ${shellTests} does not exist`);
  process.exit(2);
} else if (fs.existsSync(fork) && fs.readdirSync(fork).length) {
  console.error(`unit-tests: the eka2l1 checkout has no ${path.relative(root, shellTests)}, so no page tests run`);
} else {
  console.error('unit-tests: the eka2l1 submodule is not checked out here, so its shell-tests are left out');
}

const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
