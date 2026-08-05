// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// sub-partner-budget — runtime enforcement of the caps every spawnSubPartner
// writes into the birth engram (max_duration_ms, max_intents, max_spend_usd).
//
// Until this module existed, the closed spawn path wrote those caps as plain
// metadata that nothing ever read — what the design spec calls "theater". A
// sub-partner could run forever, emit unbounded intents, and pretend it was
// budgeted. This module reads them on every intent write through the STVC
// predicate `sub_partner_within_budget` (registered in state-machine.js),
// turning the metadata into actual gates.
//
// Cost on read: O(intents_for_this_subpartner) per intent write. Defaults
// cap intents at 50 so the per-write count stays cheap. If a future
// deployment needs higher caps, swap this for a maintained counter row.

const engram = require('./engram.js');

const SUB_PARTNER_PREFIX = 'sub:';
const BIRTH_SCOPE_PREFIX = 'sub_partner:';

function isSubPartnerId(id) {
  return typeof id === 'string' && id.indexOf(SUB_PARTNER_PREFIX) === 0;
}

// Resolve the birth engram for a sub-partner. Returns
//   { ok:true, caps:{max_duration_ms,max_intents,max_spend_usd}, spawned_at_ms }
// or { ok:false, reason } if no birth engram is on record.
function getBirth(sub_partner_id) {
  if (!isSubPartnerId(sub_partner_id)) {
    return { ok: false, reason: 'not_a_sub_partner_id' };
  }
  const scope = BIRTH_SCOPE_PREFIX + sub_partner_id;
  let rows;
  try {
    rows = engram.listEngrams({
      scope,
      principal: null,            // any principal — sub may run cross-surface
      audience: 'all',
      limit: 50
    });
  } catch (e) {
    return { ok: false, reason: 'birth_lookup_threw:' + (e && e.message || e) };
  }
  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, reason: 'no_birth_engram' };
  }
  // The spawn writes the birth as source='sub-partner.spawnSubPartner'.
  // Pick the earliest such row — if multiple exist, the first one minted
  // the principal and its caps are the binding contract.
  const births = rows.filter((r) => r && r.source === 'sub-partner.spawnSubPartner');
  const row = births.length ? births[0] : rows[0];
  // Caps live in the persisted payload column. extra_output keys outside
  // the known column set are dropped on insert (state.js engram schema),
  // so sub-partner.spawnSubPartner nests them under extra_output.payload.
  let payload;
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}); }
  catch (_) { payload = {}; }
  return {
    ok: true,
    caps: {
      max_duration_ms: typeof payload.max_duration_ms === 'number' ? payload.max_duration_ms : (60 * 60 * 1000),
      max_intents:     typeof payload.max_intents     === 'number' ? payload.max_intents     : 50,
      max_spend_usd:   typeof payload.max_spend_usd   === 'number' ? payload.max_spend_usd   : 0
    },
    spawned_at_ms: typeof payload.spawned_at_ms === 'number'
      ? payload.spawned_at_ms
      : (row.ts || Date.now())
  };
}

// Count intents already written under this sub-partner's principal. intent
// engrams carry partner_id as a top-level column (state.js promotes it from
// extra_output on insert), so the filter is a column compare, not a JSON
// dig.
function countIntents(sub_partner_id) {
  if (!isSubPartnerId(sub_partner_id)) return 0;
  let rows;
  try {
    rows = engram.listEngrams({
      principal: null,
      audience: 'all',
      limit: 2000
    });
  } catch (_) { return 0; }
  let n = 0;
  for (const r of rows) {
    if (!r) continue;
    if (typeof r.scope !== 'string' || r.scope.indexOf('intent:') !== 0) continue;
    if (r.partner_id === sub_partner_id) n++;
  }
  return n;
}

// Returns null when the proposed intent is within budget, OR a refusal
// string. Refusal cases:
//   no birth engram (sub-partner principal isn't on record)
//   TTL elapsed since spawned_at_ms
//   already at or past max_intents
// Spend enforcement is not wired in this build; for now
// max_spend_usd is carried through but not checked here.
function evaluate(sub_partner_id, now) {
  if (!isSubPartnerId(sub_partner_id)) return null; // not a sub-partner — predicate is a no-op
  const b = getBirth(sub_partner_id);
  if (!b.ok) {
    return 'sub_partner_within_budget: ' + b.reason + ' for ' + sub_partner_id;
  }
  const ts = typeof now === 'number' ? now : Date.now();
  const elapsed = ts - b.spawned_at_ms;
  if (elapsed > b.caps.max_duration_ms) {
    return 'sub_partner_within_budget: TTL elapsed (' + elapsed + 'ms > ' + b.caps.max_duration_ms + 'ms)';
  }
  const used = countIntents(sub_partner_id);
  if (used >= b.caps.max_intents) {
    return 'sub_partner_within_budget: intent budget exhausted (' + used + '/' + b.caps.max_intents + ')';
  }
  return null;
}

module.exports = {
  SUB_PARTNER_PREFIX,
  isSubPartnerId,
  getBirth,
  countIntents,
  evaluate
};
