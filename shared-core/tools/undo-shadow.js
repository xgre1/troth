// SPDX-License-Identifier: AGPL-3.0-only
// Undo shadows — the partner's photographic memory of the operator's work.
//
// WHY: the operator walks away while the partner works on their real files.
// Over enough turns a mistaken action is a certainty, and the answer to a
// mistake inside the work is undo, not a wall — deleting a project can BE
// the job. So: a photograph before every action, taken with no judgment
// about whether the action "looks dangerous". Deciding which actions
// deserve a photograph is exactly the judgment this module exists to remove.
//
// HOW: one shadow repository per ground under ~/.troth/undo/<key>/ — a git
// database whose work-tree is pointed AT the ground but whose GIT_DIR lives
// here. A snapshot is a commit into the shadow. The operator's own .git,
// stash, hooks and config are never read, never written, never listed:
// global and system git config are disabled on every call, and git itself
// refuses to track any path containing a .git component, so the ground's
// own repository is structurally outside every photograph.
//
// Restore first photographs the present — the undo is itself undoable —
// then makes the tree match the chosen photograph exactly: tracked files
// restored, files born after it removed, ignored trees untouched. If the
// ground itself was deleted, restore recreates it.
//
// WHAT IT DECLINES TO PHOTOGRAPH (counted and kept, never silent): the home
// root and anything above it, the substrate tree outside the workspace,
// shallow unclassified ground, grounds git cannot serve, and trees whose
// scan exceeds the budget. stats() and each ground's meta.json say plainly
// what is not covered.
//
// Spawn purpose: every git call here is undo plumbing. When the spawn
// boundary lands, SPAWN_PURPOSE routes these to a profile that reads the
// ground and writes only the shadow — never the strict default jail.

'use strict';

// Routed through the spawn seam: purpose 'undo-plumbing' (parent-boundary,
// argv authored here, never by a model). The census counts this file at 0.
const execFileSync = (cmd, args, opts) =>
  require('./spawn-purpose.js').execFileSync('undo-plumbing', cmd, args, opts);
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitOk } = require('../git-ok.js');

const SPAWN_PURPOSE = 'undo-plumbing';

const SIZE_CAP_BYTES = 256 * 1024 * 1024; // new files above this are not photographed (recorded)
const STATUS_TIMEOUT_MS = 8000;
const ADD_TIMEOUT_MS = 20000;             // hard scan budget; exceeding it is a loud degradation
const COMMIT_TIMEOUT_MS = 10000;
const MAINT_TIMEOUT_MS = 60000;
const RETAIN_DAYS = 14;
const KEEP_MIN = 5;
const MAINT_EVERY = 100;
const MAX_STAT_ENTRIES = 20000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Regenerable trees only — cost control, never data. What is skipped here
// can be rebuilt from a lockfile, not from regret.
const DEFAULT_EXCLUDES = [
  '.DS_Store', 'node_modules/', '.venv/', 'venv/', '__pycache__/',
  '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'dist/', 'build/',
  '.next/', '.nuxt/', 'target/', '.cache/', '.turbo/', '.parcel-cache/',
  'coverage/', '.gradle/', 'Pods/', 'DerivedData/', '.terraform/',
  '*.tmp-*'
];

const stats = {
  photographed: 0, unchanged: 0, restored: 0,
  skipped: 0, degraded: 0, lastDegradation: null
};

function _trothDir() {
  return process.env.TROTH_CONFIG_DIR
      || path.join(process.env.HOME || os.homedir(), '.troth');
}
function _undoRoot() { return path.join(_trothDir(), 'undo'); }
function _home() { return process.env.HOME || os.homedir(); }

function _degrade(reason, detail) {
  stats.degraded++;
  stats.lastDegradation = { reason, detail: detail || '', ts: Date.now() };
  return { ok: false, degraded: reason, detail: detail || '' };
}

// Which grounds a photograph refuses. allowShallow marks targets that came
// from ground classification (a jail root, an opened folder) rather than a
// bare cwd — those may sit directly under home (Desktop) and are welcome.
function _guard(dir, allowShallow) {
  if (!dir || typeof dir !== 'string') return 'no-ground';
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { return 'ground-missing'; }
  let st;
  try { st = fs.statSync(real); } catch (e) { return 'ground-missing'; }
  if (!st.isDirectory()) return 'not-a-directory';
  const home = path.resolve(_home());
  if (real === '/' || real === path.sep) return 'ground-too-broad';
  if (real === home) return 'ground-too-broad';
  if (home.startsWith(real + path.sep)) return 'ground-too-broad'; // above home
  const troth = path.resolve(_trothDir());
  const workspace = path.join(troth, 'workspace');
  if (real === troth || real.startsWith(troth + path.sep)) {
    // The substrate tree is never photographed — except the workspace,
    // which is exactly the partner's project ground.
    if (!(real === workspace || real.startsWith(workspace + path.sep))) {
      return 'substrate-ground';
    }
  }
  if (!allowShallow && real.startsWith(home + path.sep)) {
    const depth = real.slice(home.length + 1).split(path.sep).length;
    if (depth < 2) return 'shallow-unclassified-ground';
  }
  return null;
}

function _keyFor(realDir) {
  const h = crypto.createHash('sha256').update(realDir).digest('hex').slice(0, 12);
  const leaf = path.basename(realDir).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'ground';
  return leaf + '-' + h;
}

function _env() {
  const e = Object.assign({}, process.env);
  for (const k of Object.keys(e)) { if (k.indexOf('GIT_') === 0) delete e[k]; }
  // The operator's git identity, hooks, signing and fsmonitor belong to
  // THEIR repositories. The shadow runs with configuration the module owns
  // and nothing else.
  e.GIT_CONFIG_GLOBAL = '/dev/null';
  e.GIT_CONFIG_SYSTEM = '/dev/null';
  e.GIT_TERMINAL_PROMPT = '0';
  e.LC_ALL = 'C';
  return e;
}

// Single chokepoint for every git spawn in this module (SPAWN_PURPOSE).
function _git(shadow, ground, args, opts) {
  opts = opts || {};
  const full = ['--git-dir', shadow];
  if (ground) full.push('--work-tree', ground);
  for (const a of args) full.push(a);
  try {
    const out = execFileSync('git', full, {
      cwd: ground && fs.existsSync(ground) ? ground : undefined,
      env: _env(), stdio: 'pipe',
      timeout: opts.timeout || COMMIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER
    });
    return { ok: true, out: out.toString() };
  } catch (e) {
    return {
      ok: false,
      out: ((e && e.stdout) ? e.stdout.toString() : ''),
      err: ((e && e.stderr) ? e.stderr.toString() : (e && e.message) || ''),
      timedOut: !!(e && (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT'))
    };
  }
}

function _paths(realDir) {
  const base = path.join(_undoRoot(), _keyFor(realDir));
  return { base, shadow: path.join(base, 'repo.git'), meta: path.join(base, 'meta.json') };
}

function _readMeta(p) {
  try { return JSON.parse(fs.readFileSync(p.meta, 'utf8')); } catch (e) { return null; }
}
function _writeMeta(p, meta) {
  try {
    const tmp = p.meta + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, p.meta);
  } catch (e) { /* meta is advisory; the commit log is the truth */ }
}

function _headExists(p, ground) {
  return _git(p.shadow, ground, ['rev-parse', '--verify', '-q', 'refs/heads/undo']).ok;
}

function _ensure(realDir) {
  const p = _paths(realDir);
  if (fs.existsSync(p.shadow)) return p;
  fs.mkdirSync(p.base, { recursive: true, mode: 0o700 });
  const init = _git(p.shadow, realDir, ['init', '-q']);
  if (!init.ok) throw new Error('shadow-init-failed: ' + (init.err || '').slice(0, 200));
  _git(p.shadow, null, ['symbolic-ref', 'HEAD', 'refs/heads/undo']);
  const cfg = [
    ['user.name', 'troth-undo'], ['user.email', 'undo@troth.local'],
    ['commit.gpgsign', 'false'], ['gc.auto', '0'],
    ['core.untrackedCache', 'true'], ['core.autocrlf', 'false']
  ];
  for (const kv of cfg) _git(p.shadow, null, ['config', kv[0], kv[1]]);
  const info = path.join(p.shadow, 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'exclude'),
    '# troth-undo defaults: regenerable trees only\n'
    + DEFAULT_EXCLUDES.join('\n')
    + '\n# troth-undo runtime (files beyond photo budget)\n');
  _writeMeta(p, { ground: realDir, created: Date.now(), degradations: [], overBudget: [] });
  return p;
}

function _recordDegradation(p, entry) {
  const meta = _readMeta(p) || { degradations: [] };
  meta.degradations = (meta.degradations || []).slice(-19);
  meta.degradations.push(Object.assign({ ts: Date.now() }, entry));
  _writeMeta(p, meta);
}

// New files above the size cap are excluded before they are ever tracked.
// Files that were photographed once and later grew stay photographed: the
// budget may cost time, but untracking would cost the only copy.
function _capNewFiles(p, realDir, statusZ) {
  const entries = statusZ.split('\0').filter(Boolean).slice(0, MAX_STAT_ENTRIES);
  const over = [];
  for (const e of entries) {
    if (e.length < 4 || e.slice(0, 2) !== '??') continue;
    const rel = e.slice(3);
    try {
      const st = fs.statSync(path.join(realDir, rel));
      if (st.isFile() && st.size > SIZE_CAP_BYTES) over.push(rel);
    } catch (err) { /* raced away — the add will decide */ }
  }
  if (!over.length) return;
  const excl = path.join(p.shadow, 'info', 'exclude');
  let cur = '';
  try { cur = fs.readFileSync(excl, 'utf8'); } catch (e) {}
  const add = [];
  for (const rel of over) {
    const line = '/' + rel.replace(/([[\]*?\\])/g, '\\$1');
    if (cur.indexOf('\n' + line + '\n') < 0 && !cur.endsWith(line + '\n')) add.push(line);
  }
  if (add.length) fs.appendFileSync(excl, add.join('\n') + '\n');
  const meta = _readMeta(p) || {};
  meta.overBudget = Array.from(new Set((meta.overBudget || []).concat(over))).slice(-100);
  _writeMeta(p, meta);
  _degrade('file-over-cap', over.length + ' new file(s) beyond photo budget');
  _recordDegradation(p, { reason: 'file-over-cap', paths: over.slice(0, 10) });
}

function _label(s) {
  return String(s || 'photo').replace(/[\r\n]+/g, ' ').slice(0, 120) || 'photo';
}

// A photograph of the ground. Returns { ok, id, unchanged? } or
// { ok:false, skipped?|degraded?, ... }. Never throws. Never blocks the
// caller's action — a failed photo is recorded, not enforced.
function snapshot(dir, label, opts) {
  opts = opts || {};
  try {
    const why = _guard(dir, opts.allowShallow);
    if (why) { stats.skipped++; return { ok: false, skipped: why }; }
    if (!gitOk()) return _degrade('git-unavailable');
    const realDir = fs.realpathSync(dir);
    const p = _ensure(realDir);

    let st = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      st = _git(p.shadow, realDir,
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        { timeout: STATUS_TIMEOUT_MS });
      if (st.ok || (st.err || '').indexOf('index.lock') < 0) break;
    }
    if (!st.ok) {
      const r = st.timedOut ? 'scan-budget' : ((st.err || '').indexOf('index.lock') >= 0 ? 'busy' : 'status-failed');
      _recordDegradation(p, { reason: r, label: _label(label) });
      return _degrade(r, (st.err || '').slice(0, 200));
    }

    const head = _headExists(p, realDir);
    if (head && st.out.length === 0) {
      stats.unchanged++;
      const id = _git(p.shadow, realDir, ['rev-parse', '--short', 'refs/heads/undo']);
      return { ok: true, unchanged: true, id: (id.out || '').trim() };
    }

    _capNewFiles(p, realDir, st.out);

    const add = _git(p.shadow, realDir, ['add', '-A'], { timeout: ADD_TIMEOUT_MS });
    if (!add.ok) {
      const r = add.timedOut ? 'scan-budget' : 'add-failed';
      _recordDegradation(p, { reason: r, label: _label(label) });
      return _degrade(r, (add.err || '').slice(0, 200));
    }
    // Top-level .env files are photographed even when the ground's own
    // .gitignore hides them: tiny, precious, and the classic first casualty
    // of a mistaken cleanup. Their ignore rule protects them from THEIR
    // remote, not from loss.
    for (const envName of ['.env', '.env.local', '.env.production', '.env.development']) {
      if (fs.existsSync(path.join(realDir, envName))) {
        _git(p.shadow, realDir, ['add', '-f', '--', envName]);
      }
    }

    if (head) {
      const same = _git(p.shadow, realDir, ['diff-index', '--quiet', '--cached', 'HEAD']);
      if (same.ok) {
        stats.unchanged++;
        const id0 = _git(p.shadow, realDir, ['rev-parse', '--short', 'refs/heads/undo']);
        return { ok: true, unchanged: true, id: (id0.out || '').trim() };
      }
    }
    const commitArgs = ['commit', '-q', '-m', _label(label)];
    if (!head) commitArgs.push('--allow-empty');
    const c = _git(p.shadow, realDir, commitArgs, { timeout: COMMIT_TIMEOUT_MS });
    if (!c.ok) {
      _recordDegradation(p, { reason: 'commit-failed', label: _label(label) });
      return _degrade('commit-failed', (c.err || '').slice(0, 200));
    }
    stats.photographed++;
    const idr = _git(p.shadow, realDir, ['rev-parse', '--short', 'refs/heads/undo']);
    const meta = _readMeta(p) || {};
    meta.last = { id: (idr.out || '').trim(), ts: Date.now(), label: _label(label) };
    _writeMeta(p, meta);
    if (stats.photographed % MAINT_EVERY === 0) _maintain(p, realDir);
    return { ok: true, id: (idr.out || '').trim() };
  } catch (e) {
    return _degrade('snapshot-error', (e && e.message || '').slice(0, 200));
  }
}

// Photograph the ground that holds a file: the nearest ancestor that is a
// repository, else the nearest ancestor sitting directly under home (a
// Desktop file photographs the Desktop), else the file's own directory.
function snapshotForFile(filePath, label) {
  try {
    let dir = path.dirname(path.resolve(filePath));
    const home = path.resolve(_home());
    let cur = dir, repoRoot = null, homeChild = null;
    while (cur && cur !== path.sep && cur !== home) {
      if (!repoRoot && fs.existsSync(path.join(cur, '.git'))) repoRoot = cur;
      if (path.dirname(cur) === home) homeChild = cur;
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    const target = repoRoot || homeChild || dir;
    return snapshot(target, label, { allowShallow: true });
  } catch (e) {
    return _degrade('snapshot-error', (e && e.message || '').slice(0, 200));
  }
}

function _resolveShadow(dir) {
  // Ground may have been deleted — the exact case restore exists for — so
  // fall back from realpath to a meta scan over the shadows we hold.
  let realDir = null;
  try { realDir = fs.realpathSync(dir); } catch (e) {}
  if (realDir) {
    const p = _paths(realDir);
    if (fs.existsSync(p.shadow)) return { p, realDir };
  }
  const want = path.resolve(dir);
  let names = [];
  try { names = fs.readdirSync(_undoRoot()); } catch (e) { return null; }
  for (const n of names) {
    const p = { base: path.join(_undoRoot(), n) };
    p.shadow = path.join(p.base, 'repo.git');
    p.meta = path.join(p.base, 'meta.json');
    const meta = _readMeta(p);
    if (meta && meta.ground === want && fs.existsSync(p.shadow)) {
      return { p, realDir: want };
    }
  }
  return null;
}

function list(dir, n) {
  try {
    const found = _resolveShadow(dir);
    if (!found) return [];
    const r = _git(found.p.shadow, null,
      ['log', 'refs/heads/undo', '-n', String(n || 15), '--format=%h\x1f%ct\x1f%s']);
    if (!r.ok) return [];
    return r.out.split('\n').filter(Boolean).map(function (line) {
      const f = line.split('\x1f');
      return { id: f[0], ts: parseInt(f[1], 10) || 0, label: f[2] || '' };
    });
  } catch (e) { return []; }
}

// Restore the ground to a photograph. ref: 1-based index from the latest,
// or a commit id. The present is photographed first — the undo is itself
// undoable — then the tree is made to match: tracked files restored, files
// born after the photograph removed, ignored trees untouched.
function restore(dir, ref) {
  try {
    if (!gitOk()) return _degrade('git-unavailable');
    const found = _resolveShadow(dir);
    if (!found) return { ok: false, error: 'no-photographs-of-this-ground' };
    const p = found.p, realDir = found.realDir;
    if (!fs.existsSync(realDir)) fs.mkdirSync(realDir, { recursive: true });

    let target;
    if (/^\d+$/.test(String(ref || 1))) {
      const idx = Math.max(1, parseInt(ref || 1, 10));
      const r = _git(p.shadow, null,
        ['log', 'refs/heads/undo', '--format=%H', '--skip=' + (idx - 1), '-1']);
      target = r.ok ? r.out.trim() : '';
    } else {
      const r = _git(p.shadow, null, ['rev-parse', '--verify', '-q', String(ref) + '^{commit}']);
      target = r.ok ? r.out.trim() : '';
    }
    if (!target) return { ok: false, error: 'photograph-not-found' };

    const pre = snapshot(realDir, 'pre-restore', { allowShallow: true });
    if (!pre.ok) {
      return { ok: false, error: 'safety-photo-failed: ' + (pre.skipped || pre.degraded || 'unknown') };
    }

    const diff = _git(p.shadow, realDir, ['diff', '--name-only', target, 'HEAD'],
                      { timeout: STATUS_TIMEOUT_MS });
    const filesChanged = diff.ok ? diff.out.split('\n').filter(Boolean).length : -1;

    const rt = _git(p.shadow, realDir, ['read-tree', '-u', '--reset', target],
                    { timeout: ADD_TIMEOUT_MS });
    if (!rt.ok) {
      _recordDegradation(p, { reason: 'restore-failed' });
      return { ok: false, error: 'restore-failed: ' + (rt.err || '').slice(0, 200) };
    }
    const shortT = target.slice(0, 7);
    _git(p.shadow, realDir, ['commit', '-q', '--allow-empty', '-m', 'restore:' + shortT]);
    stats.restored++;
    const meta = _readMeta(p) || {};
    const overBudget = (meta.overBudget || []).length;
    return { ok: true, restored: shortT, safety: pre.id || 'unchanged',
             filesChanged: filesChanged, overBudget: overBudget };
  } catch (e) {
    return { ok: false, error: 'restore-error: ' + (e && e.message || '').slice(0, 200) };
  }
}

// Retention: photographs older than RETAIN_DAYS fall away (always keeping
// KEEP_MIN), the chain is rebuilt with original dates, and the store is
// repacked. Failures degrade loudly and harm nothing.
function _maintain(p, realDir) {
  try {
    const r = _git(p.shadow, null, ['log', 'refs/heads/undo', '--format=%H\x1f%T\x1f%ct\x1f%s']);
    if (!r.ok) return;
    const rows = r.out.split('\n').filter(Boolean).map(function (l) {
      const f = l.split('\x1f');
      return { h: f[0], t: f[1], ct: parseInt(f[2], 10) || 0, s: f[3] || 'photo' };
    });
    const cutoff = Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86400;
    let keep = rows.filter(function (x) { return x.ct >= cutoff; });
    if (keep.length < KEEP_MIN) keep = rows.slice(0, KEEP_MIN);
    if (keep.length >= rows.length) {
      _git(p.shadow, null, ['gc', '--prune=now', '--quiet'], { timeout: MAINT_TIMEOUT_MS });
      return;
    }
    keep.reverse(); // oldest first
    let parent = null;
    for (const row of keep) {
      const args = ['commit-tree', row.t, '-m', row.s];
      if (parent) { args.push('-p'); args.push(parent); }
      const c = execFileSync('git', ['--git-dir', p.shadow].concat(args), {
        env: Object.assign(_env(), {
          GIT_AUTHOR_DATE: row.ct + ' +0000', GIT_COMMITTER_DATE: row.ct + ' +0000'
        }),
        stdio: 'pipe', timeout: COMMIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER
      }).toString().trim();
      parent = c;
    }
    if (parent) {
      _git(p.shadow, null, ['update-ref', 'refs/heads/undo', parent]);
      _git(p.shadow, null, ['reflog', 'expire', '--expire=now', '--all'], { timeout: MAINT_TIMEOUT_MS });
      _git(p.shadow, null, ['gc', '--prune=now', '--quiet'], { timeout: MAINT_TIMEOUT_MS });
    }
  } catch (e) {
    _degrade('maintenance', (e && e.message || '').slice(0, 200));
  }
}

function getStats() {
  return {
    photographed: stats.photographed,
    unchanged: stats.unchanged,
    restored: stats.restored,
    skipped: stats.skipped,
    degraded: stats.degraded,
    lastDegradation: stats.lastDegradation,
    // Legacy keys — the stats surface predates the shadow store.
    checkpointed: stats.photographed,
    rollbacks: stats.restored
  };
}

module.exports = {
  snapshot: snapshot, snapshotForFile: snapshotForFile, restore: restore,
  list: list, getStats: getStats,
  SPAWN_PURPOSE: SPAWN_PURPOSE,
  _internals: { _guard: _guard, _keyFor: _keyFor, _paths: _paths, _trothDir: _trothDir,
                _maintain: _maintain,
                SIZE_CAP_BYTES: SIZE_CAP_BYTES, DEFAULT_EXCLUDES: DEFAULT_EXCLUDES }
};
