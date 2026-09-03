#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The shell wall refuses an order and lets a file body through: the words of
// an order inside a here-document are data on their way into a file, while
// the same words as a command, before or after the document, stay refused,
// and a credential inside the document is still refused.
const assert = require('assert');
const path = require('path');
const bs = require(path.join(__dirname, '..', 'shared-core', 'tools', 'bash-safety.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== the wall and here-document bodies ===\n');

const POWER = ['shut', 'down'].join('');
const RESTART = ['re', 'boot'].join('');
const body = "cat > provider.py <<'EOF'\nclass P:\n    def " + POWER + "(self):\n        return None\nEOF\n";

t('a method named like a power order inside a file body is allowed', () => {
  const r = bs.isCommandSafe(body, {});
  assert.strictEqual(r.allowed, true, JSON.stringify(r));
});

t('the bare order is refused', () => {
  assert.strictEqual(bs.isCommandSafe(POWER + ' -h now', {}).allowed, false);
  assert.strictEqual(bs.isCommandSafe('sudo ' + RESTART, {}).allowed, false);
});

t('the order after the document terminator is still an order', () => {
  const r = bs.isCommandSafe(body + POWER + ' -h now\n', {});
  assert.strictEqual(r.allowed, false, JSON.stringify(r));
  assert.strictEqual(r.pattern, POWER + '_or_' + RESTART);
});

t('a tab-indented terminator closes a <<- document', () => {
  const doc = "cat <<-EOF\n\t" + POWER + " now\n\tEOF\necho done\n";
  assert.strictEqual(bs.isCommandSafe(doc, {}).allowed, true);
});

t('a credential inside the document is still refused', () => {
  const key = ['sk', '-', 'ant', '-', 'api03', '-'].join('') + 'A'.repeat(40);
  const doc = "cat > .env <<'EOF'\nKEY=" + key + "\nEOF\n";
  assert.strictEqual(bs.isCommandSafe(doc, {}).allowed, false);
});

t('the body stripper keeps the command lines and the terminator', () => {
  const s = bs._withoutHeredocBodies("a <<X\nsecret\nX\nb");
  assert.strictEqual(s, "a <<X\nX\nb");
});

console.log('\nheredoc-body: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
