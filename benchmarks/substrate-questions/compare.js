#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Two reports side by side: facts hit, leaks and block size per road, and the
// items whose verdict changed between them.
// Usage: node benchmarks/substrate-questions/compare.js <report-a.json> <report-b.json>

const fs = require('fs');

const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('usage: node compare.js <report-a.json> <report-b.json>'); process.exit(2); }
const a = JSON.parse(fs.readFileSync(A, 'utf8'));
const b = JSON.parse(fs.readFileSync(B, 'utf8'));

console.log('\n=== ' + a.label + ' (' + a.head + ')  vs  ' + b.label + ' (' + b.head + ') ===');
for (const road of Object.keys(a.roads)) {
  const ra = a.roads[road];
  const rb = b.roads[road];
  if (!rb) { console.log('\n' + road + ': only in ' + a.label); continue; }
  const sa = ra.summary;
  const sb = rb.summary;
  console.log('\n' + road + ':');
  console.log('  facts   ' + sa.facts_hit + '/' + sa.facts_total + '  ->  ' + sb.facts_hit + '/' + sb.facts_total);
  console.log('  leaks   ' + sa.leaks + '  ->  ' + sb.leaks);
  console.log('  chars   ' + sa.mean_chars + '  ->  ' + sb.mean_chars);
  console.log('  ms      ' + sa.mean_ms + '  ->  ' + sb.mean_ms);
  const byId = new Map(rb.items.map((it) => [it.id, it]));
  for (const ia of ra.items) {
    const ib = byId.get(ia.id);
    if (!ib) continue;
    const va = ia.must_hit + '/' + ia.must_total + (ia.leaks.length ? ' leak' : '');
    const vb = ib.must_hit + '/' + ib.must_total + (ib.leaks.length ? ' leak' : '');
    if (va !== vb) console.log('  ' + ia.id + '  ' + va + '  ->  ' + vb + '   ' + String(ia.q).slice(0, 60));
  }
}
console.log('');
