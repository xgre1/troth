#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The chat surface names every tool with its target, writes each tool as a
// line of the transcript with its time when it took a while, and keeps the
// composer one height for the whole turn under the fixed layout.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'troth-chat.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== chat surface: tools in the transcript ===\n');

const m = /function toolVerb\(name, args\) \{[\s\S]*?\n\}\n/.exec(src);
assert.ok(m, 'toolVerb found');
const toolVerb = new Function(m[0] + '; return toolVerb;')();

t('every tool is named with its target, whatever the case of its name', () => {
  assert.strictEqual(toolVerb('Bash', { command: 'git status --short' }), 'running: git status --short');
  assert.strictEqual(toolVerb('bash', { command: 'x'.repeat(80) }).length, 'running: '.length + 56);
  assert.strictEqual(toolVerb('Read', { file_path: '/a/b/recall.js' }), 'reading recall.js');
  assert.strictEqual(toolVerb('hashline_edit', { file_path: '/a/b/state.js' }), 'editing state.js');
  assert.strictEqual(toolVerb('Write', { file_path: '/a/b/new.md' }), 'writing new.md');
  assert.strictEqual(toolVerb('Grep', { pattern: 'rerank' }), 'searching "rerank"');
  assert.strictEqual(toolVerb('WebFetch', { url: 'https://example.com/docs/x' }), 'fetching example.com');
  assert.strictEqual(toolVerb('WebSearch', { query: 'hermes agent memory provider' }), 'searching the web: hermes agent memory provider');
  assert.strictEqual(toolVerb('browse', { url: 'https://news.example.org/a' }), 'browsing news.example.org');
  assert.strictEqual(toolVerb('mcp__plugin_troth_troth-bash__run', { command: 'npm test' }), 'calling troth-bash.run: npm test');
  assert.strictEqual(toolVerb('mcp__troth-substrate__troth_recall', {}), 'calling troth-substrate.troth_recall');
  assert.strictEqual(toolVerb('mcp_call', { server: 'troth-memory', tool: 'troth_fetch_action' }), 'calling troth-memory.troth_fetch_action');
  assert.strictEqual(toolVerb('Task', { description: 'review the router' }), 'delegating: review the router');
  assert.strictEqual(toolVerb('SomethingNew', { url: 'https://x.test/p' }), 'using SomethingNew: https://x.test/p');
  assert.strictEqual(toolVerb('', {}), 'using tool');
});

t('a tool starts as a transcript line and ends with its time when it took a while (source pin)', () => {
  assert.ok(/case 'tool_request': \{[\s\S]*?out\(color\(DIM, '  ◦ ' \+ verb\)/.test(src), 'the start line is written to the transcript');
  assert.ok(/case 'tool_result': \{[\s\S]*?if \(ms >= 2000\) out\(/.test(src), 'the time is written when the tool took two seconds or more');
});

t('under the fixed layout the working state rides the status row and never grows the composer (source pin)', () => {
  assert.ok(/function drawMeterRow\(lead\) \{\s*\n\s*if \(fixedUI\) \{ statusWork = lead; drawStatus\(\); redraw\(\); return; \}/.test(src), 'the lead goes to the status row');
  assert.ok(/statusWork \|\| null\]\.filter\(Boolean\)/.test(src), 'the status row shows it');
});

console.log('\ncli-tool-lines: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
