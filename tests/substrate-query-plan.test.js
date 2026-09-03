#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The reads every prompt makes walk an index in time order: rows of one type,
// newest first, come from an index on (type, timestamp), never from a sort of
// every row of that type.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== the reads every prompt makes walk an index ===\n');

const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const d = state.db();
const plan = (sql) => d.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');

t('rows of one type, newest first, come from the (type, timestamp) index', () => {
  const p = plan("SELECT id FROM action_records WHERE type = 'commitment' ORDER BY timestamp DESC LIMIT 800");
  assert.ok(/idx_ar_type_ts/.test(p), p);
  assert.ok(!/TEMP B-TREE/.test(p), p);
});

t('queryActions by type in time order takes the same road', () => {
  const Database = require('better-sqlite3');
  const seen = [];
  const orig = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) { if (/FROM action_records/i.test(sql) && /ORDER BY/i.test(sql)) seen.push(sql); return orig.call(this, sql); };
  try { state.queryActions({ type: 'commitment', limit: 800 }); } finally { Database.prototype.prepare = orig; }
  assert.ok(seen.length >= 1, 'the query ran');
  const p = plan(seen[seen.length - 1].replace(/@(\w+)/g, "'x'"));
  assert.ok(/idx_ar_type_ts/.test(p) && !/TEMP B-TREE/.test(p), p);
});

t('a registry read by scope prefix walks the scope index', () => {
  const Database = require('better-sqlite3');
  const seen = [];
  const orig = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) { if (/FROM action_records/i.test(sql) && /scope/i.test(sql)) seen.push(sql); return orig.call(this, sql); };
  try { state.queryActions({ type: 'commitment', scope_prefix: 'context:registry:', limit: 200 }); } finally { Database.prototype.prepare = orig; }
  assert.ok(seen.length >= 1, 'the query ran');
  const p = plan(seen[seen.length - 1].replace(/@scope_from/g, "'context:registry:'").replace(/@scope_to/g, "'context:registry;'").replace(/@(\w+)/g, "'x'"));
  assert.ok(/idx_ar_output_scope/.test(p), p);
  assert.ok(!/idx_ar_type\b/.test(p), p);
});

console.log('\nsubstrate-query-plan: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
