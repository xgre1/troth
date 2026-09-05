#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The host's plugin follows the checkout: the versions are read from the
// manifests and the host's install record, an installed plugin behind the
// shipped one is updated through the host's own command, an equal one is
// left alone, and a host without the plugin is reported, never installed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pu = require(path.join(__dirname, '..', 'proxy', 'modules', 'plugin-update.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-plugup-'));
const REPO = path.join(TMP, 'repo'), HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(REPO, 'plugin', '.claude-plugin'), { recursive: true });
fs.mkdirSync(path.join(REPO, '.claude-plugin'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'plugins'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'troth', version: '0.2.5' }));
fs.writeFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'troth', plugins: [{ name: 'troth', source: './plugin' }] }));
const INSTALLED = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
function installed(v) { fs.writeFileSync(INSTALLED, JSON.stringify({ version: 2, plugins: { 'troth@troth': [{ scope: 'user', version: v, installPath: path.join(HOME, '.claude', 'plugins', 'cache', 'troth', 'troth', v) }] } })); }
// A stand-in for the host's command line: records its argv and writes the
// install record the host would write.
const FAKE = path.join(TMP, 'claude');
fs.writeFileSync(FAKE, '#!/bin/sh\necho "$@" > "' + path.join(TMP, 'argv') + '"\ncat > "' + INSTALLED + '" <<EOT\n{"version":2,"plugins":{"troth@troth":[{"scope":"user","version":"0.2.5","installPath":"x"}]}}\nEOT\necho updated\n');
fs.chmodSync(FAKE, 0o755);

console.log('\n=== the host plugin follows the checkout ===\n');
(async () => {
  await t('the versions come from the manifests and the install record', async () => {
    installed('0.2.4');
    const v = pu.versions({ repo: REPO, home: HOME });
    assert.deepStrictEqual({ name: v.name, marketplace: v.marketplace, shipped: v.shipped, installed: v.installed }, { name: 'troth', marketplace: 'troth', shipped: '0.2.5', installed: '0.2.4' });
    assert.ok(pu._cmp('0.2.5', '0.2.4') > 0 && pu._cmp('0.1.9', '0.1.17') < 0 && pu._cmp('1.0.0', '1.0.0') === 0);
  });
  await t('a host behind the tree is updated through its own command', async () => {
    installed('0.2.4');
    const r = await pu.checkAndUpdate({ repo: REPO, home: HOME, command: FAKE });
    assert.strictEqual(r.action, 'updated', JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(TMP, 'argv'), 'utf8').trim(), 'plugin update troth@troth');
    assert.strictEqual(r.installed, '0.2.5');
  });
  await t('a host at the shipped version is left alone', async () => {
    installed('0.2.5');
    fs.rmSync(path.join(TMP, 'argv'), { force: true });
    const r = await pu.checkAndUpdate({ repo: REPO, home: HOME, command: FAKE });
    assert.strictEqual(r.action, 'current');
    assert.ok(!fs.existsSync(path.join(TMP, 'argv')), 'the command never ran');
  });
  await t('a host without the plugin is reported and never installed', async () => {
    fs.rmSync(INSTALLED, { force: true });
    const r = await pu.checkAndUpdate({ repo: REPO, home: HOME, command: FAKE });
    assert.strictEqual(r.action, 'not_installed');
    assert.ok(!fs.existsSync(path.join(TMP, 'argv')), 'the command never ran');
  });
  await t('a failing command is reported with its last line', async () => {
    installed('0.2.4');
    const BAD = path.join(TMP, 'claude-bad');
    fs.writeFileSync(BAD, '#!/bin/sh\necho "no marketplace" >&2\nexit 1\n'); fs.chmodSync(BAD, 0o755);
    const r = await pu.checkAndUpdate({ repo: REPO, home: HOME, command: BAD });
    assert.strictEqual(r.action, 'failed');
    assert.ok(/no marketplace/.test(r.output), r.output);
  });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\nplugin-update: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
