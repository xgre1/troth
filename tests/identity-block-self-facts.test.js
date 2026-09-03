#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The [troth/identity] block leads with what the operator has stated about
// themselves, as the memory's understanding keeps it: the current fact per
// subject with the day it was said, never the row a newer statement
// retired, and ahead of a rule of thumb whatever its salience.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const assert = require('assert');
const REPO = path.join(__dirname, '..');
const PLUGIN = path.join(REPO, 'plugin');
const TMP = path.join(os.tmpdir(), 'troth-idself-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });
process.env.CLAUDE_PLUGIN_DATA = TMP;
// The harness convention: the substrate file is named outright, for this
// process and for the hook it spawns.
process.env.STATE_DB_PATH = path.join(TMP, 'state.db');
process.env.TROTH_NO_MODEL_FETCH = '1';
const state = require(path.join(REPO, 'shared-core', 'state.js'));
const ar = require(path.join(REPO, 'shared-core', 'action-record.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
function writeEngram(agent_id, statement, salience, opts) {
  opts = opts || {};
  const output = { statement, commitment_type: 'engram', salience: salience || 1.0, tier: 'working', truth_score: 1.0 };
  if (opts.scope) output.scope = opts.scope;
  if (opts.payload) output.payload = opts.payload;
  if (opts.supersedes) output.lifetime = { supersedes: opts.supersedes, reason: 'newer_on_subject' };
  const rec = { id: ar.uuidv7(), timestamp: opts.ts || Date.now(), type: 'commitment', agent_id, cwd: '/tmp/idself-cwd', user_id: 'default', input: { source: 'idself-test' }, output };
  state.recordAction(rec, ar.toSearchText(rec));
  return rec.id;
}
function runInjector(prompt) {
  const out = execFileSync(process.execPath, [path.join(PLUGIN, 'hooks', 'injector.mjs')], {
    input: JSON.stringify({ session_id: 'idself-' + Date.now(), cwd: '/tmp/idself-cwd', user_prompt: prompt }),
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: TMP }),
    encoding: 'utf8', timeout: 20000
  });
  const j = out.trim() ? JSON.parse(out.trim()) : {};
  return (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || '';
}

console.log('\n=== identity block: the operator\'s own current facts ===\n');
const MAY = Date.UTC(2026, 4, 4), SEP = Date.UTC(2026, 8, 2);
writeEngram('idself-agent', 'the does not want background watchers left running from previous sessions', 2.0);
const older = writeEngram('idself-agent', 'I work at Northwind for 700 euros a month', 1.0, { scope: 'consolidated:self', ts: MAY });
writeEngram('idself-agent', 'I work at Northwind two days a week for 600 euros a month', 1.0, { scope: 'consolidated:self', ts: SEP, supersedes: [older], payload: { fact_kind: 'fact', subject: 'Northwind', attribute: 'pay' } });
// A self row the reader let through with nothing it is about: newer than
// everything, and never the foundation.
writeEngram('idself-agent', 'We just set the quant to q4', 1.0, { scope: 'consolidated:self', ts: Date.now(), payload: { fact_kind: 'fact', subject: '', attribute: 'other' } });

t('the core fact is the operator\'s own current statement, with the day it was said', () => {
  const ac = runInjector('please help me plan next week around the days I work at Northwind');
  const line = ac.split('\n').find((l) => l.startsWith('[troth/identity]')) || '';
  assert.ok(line, 'identity block present: ' + ac.slice(0, 300));
  assert.ok(/\[core\] "I work at Northwind two days a week for 600 euros a month" \(as of 2026-09-02\)/.test(line), line);
});

t('the row a newer statement retired never surfaces', () => {
  const ac = runInjector('please help me plan next week around the days I work at Northwind');
  assert.ok(!/700 euros/.test(ac), ac.split('\n').find((l) => l.startsWith('[troth/identity]')));
});

t('a self row with no subject never takes the core slot', () => {
  const ac = runInjector('please help me plan next week around the days I work at Northwind');
  const line = ac.split('\n').find((l) => l.startsWith('[troth/identity]')) || '';
  assert.ok(!/\[core\] "We just set the quant/.test(line), line);
});

t('a rule of thumb, whatever its salience, no longer takes the core slot', () => {
  const ac = runInjector('what should I do about the proxy restart routine this week');
  const line = ac.split('\n').find((l) => l.startsWith('[troth/identity]')) || '';
  assert.ok(!/\[core\] "the does not want background watchers/.test(line), line);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\nidentity-block-self-facts: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
