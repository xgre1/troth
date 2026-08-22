// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// authority-weights.js — THE single authority model (S3, standards/INVARIANTS.md).
//
// One coherent ranking model, not divergent copies. Before this, recall.js, the
// entity Phase-F identity read, and the proxy injector each carried their own
// copy of the authority gradient, so the partner ranked its own memory
// differently depending on which surface spoke (an internal audit). This module is the
// one source every surface calls.
//
// Gradient (OUR design): operator_confirmed > plr_evolved > llm_inferred >
// regex_extracted. Signature-rooted authority outranks self-evolved outranks
// model-inferred outranks regex-scraped. It discriminates among LABELED facts.
//
// UNLABELED rows (no source_authority) predate the labeling layer. That pool is
// dominated by low-trust provenance — test fixtures, seeds, deliberator
// drift-noise and watcher ingests — mixed with a minority of genuine operator
// facts (source=user / slash:deterministic:remember). So the default for
// unlabeled MUST stay conservative (regex_extracted weight): a blanket high
// default elevates test junk and drift noise to operator tier.
//
// The CORRECT upgrade is source-derived authority, NOT a blanket default:
// derive the tier from the engram's `source` provenance (which IS populated).
// That mapping is operator-approved (decision #4) and lives in the pending
// source-based backfill / read-time resolver — until it lands, unlabeled =
// regex_extracted, the known-good conservative floor.

const UNMIGRATED_SENTINEL = '__unmigrated__';

const AUTHORITY_WEIGHTS = Object.freeze({
  operator_confirmed: 1.00,
  plr_evolved:        0.90,
  llm_inferred:       0.60,
  regex_extracted:    0.30,
  // Unlabeled default = regex_extracted floor (conservative). Restored from the
  // d7b614f 1.00 regression after the live source distribution showed the
  // unlabeled pool is mostly test/seed/deliberator junk, not trusted history.
  [UNMIGRATED_SENTINEL]: 0.30,
});

// Resolve the authority weight for a source_authority value (which may be
// null/undefined on legacy rows). Missing → conservative unlabeled floor.
// This is the one function every surface calls.
function authorityWeightOf(srcAuthority) {
  const auth = srcAuthority || UNMIGRATED_SENTINEL;
  return AUTHORITY_WEIGHTS[auth] !== undefined
    ? AUTHORITY_WEIGHTS[auth]
    : AUTHORITY_WEIGHTS[UNMIGRATED_SENTINEL];
}

module.exports = { AUTHORITY_WEIGHTS, UNMIGRATED_SENTINEL, authorityWeightOf };
