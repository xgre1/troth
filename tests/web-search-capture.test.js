#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A web search the partner ran is research: its results enter the knowledge
// queue under the search itself, the way a fetched page does, so a later
// question meets what was found and not only what was asked.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const assert = require('assert');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-websearch-'));
fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
process.env.HOME = home;
process.env.STATE_DB_PATH = path.join(home, '.troth', 'state.db');
process.env._TROTH_TEST_HOME = home;
process.env.TROTH_NO_MODEL_FETCH = '1';
const REPO = path.join(__dirname, '..');
const state = require(path.join(REPO, 'shared-core', 'state.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
function runHook(rel, payload) {
  return spawnSync(process.execPath, [path.join(REPO, 'plugin', rel)], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin') }),
    encoding: 'utf8', timeout: 10000
  });
}

console.log('\n=== web search capture ===\n');
const results = Array.from({ length: 6 }, (_, i) => ({ title: 'Result ' + i + ' about llama.cpp on Apple Silicon', url: 'https://example.org/' + i, snippet: 'Metal backend decode speed and memory figures for M-series chips, run ' + i + '.' }));

t('a search with results lands in the knowledge queue under the search itself', () => {
  const r = runHook('hooks/mark-read.mjs', { session_id: 's1', tool_name: 'WebSearch', tool_input: { query: 'llama.cpp Apple Silicon benchmarks 2026' }, tool_response: { results } });
  assert.strictEqual(r.status, 0, r.stderr);
  const rows = state.listPendingKnowledge(10) || [];
  assert.strictEqual(rows.length, 1, JSON.stringify(rows.map((x) => x.ref)));
  assert.strictEqual(rows[0].kind, 'web');
  assert.strictEqual(rows[0].ref, 'search:llama.cpp Apple Silicon benchmarks 2026');
  assert.ok(/^Web search: llama\.cpp Apple Silicon benchmarks 2026\n\n/.test(rows[0].payload), rows[0].payload.slice(0, 80));
  assert.ok(/Result 5 about llama\.cpp/.test(rows[0].payload), 'the results are the payload');
});

t('the same search with the same results is queued once', () => {
  runHook('hooks/mark-read.mjs', { session_id: 's1', tool_name: 'WebSearch', tool_input: { query: 'llama.cpp Apple Silicon benchmarks 2026' }, tool_response: { results } });
  assert.strictEqual((state.listPendingKnowledge(10) || []).length, 1);
});

t('a search that found nothing leaves no row', () => {
  runHook('hooks/mark-read.mjs', { session_id: 's1', tool_name: 'WebSearch', tool_input: { query: 'zzz' }, tool_response: { results: [] } });
  assert.strictEqual((state.listPendingKnowledge(10) || []).length, 1);
});

t('hooks.json routes WebSearch to the same hook as WebFetch', () => {
  const h = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  const H = h.hooks || h;
  const g = (H.PostToolUse || []).find((x) => (x.hooks || []).some((k) => /mark-read\.mjs/.test(String(k.command))));
  assert.ok(g && /WebSearch/.test(g.matcher) && /WebFetch/.test(g.matcher), g && g.matcher);
});

console.log('\nweb-search-capture: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
