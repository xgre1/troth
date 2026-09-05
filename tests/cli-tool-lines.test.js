#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The chat surface names every tool with its target on the status row while
// it runs, leaves one summary line per turn in the transcript, keeps the
// composer one height under the fixed layout, and a stop reaches the daemon.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'troth-chat.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== chat surface: tools on the status row, one line per turn ===\n');

const m = /function toolVerb\(name, args\) \{[\s\S]*?\n\}\n/.exec(src);
assert.ok(m, 'toolVerb found');
const toolVerb = new Function(m[0] + '; return toolVerb;')();

t('every tool is named in plain words, whatever the case of its name', () => {
  assert.strictEqual(toolVerb('Bash', { command: 'git status --short' }), 'running git status --short');
  assert.strictEqual(toolVerb('bash', { command: 'x'.repeat(80) }), 'running a command');
  assert.strictEqual(toolVerb('bash', { command: 'node - <<EOF\nconsole.log(1)\nEOF' }), 'running a command');
  assert.strictEqual(toolVerb('Read', { file_path: '/a/b/recall.js' }), 'reading recall.js');
  assert.strictEqual(toolVerb('hashline_edit', { file_path: '/a/b/state.js' }), 'editing state.js');
  assert.strictEqual(toolVerb('Write', { file_path: '/a/b/new.md' }), 'writing new.md');
  assert.strictEqual(toolVerb('Grep', { pattern: 'rerank' }), 'searching "rerank"');
  assert.strictEqual(toolVerb('WebFetch', { url: 'https://example.com/docs/x' }), 'fetching example.com');
  assert.strictEqual(toolVerb('WebSearch', { query: 'hermes agent memory' }), 'searching the web: hermes agent memory');
  assert.strictEqual(toolVerb('browse', { url: 'https://news.example.org/a' }), 'browsing news.example.org');
  assert.strictEqual(toolVerb('mcp__plugin_troth_troth-bash__run', { command: 'npm test' }), 'running npm test');
  assert.strictEqual(toolVerb('mcp__plugin_troth_troth-hashline__hashline_read', { file_path: '/x/y/server.js' }), 'reading server.js');
  assert.strictEqual(toolVerb('mcp__troth-substrate__troth_recall', {}), 'recalling');
  assert.strictEqual(toolVerb('mcp_call', { server: 'troth-memory', tool: 'troth_fetch_action' }), 'consulting memory');
  assert.strictEqual(toolVerb('mcp_call', { server: 'troth-substrate', tool: 'troth_engram_record' }), 'remembering');
  assert.strictEqual(toolVerb('mcp_call', { server: 'stripe', tool: 'list_customers' }), 'calling stripe');
  assert.strictEqual(toolVerb('Task', { description: 'review the router' }), 'delegating: review the router');
  assert.strictEqual(toolVerb('SomethingNew', { url: 'https://x.test/p' }), 'using SomethingNew: https://x.test/p');
  assert.strictEqual(toolVerb('', {}), 'using a tool');
});

t('a tool rides the status row and never becomes a transcript line (source pin)', () => {
  const req = /case 'tool_request': \{([\s\S]*?)break;/.exec(src);
  assert.ok(req, 'tool_request case found');
  assert.ok(/spinner\.update\(toolVerb\(/.test(req[1]), 'the verb goes to the status row');
  assert.ok(!/\bout\(/.test(req[1]), 'nothing is written to the transcript when a tool starts');
  const res = /case 'tool_result': \{([\s\S]*?)break;/.exec(src);
  assert.ok(res, 'tool_result case found');
  assert.ok(!/\bout\(/.test(res[1]), 'nothing is written to the transcript when a tool ends');
});

t('the turn leaves one summary line: tools and seconds (source pin)', () => {
  assert.ok(/if \(turnTools > 0\) out\(color\(DIM, '  ◦ ' \+ turnSummary\(\)\)/.test(src), 'the reply is preceded by the summary line');
  const m2 = /function turnSummary\(\) \{\n([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(m2, 'turnSummary found');
  const mk = (tools, start, acts) => new Function('turnTools', 'turnStart', 'turnActions', m2[1])(tools, start, acts);
  assert.strictEqual(mk(1, 0, ['read']), 'read 1 file');
  assert.strictEqual(mk(4, 0, ['read', 'read', 'search', 'run']), 'read 2 files, searched, ran 1 command');
  assert.strictEqual(mk(3, 0, ['search', 'search', 'recall']), 'searched twice, recalled');
  assert.strictEqual(mk(1, 0, []), '1 tool');
  assert.ok(/^edited 1 file · \d+s$/.test(mk(1, Date.now() - 12000, ['edit'])), mk(1, Date.now() - 12000, ['edit']));
});

t('a stop tells the daemon to cancel the turn it is running (source pin)', () => {
  const c = /function cancelInFlight\(\) \{([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(c, 'cancelInFlight found');
  assert.ok(/child\.stdin\.write\(JSON\.stringify\(\{ type: 'control', op: 'cancel_turn', conversation_id: CONV_ID \}\)/.test(c[1]), 'the cancel_turn control frame carries the session conversation id');
  assert.ok(/dropNextResponse = true/.test(c[1]), 'the aborted reply that follows is discarded');
  assert.ok(/stopped/.test(c[1]), 'the transcript says stopped');
  assert.ok(/rl\.on\('escape', \(\) => \{ cancelInFlight\(\); \}\)/.test(src) && /rl\.on\('interrupt', \(\) => \{\s*if \(cancelInFlight\(\)\) return;/.test(src), 'Escape and Ctrl-C both reach it');
});

t('under the fixed layout the working state rides the status row and never grows the composer (source pin)', () => {
  assert.ok(/function drawMeterRow\(lead\) \{\s*\n\s*if \(fixedUI\) \{ statusWork = lead; drawStatus\(\); redraw\(\); return; \}/.test(src), 'the lead goes to the status row');
  assert.ok(/statusWork \|\| null\]\.filter\(Boolean\)/.test(src), 'the status row shows it');
});

console.log('\ncli-tool-lines: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
