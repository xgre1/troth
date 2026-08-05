// SPDX-License-Identifier: AGPL-3.0-only
// deliberator — Property #3 skeleton.
//
// Background task scheduler. the entity design calls for "contradiction
// detection, fact merging, consolidation, spontaneous reflection during
// idle periods." The orchestrator runs DURING tasks and the background
// worker runs on its own cadence; neither of them runs the cheap,
// always-on cognitive hygiene cycle the design requires.
//
// This module is that cycle. Each tick:
//   1. Pulls the last N ActionRecords from the substrate (state.queryActions).
//   2. Runs `drift-monitor.analyzeWindow` over them.
//   3. For every drift signal whose score exceeds threshold, writes an
//      engram (scope='system:drift') so the next session's identity
//      injection can surface it. Engrams are cheap, tagged, deduped at
//      retrieval — no risk of flooding the prefix.
//   4. Optionally runs a contradiction sweep over recent decisions; on
//      hit, writes a `system:contradiction` engram. (Skeleton: simple
//      lexical opposite-pair check; the real implementation uses
//      structured-claim extraction. See "Skeleton scope" below.)
//
// Design choices:
//   DEFAULT OFF. New cognitive process running on a timer is a real
//     cost (CPU, engram writes, possible model calls in future
//     iterations). We mirror the background-worker pattern: opt-in via
//     transport-config (`cfg.deliberator_enabled`, default false) OR
//     by passing `enabled: true` to start(). Production substrate
//     should not assume this is running.
//   tick is exposed for tests + manual drive. start/stop wrap it
//     in setTimeout so daemons can fire-and-forget. Match the background
//     worker style so operators have one mental model for substrate workers.
//   Notify callback (optional) emits structured events ('drift_signal',
//     'contradiction', 'tick_skipped') so a dashboard can render the
//     deliberator's activity without polling the engram store.
//
// ── Skeleton scope ──────────────────────────────────────────────────────
// What's here:
//   Periodic pull + drift-monitor + engram write pipeline
//   Naive contradiction detection (token-level opposite-pair on commitment statements)
//   Default-off, manually drivable, deterministic
// What evolves later (per the design work):
//   LLM-driven contradiction detection (structured-claim extraction
//     from recent decisions, then NLI between claims; or a small judge
//     model running on idle GPU)
//   - "Spontaneous reflection" — when an open question hasn't been
//     touched in N hours, prompt the language faculty with "is there a
//     new angle on X?" and record the result as a `background_insight`
//     ActionRecord
//   Cost-bounded scheduling (token budget + idle-detection so we
//     don't fire while the user is mid-turn)
//   Fact merging / consolidation — collapse near-duplicate engrams
//     written within a short window
//   Cross-session correlation — if signal X fired in 3 of the last 5
//     sessions, escalate to a hard commitment
// All of those are U6's resolution path, not the skeleton.

const cfg     = require('./transport-config.js');
const state   = require('./state.js');
const ar      = require('./action-record.js');
const engram  = require('./engram.js');
const drift   = require('./drift-monitor.js');

const DEFAULT_TICK_MS         = 60 * 1000;        // 60s — paper says "idle periods"
const DEFAULT_WINDOW_LIMIT    = 50;               // last N actions per tick
const DEFAULT_SCORE_THRESHOLD = 0.4;              // signal must exceed this to surface
const DRIFT_SCOPE             = 'system:drift';
const CONTRADICTION_SCOPE     = 'system:contradiction';

// Resolve the enabled flag with fail-closed defaults. `cfg.deliberator_enabled`
// is read via transport-config IF present; otherwise we honor the explicit
// opts.enabled flag; otherwise OFF. Mirrors the background-worker convention.
//
// Note: transport-config.get() throws on unknown fields, so we wrap. The
// field is intentionally NOT yet registered in BUILT_IN_DEFAULTS — the
// skeleton stays opt-in by explicit start() argument. Once empirical
// evaluation (U6) shows deliberation produces value, we register it.
function _resolveEnabled(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'enabled')) return !!opts.enabled;
  try {
    const v = cfg.get('deliberator_enabled');
    return !!v;
  } catch (_) {
    return false; // fail-closed
  }
}

class Deliberator {
  constructor(opts) {
    opts = opts || {};
    this._agent_id = opts.agent_id || null;
    this._cwd      = opts.cwd || null;
    this._user_id  = opts.user_id || 'default';
    this._tickMs   = typeof opts.tick_ms === 'number' ? opts.tick_ms : DEFAULT_TICK_MS;
    this._windowLimit = typeof opts.window_limit === 'number' ? opts.window_limit : DEFAULT_WINDOW_LIMIT;
    this._threshold   = typeof opts.threshold   === 'number' ? opts.threshold   : DEFAULT_SCORE_THRESHOLD;
    this._notify   = typeof opts.notify === 'function' ? opts.notify : null;
    this._enabled  = _resolveEnabled(opts);
    this._timer    = null;
    this._running  = false;
    // Deduplication: don't re-write the same drift kind within a single
    // tick burst. Reset every tick — cross-tick repeats ARE meaningful
    // (the issue is persistent), so we keep them.
  }

  _emit(kind, payload) {
    if (!this._notify) return;
    // Spread payload FIRST so the outer `kind` (the event channel) wins
    // when payload also carries an inner `kind` field (e.g. drift signal
    // kind). Without this the channel name was masked by sig.kind.
    try { this._notify({ ...(payload || {}), kind, ts: Date.now() }); } catch (_) {}
  }

  // start() boots the periodic timer. No-op if already started OR if
  // the deliberator is disabled (default). Returns this for chaining.
  start(opts) {
    if (this._running) return this;
    // Late-binding override: caller can flip enabled at start time.
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'enabled')) this._enabled = !!opts.enabled;
    if (!this._enabled) {
      this._emit('tick_skipped', { reason: 'disabled' });
      return this;
    }
    this._running = true;
    const loop = async () => {
      if (!this._running) return;
      try { await this.tick(); } catch (e) { this._emit('tick_threw', { error: String(e && e.message || e) }); }
      if (this._running) this._timer = setTimeout(loop, this._tickMs);
    };
    // First tick deferred so boot doesn't fire on cold substrate.
    this._timer = setTimeout(loop, this._tickMs);
    return this;
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  // tick() is the unit of work. Public + sync-safe (no awaiting required
  // engram + state writes are synchronous SQLite). Tests drive this
  // directly. Returns a structured summary so callers can assert on it.
  tick() {
    const summary = {
      ok: true,
      window_size: 0,
      drift: null,
      drift_engrams_written: 0,
      contradiction_engrams_written: 0
    };

    // Pull recent ActionRecords. Without an agent_id we still run, but
    // the substrate's isolation guards on engram.recordEngram + queries
    // mean cross-agent pollution is impossible: queryActions accepts a
    // null agent_id (returns all), but engram.recordEngram REQUIRES an
    // agent_id to write — so a no-agent_id deliberator is read-only.
    const rows = state.queryActions({
      agent_id: this._agent_id || undefined,
      cwd:      this._cwd || undefined,
      limit:    this._windowLimit,
      order:    'asc'
    }) || [];

    summary.window_size = rows.length;

    if (rows.length === 0) {
      this._emit('tick_skipped', { reason: 'empty_window' });
      return summary;
    }

    // Drift sweep
    const report = drift.analyzeWindow(rows, {});
    summary.drift = report;

    if (this._agent_id) {
      for (const sig of report.signals) {
        if (sig.score < this._threshold) continue;
        const id = engram.recordEngram({
          agent_id:  this._agent_id,
          user_id:   this._user_id,
          cwd:       this._cwd,
          statement: 'Drift signal "' + sig.kind + '" fired with score ' +
                     sig.score.toFixed(2) + ' over the last ' + rows.length + ' actions.',
          source:    'deliberator',
          scope:     DRIFT_SCOPE,
          salience:  Math.min(1, sig.score)
        });
        if (id) {
          summary.drift_engrams_written++;
          this._emit('drift_signal', { signal_kind: sig.kind, score: sig.score, engram_id: id });
        }
      }
    }

    // Contradiction sweep — naive skeleton: scan recent commitments for
    // statement pairs that share keywords but contain an opposite-pair
    // marker. Real implementation uses structured-claim NLI. See
    // "Skeleton scope" comment at top.
    const contradictions = this._detectContradictionsSkeleton(rows);
    if (this._agent_id) {
      for (const c of contradictions) {
        const id = engram.recordEngram({
          agent_id:  this._agent_id,
          user_id:   this._user_id,
          cwd:       this._cwd,
          statement: 'Possible contradiction between commitments: "' +
                     c.a.slice(0, 80) + '" vs "' + c.b.slice(0, 80) + '"',
          source:    'deliberator',
          scope:     CONTRADICTION_SCOPE,
          salience:  0.7
        });
        if (id) {
          summary.contradiction_engrams_written++;
          this._emit('contradiction', { engram_id: id });
        }
      }
    }

    return summary;
  }

  // Skeleton contradiction detection. Pulls recent commitment records,
  // pairs them up, and flags any pair where one contains a negation
  // marker the other doesn't, AND they share at least one >=4-letter
  // content word. False positives are expected — that's why the result
  // is a "possible contradiction" engram, not a hard alert. The U3 path
  // (the design work) replaces this with proper structured-claim NLI.
  _detectContradictionsSkeleton(rows) {
    const out = [];
    const stmts = [];
    for (const row of rows) {
      if (row.type !== 'commitment') continue;
      let output = row.output;
      if (typeof output === 'string') {
        try { output = JSON.parse(output); } catch (_) { output = {}; }
      }
      const s = output && output.statement;
      if (typeof s === 'string' && s.length) stmts.push(s);
    }
    if (stmts.length < 2) return out;
    const NEG = /\b(not|never|no|cannot|won'?t|don'?t|reject|refuse)\b/i;
    function tokens(s) {
      return new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
    }
    for (let i = 0; i < stmts.length; i++) {
      for (let j = i + 1; j < stmts.length; j++) {
        const negA = NEG.test(stmts[i]);
        const negB = NEG.test(stmts[j]);
        if (negA === negB) continue; // both or neither — no flip
        const ta = tokens(stmts[i]);
        const tb = tokens(stmts[j]);
        let shared = 0;
        for (const t of ta) if (tb.has(t)) shared++;
        if (shared >= 1) out.push({ a: stmts[i], b: stmts[j] });
      }
    }
    return out;
  }
}

module.exports = {
  Deliberator,
  DEFAULT_TICK_MS,
  DEFAULT_WINDOW_LIMIT,
  DEFAULT_SCORE_THRESHOLD,
  DRIFT_SCOPE,
  CONTRADICTION_SCOPE
};
