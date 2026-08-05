#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// troth audit verify CLI.
//
// Walks l4_signed_audit_chain, verifies every row's hash + signature.
// Returns 0 on intact chain, 1 on tamper, 2 on bad invocation.

'use strict';

const path = require('path');
const sa = require(path.join(__dirname, '..', 'shared-core', 'signed-audit.js'));

async function main() {
  console.log('=== troth audit verify ===');
  const key = sa.ensureKey({});
  console.log('Active public_key_id: ' + key.public_key_id);

  const res = sa.verifyChain({});
  console.log(JSON.stringify({
    ok:               res.ok,
    rows_checked:     res.rows_checked,
    empty:            res.empty || false,
    last_chain_hash:  res.last_chain_hash || null,
    first_tamper:     res.first_tamper || null
  }, null, 2));

  if (res.ok) {
    console.log('\nChain intact.');
    process.exit(0);
  } else {
    console.log('\n⚠ Tamper detected at row ' + (res.first_tamper && res.first_tamper.row_id));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('audit-verify.js threw: ' + (e && e.stack || e));
  process.exit(2);
});
