#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Runs the standalone *.test.js files — the ones that are not registered in
// tests/test-all.js and each own their own setup.
//
// They exist, they are tracked, and until this runner they were reachable only
// by typing `node tests/<name>.test.js` by hand. Run that way most of them
// FAILED, and the reason was the same in every case: each file's header says it
// is hermetic via tests/hermetic-db.js, but none of them requires it. Run bare
// they opened the operator's real ~/.troth/state.db, counted rows left by
// earlier runs, and tried to verify a signed-audit chain against a key they did
// not have. The product was right every time; the invocation was wrong.
//
// So the invocation lives here instead of in a comment: every file is spawned
// with -r ./tests/hermetic-db.js, which pins a throwaway HOME and database
// before any module loads.
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'hermetic-db.js');

function discover() {
  let tracked = [];
  try {
    tracked = execSync("git ls-files 'tests/*.test.js' 'tests/**/*.test.js' 'tools/*.test.js'",
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (_) {
    // No git answer. Two very different reasons, and only one is safe to
    // guess at.
    //
    // If there is no .git at all (an npm install, a `git archive` export),
    // every .test.js on disk came from the published tree, so walking it is
    // exactly equivalent to the query. That case would walk tests/ only and
    // therefore found three fewer files than a clone of the same commit, so
    // the published count depended on how you obtained the source; the walk
    // now covers tools/ as well.
    //
    // If .git EXISTS and git still failed, a walk is not equivalent and must
    // not be substituted: an untracked file is invisible to the query and
    // visible to the walk, and on a machine that also holds the closed
    // overlay that difference is fourteen closed test files this runner would
    // try to execute.
    // Refuse instead of guessing.
    if (fs.existsSync(path.join(ROOT, '.git'))) {
      console.error('run-standalone: this is a git checkout but `git ls-files` failed.');
      console.error('Refusing to fall back to a directory walk: it would include untracked');
      console.error('files that are not part of this repository. Fix git, then rerun.');
      process.exit(2);
    }
    const walk = (d, acc) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return acc; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (e.name.endsWith('.test.js')) acc.push(path.relative(ROOT, p));
      }
      return acc;
    };
    tracked = [];
    for (const dir of ['tests', 'tools']) walk(path.join(ROOT, dir), tracked);
  }
  // Anything test-all.js already registers belongs to that runner, not this one.
  let registered = '';
  try { registered = fs.readFileSync(path.join(__dirname, 'test-all.js'), 'utf8'); } catch (_) {}
  return tracked.filter((f) => !registered.includes(path.basename(f)));
}

// One file needs a running Docker daemon for the hypervisor seam. Absent
// daemon is an environment fact, not a defect, and it is reported as a skip
// rather than quietly counted as a pass.
function dockerUp() {
  try { execSync('docker info', { stdio: 'ignore', timeout: 5000 }); return true; }
  catch (_) { return false; }
}

const files = discover().sort();
const needsDocker = new Set(['tests/host/host-seam.test.js']);
const haveDocker = dockerUp();

let pass = 0, fail = 0, skip = 0;
const failed = [];
for (const f of files) {
  if (needsDocker.has(f) && !haveDocker) {
    console.log('  ○ SKIP ' + f + ' (needs a running Docker daemon)');
    skip++;
    continue;
  }
  const r = spawnSync(process.execPath, ['-r', PRELOAD, path.join(ROOT, f)],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) { console.log('  ✓ ' + f); pass++; }
  else {
    console.log('  ✗ ' + f);
    const tail = String(r.stdout || '').split('\n').filter((l) => l.includes('✗')).slice(0, 3);
    for (const l of tail) console.log('      ' + l.trim().slice(0, 160));
    if (!tail.length && r.stderr) console.log('      ' + String(r.stderr).split('\n')[0].slice(0, 160));
    fail++; failed.push(f);
  }
}

console.log('');
console.log('=== standalone: ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped ===');
if (failed.length) { for (const f of failed) console.log('  failed: ' + f); }
process.exit(fail ? 1 : 0);
