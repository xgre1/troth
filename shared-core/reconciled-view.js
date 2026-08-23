// SPDX-License-Identifier: AGPL-3.0-only
// reconciled-view - one truth, shown with its receipts.
//
// A count prompt that carries the understood stratum (instances) NEXT TO the
// raw statements hands the model two competing truths and asks it to judge
// which to trust - and prose arbitration oscillates. This module builds ONE
// view instead, mechanically: every ledger line names the raw statements
// that attest it (set arithmetic over provenance ids, no judgment), covered
// raw statements stay visible as SUPPORT (the mind's power to re-examine its
// primary record - never amputated), and only raw statements outside the
// ledger are offered for judgment. Surviving disagreement is FLAGGED, not
// silently resolved: doubt is shown, not buried.
'use strict';

// items: the retrieval output - instance-pool items carry refs (dialogue
// turn ids from provenance), raw dialogue items carry their own id.
// Returns { ledger, raw, render() }.
function buildReconciledView(items) {
  const instances = [];
  const raws = [];
  for (const it of (items || [])) {
    if (it.source === 'instance-pool') instances.push(it);
    else raws.push(it);
  }
  const rawIndex = new Map();  // action id -> raw entry
  const raw = raws.map((it, i) => {
    const entry = { n: i + 1, id: it.id, statement: it.statement, ts: it.ts, role: 'new', supports: [] };
    rawIndex.set(String(it.id), entry);
    return entry;
  });
  const ledger = instances.map((it, i) => {
    const refs = [];
    const flags = [];
    for (const ref of (it.refs || [])) {
      const id = String(ref).replace(/^dialogue\.turn:/, '');
      const hit = rawIndex.get(id);
      if (hit) {
        refs.push(hit.n);
        hit.role = 'supports';
        hit.supports.push(i + 1);
      }
    }
    if (!refs.length) flags.push('attested outside the shown statements');
    return { n: i + 1, statement: it.statement, refs, flags };
  });
  return {
    ledger,
    raw,
    render() {
      const lines = [];
      if (ledger.length) {
        lines.push('Consolidated ledger (each line is ONE real-world occurrence; its attestations are listed - never count an attestation separately):');
        for (const l of ledger) {
          lines.push('L' + l.n + '. ' + l.statement.replace(/^\[instance\]\s*/, '') +
            (l.refs.length ? ' (attested by ' + l.refs.map(n => 'S' + n).join(', ') + ')' : '') +
            (l.flags.length ? ' [flag: ' + l.flags.join('; ') + ']' : ''));
        }
        lines.push('');
      }
      lines.push('Memory statements:');
      for (const r of raw) {
        lines.push('S' + r.n + '. ' + r.statement +
          (r.role === 'supports' ? '  (supports ' + r.supports.map(n => 'L' + n).join(', ') + ' - already counted there)' : (ledger.length ? '  (not in the ledger - judge this one)' : '')));
      }
      return lines.join('\n');
    }
  };
}

module.exports = { buildReconciledView };
