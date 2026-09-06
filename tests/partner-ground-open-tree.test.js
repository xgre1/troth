#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The partner-ground choice is read from ~/.troth/config.json by the shell
// wall itself, so a tree that ships without the closed configuration
// reader still honours `confine`; the default without a file is `open`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const cfgPath = path.join(process.env.HOME, '.troth', 'config.json');
const write = (obj) => { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.writeFileSync(cfgPath, JSON.stringify(obj)); };

(async () => {
  console.log('partner-ground-open-tree');
  const jail = await import('../plugin/mcp-servers/troth-bash/workspace-jail.mjs');
  await t('the wall exports both roads to the partner-ground choice', () => {
    assert.strictEqual(typeof jail.partnerGroundMode, 'function');
    assert.strictEqual(typeof jail.partnerGroundFromConfigFile, 'function');
  });
  await t('no config file: open', () => {
    try { fs.unlinkSync(cfgPath); } catch (_) {}
    assert.strictEqual(jail.partnerGroundFromConfigFile(), 'open');
    assert.strictEqual(jail.partnerGroundMode(), 'open');
  });
  await t('confine in the file: confine, through the file road and through the wall', () => {
    write({ l4: { sandbox: { partner_ground: 'confine' } } });
    assert.strictEqual(jail.partnerGroundFromConfigFile(), 'confine');
    assert.strictEqual(jail.partnerGroundMode(), 'confine');
  });
  await t('anything else in the file: open', () => {
    write({ l4: { sandbox: { partner_ground: 'wide open' } } });
    assert.strictEqual(jail.partnerGroundFromConfigFile(), 'open');
    write({ l4: {} });
    assert.strictEqual(jail.partnerGroundFromConfigFile(), 'open');
    fs.writeFileSync(cfgPath, '{not json');
    assert.strictEqual(jail.partnerGroundFromConfigFile(), 'open');
  });
  console.log('\npartner-ground-open-tree: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
