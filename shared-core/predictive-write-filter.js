// SPDX-License-Identifier: AGPL-3.0-only
// predictive-write-filter — PRWF.
//
// Architectural shift: instead of append-and-store every ActionRecord
// (the Letta/Mem0/Zep pattern), maintain a generative model of the
// agent's action stream and write only the SURPRISING actions —
// records the model couldn't have predicted from recent context.
// Routine, highly-predictable sequences (formatting → compile → test
// over and over) are dropped at the storage layer.
//
// Grounded in Karl Friston's free-energy principle: biological brains
// don't log every input; they keep a generative model and transmit
// only prediction-error residuals. The substrate version of that:
// substrate keeps a cheap n-gram Markov chain over action signatures
// (tool_name for tool_calls, input.kind for decisions, type for
// everything else), predicts the next action's probability given
// recent history, and writes only when probability falls below the
// surprise threshold.
//
// Falsifiable target from the paper: 85% reduction in write volume on
// routine sequences while preserving 100% recall on anomalies. The
// test PRWF5 measures both bounds against a synthetic stream.
//
// What we DO:
//   1. actionSignature(rec) — extract a compact string per record so
//      the n-gram model has finite vocabulary
//   2. buildModel(signatures, n) — count n-gram → next transitions
//   3. predictProbability(model, history, candidate, n) — conditional
//      probability of `candidate` given the last `n` signatures
//   4. shouldWriteAction(model, history, candidate, opts) — boolean
//      gate; true when surprise (1 - probability) is high enough
//   5. makePredictor(opts) — stateful wrapper that maintains a
//      sliding window of recent signatures per (agent_id, cwd) so the
//      model stays current without re-bootstrapping every call
//
// What we DO NOT do:
//   Modify state.recordAction. Wiring is opt-in: callers pass their
//     records through the predictor before calling recordAction. This
//     avoids breaking the dozens of existing call sites and lets us
//     measure write-volume reduction without disrupting production
//     telemetry until we trust the model.
//   Train a real neural model. The paper's prototype scope is
//     explicit: "a simple n-gram Markov chain over the intents and
//     edits sequence within the SQLite database." Anything heavier is
//     premature.

const DEFAULT_NGRAM = 2;
const DEFAULT_SURPRISE_THRESHOLD = 0.85;  // write if prob_predicted < 0.85
const DEFAULT_MIN_HISTORY = 3;            // need ≥3 prior signatures to predict
const DEFAULT_HISTORY_CAP = 200;          // sliding window per scope

// ── Action signature ───────────────────────────────────────────────────

// Compact string that identifies the "kind" of action for n-gram
// modeling. More specific than `type` (so Bash and Edit are distinct
// signatures even though both are tool_calls), but bounded vocabulary
// so the n-gram model doesn't explode.
function actionSignature(rec) {
  if (!rec || !rec.type) return null;
  if (rec.type === 'tool_call') {
    const name = (rec.input && rec.input.tool_name) || 'unknown';
    return 'tool:' + name;
  }
  if (rec.type === 'decision') {
    const kind = (rec.input && rec.input.kind) || 'untyped';
    return 'decision:' + kind;
  }
  return 'type:' + rec.type;
}

// ── Markov n-gram model ────────────────────────────────────────────────

// Build the model from an ordered sequence of signatures.
// Returns Map<context_key, Map<next_signature, count>> where
// context_key = signatures[i..i+n-1].join('|').
function buildModel(signatures, n) {
  n = n || DEFAULT_NGRAM;
  const model = new Map();
  if (!Array.isArray(signatures) || signatures.length <= n) return model;
  for (let i = 0; i + n < signatures.length; i++) {
    const ctx = signatures.slice(i, i + n).join('|');
    const next = signatures[i + n];
    if (!next) continue;
    let counts = model.get(ctx);
    if (!counts) { counts = new Map(); model.set(ctx, counts); }
    counts.set(next, (counts.get(next) || 0) + 1);
  }
  return model;
}

// Conditional probability of `candidate` given `history`'s last n.
// Returns null when context hasn't been seen (the caller treats this
// as "high surprise — write" by default).
function predictProbability(model, history, candidate, n) {
  n = n || DEFAULT_NGRAM;
  if (!model || !Array.isArray(history) || history.length < n) return null;
  const ctx = history.slice(-n).join('|');
  const counts = model.get(ctx);
  if (!counts || !counts.size) return null;
  let total = 0;
  for (const c of counts.values()) total += c;
  if (!total) return null;
  const hit = counts.get(candidate) || 0;
  return hit / total;
}

// Returns true when this action is surprising enough to be worth
// writing. Default behavior:
//   First few actions (history < min_history) → always write
//   Unseen context (predict returns null) → always write
//   Predicted probability < threshold → write (it's surprising)
//   Predicted probability ≥ threshold → SKIP (it's expected)
function shouldWriteAction(model, history, candidate, opts) {
  opts = opts || {};
  const n = opts.n || DEFAULT_NGRAM;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_SURPRISE_THRESHOLD;
  const minHistory = typeof opts.min_history === 'number' ? opts.min_history : DEFAULT_MIN_HISTORY;
  if (history.length < minHistory) return { write: true, reason: 'cold_start', probability: null };
  const p = predictProbability(model, history, candidate, n);
  if (p === null) return { write: true, reason: 'unseen_context', probability: null };
  if (p < threshold) return { write: true, reason: 'surprising', probability: p };
  return { write: false, reason: 'expected', probability: p };
}

// ── Stateful predictor (per-scope sliding window) ─────────────────────

// Maintains a separate Markov model per (agent_id, cwd) scope so that
// patterns from one project don't pollute another. Sliding window cap
// prevents unbounded memory growth in long-lived processes.
function makePredictor(opts) {
  opts = opts || {};
  const n = opts.n || DEFAULT_NGRAM;
  const cap = opts.history_cap || DEFAULT_HISTORY_CAP;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_SURPRISE_THRESHOLD;
  const minHistory = typeof opts.min_history === 'number' ? opts.min_history : DEFAULT_MIN_HISTORY;

  // Map<scope_key, { history: string[], model: Map }>
  const scopes = new Map();
  const stats = { observed: 0, written: 0, skipped: 0 };

  function scopeKey(rec) {
    const a = (rec && rec.agent_id) || '_';
    const c = (rec && rec.cwd) || '_';
    return a + '::' + c;
  }

  function ensureScope(key) {
    let s = scopes.get(key);
    if (!s) { s = { history: [], model: new Map() }; scopes.set(key, s); }
    return s;
  }

  function bootstrap(rec, signatures) {
    if (!rec || !Array.isArray(signatures)) return;
    const s = ensureScope(scopeKey(rec));
    s.history = signatures.slice(-cap);
    s.model = buildModel(s.history, n);
  }

  function observe(rec) {
    const sig = actionSignature(rec);
    if (!sig) return;
    const s = ensureScope(scopeKey(rec));
    s.history.push(sig);
    if (s.history.length > cap) s.history.shift();
    // Re-add the new transition to the model (incremental update,
    // cheaper than rebuilding).
    if (s.history.length > n) {
      const ctx = s.history.slice(-n - 1, -1).join('|');
      let counts = s.model.get(ctx);
      if (!counts) { counts = new Map(); s.model.set(ctx, counts); }
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
    stats.observed++;
  }

  function decide(rec) {
    const sig = actionSignature(rec);
    if (!sig) return { write: true, reason: 'no_signature', probability: null };
    const s = ensureScope(scopeKey(rec));
    return shouldWriteAction(s.model, s.history, sig, { n, threshold, min_history: minHistory });
  }

  function noteWritten() { stats.written++; }
  function noteSkipped() { stats.skipped++; }
  function getStats()    { return Object.assign({}, stats); }

  return { bootstrap, observe, decide, noteWritten, noteSkipped, getStats, _scopes: scopes };
}

// ── Opt-OUT wrapper around state.recordAction ─────────────────────────

// Callers that want PRWF gating use this instead of state.recordAction
// directly. Default-ON (mirror of TMMA write-time QC default — Phase 2d):
// substrate-as-mind operational thickening means the brain's prediction
// model gates writes by default, opt-out via TROTH_PRWF=0. When the
// predictor says skip, the record is dropped and skipped++ — observe
// runs EITHER WAY so the model keeps tracking the real action stream
// even when individual actions get dropped (otherwise the model would
// learn from a censored distribution). Activated  — // graduates from shipped-but-shelved to default operational.
function recordActionFiltered(state, predictor, rec, searchText, opts) {
  opts = opts || {};
  const enabled = opts.enabled !== undefined ? opts.enabled : (process.env.TROTH_PRWF !== '0');
  if (!enabled || !predictor) {
    if (predictor) predictor.observe(rec);
    return state.recordAction(rec, searchText);
  }
  const verdict = predictor.decide(rec);
  predictor.observe(rec);
  if (verdict.write) {
    predictor.noteWritten();
    return state.recordAction(rec, searchText);
  }
  predictor.noteSkipped();
  return null;
}

module.exports = {
  actionSignature,
  buildModel,
  predictProbability,
  shouldWriteAction,
  makePredictor,
  recordActionFiltered,
  DEFAULT_NGRAM,
  DEFAULT_SURPRISE_THRESHOLD,
  DEFAULT_MIN_HISTORY,
  DEFAULT_HISTORY_CAP
};
