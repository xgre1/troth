// SPDX-License-Identifier: AGPL-3.0-only
// The replica — a full mind on every device.
//
// A following device keeps its OWN complete substrate. Writes land locally
// in the caller's breath and ride the outbox up; everyone else's events
// flow down through the hub's feed and are applied here, strictly in the
// hub's order, through the same catalogue handlers the hub itself trusts.
// The device's own events come back in the feed too and are skipped by
// device_id: they were applied at write time.
//
// Offline is full function — recall, dialogue, everything answers from the
// local copy; the outbox holds what was said and the feed position waits.
// Reconnection drains both directions by itself.
//
// First breath: a fresh replica bootstraps from the hub's baseline (the
// whole mind as id-keyed atlas NDJSON, the same road the move file rides)
// stamped with the journal position it was cut at, then pulls events from
// that stamp. Baseline plus deltas; ids make both re-runnable.
//
// Honesty ledger: applying an event and advancing the position are not one
// transaction (handlers embed through the local embedder and may await), so
// a crash between them re-applies one event on the next pull. Events carry
// their author's record ids, so the re-apply lands on the same id and the
// domain guards (id conflict, dialogue window, rule similarity) absorb it.
// An event this build cannot interpret STOPS the feed and says so — silent
// skipping is how two replicas quietly stop being the same mind.
'use strict';

const state = require('../state.js');

let _pulling = null;

function _kvGet(k) {
  try { const r = state.db().prepare('SELECT v FROM sync_client_state WHERE k = ?').get(k); return r ? r.v : null; }
  catch (_) { return null; }
}
function _kvSet(k, v) {
  state.db().prepare('INSERT INTO sync_client_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, String(v));
}

function appliedGseq() { return parseInt(_kvGet('replica_applied_gseq') || '0', 10) || 0; }
function bootstrapped() { return _kvGet('replica_bootstrapped') === '1'; }
function quarantined() { return _kvGet('replica_quarantined_op') || null; }

function _embeddingHost() {
  try { return require('../transport-config.js').embeddingHost(); }
  catch (_) { return null; }
}

// Apply ONE foreign event through the same one-road handlers. Returns false
// only for quarantine (unknown op) — a domain refusal still advances, the
// same anti-stall the hub lives by.
async function _applyOne(ev, myDeviceId) {
  if (ev.device_id === myDeviceId) return true; // our own echo — applied at write time
  const catalogue = require('./catalogue.js');
  const resolved = catalogue.getOp(ev.op, ev.op_v);
  if (resolved.error) {
    _kvSet('replica_quarantined_op', ev.op + '@v' + ev.op_v + ' (gseq ' + ev.gseq + ')');
    return false;
  }
  if (resolved.entry.kind !== 'write') return true; // nothing to replay
  try {
    await resolved.entry.run(ev.args || {}, {
      _local: true,
      agent_id: (ev.ctx && ev.ctx.agent_id) || ('device:' + ev.device_id),
      user_id: (ev.ctx && ev.ctx.user_id) || 'default',
      cwd: (ev.ctx && ev.ctx.cwd) || null,
      device_id: ev.device_id,
      embedding_host: _embeddingHost()
    });
  } catch (_) { /* a domain refusal is applied history, not a retry */ }
  return true;
}

// Pull the feed until it runs dry. Serial by construction.
function pull() {
  if (_pulling) return _pulling;
  _pulling = _pullLoop().finally(() => { _pulling = null; });
  return _pulling;
}

async function _pullLoop() {
  const rc = require('./remote-client.js');
  if (!rc.active()) return { pulled: 0 };
  if (quarantined()) return { pulled: 0, quarantined: quarantined() };
  const myId = rc.status().device_id;
  if (!bootstrapped()) {
    const b = await bootstrap();
    if (!b.ok) return { pulled: 0, blocked: b.error };
  }
  let n = 0;
  for (;;) {
    const res = await rc.request('GET', '/api/sync/events?since=' + appliedGseq() + '&limit=200', null);
    if (!res || res.transport_error || !res.ok) return { pulled: n, blocked: (res && res.error) || 'unreachable' };
    const events = res.events || [];
    if (!events.length) break;
    for (const ev of events) {
      const ok = await _applyOne(ev, myId);
      if (!ok) return { pulled: n, quarantined: quarantined() };
      _kvSet('replica_applied_gseq', ev.gseq);
      n++;
    }
  }
  return { pulled: n };
}

// The first breath: baseline atlas + position stamp.
async function bootstrap() {
  const rc = require('./remote-client.js');
  const res = await rc.request('GET', '/api/sync/baseline', null);
  if (!res || res.transport_error || !res.ok) return { ok: false, error: (res && res.error) || 'unreachable' };
  try {
    let ndjson = String(res.atlas_ndjson || '');
    if (res.atlas_encoding === 'gzip+base64') {
      ndjson = require('zlib').gunzipSync(Buffer.from(ndjson, 'base64')).toString('utf8');
    }
    if (ndjson.trim()) {
      const atlas = require('../atlas.js');
      atlas.importAtlas(state, ndjson, { conflict: 'skip' });
    }
    _kvSet('replica_applied_gseq', res.latest_gseq | 0);
    _kvSet('replica_bootstrapped', '1');
    return { ok: true, at: res.latest_gseq | 0, memories: res.atlas_count };
  } catch (e) {
    return { ok: false, error: 'baseline_import_failed: ' + String(e && e.message || e).slice(0, 200) };
  }
}

function status() {
  return {
    bootstrapped: bootstrapped(),
    applied_gseq: appliedGseq(),
    quarantined: quarantined()
  };
}

module.exports = { pull, bootstrap, status, appliedGseq, _applyOne };
