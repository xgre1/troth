#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The passphrase read: a line ends at Enter in either form, Backspace
// removes the last character, Ctrl-C is an interruption and not a
// character, the environment variable short-circuits the prompt.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tp = require(path.join(__dirname, '..', 'shared-core', 'tty-passphrase.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-pass-'));
function fdWith(bytes) { const p = path.join(TMP, 'in-' + Math.random().toString(36).slice(2)); fs.writeFileSync(p, Buffer.from(bytes)); return fs.openSync(p, 'r'); }

console.log('\n=== passphrase read ===\n');

t('a line ends at newline, and at carriage return in raw mode', () => {
  assert.strictEqual(tp.readLineSync(fdWith('hunter2\nrest')), 'hunter2');
  assert.strictEqual(tp.readLineSync(fdWith('hunter2\rrest')), 'hunter2');
});

t('backspace removes the last character', () => {
  assert.strictEqual(tp.readLineSync(fdWith('abc\x7fd\n')), 'abd');
  assert.strictEqual(tp.readLineSync(fdWith('ab\x08\x08xy\n')), 'xy');
});

t('Ctrl-C interrupts instead of becoming a character', () => {
  assert.throws(() => tp.readLineSync(fdWith('ab\x03cd\n')), (e) => e.code === 'INTERRUPTED');
});

t('end of input on an empty line reads as empty, and a utf-8 passphrase survives', () => {
  assert.strictEqual(tp.readLineSync(fdWith('\x04')), '');
  assert.strictEqual(tp.readLineSync(fdWith('pässwörd ünïcode\n')), 'pässwörd ünïcode');
});

t('the environment variable answers without touching a terminal', () => {
  process.env[tp.ENV] = 'from-env';
  try { assert.strictEqual(tp.readPassphraseSync('Operator passphrase'), 'from-env'); }
  finally { delete process.env[tp.ENV]; }
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\npassphrase-read: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
