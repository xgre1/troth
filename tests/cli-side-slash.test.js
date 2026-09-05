#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The chat answers a deterministic slash typed during a turn beside the
// running work. Which slashes count as deterministic is the executor's
// knowledge; the chat keeps a copy, and this pins the two to each other.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== the chat\'s deterministic-slash set ===\n');

t('the chat names exactly the slashes the executor answers on its own', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'troth-chat.js'), 'utf8');
  const m = /const SLASH_DET = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, 'the set is declared');
  const mine = m[1].match(/'([a-z-]+)'/g).map((s) => s.replace(/'/g, '')).sort();
  const theirs = Object.keys(require(path.join(REPO, 'shared-core', 'slash', 'executor.js')).DETERMINISTIC_HANDLERS).sort();
  assert.deepStrictEqual(mine, theirs);
});

t('/mcps is one of them, so it is answered without waiting behind a turn', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'troth-chat.js'), 'utf8');
  assert.ok(/\/\^\\\/mcps\(\\s\|\$\)\/\.test\(line\)/.test(src), 'the chat answers /mcps itself');
});

console.log('\ncli-side-slash: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
