#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// troth Standards runner — the anti-drift ratchet.
//
// Each check declares expect:'pass'|'debt'. Semantics (see
// shared-core/standards/INVARIANTS.md):
//   expect=pass + fail  -> REGRESSION, exit 1 (the thesis was violated)
//   expect=debt + fail  -> tracked debt, exit 0 (a milestone owes this)
//   expect=debt + pass  -> DEBT PAID, exit 1 with "flip to enforced"
//   expect=pass + pass  -> green
'use strict';

// Some checks live on the CLOSED side of the repo split (.gitignore'd here),
// so the open checkout — and CI — must skip what is absent instead of dying
// on require.
// Same guarded-load pattern as the core-ext.js overlay loads in shared-core.
const fs = require('fs');
const path = require('path');
const CHECK_FILES = [
  './s1_substrate_subject.js',
  './s2_intents_not_tools.js',
  './s3_authority_signature.js',
  './s4_stvc_pre_llm.js',
  './s5_pac_bounded.js',
  './s6_mcp_servers_boot.js',
];
const checks = [];
const skipped = [];
for (const f of CHECK_FILES) {
  if (fs.existsSync(path.join(__dirname, f))) checks.push(require(f));
  else skipped.push(f.replace(/^\.\/(s\d+).*/, '$1'));
}

let regressions = 0;
let paid = 0;
const debts = [];

console.log('\n=== troth Standards (anti-drift ratchet) ===\n');
if (skipped.length) {
  console.log(`(closed-side checks not present in this checkout, skipped: ${skipped.join(', ')})\n`);
}
for (const c of checks) {
  let res;
  try { res = c.run(); }
  catch (e) { res = { pass: false, detail: 'check threw: ' + (e && e.message || e) }; }
  const passed = !!res.pass;
  let mark, note = '';
  if (c.expect === 'pass' && passed)      { mark = '✓ PASS '; }
  else if (c.expect === 'pass' && !passed){ mark = '✗ REGRESSION'; regressions++; }
  else if (c.expect === 'debt' && !passed){ mark = '· DEBT '; debts.push(c); }
  else /* debt + passed */                { mark = '! DEBT-PAID'; paid++; }
  console.log(`${mark}  ${c.id} — ${c.title}`);
  if (res.detail) console.log(`        ${res.detail}`);
  if (c.expect === 'debt' && passed) {
    console.log(`        → ${c.id} now passes. Flip its expect to 'pass' so it can never regress.`);
  }
}

if (debts.length) {
  console.log(`\nTracked debt (${debts.length}) — owed by milestones, build stays green:`);
  for (const d of debts) console.log(`  · ${d.id} (${d.owedBy || 'unassigned'})`);
}

console.log('');
if (regressions || paid) {
  console.log(`STANDARDS RED: ${regressions} regression(s), ${paid} debt(s) newly paid (flip to 'pass').`);
  process.exit(1);
}
console.log(`STANDARDS GREEN: 0 regressions, ${debts.length} tracked debt(s).`);
process.exit(0);
