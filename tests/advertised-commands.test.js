#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every command the product tells its operator to run has to exist.
//
// This has already shipped twice. `troth codex login` — the command the setup
// guide says to run to use a ChatGPT plan — answered "Run not found: codex" in
// every published release until the subcommand was restored. And the session
// orientation the partner reads at the top of every turn instructed the
// operator to run `troth thesis set`, which was never a command in any release.
//
// Both were invisible to the suite: nothing crashed, nothing failed, the text
// simply named something that was not there. This test reads the CLI's own
// subcommand table and holds every shipped instruction against it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The subcommand table, read from the router rather than copied — a copy would
// drift and start passing on a list that no longer matches the product.
const cliSrc = fs.readFileSync(path.join(ROOT, 'bin', 'troth.js'), 'utf8');
const setMatch = cliSrc.match(/var SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(setMatch, 'bin/troth.js no longer declares SUBCOMMANDS the way this test reads it');
const SUBCOMMANDS = new Set(
  (setMatch[1].match(/"[a-z][a-z0-9-]*"/g) || []).map((s) => s.slice(1, -1))
);
assert.ok(SUBCOMMANDS.size > 10, 'parsed too few subcommands: ' + SUBCOMMANDS.size);

// Words that follow "troth" as ordinary English or as a noun, not as a command.
const PROSE = new Set([
  'is', 'has', 'was', 'will', 'can', 'and', 'or', 'the', 'to', 'in', 'on', 'at',
  'as', 'by', 'for', 'from', 'with', 'without', 'itself', 'here', 'there',
  'does', 'did', 'so', 'now', 'then', 'when', 'while', 'that', 'this', 'they',
  'you', 'we', 'it', 'its', 'also', 'already', 'never', 'always', 'only',
  'app', 'chat', 'core', 'cli', 'dashboard', 'proxy', 'entity', 'plugin',
  'substrate', 'memory', 'home', 'config', 'repo', 'project', 'files',
  'answers', 'runs', 'reads', 'writes', 'keeps', 'holds', 'starts', 'stops',
  'boots', 'ships', 'lives', 'stays', 'uses', 'needs', 'wants', 'sees',
  'mounted', 'worker'
]);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|md|html|txt)$/.test(name)) out.push(full);
  }
  return out;
}

// Instructions, not prose: `troth x` in backticks, or after run/with/try/:.
const PATTERNS = [
  /`troth ([a-z][a-z0-9-]*)/g,
  /(?:run|Run|running|try|Try|use|Use|with|operator should:?)\s+troth ([a-z][a-z0-9-]*)/g
];

const offences = [];
for (const file of walk(ROOT, [])) {
  if (file.includes(path.join('tests', 'advertised-commands.test.js'))) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const word = m[1];
      if (SUBCOMMANDS.has(word) || PROSE.has(word)) continue;
      // Comments describe internals; they are not instructions to anyone.
      // Only text the operator can actually read counts as an advertisement.
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineText = src.slice(lineStart, src.indexOf('\n', m.index));
      if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offences.push(path.relative(ROOT, file) + ':' + line + ' → troth ' + word);
    }
  }
}

assert.deepStrictEqual(offences, [],
  'these surfaces name a command the CLI does not have:\n  ' + offences.join('\n  '));

console.log('PASS advertised-commands: every `troth <cmd>` in shipped text exists (' +
  SUBCOMMANDS.size + ' subcommands)');
