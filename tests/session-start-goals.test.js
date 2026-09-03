#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A fresh session sees the open goals live, with what the knowledge pass has
// found for each, whether or not the entity daemon refreshed a snapshot.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'shared-core');
const HOOK = path.join(ROOT, 'plugin', 'hooks', 'session-start.mjs');
const engram = require(path.join(CORE, 'engram.js'));
const goalStatus = require(path.join(CORE, 'goal-status.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== a fresh session sees its open goals ===\n');

const goalId = engram.recordEngram({ agent_id: 'local-agent', user_id: 'default', cwd: null, statement: '[research] which local models run on Apple Silicon through llama.cpp', scope: 'goal', salience: 2, source: 'test', source_authority: 'plr_evolved', auto_verify: false });
assert.ok(goalId, 'a goal exists');
assert.ok(goalStatus.markFinding({ goal_id: goalId, statement: 'Qwen3-27B runs on Apple Silicon through llama.cpp in GGUF form.', knowledge_id: 'k1', source_title: 'Qwen3-27B model card' }), 'a finding is recorded');

t('the session start names the open goal and its finding', () => {
  const payload = JSON.stringify({ session_id: 'goals-' + Date.now(), cwd: process.cwd(), hook_event_name: 'SessionStart', reason: 'startup' });
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') })
  });
  assert.strictEqual(r.status, 0, 'exit 0: ' + String(r.stderr).slice(-300));
  const out = JSON.parse(r.stdout);
  const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  assert.ok(/\[troth\/goals\] Open goals:/.test(ctx), 'the goals line is present: ' + String(ctx).slice(0, 400));
  assert.ok(/which local models run on Apple Silicon/.test(ctx), 'the goal is named');
  assert.ok(/\(1 finding recorded/.test(ctx), 'its finding is counted: ' + String(ctx).slice(0, 600));
});

console.log('\nsession-start-goals: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
