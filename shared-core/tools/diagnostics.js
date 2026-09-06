// SPDX-License-Identifier: AGPL-3.0-only
// diagnostics — the project's own checkers on the files just touched.
//
// After an edit the partner asks the project, not itself, whether the code
// still holds: tsc for a TypeScript project, eslint where a config exists,
// cargo check for Rust, ruff for Python. Each checker is found from the
// nearest project root above the touched files, runs time-boxed through the
// spawn seam and comes back as one list of problems with file, line, column
// and message. A project with no checker says so instead of pretending.
'use strict';

const fs = require('fs');
const path = require('path');
const spawnPurpose = require('./spawn-purpose.js');

const CHECKER_TIMEOUT_MS = 60000;
const MAX_PROBLEMS = 40;
const ROOT_MARKERS = ['tsconfig.json', 'package.json', 'Cargo.toml', 'pyproject.toml', 'ruff.toml'];
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];

const schema = { type: 'function', function: {
  name: 'diagnostics',
  description: 'Run the project\'s own checkers on files you just edited and get their problems back with file, line and message: tsc for TypeScript, eslint where configured, cargo check for Rust, ruff for Python. Call it after edits before saying a change is clean. A project without a checker reports nothing_to_run.',
  parameters: { type: 'object', properties: {
    files: { type: 'array', items: { type: 'string' }, description: 'The files just touched (absolute or relative to the workspace). Omit to check the whole project from the workspace root.' }
  } }
} };

function _exists(p) { try { fs.statSync(p); return true; } catch (_) { return false; } }
function _isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

// The nearest directory above `from` carrying a project marker.
function findRoot(from) {
  let dir = path.resolve(from);
  if (_isFile(dir)) dir = path.dirname(dir);
  for (let i = 0; i < 40; i++) {
    for (const m of ROOT_MARKERS) if (_exists(path.join(dir, m))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function _binFor(root, name) {
  const local = path.join(root, 'node_modules', '.bin', name);
  if (_isFile(local)) return local;
  return name; // PATH
}

function _onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => d && _isFile(path.join(d, name)));
}

function _runChecker(label, cmd, args, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawnPurpose.spawn('project-run', cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }) });
    } catch (e) {
      return resolve({ checker: label, started: false, error: e && e.message || String(e), ms: 0, stdout: '', stderr: '' });
    }
    let out = '', err = '', done = false, timedOut = false;
    const finish = (code) => {
      if (done) return; done = true;
      resolve({ checker: label, started: true, exit: code, timed_out: timedOut, ms: Date.now() - t0, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, CHECKER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); if (!done) { done = true; resolve({ checker: label, started: false, error: e && e.message || String(e), ms: Date.now() - t0, stdout: out, stderr: err }); } });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
  });
}

// tsc:  path(line,col): error TSxxxx: message   (also the path:line:col form)
function parseTsc(text, root) {
  const rows = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  for (const line of String(text).split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    rows.push({ file: path.resolve(root, m[1]), line: Number(m[2]), col: Number(m[3]), severity: m[4], code: m[5], message: m[6].trim(), checker: 'tsc' });
  }
  return rows;
}

// eslint --format json
function parseEslint(text) {
  const rows = [];
  let arr;
  try { arr = JSON.parse(text); } catch (_) { return rows; }
  if (!Array.isArray(arr)) return rows;
  for (const f of arr) {
    for (const m of (f && f.messages) || []) {
      rows.push({ file: f.filePath, line: m.line || 0, col: m.column || 0, severity: m.severity === 2 ? 'error' : 'warning', code: m.ruleId || null, message: String(m.message || '').trim(), checker: 'eslint' });
    }
  }
  return rows;
}

// cargo --message-format short:  src/x.rs:12:5: error[E0308]: message
function parseCargo(text, root) {
  const rows = [];
  const re = /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)\])?:\s+(.*)$/;
  for (const line of String(text).split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    rows.push({ file: path.resolve(root, m[1]), line: Number(m[2]), col: Number(m[3]), severity: m[4], code: m[5] || null, message: m[6].trim(), checker: 'cargo' });
  }
  return rows;
}

// ruff --output-format concise:  path:line:col: CODE message
function parseRuff(text, root) {
  const rows = [];
  const re = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.*)$/;
  for (const line of String(text).split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    rows.push({ file: path.resolve(root, m[1]), line: Number(m[2]), col: Number(m[3]), severity: 'error', code: m[4], message: m[5].trim(), checker: 'ruff' });
  }
  return rows;
}

function plan(root, files) {
  const rel = files.map((f) => path.resolve(root, f));
  const has = (re) => files.length === 0 || rel.some((f) => re.test(f));
  const out = [];
  const skipped = [];
  if (_exists(path.join(root, 'tsconfig.json'))) {
    const tsc = _binFor(root, 'tsc');
    if (tsc !== 'tsc' || _onPath('tsc')) out.push({ checker: 'tsc', cmd: tsc, args: ['--noEmit', '--pretty', 'false', '-p', path.join(root, 'tsconfig.json')], parse: (r) => parseTsc(r.stdout + '\n' + r.stderr, root), filter: true });
    else skipped.push({ checker: 'tsc', why: 'tsconfig.json present but no tsc (project node_modules or PATH)' });
  }
  if (ESLINT_CONFIGS.some((c) => _exists(path.join(root, c))) && has(/\.(m?js|cjs|jsx|ts|tsx)$/i)) {
    const eslint = _binFor(root, 'eslint');
    const targets = files.length ? rel.filter((f) => /\.(m?js|cjs|jsx|ts|tsx)$/i.test(f)) : ['.'];
    if (eslint !== 'eslint' || _onPath('eslint')) out.push({ checker: 'eslint', cmd: eslint, args: ['--format', 'json', '--no-error-on-unmatched-pattern'].concat(targets), parse: (r) => parseEslint(r.stdout), filter: false });
    else skipped.push({ checker: 'eslint', why: 'an eslint config is present but no eslint (project node_modules or PATH)' });
  }
  if (_exists(path.join(root, 'Cargo.toml')) && has(/\.rs$/i)) {
    if (_onPath('cargo')) out.push({ checker: 'cargo', cmd: 'cargo', args: ['check', '--message-format', 'short', '--quiet'], parse: (r) => parseCargo(r.stderr + '\n' + r.stdout, root), filter: true });
    else skipped.push({ checker: 'cargo', why: 'Cargo.toml present but no cargo on PATH' });
  }
  if ((_exists(path.join(root, 'pyproject.toml')) || _exists(path.join(root, 'ruff.toml'))) && has(/\.py$/i)) {
    const targets = files.length ? rel.filter((f) => /\.py$/i.test(f)) : ['.'];
    if (_onPath('ruff')) out.push({ checker: 'ruff', cmd: 'ruff', args: ['check', '--output-format', 'concise', '--no-fix'].concat(targets), parse: (r) => parseRuff(r.stdout, root), filter: false });
    else skipped.push({ checker: 'ruff', why: 'a Python project but no ruff on PATH' });
  }
  return { checks: out, skipped };
}

async function run(args, ctx) {
  const a = args || {};
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const files = Array.isArray(a.files) ? a.files.filter((f) => typeof f === 'string' && f.trim()).map((f) => path.resolve(cwd, f.trim())) : [];
  const root = (files.length ? findRoot(files[0]) : null) || findRoot(cwd);
  if (!root) return { nothing_to_run: true, hint: 'no project root (tsconfig.json, package.json, Cargo.toml, pyproject.toml) above ' + (files[0] || cwd) };
  const { checks, skipped } = plan(root, files);
  if (!checks.length) {
    return { nothing_to_run: true, root, skipped, hint: skipped.length ? 'a checker is configured but not installed' : 'no checker configured for this project' };
  }
  const ran = [];
  let problems = [];
  const wanted = new Set(files);
  for (const c of checks) {
    const r = await _runChecker(c.checker, c.cmd, c.args, root);
    ran.push({ checker: c.checker, started: r.started, exit: r.exit == null ? null : r.exit, timed_out: !!r.timed_out, ms: r.ms, error: r.error || null, wall: undefined });
    if (!r.started) continue;
    let rows = c.parse(r);
    if (c.filter && wanted.size) rows = rows.filter((p) => wanted.has(path.resolve(p.file)));
    // A checker that failed without naming a problem (a bad config, a crash)
    // still has to be heard: keep its last lines.
    if (!rows.length && r.exit !== 0 && !r.timed_out) {
      const tail = String(r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n');
      if (tail) rows = [{ file: root, line: 0, col: 0, severity: 'error', code: null, message: c.checker + ' exited ' + r.exit + ': ' + tail, checker: c.checker }];
    }
    problems = problems.concat(rows);
  }
  const shown = problems.slice(0, MAX_PROBLEMS).map((p) => ({ file: path.relative(root, p.file) || p.file, line: p.line, col: p.col, severity: p.severity, code: p.code, message: p.message, checker: p.checker }));
  return {
    ok: problems.length === 0 && ran.every((r) => r.started && !r.timed_out),
    root,
    ran,
    skipped,
    problem_count: problems.length,
    problems: shown,
    truncated: problems.length > MAX_PROBLEMS
  };
}

module.exports = { schema, run, findRoot, plan, parseTsc, parseEslint, parseCargo, parseRuff, CHECKER_TIMEOUT_MS, MAX_PROBLEMS };
