#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A non-Claude lane receives the tools the engine can act on: the coding
// tools and every MCP tool, in the order they arrived. Claude Code's own
// product surfaces and its deferred set stay behind.
const assert = require('assert');
const path = require('path');
const et = require(path.join(__dirname, '..', 'proxy', 'modules', 'engine-tools.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== engine tools ===\n');

const schema = { type: 'object', properties: { a: { type: 'string' } } };
const TOOLS = [
  { name: 'Read', description: 'read a file', input_schema: schema },
  { name: 'Artifact', description: 'publish a page', input_schema: schema },
  { name: 'WebFetch', description: 'fetch', input_schema: schema, defer_loading: true },
  { name: 'mcp__plugin_troth_troth-bash__run', description: 'run a command', input_schema: schema },
  { name: 'ToolSearch', description: 'load deferred tools', input_schema: schema },
  { name: 'Edit', description: 'edit a file', input_schema: schema, defer_loading: false },
  { name: 'mcp__plugin_troth_troth-router__troth_recall', description: 'recall', input_schema: schema, defer_loading: true }
];

t('coding tools and MCP tools stay in order, product surfaces and the deferred set leave', () => {
  const r = et.trimForEngine(TOOLS, 'openai_sub');
  assert.deepStrictEqual(r.tools.map((x) => x.name), ['Read', 'mcp__plugin_troth_troth-bash__run', 'Edit']);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.before, 7);
  assert.strictEqual(r.after, 3);
  assert.ok(r.after_bytes < r.before_bytes);
});

t('the deferred flag never travels, and the source list is untouched', () => {
  const r = et.trimForEngine(TOOLS, 'kimi_sub');
  for (const x of r.tools) assert.ok(!('defer_loading' in x), x.name + ' still carries defer_loading');
  assert.strictEqual(TOOLS[5].defer_loading, false, 'the caller\'s array is not mutated');
  assert.strictEqual(TOOLS.length, 7);
});

t('a list with nothing to drop comes back unchanged', () => {
  const plain = [{ name: 'Read', input_schema: schema }, { name: 'mcp__x__y', input_schema: schema }];
  const r = et.trimForEngine(plain, 'local');
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.tools.map((x) => x.name), ['Read', 'mcp__x__y']);
});

t('no tools is no tools', () => {
  assert.strictEqual(et.trimForEngine(undefined, 'x').tools, undefined);
  assert.deepStrictEqual(et.trimForEngine([], 'x').tools, []);
});

console.log('\nengine-tools: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
