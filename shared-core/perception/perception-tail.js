// SPDX-License-Identifier: AGPL-3.0-only
// Live-view perception tail (operator window into
// the browser observer). The substrate's browser observer writes
// perception engrams through the normal engram pipeline (recordEngram):
// durable, audience-tagged, recall-indexed — but NOT cheap to poll. The
// operator panel polls the control channel ~every 1.5s and wants "what
// has perception seen lately" without running an FTS query per tick.
//
// This module is a bounded in-memory TEE. The entity's observer
// writeEngram callback mirrors each engram here as it is written; the
// control:perception_tail + control:browser_state handlers read from it.
// Durable truth lives in the engram store — this is only a most-recent-N
// cache for the live view, lost on restart (acceptable: it is a view,
// not a record).
//
// Module singleton: the entity requires this once, so the observer
// callback and the control handlers share the same ring. __resetForTest
// lets hermetic tests start from a clean buffer.

'use strict';

const DEFAULT_MAX = 200;

let _max = DEFAULT_MAX;
const _ring = [];          // compact perception records, oldest → newest
let _lastBrowserState = null;

// Mirror one observer engram into the ring. Shape mirrors the
// engram-schemas output (class/scope/audience/statement/payload). Never
// throws — a live-view tee must never disturb the observer's write path.
function recordPerception(eng) {
  if (!eng || typeof eng !== 'object') return;
  const payload = (eng.payload && typeof eng.payload === 'object') ? eng.payload : {};
  const rec = {
    ts:        typeof payload.ts === 'number' ? payload.ts : Date.now(),
    class:     eng.class || null,
    scope:     eng.scope || null,
    audience:  eng.audience || null,
    statement: eng.statement || null,
    payload,
  };
  _ring.push(rec);
  if (_ring.length > _max) _ring.splice(0, _ring.length - _max);

  // page_visit carries the canonical page-level state the operator wants
  // in control:browser_state (current url/title/AX summary).
  if (rec.class === 'page_visit') {
    _lastBrowserState = {
      url:              payload.url || null,
      title:            payload.title || null,
      ax_node_count:    payload.ax_node_count || 0,
      semantic_summary: payload.semantic_summary || null,
      ax_graph_hash:    payload.ax_graph_hash || null,
      ts:               rec.ts,
    };
  }
}

// control:perception_tail — operator polls forward with since_ts; kind
// filters by engram class (e.g. 'page_visit') OR perception_event sub-kind
// (e.g. 'network'); limit caps the slice (clamped to the ring size).
function perceptionTail(opts) {
  opts = opts || {};
  const sinceTs = typeof opts.since_ts === 'number' ? opts.since_ts : 0;
  const cap = Math.min(parseInt(opts.limit, 10) || 50, _max);
  const kind = opts.kind || null;
  let out = _ring.filter((r) => r.ts > sinceTs);
  if (kind) {
    out = out.filter((r) => r.class === kind || (r.payload && r.payload.kind === kind));
  }
  out = out.slice(-cap);
  return { events: out, now_ts: Date.now(), buffered: _ring.length, max_buffered: _max };
}

// control:browser_state — the latest page-level state the observer saw.
// observer_connected/observer_active are merged in by the entity handler
// (they live on the observer instance, not in this pure module).
function browserState() {
  return { last_page: _lastBrowserState, now_ts: Date.now() };
}

function __resetForTest(max) {
  _ring.length = 0;
  _lastBrowserState = null;
  _max = (typeof max === 'number' && max > 0) ? max : DEFAULT_MAX;
}

module.exports = { recordPerception, perceptionTail, browserState, __resetForTest, DEFAULT_MAX };
