#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The undo net holds only if a photograph exists before every action and a
// restore reproduces the photographed state EXACTLY — including files that
// were deleted, files born after the photograph, and the operator's own
// repository being left byte-for-byte alone. The stash-based mechanism this
// module replaced failed all four; each failure is pinned here so it cannot
// return.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-undo-test-'));
process.env.TROTH_CONFIG_DIR = path.join(tmpRoot, 'troth-config');
fs.mkdirSync(process.env.TROTH_CONFIG_DIR, { recursive: true });

const undo = require('../shared-core/tools/undo-shadow.js');

function w(p, c) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
function rd(p) { return fs.readFileSync(p, 'utf8'); }
let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ok ' + name); }

try {
  // ── 1. Non-git ground (the Desktop case): exact restore, both directions ──
  const g1 = path.join(tmpRoot, 'ground-plain');
  w(path.join(g1, 'a.txt'), 'A1');
  w(path.join(g1, 'sub', 'b.txt'), 'B1');
  w(path.join(g1, 'c.txt'), 'C1');
  const s1 = undo.snapshot(g1, 'first');
  ok('photograph works on ground with no repository', s1.ok && !!s1.id);

  w(path.join(g1, 'a.txt'), 'A2');
  fs.unlinkSync(path.join(g1, 'c.txt'));
  w(path.join(g1, 'new.txt'), 'N1');
  const s2 = undo.snapshot(g1, 'second');
  ok('changed ground yields a new photograph', s2.ok && !s2.unchanged);

  const r1 = undo.restore(g1, 2); // 1 = 'second', 2 = 'first'
  ok('restore reports ok', r1.ok);
  ok('edited file back to photographed content', rd(path.join(g1, 'a.txt')) === 'A1');
  ok('deleted file returned', rd(path.join(g1, 'c.txt')) === 'C1');
  ok('file born after the photograph removed', !fs.existsSync(path.join(g1, 'new.txt')));
  ok('untouched file intact', rd(path.join(g1, 'sub', 'b.txt')) === 'B1');

  // The state before the restore is itself held — undo the undo.
  // History now: restore-marker(1), second(2), first(3).
  const r2 = undo.restore(g1, 2);
  ok('undo of the undo reports ok', r2.ok);
  ok('post-mistake state fully back', rd(path.join(g1, 'a.txt')) === 'A2'
     && fs.existsSync(path.join(g1, 'new.txt')) && !fs.existsSync(path.join(g1, 'c.txt')));

  // ── 2. The operator's own repository is never touched ──
  const g2 = path.join(tmpRoot, 'ground-repo');
  w(path.join(g2, 'f.txt'), 'F1');
  const gitCfg = ['-c', 'user.email=t@t.local', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  execFileSync('git', ['-C', g2, 'init', '-q']);
  execFileSync('git', ['-C', g2, 'add', '-A']);
  execFileSync('git', gitCfg.concat(['-C', g2, 'commit', '-q', '-m', 'base']));
  const headBefore = execFileSync('git', ['-C', g2, 'rev-parse', 'HEAD']).toString();
  w(path.join(g2, 'f.txt'), 'F2'); // operator's own uncommitted work
  const s3 = undo.snapshot(g2, 'repo-ground');
  ok('photograph works on git ground', s3.ok);
  ok('operator HEAD untouched',
     execFileSync('git', ['-C', g2, 'rev-parse', 'HEAD']).toString() === headBefore);
  ok('operator stash list still empty',
     execFileSync('git', ['-C', g2, 'stash', 'list']).toString().trim() === '');
  ok('operator uncommitted work still uncommitted',
     execFileSync('git', ['-C', g2, 'status', '--porcelain']).toString().indexOf('f.txt') >= 0);
  const shadow2 = undo._internals._paths(fs.realpathSync(g2)).shadow;
  const shadowFiles = execFileSync('git', ['--git-dir', shadow2, 'ls-files']).toString().split('\n');
  ok('operator .git never photographed',
     shadowFiles.every(function (f) { return f.indexOf('.git/') !== 0; }));

  // ── 3. Regenerable trees: not photographed, not touched by restore ──
  w(path.join(g2, 'node_modules', 'x', 'i.js'), 'NM');
  const s4 = undo.snapshot(g2, 'with-node-modules');
  ok('regenerable tree does not force a new photograph', s4.ok && s4.unchanged === true);
  const r3 = undo.restore(g2, 1);
  ok('restore on repo ground ok', r3.ok);
  ok('regenerable tree untouched by restore', fs.existsSync(path.join(g2, 'node_modules', 'x', 'i.js')));
  ok('operator repository still intact after restore',
     execFileSync('git', ['-C', g2, 'rev-parse', 'HEAD']).toString() === headBefore);

  // ── 4. .env is photographed even when the ground's .gitignore hides it ──
  const g3 = path.join(tmpRoot, 'ground-env');
  w(path.join(g3, '.gitignore'), '.env\n');
  w(path.join(g3, '.env'), 'SECRET=1');
  undo.snapshot(g3, 'env-held');
  fs.unlinkSync(path.join(g3, '.env'));
  const sEnvGone = undo.snapshot(g3, 'env-gone');
  ok('.env deletion is itself photographed', sEnvGone.ok && !sEnvGone.unchanged);
  undo.restore(g3, 2);
  ok('.env recovered despite gitignore', rd(path.join(g3, '.env')) === 'SECRET=1');

  // ── 5. Grounds the net declines, counted never silent ──
  const gHome = undo.snapshot(os.homedir(), 'x');
  ok('home root declined', gHome.skipped === 'ground-too-broad');
  const gSub = undo.snapshot(process.env.TROTH_CONFIG_DIR, 'x');
  ok('substrate tree declined', gSub.skipped === 'substrate-ground');
  const ws = path.join(process.env.TROTH_CONFIG_DIR, 'workspace', 'proj');
  w(path.join(ws, 'p.txt'), 'P');
  ok('workspace project ground welcomed', undo.snapshot(ws, 'ws').ok);

  // ── 6. Deleted ground is rebuilt whole ──
  const g4 = path.join(tmpRoot, 'ground-del');
  w(path.join(g4, 'keep.txt'), 'K');
  w(path.join(g4, 'sub', 'deep.txt'), 'D');
  ok('photo before the mistake', undo.snapshot(g4, 'before-del').ok);
  fs.rmSync(g4, { recursive: true, force: true });
  const r4 = undo.restore(g4, 1);
  ok('deleted ground rebuilt', r4.ok && rd(path.join(g4, 'keep.txt')) === 'K'
     && rd(path.join(g4, 'sub', 'deep.txt')) === 'D');

  // ── 7. File-road photos land on the enclosing repository ground ──
  w(path.join(g2, 'sub', 'deep.txt'), 'DD');
  const sf = undo.snapshotForFile(path.join(g2, 'sub', 'deep.txt'), 'file-road');
  ok('file photo accepted', sf.ok);
  ok('file photo landed on the repo-root shadow', undo.list(g2, 1)[0].label === 'file-road');

  // ── 8. Stats keep the legacy surface alive ──
  const st = undo.getStats();
  ok('stats present with legacy keys',
     typeof st.photographed === 'number' && typeof st.checkpointed === 'number'
     && typeof st.rollbacks === 'number' && st.checkpointed === st.photographed);

  // ── 9. Retention: photographs past the window fall away, at least KEEP_MIN
  // survive, and the dropped photographs release their disk — a prune that
  // rewrote refs without collecting objects would keep every byte. ──
  const g9 = path.join(tmpRoot, 'ground-retain');
  const f9 = path.join(g9, 'f.txt');
  for (let i = 0; i < 6; i++) { w(f9, 'old-content-' + i); undo.snapshot(g9, 'old-' + i); }
  const p9 = undo._internals._paths(fs.realpathSync(g9));
  const env9 = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
  });
  const g9git = (args, extra) => execFileSync('git', ['--git-dir', p9.shadow].concat(args),
    { env: Object.assign({}, env9, extra || {}), stdio: 'pipe' }).toString().trim();
  // Re-date the whole chain 30 days back, preserving trees and order.
  const rows9 = g9git(['log', 'refs/heads/undo', '--format=%H\x1f%T\x1f%s']).split('\n').filter(Boolean)
    .map((l) => { const f = l.split('\x1f'); return { t: f[1], s: f[2] }; }).reverse();
  const oldTs = (Math.floor(Date.now() / 1000) - 30 * 86400) + ' +0000';
  let parent9 = null;
  for (const row of rows9) {
    const a = ['commit-tree', row.t, '-m', row.s];
    if (parent9) { a.push('-p'); a.push(parent9); }
    parent9 = g9git(a, { GIT_AUTHOR_DATE: oldTs, GIT_COMMITTER_DATE: oldTs });
  }
  g9git(['update-ref', 'refs/heads/undo', parent9]);
  const oldBlob = g9git(['rev-parse', 'refs/heads/undo~5:f.txt']);
  w(f9, 'fresh-1'); undo.snapshot(g9, 'fresh-1');
  w(f9, 'fresh-2'); undo.snapshot(g9, 'fresh-2');
  const before9 = parseInt(g9git(['rev-list', '--count', 'refs/heads/undo']), 10);
  undo._internals._maintain(p9, fs.realpathSync(g9));
  const after9 = parseInt(g9git(['rev-list', '--count', 'refs/heads/undo']), 10);
  ok('retention drops photographs past the window down to the keep floor',
     before9 === 8 && after9 === 5);
  ok('the newest photograph survives maintenance intact', undo.list(g9, 1)[0].label === 'fresh-2');
  let oldGone9 = false;
  try { g9git(['cat-file', '-e', oldBlob]); } catch (_) { oldGone9 = true; }
  ok('pruned photographs release their disk: the dropped content object is gone', oldGone9);

  console.log('\nundo-shadow: ' + passed + ' assertions passed');
} catch (e) {
  console.error('\nundo-shadow FAILED: ' + (e && e.message));
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
}
