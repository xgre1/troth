#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A reply rendered for the terminal: no markdown marker survives, every
// line fits the width, lists hang under their bullet, code keeps its shape,
// tables align, and a pipe (tty:false) receives the text as it came.
const assert = require('assert');
const path = require('path');
const md = require(path.join(__dirname, '..', 'shared-core', 'tty-markdown.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const plain = (s) => md.stripAnsi(s);
const lines = (s) => plain(s).split('\n');

console.log('\n=== reply rendering ===\n');

t('headings lose their hashes and bold, italic, code and links lose their markers', () => {
  const s = md.render('## Plan\n\nUse **bold**, *em*, `code` and [a link](https://x.y/z).', { width: 60 });
  const p = plain(s);
  assert.ok(!/#/.test(p), p);
  assert.ok(!/\*|`|\[|\]\(/.test(p), p);
  assert.ok(/Plan/.test(p) && /bold/.test(p) && /a link \(https:\/\/x\.y\/z\)/.test(p), p);
  assert.ok(/\x1b\[1m/.test(s), 'bold is styled');
});

t('every line fits the width and a long paragraph wraps at spaces', () => {
  const s = md.render('word '.repeat(60).trim(), { width: 32 });
  for (const l of lines(s)) assert.ok(l.length <= 32, 'too wide: "' + l + '"');
  assert.ok(lines(s).length >= 8);
});

t('a list hangs under its bullet, nests, numbers and ticks', () => {
  const s = md.render('- alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\n  - nested one\n1. first\n2. second\n- [x] done\n- [ ] open', { width: 30 });
  const L = lines(s);
  assert.ok(L[0].startsWith('• alpha'), L[0]);
  assert.ok(L[1].startsWith('  ') && !L[1].startsWith('  •'), 'continuation hangs: ' + L[1]);
  assert.ok(L.some((l) => l.startsWith('  ◦ nested one')), L.join('|'));
  assert.ok(L.some((l) => l === '1. first') && L.some((l) => l === '2. second'), L.join('|'));
  assert.ok(L.some((l) => l.startsWith('☑ done')) && L.some((l) => l.startsWith('☐ open')), L.join('|'));
});

t('a fenced block keeps its lines verbatim under a labelled rule', () => {
  const s = md.render('before\n\n```js\nconst  x = 1;   // spaced\n  indented();\n```\n\nafter', { width: 60 });
  const L = lines(s);
  const top = L.findIndex((l) => /^┄ js ┄/.test(l));
  assert.ok(top > 0, L.join('|'));
  assert.strictEqual(L[top + 1], '  const  x = 1;   // spaced');
  assert.strictEqual(L[top + 2], '    indented();');
  assert.ok(/^┄+$/.test(L[top + 3]));
  assert.ok(L.indexOf('after') > top + 3);
});

t('a table aligns its columns with a header rule', () => {
  const s = md.render('| name | size |\n|---|---|\n| alpha | 1 |\n| b | 22 |', { width: 60 });
  const L = lines(s);
  assert.strictEqual(L[0], 'name  │ size');
  assert.ok(/^─+┼─+$/.test(L[1]), L[1]);
  assert.strictEqual(L[2], 'alpha │ 1   ');
  assert.strictEqual(L[3], 'b     │ 22  ');
});

t('a quote carries a bar, a rule is a line, and blank lines collapse', () => {
  const s = md.render('> said so\n\n\n\n---\n\nend', { width: 40 });
  const L = lines(s);
  assert.ok(L[0].startsWith('▎ said so'), L[0]);
  assert.ok(L.some((l) => /^─{10,}$/.test(l)));
  assert.ok(!L.some((l, i) => l === '' && L[i + 1] === ''), 'no double blank: ' + JSON.stringify(L));
});

t('a pipe receives the text as it came', () => {
  const src = '# H\n\n- a\n- b\n';
  assert.strictEqual(md.render(src, { tty: false }), src);
});

t('the palette owns the colours', () => {
  const s = md.render('**b** plain', { width: 40, palette: { strong: (x) => '<' + x + '>', text: (x) => '[' + x + ']' } });
  assert.strictEqual(s, '<b>[ ][plain]');
});

console.log('\ntty-markdown: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
