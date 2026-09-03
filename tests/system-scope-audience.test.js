#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The substrate's own marks and signals (scope system:*, internal:*) are
// bookkeeping: written as substrate-internal, operational rows that recall
// never serves back as a memory. A lesson or a fact stays model-visible.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-sys-scope-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== bookkeeping scopes stay internal ===\n');
const A = 'sys-scope-test';
const write = (scope, statement) => engram.recordEngram({ agent_id: A, user_id: 'default', cwd: null, statement, scope, source: 'test', auto_verify: false });
const audienceOf = (id) => { const r = state.getAction(id); return { audience: r.audience, memory_class: r.memory_class }; };

t('a drift signal under system: is substrate-internal and operational', () => {
  const id = write('system:drift', 'Drift signal "repetition" fired with score 1.00 over the last 5 actions.');
  assert.ok(id, 'written');
  assert.deepStrictEqual(audienceOf(id), { audience: 'substrate_internal', memory_class: 'operational' });
});

t('a watermark under internal: is the same', () => {
  const id = write('internal:wm_watermark', 'processed_through: 1');
  assert.deepStrictEqual(audienceOf(id), { audience: 'substrate_internal', memory_class: 'operational' });
});

t('a lesson and a plain fact stay model-visible', () => {
  const a = write('lesson:tests', 'A test that names an export must load the module.');
  const b = write('', 'The operator runs the benchmark on the studio.');
  assert.strictEqual(audienceOf(a).audience, 'model_visible');
  assert.strictEqual(audienceOf(b).audience, 'model_visible');
});

t('recall over everything model-visible never returns the drift signal', () => {
  const rows = engram.listEngrams({ audience: 'model_visible', agent_id: A, limit: 50 }) || [];
  assert.ok(!rows.some((r) => /Drift signal/.test(r.statement)), rows.map((r) => r.statement).join(' | '));
  assert.ok(rows.some((r) => /benchmark on the studio/.test(r.statement)));
});

t('a system: row written model-visible by an older writer is re-stamped when the substrate opens', () => {
  const ar = require(path.join(__dirname, '..', 'shared-core', 'action-record.js'));
  const rec = { id: ar.uuidv7(), timestamp: Date.now(), type: 'commitment', agent_id: A, cwd: null, user_id: 'default', input: { source: 'old-writer' }, output: { statement: 'Drift signal "tunnel_vision" fired with score 1.00 over the last 5 actions.', commitment_type: 'engram', salience: 1, tier: 'working', truth_score: 1, scope: 'system:drift' }, audience: 'model_visible', memory_class: 'episodic' };
  state.recordAction(rec, ar.toSearchText(rec));
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', 'const s=require(process.argv[1]); const r=s.getAction(process.argv[2]); console.log(JSON.stringify({audience:r.audience,memory_class:r.memory_class}))', path.join(__dirname, '..', 'shared-core', 'state.js'), rec.id], { env: process.env, encoding: 'utf8', timeout: 20000 }).trim();
  assert.deepStrictEqual(JSON.parse(out), { audience: 'substrate_internal', memory_class: 'operational' });
});

console.log('\nsystem-scope-audience: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
