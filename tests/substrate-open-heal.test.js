#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Opening the substrate heals only the rows written since the last open: a
// row an older writer left without an audience or a memory class is repaired
// when it is newer than the recorded mark, left alone when it is older (an
// earlier open already walked it), and every heal statement carries that
// bound, so no open walks the whole table.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== opening the substrate heals only what is new ===\n');

// Process A: create the schema (the first open walks everything once), then
// leave unhealed rows behind: two older than the mark, one newer.
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar = require(path.join(ROOT, 'shared-core', 'action-record.js'));
const d = state.db();
const mark = Number(d.prepare("SELECT value FROM substrate_meta WHERE key='heal_since'").get().value);
assert.ok(mark > 0, 'the first open records a mark');
const OLD = mark - 3600000;
const NEW = Date.now() + 1000;
const ins = d.prepare("INSERT INTO action_records (id, timestamp, type, agent_id, user_id, input, output, verification, outcome, audience, memory_class) VALUES (?, ?, 'decision', 'fc', 'default', '{}', '{}', '{}', '{}', ?, ?)");
const oldId = ar.uuidv7(OLD); ins.run(oldId, OLD, null, null);
const old2 = ar.uuidv7(OLD + 1); ins.run(old2, OLD + 1, 'model_visible', null);
const newId = ar.uuidv7(NEW); ins.run(newId, NEW, null, null);

// Process B: a fresh open, with every statement it runs on record.
const script = [
  "const Database = require('better-sqlite3');",
  "const seen = [];",
  "const orig = Database.prototype.prepare;",
  "Database.prototype.prepare = function (sql) { if (/^\\s*UPDATE\\s+action_records/i.test(sql)) seen.push(sql.replace(/\\s+/g, ' ')); return orig.call(this, sql); };",
  "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
  "const d = state.db();",
  "const row = (id) => d.prepare('SELECT audience, memory_class FROM action_records WHERE id = ?').get(id);",
  "console.log(JSON.stringify({ old: row(" + JSON.stringify(oldId) + "), old2: row(" + JSON.stringify(old2) + "), fresh: row(" + JSON.stringify(newId) + "), updates: seen }));"
].join('\n');
const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: process.env, timeout: 60000 });
assert.strictEqual(r.status, 0, r.stderr);
const out = JSON.parse(String(r.stdout).trim().split('\n').pop());

t('a row newer than the mark takes the fail-closed defaults', () => {
  assert.deepStrictEqual(out.fresh, { audience: 'substrate_internal', memory_class: 'operational' });
});

t('a row older than the mark is left as an earlier open left it', () => {
  assert.deepStrictEqual(out.old, { audience: null, memory_class: null });
  assert.deepStrictEqual(out.old2, { audience: 'model_visible', memory_class: null });
});

t('every heal on the open path is bounded to the rows written since the last open', () => {
  assert.ok(out.updates.length >= 7, 'the heals ran: ' + out.updates.length);
  const unbounded = out.updates.filter((s) => !/timestamp > @since/.test(s));
  assert.deepStrictEqual(unbounded, [], 'unbounded: ' + unbounded.join(' || '));
});

console.log('\nsubstrate-open-heal: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
