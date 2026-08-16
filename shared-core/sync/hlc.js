// SPDX-License-Identifier: AGPL-3.0-only
// Hybrid Logical Clock, collatable-string form:
//
//   2026-08-16T12:00:00.000Z-0042-<node>
//
// Plain string comparison IS the ordering: ISO instant, then a zero-padded
// counter for same-millisecond events, then the node id as a tiebreak. The
// clock never arbitrates convergence — the hub's gseq is the only order
// that exists. What a stamp carries is operator INTENT time: the one signal
// that can tell a stale offline write from a deliberate correction when a
// dispute needs ranking. The system must stay correct if every stamp here
// were garbage.
'use strict';

function fmt(ms, count, node) {
  const c = Math.max(0, Math.min(9999, count | 0));
  return new Date(ms).toISOString() + '-' + String(c).padStart(4, '0') + '-' + String(node || 'n0');
}

function parse(s) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-(\d{4})-(.+)$/.exec(String(s || ''));
  if (!m) return null;
  const ms = Date.parse(m[1]);
  if (!Number.isFinite(ms)) return null;
  return { ms, count: parseInt(m[2], 10), node: m[3] };
}

// The next stamp after prev (a stamp this node issued or witnessed). A wall
// clock that stalls or steps backwards advances the counter instead — the
// sequence a node issues is strictly increasing no matter what its clock
// does.
function next(prev, node, nowMs) {
  const pt = typeof nowMs === 'number' ? nowMs : Date.now();
  const p = prev ? parse(prev) : null;
  if (!p || pt > p.ms) return fmt(pt, 0, node);
  return fmt(p.ms, p.count + 1, node);
}

module.exports = { next, parse, fmt };
