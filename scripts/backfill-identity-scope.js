#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Backfill output.scope='identity' on existing commitment rows whose
// agent_id='identity'. Idempotent: only
// updates rows where scope is missing or empty. agent_id stays intact
// so older provenance / rollback paths remain available.
//
// Usage: node scripts/backfill-identity-scope.js

const state = require('../shared-core/state.js');

function main() {
  const d = state._dbForQuery();
  const before = d.prepare(
    "SELECT COUNT(*) AS n FROM action_records " +
    "WHERE agent_id='identity' AND type='commitment' " +
    "  AND (json_extract(output,'$.scope') IS NULL OR json_extract(output,'$.scope') = '')"
  ).get().n;
  process.stdout.write('Rows needing scope backfill: ' + before + '\n');
  if (!before) {
    process.stdout.write('Nothing to backfill — already migrated.\n');
    return;
  }
  const tx = d.transaction(() => {
    d.prepare(
      "UPDATE action_records " +
      "SET output = json_set(output, '$.scope', 'identity') " +
      "WHERE agent_id='identity' AND type='commitment' " +
      "  AND (json_extract(output,'$.scope') IS NULL OR json_extract(output,'$.scope') = '')"
    ).run();
  });
  tx();
  const after = d.prepare(
    "SELECT COUNT(*) AS n FROM action_records " +
    "WHERE agent_id='identity' AND type='commitment' " +
    "  AND (json_extract(output,'$.scope') IS NULL OR json_extract(output,'$.scope') = '')"
  ).get().n;
  process.stdout.write('Rows still missing scope after backfill: ' + after + '\n');
  if (after !== 0) {
    process.stderr.write('FAIL: ' + after + ' rows still missing scope\n');
    process.exit(1);
  }
  process.stdout.write('OK — identity-pool scope backfill complete.\n');
}

main();
