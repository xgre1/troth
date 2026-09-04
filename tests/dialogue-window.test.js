#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The recent-dialogue block the engine receives: the latest exchange is
// never cut away, older exchanges fill what budget remains newest-first,
// and a reply that alone outgrows the budget keeps its opening and its end.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const dm = require(path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== recent dialogue window ===\n');

const turn = (u, a) => ({ user_text: u, assistant_text: a });

t('the latest exchange survives whole when older ones are elided', () => {
  const turns = [turn('first question', 'first answer ' + 'x'.repeat(900)), turn('second question', 'second answer ' + 'y'.repeat(900)), turn('what happens with the old address', 'First we check that it resolves. ' + 'z'.repeat(1500))];
  const out = dm.renderTranscript(turns, { max_chars: 2000 });
  assert.ok(out.includes('user: what happens with the old address'), 'the last question is whole');
  assert.ok(out.includes('First we check that it resolves.'), 'the last answer opens whole');
  assert.ok(!out.includes('first question'), 'the oldest exchange left');
  assert.ok(out.includes('earlier turns elided'), 'the elision is named');
  assert.ok(out.length <= 2200, 'the block stays near the budget: ' + out.length);
});

t('a reply that alone outgrows the budget keeps its opening and its end', () => {
  const long = 'OPENING sentence of the answer. ' + 'middle '.repeat(600) + ' FINAL sentence with the conclusion.';
  const out = dm.renderTranscript([turn('ok psaxe', long)], { max_chars: 1200 });
  assert.ok(out.includes('user: ok psaxe'), 'the question stays');
  assert.ok(out.includes('OPENING sentence'), 'the opening stays');
  assert.ok(out.includes('FINAL sentence with the conclusion.'), 'the end stays');
  assert.ok(/elided/.test(out), 'the cut is named');
  assert.ok(out.length <= 1400, 'near the budget: ' + out.length);
});

t('older exchanges fill the remaining budget newest first', () => {
  const turns = [];
  for (let i = 1; i <= 12; i++) turns.push(turn('q' + i, 'a' + i + ' ' + 'w'.repeat(150)));
  const out = dm.renderTranscript(turns, { max_chars: 900 });
  assert.ok(out.includes('user: q12'), 'newest kept');
  assert.ok(out.includes('user: q11'), 'the one before kept');
  assert.ok(!out.includes('user: q1\n') && !out.includes('user: q1 '), 'the oldest left');
});

t('a short conversation renders unchanged', () => {
  const out = dm.renderTranscript([turn('hi', 'hello'), turn('how', 'fine')], { max_chars: 4000 });
  assert.strictEqual(out, 'Recent dialogue (substrate continuity):\n  user: hi\n  faculty: hello\n  user: how\n  faculty: fine');
});

console.log('\ndialogue-window: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
