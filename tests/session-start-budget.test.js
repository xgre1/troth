#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The SessionStart hook has five seconds before the harness drops its whole
// output. The daily maintenance tick runs in a detached child instead of
// inline, so the orientation always arrives; the ledger rows still land.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== session start inside its budget ===\n');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'plugin', 'hooks', 'session-start.mjs');
const src = fs.readFileSync(HOOK, 'utf8');

t('the daily tick is no longer awaited inside the hook', () => {
  assert.ok(!/await bg\.runDueTasks/.test(src), 'no inline await of runDueTasks');
  assert.ok(/detached: true/.test(src) && /child\.unref\(\)/.test(src), 'a detached, unreferenced child runs it');
});

t('the hook answers well inside five seconds with the substrate in place', () => {
  const payload = JSON.stringify({ session_id: 'budget-' + Date.now(), cwd: process.cwd(), hook_event_name: 'SessionStart', reason: 'startup' });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') })
  });
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, 0, 'exit 0: ' + String(r.stderr).slice(-300));
  let out; try { out = JSON.parse(r.stdout); } catch (e) { throw new Error('hook output is not JSON: ' + String(r.stdout).slice(0, 200)); }
  const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  assert.ok(ctx && /troth\/substrate-first/.test(ctx), 'the orientation block is present');
  assert.ok(ms < 4000, 'hook took ' + ms + ' ms');
});

console.log('\nsession-start-budget: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
