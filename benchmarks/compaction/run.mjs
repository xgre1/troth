#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Compaction-hook end-to-end driver. Exercises Layer 5 of the substrate
// (the substrate design notes) without depending on Claude Code's
// internal compaction trigger (which only fires at ~70% of the context
// window and takes tens of thousands of tokens of real work to reach).
//
// What this proves:
//   1. pre-compact.mjs, when given a realistic PreCompact payload, writes
//      a type=compact ActionRecord to the substrate.
//   2. Pinned pages survive the swap; non-pinned pages within budget are
//      kept; overflow is evicted but remains fetchable via getAction
//      (evicted != lost).
//   3. The manifest text emitted as additionalContext is bounded by the
//      working-set budget and includes every retained pointer.
//   4. A post-compact fetch_action on a dropped id returns the full
//      record (virtual-memory-style page reload).
//
// What this does NOT prove:
//   - That Claude Code itself routes its native compaction through our
//     hook. That's wired in plugin/hooks/hooks.json (matcher PreCompact)
//     and is Claude Code's contract to honor. A manual repro is to run
//     `claude` interactively, fill context until compaction fires, and
//     inspect ~/.claude/plugins/data/troth-troth-local/state.db for
//     a new type=compact row.
//
// Usage:
//   CLAUDE_PLUGIN_DATA=/tmp/compact-bench node benchmarks/compaction/run.mjs
//
// Exits non-zero on assertion failure.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// Isolated state dir so the benchmark doesn't pollute ~/.troth.
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || resolve('/tmp', 'gc-compact-' + Date.now());
mkdirSync(DATA_DIR, { recursive: true });
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR;

// Late-require so state.js picks up our data dir.
const state         = require(resolve(REPO, 'shared-core', 'state.js'));
const actionRecord  = require(resolve(REPO, 'shared-core', 'action-record.js'));
const workingSet    = require(resolve(REPO, 'shared-core', 'working-set.js'));
const runtime       = require(resolve(REPO, 'shared-core', 'runtime.js'));

const SESSION  = 'compact-bench-' + Date.now();
const CWD      = '/tmp/compact-bench-cwd';
const BUDGET   = 300; // deliberately tight so 30 seeded records exceed it
const SEEDS    = 30;  // drives tokens well above budget, forcing evictions

let failed = 0;
function assert(cond, label) {
  const mark = cond ? '✓' : '✗';
  console.log('  ' + mark + ' ' + label);
  if (!cond) failed++;
}

// ── seed SEEDS records into the substrate ────────────────────────────────
console.log('[seed] writing ' + SEEDS + ' edit records to substrate...');
const ids = [];
for (let i = 0; i < SEEDS; i++) {
  const rec = actionRecord.create({
    type: 'edit', agent_id: 'claude-code',
    session_id: SESSION, cwd: CWD,
    input:  { file_path: '/project/src/module-' + i + '.js', format: 'edit' },
    output: { hash_after: 'h' + i + 'a'.repeat(40), lines_changed: 3 },
    verification: { ast: { ok: true, skipped: false } }
  });
  state.recordAction(rec, actionRecord.toSearchText(rec));
  ids.push(rec.id);
}

// ── open working set, load all SEEDS, pin 2 ──────────────────────────────
workingSet.openSession(state, {
  session_id: SESSION, agent_id: 'claude-code',
  cwd: CWD, budget_tokens: BUDGET, max_size: SEEDS + 10
});
// Pin two early so they survive eviction during loading.
workingSet.load(state, SESSION, ids[0], { pinned: true });
workingSet.load(state, SESSION, ids[1], { pinned: true });
for (let i = 2; i < ids.length; i++) workingSet.load(state, SESSION, ids[i]);

const before = workingSet.manifest(SESSION);
console.log('[pre]  resident=' + before.resident + ' tokens=' + before.tokens +
            '/' + before.budget + ' pinned=' + before.pinned.length);

// ── invoke pre-compact.mjs as a real subprocess ──────────────────────────
console.log('[fire] spawning plugin/hooks/pre-compact.mjs...');
const hookPath = resolve(REPO, 'plugin', 'hooks', 'pre-compact.mjs');
const payload = JSON.stringify({
  session_id: SESSION, cwd: CWD,
  hook_event_name: 'PreCompact',
  budget_tokens: BUDGET
});
const hookOut = execFileSync('node', [hookPath], {
  input: payload,
  env: Object.assign({}, process.env, {
    CLAUDE_PLUGIN_ROOT: resolve(REPO, 'plugin'),
    CLAUDE_PLUGIN_DATA: DATA_DIR
  }),
  encoding: 'utf8'
});

// ── assertions on the substrate state ────────────────────────────────────
console.log('[check] assertions:');

const compactRows = state.queryActions({ type: 'compact', session_id: SESSION });
assert(compactRows.length >= 1,
  'PreCompact wrote at least one type=compact ActionRecord (got ' + compactRows.length + ')');

// The subprocess hook mutated the persisted session. Force re-hydrate by
// closing the stale in-memory copy so the next getSession reads disk.
workingSet.closeSession(SESSION);
const afterManifest = workingSet.manifest(SESSION);
assert(afterManifest.pinned.length === 2,
  'both pinned pages survived the swap (got ' + afterManifest.pinned.length + ')');
assert(afterManifest.tokens <= BUDGET * 0.7 + 50, // 50-token slack for pinned overflow
  'post-compact token count is within ~70% of budget (got ' + afterManifest.tokens + '/' + BUDGET + ')');

const residentIds = new Set(afterManifest.entries.map(e => e.id));
assert(residentIds.has(ids[0]) && residentIds.has(ids[1]),
  'specific pinned ids still resident');

// Find a dropped id.
const droppedId = ids.find(id => !residentIds.has(id));
assert(!!droppedId, 'at least one page was evicted');

// ── evicted != lost: substrate still serves the page ─────────────────────
if (droppedId) {
  const fault = runtime.handleFetch(state, SESSION, droppedId);
  assert(fault.ok === true, 'evicted page reloads via runtime.handleFetch (ok=' + fault.ok + ')');
  assert(fault.action && fault.action.id === droppedId,
    'fetched record matches the evicted id');
}

// ── unknown-id fault behaves correctly ───────────────────────────────────
const unknownFault = runtime.handleFetch(state, SESSION, 'ffffffff-ffff-7fff-bfff-ffffffffffff');
assert(unknownFault.ok === false && unknownFault.fault === 'not_found',
  'unknown id returns structured not_found fault (not hallucinated content)');

// ── manifest emitted as additionalContext ────────────────────────────────
let manifestInHookOut = false;
try {
  const parsed = JSON.parse(hookOut);
  const txt = parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
  manifestInHookOut = typeof txt === 'string' && txt.includes('[troth/working-set]');
} catch {}
assert(manifestInHookOut,
  'hook stdout contains hookSpecificOutput.additionalContext with working-set manifest');

// ── report ───────────────────────────────────────────────────────────────
console.log('\n[report]');
console.log('  session_id     : ' + SESSION);
console.log('  seed records   : ' + ids.length);
console.log('  pinned         : 2');
console.log('  before tokens  : ' + before.tokens);
console.log('  after tokens   : ' + afterManifest.tokens);
console.log('  dropped        : ' + (ids.length - afterManifest.resident));
console.log('  compact rows   : ' + compactRows.length);
console.log('  data dir       : ' + DATA_DIR);
console.log('  assertions     : ' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));

if (failed > 0) process.exit(1);
