#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Backfill action_records.audience + memory_class for the
// audience/memory-class reconstruction.
//
// Inventions 1 (audience) + 2 (memory_class) for the design rationale.
//
// Heuristic (applied in order; more specific patterns first):
//
//   type='lesson'                                       → model_visible + semantic
//     (curriculum_import; the ~3700 research records)
//   type='tool_call' && input.tool_name='dialogue.turn' → model_visible + episodic
//     (conversation thread)
//   type='commitment' && output.scope='identity'        → model_visible + identity
//   type='commitment' && output.scope LIKE 'handoff:%'  → substrate_internal + operational
//   type='commitment' && output.scope LIKE 'docs:%'     → model_visible + semantic
//   type='commitment' && output.commitment_type='anchor'→ model_visible + identity
//   type='commitment' && output.commitment_type='engram'→ model_visible + episodic
//     (default for user-facing engrams)
//   type='compiled_procedure'                           → model_visible + procedural
//   type IN ('decision','intent','mind_snapshot','edit',
//           'read','search','tool_call','compact',
//           'avoided_path')                             → substrate_internal + operational
//   anything else (catch-all)                           → substrate_internal + operational
//
// Idempotent: only updates rows where audience IS NULL or memory_class IS NULL.
// Reversible: `UPDATE action_records SET audience=NULL, memory_class=NULL`
// restores prior state (the source fields type/output are never modified).
//
// Usage: node scripts/backfill-audience-memory-class.js
// Prints before/after NULL counts + final distribution by (audience, memory_class).

const state = require('../shared-core/state.js');

// (sql, label) tuples — UPDATE runs in declaration order, more specific first.
const RULES = [
  ['lessons → model_visible + semantic',
    `UPDATE action_records
       SET audience='model_visible', memory_class='semantic'
     WHERE type='lesson' AND (audience IS NULL OR memory_class IS NULL)`],

  ['dialogue turns → model_visible + episodic',
    `UPDATE action_records
       SET audience='model_visible', memory_class='episodic'
     WHERE type='tool_call'
       AND json_extract(input,'$.tool_name')='dialogue.turn'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['scope=identity commitments → model_visible + identity',
    `UPDATE action_records
       SET audience='model_visible', memory_class='identity'
     WHERE type='commitment'
       AND json_extract(output,'$.scope')='identity'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['scope=handoff:* commitments → substrate_internal + operational',
    `UPDATE action_records
       SET audience='substrate_internal', memory_class='operational'
     WHERE type='commitment'
       AND json_extract(output,'$.scope') LIKE 'handoff:%'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['scope=docs:* commitments (chameleon) → model_visible + semantic',
    `UPDATE action_records
       SET audience='model_visible', memory_class='semantic'
     WHERE type='commitment'
       AND json_extract(output,'$.scope') LIKE 'docs:%'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['commitment_type=anchor → model_visible + identity',
    `UPDATE action_records
       SET audience='model_visible', memory_class='identity'
     WHERE type='commitment'
       AND json_extract(output,'$.commitment_type')='anchor'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['commitment_type=engram (default) → model_visible + episodic',
    `UPDATE action_records
       SET audience='model_visible', memory_class='episodic'
     WHERE type='commitment'
       AND json_extract(output,'$.commitment_type')='engram'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['compiled_procedure → model_visible + procedural',
    `UPDATE action_records
       SET audience='model_visible', memory_class='procedural'
     WHERE type='compiled_procedure'
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['operational types → substrate_internal + operational',
    `UPDATE action_records
       SET audience='substrate_internal', memory_class='operational'
     WHERE type IN ('decision','intent','mind_snapshot','edit','read',
                    'search','tool_call','compact','avoided_path')
       AND (audience IS NULL OR memory_class IS NULL)`],

  ['catch-all remaining → substrate_internal + operational',
    `UPDATE action_records
       SET audience='substrate_internal', memory_class='operational'
     WHERE audience IS NULL OR memory_class IS NULL`]
];

function nullsCount(d) {
  return d.prepare(
    'SELECT COUNT(*) AS n FROM action_records WHERE audience IS NULL OR memory_class IS NULL'
  ).get().n;
}

function backfill(dArg) {
  const d = dArg || state._dbForQuery();
  const before = nullsCount(d);
  process.stdout.write('NULL audience/memory_class rows before: ' + before + '\n');
  if (!before) {
    process.stdout.write('Nothing to backfill — already migrated.\n');
    return { before: 0, after: 0, perRule: [] };
  }
  const perRule = [];
  const tx = d.transaction(() => {
    for (const [label, sql] of RULES) {
      const n = d.prepare(sql).run().changes;
      perRule.push({ label, n });
      process.stdout.write('  ' + String(n).padStart(7) + '  ' + label + '\n');
    }
  });
  tx();
  const after = nullsCount(d);
  process.stdout.write('NULL audience/memory_class rows after:  ' + after + '\n');
  // Distribution snapshot — operator sanity check.
  const dist = d.prepare(`
    SELECT audience, memory_class, COUNT(*) AS n
      FROM action_records
     GROUP BY audience, memory_class
     ORDER BY n DESC
  `).all();
  process.stdout.write('Distribution (audience, memory_class, count):\n');
  for (const r of dist) {
    process.stdout.write(
      '  ' + String(r.n).padStart(7) +
      '  ' + String(r.audience || '<NULL>').padEnd(20) +
      '  ' + String(r.memory_class || '<NULL>') + '\n'
    );
  }
  if (after !== 0) {
    process.stderr.write('FAIL: ' + after + ' rows still NULL after backfill\n');
    process.exit(1);
  }
  process.stdout.write('OK — backfill complete, zero NULLs.\n');
  return { before, after, perRule };
}

// Exported so the test suite can drive backfill against a synthetic DB.
module.exports = { backfill, RULES };

if (require.main === module) backfill();
