#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// diagnostics: the project's own checkers on the touched files, found from
// the nearest project root, parsed into one list of problems; honest about
// a project with nothing to run and about a checker that is not installed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diag = require('../shared-core/tools/diagnostics.js');
const permission = require('../shared-core/tools/permission.js');

let pass = 0, fail = 0, skipped = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { if (e && e.skip) { console.log('  ○ SKIP ' + name + ' (' + e.skip + ')'); skipped++; return; } console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const skip = (why) => { const e = new Error(why); e.skip = why; throw e; };
const onPath = (name) => String(process.env.PATH || '').split(path.delimiter).some((d) => { try { return fs.statSync(path.join(d, name)).isFile(); } catch (_) { return false; } });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} };

(async () => {
  console.log('diagnostics');

  await t('registered as a read tool with a schema; the parsers read each checker\'s lines', () => {
    const reg = require('../shared-core/tools/index.js');
    const names = (reg.unifiedRegistry ? Object.keys(reg.unifiedRegistry()) : Object.keys(reg.REGISTRY || {}));
    assert.ok(names.includes('diagnostics') || !!(reg.REGISTRY && reg.REGISTRY.diagnostics), 'in the registry');
    assert.strictEqual(permission.classify('diagnostics'), 'read');
    const ts = diag.parseTsc('src/a.ts(3,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\nnoise', '/p');
    assert.deepStrictEqual(ts, [{ file: '/p/src/a.ts', line: 3, col: 7, severity: 'error', code: 'TS2322', message: 'Type \'string\' is not assignable to type \'number\'.', checker: 'tsc' }]);
    const es = diag.parseEslint(JSON.stringify([{ filePath: '/p/x.js', messages: [{ line: 1, column: 2, severity: 2, ruleId: 'no-undef', message: 'x is not defined' }] }]));
    assert.strictEqual(es[0].code, 'no-undef');
    assert.strictEqual(es[0].severity, 'error');
    const cg = diag.parseCargo('src/main.rs:4:9: error[E0308]: mismatched types\nwarning: unused', '/p');
    assert.deepStrictEqual(cg, [{ file: '/p/src/main.rs', line: 4, col: 9, severity: 'error', code: 'E0308', message: 'mismatched types', checker: 'cargo' }]);
    const rf = diag.parseRuff('app.py:1:8: F401 `os` imported but unused', '/p');
    assert.strictEqual(rf[0].code, 'F401');
    assert.strictEqual(rf[0].line, 1);
  });

  await t('no project root: nothing_to_run names the place it looked', async () => {
    const d = tmp('diag-none-');
    try {
      const r = await diag.run({}, { cwd: d });
      assert.strictEqual(r.nothing_to_run, true);
      assert.ok(r.hint.includes(d), 'hint names the folder');
    } finally { rm(d); }
  });

  await t('a project whose checker is not installed is reported as skipped, not silently clean', async () => {
    const d = tmp('diag-skip-');
    try {
      fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname = "x"\n');
      fs.writeFileSync(path.join(d, 'app.py'), 'import os\n');
      const p = diag.plan(d, [path.join(d, 'app.py')]);
      if (onPath('ruff')) skip('ruff is on this machine; the skipped road needs its absence');
      assert.strictEqual(p.checks.length, 0);
      assert.strictEqual(p.skipped[0].checker, 'ruff');
      const r = await diag.run({ files: ['app.py'] }, { cwd: d });
      assert.strictEqual(r.nothing_to_run, true);
      assert.strictEqual(r.skipped[0].checker, 'ruff');
    } finally { rm(d); }
  });

  await t('the root is the nearest marker above the file; the plan picks checkers by file type', () => {
    const d = tmp('diag-root-');
    try {
      fs.mkdirSync(path.join(d, 'pkg', 'src'), { recursive: true });
      fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "outer"\n');
      fs.writeFileSync(path.join(d, 'pkg', 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(d, 'pkg', 'src', 'a.ts'), 'export const a = 1;\n');
      assert.strictEqual(diag.findRoot(path.join(d, 'pkg', 'src', 'a.ts')), path.join(d, 'pkg'));
      assert.strictEqual(diag.findRoot(path.join(d, 'pkg', 'src')), path.join(d, 'pkg'));
      const p = diag.plan(d, [path.join(d, 'pkg', 'src', 'a.ts')]);
      assert.ok(!p.checks.some((c) => c.checker === 'cargo'), 'no .rs file touched: cargo not planned');
      const p2 = diag.plan(d, []);
      assert.ok(p2.checks.some((c) => c.checker === 'cargo') || p2.skipped.some((s) => s.checker === 'cargo'), 'no files: the whole project, cargo considered');
    } finally { rm(d); }
  });

  await t('a TypeScript project with one type error: tsc names it, filtered to the touched file', async () => {
    if (!onPath('tsc')) skip('no tsc on PATH');
    const d = tmp('diag-ts-');
    try {
      fs.mkdirSync(path.join(d, 'src'));
      fs.writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2020', module: 'commonjs', types: [] }, include: ['src'] }));
      fs.writeFileSync(path.join(d, 'src', 'bad.ts'), 'export const n: number = "no";\n');
      fs.writeFileSync(path.join(d, 'src', 'other.ts'), 'export const m: number = "also no";\n');
      const r = await diag.run({ files: ['src/bad.ts'] }, { cwd: d });
      assert.strictEqual(r.nothing_to_run, undefined, 'something ran: ' + JSON.stringify(r).slice(0, 300));
      assert.ok(r.ran.some((x) => x.checker === 'tsc' && x.started), 'tsc ran: ' + JSON.stringify(r.ran));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.problem_count, 1, 'only the touched file\'s problem: ' + JSON.stringify(r.problems));
      assert.strictEqual(r.problems[0].file, path.join('src', 'bad.ts'));
      assert.strictEqual(r.problems[0].line, 1);
      assert.strictEqual(r.problems[0].code, 'TS2322');
      const all = await diag.run({}, { cwd: d });
      assert.strictEqual(all.problem_count, 2, 'no files: the whole project');
      fs.writeFileSync(path.join(d, 'src', 'bad.ts'), 'export const n: number = 1;\n');
      fs.writeFileSync(path.join(d, 'src', 'other.ts'), 'export const m: number = 2;\n');
      const clean = await diag.run({ files: ['src/bad.ts'] }, { cwd: d });
      assert.strictEqual(clean.ok, true, 'clean after the fix: ' + JSON.stringify(clean).slice(0, 300));
    } finally { rm(d); }
  });

  await t('a Rust project with one type error: cargo check names it', async () => {
    if (!onPath('cargo')) skip('no cargo on PATH');
    const d = tmp('diag-rs-');
    try {
      fs.mkdirSync(path.join(d, 'src'));
      fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "diagprobe"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
      fs.writeFileSync(path.join(d, 'src', 'main.rs'), 'fn main() { let x: u32 = "no"; println!("{}", x); }\n');
      const r = await diag.run({ files: ['src/main.rs'] }, { cwd: d });
      assert.ok(r.ran.some((x) => x.checker === 'cargo' && x.started), 'cargo ran: ' + JSON.stringify(r.ran));
      assert.strictEqual(r.ok, false);
      assert.ok(r.problems.some((p) => p.file === path.join('src', 'main.rs') && p.code === 'E0308'), 'the mismatch is named: ' + JSON.stringify(r.problems));
    } finally { rm(d); }
  });

  console.log('\ndiagnostics: ' + pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exit(fail ? 1 : 0);
})();
