#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The doctor reads the plugin the Claude Code sessions really load: the
// cache copy with its version and whether shared-core is reachable from it,
// or this checkout itself.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const seat = require(path.join(__dirname, '..', 'bin', 'cmd-doctor-seat.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== doctor from the operator\'s seat ===\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-doctor-'));
const HOME = path.join(TMP, 'home');
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(path.join(HOME, '.claude', 'plugins'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'plugin', '.claude-plugin'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'shared-core'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'shared-core', 'state.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'troth', version: '0.1.19' }));
const CACHE = path.join(HOME, '.claude', 'plugins', 'cache', 'troth', 'troth');
fs.mkdirSync(path.join(CACHE, '0.1.17'), { recursive: true });
function installed(entry) { fs.writeFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'troth@troth': [entry] } })); }

t('a stale cache copy that cannot reach shared-core is named with the fix', () => {
  installed({ installPath: path.join(CACHE, '0.1.17'), version: '0.1.17' });
  const r = seat.pluginCheck({ HOME, repoRoot: REPO });
  assert.strictEqual(r.ok, false);
  assert.ok(/cannot reach shared-core/.test(r.detail) && /troth install-plugin/.test(r.detail), r.detail);
});

t('a wired cache copy behind the checkout names the update', () => {
  fs.symlinkSync(path.join(REPO, 'shared-core'), path.join(CACHE, 'shared-core'), 'dir');
  installed({ installPath: path.join(CACHE, '0.1.17'), version: '0.1.17' });
  const r = seat.pluginCheck({ HOME, repoRoot: REPO });
  assert.strictEqual(r.ok, false);
  assert.ok(/0\.1\.17/.test(r.detail) && /0\.1\.19/.test(r.detail) && /claude plugin update/.test(r.detail), r.detail);
});

t('a wired cache copy at the checkout version is fine', () => {
  fs.mkdirSync(path.join(CACHE, '0.1.19'), { recursive: true });
  installed({ installPath: path.join(CACHE, '0.1.19'), version: '0.1.19' });
  const r = seat.pluginCheck({ HOME, repoRoot: REPO });
  assert.strictEqual(r.ok, true, r.detail);
});

t('the checkout itself as the install is fine', () => {
  installed({ installPath: path.join(REPO, 'plugin'), version: '0.1.19' });
  const r = seat.pluginCheck({ HOME, repoRoot: REPO });
  assert.strictEqual(r.ok, true, r.detail);
  assert.ok(/this checkout/.test(r.detail));
});

t('no install at all says so', () => {
  fs.writeFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
  const r = seat.pluginCheck({ HOME, repoRoot: REPO });
  assert.strictEqual(r.ok, false);
  assert.ok(/not installed/.test(r.detail));
});

t('the continuity check reads the live router', () => {
  const r = seat.continuityCheck({ repoRoot: path.join(__dirname, '..') });
  assert.strictEqual(r.ok, true, r.detail);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\ndoctor-seat: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
