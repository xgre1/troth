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
// Returns { ledger, cast, raw, render() }.
function buildReconciledView(items, opts) {
  const instances = [];
  const castItems = [];
  const raws = [];
  for (const it of (items || [])) {
    if (it.source === 'instance-pool') instances.push(it);
    else if (it.source === 'identity-cast') castItems.push(it);
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
  // Cast: identities the mounted material mentions. Distinctness questions
  // ("how many different doctors") are counted over people, not mentions,
  // so each cast line links the ledger AND statement lines that evidence
  // that person — over every registry-unique name it carries (an alias two
  // identities share renders but never joins).
  const _nameRe = (n) => {
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![a-z0-9])' + esc + '(?![a-z0-9])', 'i');
  };
  const cast = castItems.map((it, i) => {
    const m = /^\[cast\]\s*([^—(]+)/.exec(String(it.statement || ''));
    const parsed = m ? m[1].trim().toLowerCase() : '';
    const names = (Array.isArray(it.link_names) && it.link_names.length ? it.link_names : (parsed ? [parsed] : []))
      .map((n) => String(n).toLowerCase())
      .filter((n) => n.length >= 3);
    const res = names.map(_nameRe);
    const links = [];
    const slinks = [];
    for (const l of ledger) if (res.some((re) => re.test(String(l.statement)))) links.push(l.n);
    for (const r of raw) if (res.some((re) => re.test(String(r.statement)))) slinks.push(r.n);
    return { n: i + 1, statement: it.statement, links, slinks };
  });
  return {
    ledger,
    cast,
    raw,
    render() {
      const lines = [];
      if (ledger.length) {
        lines.push('Consolidated ledger (each line is ONE real-world occurrence; its attestations are listed - never count an attestation separately):');
        // No verb-matching prose here: a text rule that gates counting
        // cannot tell counting occurrences from summing quantities, and it
        // discarded quantity-bearing evidence the moment it shipped. The
        // qualifier lives structured on every line; discrimination belongs
        // to structure (question family + status maturation), not prose.
        // Ownership doctrine — measured: a possession's [completed] status read
        // as "done with it", and a real, still-owned tank was subtracted the
        // moment a newer one appeared. Completed acquisition means owned;
        // only explicit disposal ends ownership, and the header says so once.
        if (ledger.some((l) => /^(\[instance\]\s*)?possession:/.test(l.statement))) {
          lines.push('Possessions stay owned until an explicit disposal (sold, gave away, broke, returned) - a newer similar item never replaces an older one by itself.');
        }
        for (const l of ledger) {
          let text = l.statement.replace(/^\[instance\]\s*/, '');
          if (/^possession:/.test(text)) text = text.replace('[completed', '[owned');
          lines.push('L' + l.n + '. ' + text +
            (l.refs.length ? ' (attested by ' + l.refs.map(n => 'S' + n).join(', ') + ')' : '') +
            (l.flags.length ? ' [flag: ' + l.flags.join('; ') + ']' : ''));
        }
        lines.push('');
      }
      if (cast.length) {
        // The counting clause converts "distinct people mentioned nearby"
        // into "distinct occurrences" when the counted thing is NOT people
        // (measured: a weddings count read the cast's four people as four
        // weddings). Scope it: only a person-headed count question keeps the
        // clause; anything else gets the cast as a reading glossary. No head
        // supplied → the clause stays, exactly as before.
        const _head = opts && opts.noun_head ? String(opts.noun_head).toLowerCase().replace(/s$/, '') : null;
        const _PERSON_HEADS = new Set(['person', 'people', 'doctor', 'dentist', 'specialist', 'therapist', 'physician', 'friend', 'cousin', 'relative', 'sibling', 'colleague', 'neighbor', 'neighbour', 'provider', 'practitioner', 'contact', 'member', 'guest']);
        lines.push(!_head || _PERSON_HEADS.has(_head)
          ? 'Known people and entities here (identity registry) - when the question counts DISTINCT people or entities, count over THIS list, using ledger and statements as each one\'s evidence:'
          : 'Known people and entities here (identity registry) - a glossary for reading the evidence; the question does not count people, so this list is never what is counted:');
        for (const c of cast) {
          lines.push('C' + c.n + '. ' + c.statement.replace(/^\[cast\]\s*/, '') +
            (c.links.length ? ' (ledger: ' + c.links.map(n => 'L' + n).join(', ') + ')' : '') +
            (c.slinks && c.slinks.length ? ' (statements: ' + c.slinks.map(n => 'S' + n).join(', ') + ')' : ''));
        }
        lines.push('');
      }
      // The coverage marks live in ONE legend up here — measured: a per-line
      // "judge this one" clause got quoted back mid-reasoning and derailed an
      // enumeration. Statements stay clean; the marks stay terse.
      lines.push(ledger.length
        ? 'Memory statements ("=Ln" marks one already counted by ledger line Ln; "+" marks one the ledger does not cover - judge those individually):'
        : 'Memory statements:');
      for (const r of raw) {
        const mark = r.role === 'supports' ? ' [=' + r.supports.map(n => 'L' + n).join(',') + ']' : (ledger.length ? ' [+]' : '');
        lines.push('S' + r.n + '.' + mark + ' ' + r.statement);
      }
      return lines.join('\n');
    }
  };
}

module.exports = { buildReconciledView };
