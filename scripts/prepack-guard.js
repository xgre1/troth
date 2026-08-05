#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Refuses `npm pack` / `npm publish` when the package would contain a file the
// open repository does not.
//
// Why this exists: `npm pack` reads the WORKING TREE, not git. On a machine
// that holds anything the repository does not, the package picks it up
// silently and ships it to a public registry. The app bundle is staged with
// `git archive` and so cannot make that mistake; the npm path had no
// equivalent, and a publish is not reversible.
//
// It asks npm what it would pack, rather than asking git what is untracked.
// The first version of this guard asked git, and reported the tree clean: the
// overlay is listed in .git/info/exclude, which git honours and npm does not,
// so every one of those files was still going into the tarball behind a green
// check. A guard that answers the wrong question is worse than no guard.
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHIPPED = /^(bin|shared-core|proxy|adapters|scripts|plugin|tests|benchmarks|docs)\//;

let tracked, packed;
try {
  tracked = new Set(execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));
} catch (_) {
  // Not a git checkout: an unpacked tarball being repacked, or a CI export.
  // Nothing to compare against.
  process.exit(0);
}
try {
  // --ignore-scripts so this hook does not re-enter itself.
  packed = execSync('npm pack --dry-run --ignore-scripts 2>&1', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.replace(/^npm notice\s+/, '').replace(/^[0-9.]+\s?[kMG]?B\s+/, '').trim())
    .filter((f) => SHIPPED.test(f));
} catch (e) {
  console.error('prepack: could not determine package contents: ' + (e && e.message || e));
  process.exit(1);
}

const extra = packed.filter((f) => !tracked.has(f));

if (process.env.TROTH_ALLOW_DIRTY_PACK === '1') {
  if (extra.length) {
    console.error('prepack: TROTH_ALLOW_DIRTY_PACK=1 — packing anyway with ' + extra.length +
      ' file(s) that are not in the open repository. This is how closed source ships by accident.');
  }
  process.exit(0);
}
if (!extra.length) process.exit(0);

console.error('');
console.error('prepack: REFUSING to pack. ' + extra.length +
  ' file(s) would be published that are NOT in the open repository:');
for (const f of extra.slice(0, 10)) console.error('  ' + f);
if (extra.length > 10) console.error('  ... and ' + (extra.length - 10) + ' more');
console.error('');
console.error('npm reads the working tree, and .git/info/exclude does not stop it.');
console.error('Publish from a clean clone:');
console.error('  git clone <repo> /tmp/troth-publish && cd /tmp/troth-publish && npm publish');
console.error('');
process.exit(1);
