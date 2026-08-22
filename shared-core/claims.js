// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Facts the substrate can CHECK, not just recall.
//
// A memory row is a hypothesis about the world; the world moves. A
// substrate can hold "the repo is public" while GitHub says private, and
// a model — like the frontier models the STALE benchmark measures at 55%
// premise resistance — bridges the contradiction with a story instead of
// stopping. Retrieval cannot catch this: a stale fact
// still matches its query. Only a CHECK can.
//
// So a claim is a typed (subject, predicate, value) with a machine probe
// attached. The partial unique index in state.js makes two live values for
// one slot structurally impossible: asserting over an existing slot is an
// explicit supersession transaction (old row invalidated, event written,
// new row linked) — Graphiti's invalidation semantics enforced by SQLite
// instead of an LLM judge, Doyle's TMS bookkeeping in one table.
//
// Probes are TYPED and allowlisted — http_status / file_exists / gh_json —
// never arbitrary shell read from a database. A probe that contradicts its
// claim does not update anything silently: it flips the row to 'disputed',
// writes the event, and every serving path excludes disputed rows until an
// explicit resolution names which side was right (authority order: live
// observation > operator statement > agent inference). Fail-closed: a
// disputed memory is a memory the model does not get to lean on.
//
// Volatility sets the re-verification cadence (FreshLLMs' fact classes):
//   never — structural facts, checked only on demand
//   slow  — re-verify when older than 7 days (default)
//   fast  — re-verify when older than 1 hour

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let _state = null;
function state() {
  if (!_state) _state = require(path.join(__dirname, 'state.js'));
  return _state;
}
let _ar = null;
function ar() {
  if (!_ar) _ar = require(path.join(__dirname, 'action-record.js'));
  return _ar;
}
function db() { return state()._dbForQuery(); }

const TTL_MS = { never: Infinity, slow: 7 * 24 * 3600 * 1000, fast: 3600 * 1000 };

function _event(claim_id, kind, detail) {
  try {
    db().prepare('INSERT INTO claim_events (id, claim_id, ts, kind, detail) VALUES (?,?,?,?,?)')
      .run(ar().uuidv7(), claim_id, Date.now(), kind, detail ? String(detail).slice(0, 500) : null);
  } catch (_) { /* the event trail is best-effort; the row states are not */ }
}

// assertClaim — write a fact into its slot. Same value refreshes
// verified_at (a confirmation, not a duplicate); a different value is a
// SUPERSESSION and happens in one transaction or not at all.
function assertClaim(opts) {
  opts = opts || {};
  const subject = String(opts.subject || '').trim();
  const predicate = String(opts.predicate || '').trim();
  const value = String(opts.value === undefined ? '' : opts.value).trim();
  if (!subject || !predicate || !value) return { ok: false, error: 'subject, predicate and value are required' };
  const now = Date.now();
  const d = db();
  const live = d.prepare(
    'SELECT * FROM claims WHERE subject=? AND predicate=? AND invalid_at IS NULL'
  ).get(subject, predicate);

  if (live && live.value === value) {
    // A re-assertion may also CORRECT the probe (first field case: a healthy
    // 302 endpoint disputed by a probe that assumed 200 — the fact stood,
    // the check was wrong). New probe in hand = the dispute is being
    // resolved by fixing the instrument, so the row returns to live.
    if (opts.probe && opts.probe.kind) {
      d.prepare("UPDATE claims SET verified_at=?, status='live', probe_kind=?, probe_arg=? WHERE id=?")
        .run(now, String(opts.probe.kind), JSON.stringify(opts.probe), live.id);
      _event(live.id, 'probe_corrected', JSON.stringify(opts.probe).slice(0, 200));
      return { ok: true, id: live.id, action: 'probe_corrected' };
    }
    d.prepare('UPDATE claims SET verified_at=?, status=CASE WHEN status=\'disputed\' THEN status ELSE \'live\' END WHERE id=?')
      .run(now, live.id);
    _event(live.id, 'confirmed', 'same value re-asserted');
    return { ok: true, id: live.id, action: 'confirmed' };
  }

  const id = ar().uuidv7();
  const insert = d.prepare(`INSERT INTO claims
    (id, subject, predicate, value, valid_from, invalid_at, superseded_by, status,
     volatility, verified_at, probe_kind, probe_arg, source_rank, source, created_at)
    VALUES (?,?,?,?,?,NULL,NULL,'live',?,?,?,?,?,?,?)`);
  const args = [
    id, subject, predicate, value, now,
    TTL_MS[opts.volatility] ? opts.volatility : 'slow',
    opts.verified === false ? null : now,
    opts.probe && opts.probe.kind ? String(opts.probe.kind) : null,
    opts.probe ? JSON.stringify(opts.probe) : null,
    Number.isInteger(opts.source_rank) ? opts.source_rank : 2,
    opts.source ? String(opts.source).slice(0, 120) : null,
    now
  ];

  if (!live) {
    insert.run(...args);
    _event(id, 'asserted', value);
    return { ok: true, id, action: 'asserted' };
  }

  const tx = d.transaction(() => {
    d.prepare('UPDATE claims SET invalid_at=?, superseded_by=?, status=\'superseded\' WHERE id=?')
      .run(now, id, live.id);
    insert.run(...args);
  });
  tx();
  _event(live.id, 'superseded', 'by ' + id + ' (' + value + ')');
  _event(id, 'asserted', value + ' (supersedes ' + live.id + ')');
  return { ok: true, id, action: 'superseded', superseded: live.id };
}

function liveClaims(opts) {
  opts = opts || {};
  const d = db();
  const rows = opts.subject
    ? d.prepare("SELECT * FROM claims WHERE status='live' AND invalid_at IS NULL AND subject=?").all(String(opts.subject))
    : d.prepare("SELECT * FROM claims WHERE status='live' AND invalid_at IS NULL").all();
  return rows;
}

function disputedClaims() {
  return db().prepare("SELECT * FROM claims WHERE status='disputed' AND invalid_at IS NULL").all();
}

function needsVerification(row, now) {
  if (!row || !row.probe_kind) return false;
  const ttl = TTL_MS[row.volatility] || TTL_MS.slow;
  if (ttl === Infinity) return false;
  return ((now || Date.now()) - (row.verified_at || 0)) > ttl;
}

// ── Typed probe registry ────────────────────────────────────────────────────
// Each kind takes its own small argument object and answers
// { checked, matches, observed } — or { checked:false } when the world was
// unreachable (an unreachable probe NEVER disputes a claim; absence of
// evidence is not contradiction).

const PROBES = {
  file_exists(arg, cb) {
    let exists = false;
    try { exists = fs.existsSync(String(arg.path || '')); } catch (_) {}
    cb({ checked: true, matches: exists === (arg.expect !== false), observed: String(exists) });
  },
  http_status(arg, cb) {
    const url = String(arg.url || '');
    if (!/^https?:\/\//i.test(url)) return cb({ checked: false });
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      res.resume();
      const expect = Number(arg.expect_status || 200);
      cb({ checked: true, matches: res.statusCode === expect, observed: String(res.statusCode) });
    });
    req.on('error', () => cb({ checked: false }));
    req.on('timeout', () => { req.destroy(); cb({ checked: false }); });
    req.end();
  },
  gh_json(arg, cb) {
    // Fixed argv through execFile — no shell, no interpolation. jq_path is a
    // dot-path handed to gh's own --jq.
    const endpoint = String(arg.endpoint || '');
    const jqPath = String(arg.jq_path || '');
    if (!endpoint || !/^[.\w[\]"/-]+$/.test(jqPath)) return cb({ checked: false });
    execFile('gh', ['api', endpoint, '--jq', jqPath], { timeout: 15000 }, (err, stdout) => {
      if (err) return cb({ checked: false });
      const observed = String(stdout || '').trim();
      cb({ checked: true, matches: observed === String(arg.expect), observed });
    });
  }
};

function runProbe(row, cb) {
  let arg = null;
  try { arg = JSON.parse(row.probe_arg || 'null'); } catch (_) {}
  const kind = row.probe_kind && PROBES[row.probe_kind] ? row.probe_kind : null;
  if (!kind || !arg) return cb({ checked: false });
  try { PROBES[kind](arg, cb); } catch (_) { cb({ checked: false }); }
}

// verifyDue — re-run probes for live claims past their volatility TTL.
// A mismatch is a CONTRADICTION EVENT: the row flips to disputed (excluded
// from serving) and the caller gets it back to interrupt with — never to
// narrate over.
function verifyDue(opts, done) {
  if (typeof opts === 'function') { done = opts; opts = {}; }
  opts = opts || {};
  const now = Date.now();
  const due = liveClaims({}).filter(r => needsVerification(r, now));
  const disputes = [];
  let pending = due.length;
  if (!pending) return done && done({ checked: 0, disputes });
  for (const row of due) {
    runProbe(row, (res) => {
      if (res.checked && res.matches) {
        db().prepare('UPDATE claims SET verified_at=? WHERE id=?').run(Date.now(), row.id);
        _event(row.id, 'probe_ok', res.observed);
      } else if (res.checked && !res.matches) {
        db().prepare("UPDATE claims SET status='disputed' WHERE id=?").run(row.id);
        _event(row.id, 'probe_mismatch', 'claimed ' + row.value + ', observed ' + res.observed);
        disputes.push({ id: row.id, subject: row.subject, predicate: row.predicate, claimed: row.value, observed: res.observed });
      }
      if (--pending === 0 && done) done({ checked: due.length, disputes });
    });
  }
}

// resolveDispute — the ONLY road back from disputed. The resolver states
// which side was right; the ledger records why.
function resolveDispute(id, opts) {
  opts = opts || {};
  const d = db();
  const row = d.prepare('SELECT * FROM claims WHERE id=?').get(String(id));
  if (!row || row.status !== 'disputed') return { ok: false, error: 'no disputed claim with that id' };
  if (opts.action === 'confirm') {
    d.prepare("UPDATE claims SET status='live', verified_at=? WHERE id=?").run(Date.now(), row.id);
    _event(row.id, 'resolved', 'confirmed: ' + (opts.reason || 'operator/observation says the claim stands'));
    return { ok: true, action: 'confirmed' };
  }
  if (opts.action === 'supersede') {
    if (!opts.value) return { ok: false, error: 'supersede needs the observed value' };
    const r = assertClaim({
      subject: row.subject, predicate: row.predicate, value: opts.value,
      volatility: row.volatility, source_rank: 0, source: opts.reason || 'probe observation',
      probe: row.probe_arg ? JSON.parse(row.probe_arg) : null
    });
    _event(row.id, 'resolved', 'superseded by observation: ' + opts.value);
    return r;
  }
  return { ok: false, error: 'action must be confirm or supersede' };
}

module.exports = {
  assertClaim, liveClaims, disputedClaims, needsVerification,
  runProbe, verifyDue, resolveDispute, _TTL_MS: TTL_MS
};
