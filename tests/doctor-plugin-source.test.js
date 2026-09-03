#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The doctor tells the truth about where the Claude Code plugin runs from:
// a directory marketplace pointing at this checkout runs these hooks, and
// the cache registry's version is not the version in use.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const assert = require('assert');
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-doctor-plugin-'));
fs.mkdirSync(path.join(TMP, '.troth'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.claude', 'plugins'), { recursive: true });
process.env.HOME = TMP;
process.env.CLAUDE_PLUGIN_DATA = path.join(TMP, '.troth');
process.env.STATE_DB_PATH = path.join(TMP, '.troth', 'state.db');
process.env._TROTH_TEST_HOME = TMP;
process.env.TROTH_NO_MODEL_FETCH = '1';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
function doctor() {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'troth.js'), 'doctor'], { env: process.env, encoding: 'utf8', timeout: 90000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return out.split('\n').find((l) => /Plugin in Claude Code/.test(l)) || '';
}

console.log('\n=== doctor: where the plugin runs from ===\n');
fs.writeFileSync(path.join(TMP, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'troth@troth': [{ scope: 'user', installPath: '/nowhere/cache/0.1.17', version: '0.1.17' }] } }));

t('a cache registry alone reports the version behind the core', () => {
  fs.writeFileSync(path.join(TMP, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'troth@troth': true } }));
  const line = doctor();
  assert.ok(/v0\.1\.17 while the core is v/.test(line), line);
});

t('a directory marketplace pointing at this checkout runs from here', () => {
  fs.writeFileSync(path.join(TMP, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'troth@troth': true }, extraKnownMarketplaces: { troth: { source: { source: 'directory', path: REPO } } } }));
  const line = doctor();
  assert.ok(/runs from this checkout/.test(line), line);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\ndoctor-plugin-source: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
