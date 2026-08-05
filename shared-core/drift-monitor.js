// SPDX-License-Identifier: AGPL-3.0-only
// drift-monitor — Property #6 skeleton.
//
// Rolling-window analyzer over recent ActionRecords. Pure function; no
// I/O, no async, no LLM calls. Given an array of recent actions and a
// few knobs, returns four scalar drift scores plus a `signals` array
// that explains WHY each score landed where it did (so the Deliberator
// or a dashboard can drill in).
//
// This is the holistic monitor the entity design calls for. It is
// intentionally NOT the per-reply identity-alignment scorer in
// `drift-detector.js` (that one is G3 — embedding similarity vs anchors
// and refusals). Both are needed; they catch different failure modes:
//
//   drift-detector.js   →  "this single reply violates THIS commitment"
//   drift-monitor.js    →  "looking at the last N actions, the entity
//                           is showing systemic patterns we associate
//                           with degraded cognition"
//
// Detectors implemented (intentionally cheap, regex/heuristic level —
// see "Skeleton scope" below for the evolution path):
//
//   sycophancy       Phrase-bank match over assistant turns. Score is
//                    the fraction of assistant turns containing >=1
//                    sycophancy phrase.
//
//   tunnel_vision    Longest run of consecutive identical tool calls
//                    in the window. Score is run_length / window_size,
//                    capped at 1. Anything <= TUNNEL_RUN_FLOOR scores 0.
//
//   length_collapse  Compares mean assistant-turn length in the EARLIER
//                    half of the window vs the RECENT half. If the
//                    recent half is strictly shorter, score is the
//                    relative shrink (1 - recent/earlier). Strict-
//                    monotonic-down within the recent half required to
//                    fire — otherwise 0.
//
//   repetition       Max bigram-Jaccard overlap between any two
//                    assistant turns in the recent window. Score = max
//                    overlap; 0 when no pair overlaps meaningfully.
//
// Each fired detector contributes one entry to `signals`:
//   { kind, score, evidence: [action_id,...] }
// so the caller can look up the exact ActionRecords that drove the
// score. Empty `evidence` means the detector contributed but did not
// localize to specific records (e.g., length-trend across the whole
// window).
//
// ── Skeleton scope ─────────────────────────────────────────────────────
// What's here: simple, honest, deterministic heuristics. No corpus-
//   tuned thresholds, no per-domain calibration, no embedding model.
// What evolves later (per the design work):
//   Phrase bank → tuned classifier / embedding-based sycophancy detector
//   Tunnel-vision → tool-diversity entropy across full window, not
//     just longest-run
//   Length-collapse → segmented regression w/ confidence interval, so
//     legitimate "now we move to short answers" doesn't false-fire
//   Repetition → contrastive-decoded suffix overlap, not bag-of-bigrams
//   Cross-session correlation: a drift signal in session N feeds the
//     identity envelope of session N+1 (today: only same-window)
//   Pluggable detector registry so new patterns slot in without
//     touching the core analyze loop
// All of those need either a labeled corpus or runtime measurement;
// they belong in U2's resolution path, not in the skeleton.

// ── Tunables (constants, not env-driven yet — keep skeleton honest) ─────
const TUNNEL_RUN_FLOOR = 5;          // run >= this counts as tunnel (per spec: ">5x")
const REPETITION_RECENT_WINDOW = 6;  // last N assistant turns scanned for repetition
const LENGTH_RECENT_HALF = 0.5;      // split point for "recent" vs "earlier"
const SYCOPHANCY_PATTERNS = [
  /\byou(?:'?re|\s+are)\s+(?:absolutely\s+|completely\s+|totally\s+)?(?:right|correct)\b/i,
  /\bgreat\s+(?:point|question|idea|catch)\b/i,
  /\bexcellent\s+(?:point|question|idea|catch)\b/i,
  /\b(?:good|great)\s+catch\b/i,
  /\bi\s+(?:was|am)\s+(?:wrong|mistaken|incorrect)\b/i,
  /\bi\s+apologi[sz]e\b/i,
  /\bmy\s+(?:apologies|mistake|bad)\b/i,
  /\bi\s+stand\s+corrected\b/i,
  /\byou'?re\s+absolutely\s+right\b/i,
  /\bi\s+(?:agree|defer)\s+(?:completely|entirely)\b/i
];

// ── Helpers — extract semantic fields from generic ActionRecord rows ────
//
// Rows come from state.queryActions() and have JSON-string `input` /
// `output` columns. We accept either raw rows OR pre-parsed records
// (where `input` / `output` are already objects). Caller convenience.
function _parseField(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return {}; }
  }
  return {};
}

// Pull assistant-text out of an action. Recognizes:
//   dialogue.turn tool_call records (output.assistant_text)
//   generic records with output.text
//   decision records with output.reason (best-effort fallback)
function _assistantText(action) {
  if (!action) return null;
  const output = _parseField(action.output);
  if (typeof output.assistant_text === 'string' && output.assistant_text.length) {
    return output.assistant_text;
  }
  if (typeof output.text === 'string' && output.text.length) {
    return output.text;
  }
  return null;
}

// Pull tool name. Recognizes generic tool_call records and treats edits/
// reads/searches as their type-as-tool-name. Conversational tool_calls
// (dialogue.turn — the dialogue-memory wrapper) are NOT tool actions
// for the purposes of tunnel-vision: a sequence of replies is not a
// stuck loop. Returning null skips them in the detector.
function _toolName(action) {
  if (!action) return null;
  const input = _parseField(action.input);
  const tn = input.tool_name;
  if (typeof tn === 'string' && tn && tn !== 'dialogue.turn') return tn;
  if (action.type === 'edit' || action.type === 'read' || action.type === 'search') {
    return action.type;
  }
  return null;
}

function _id(action) {
  return action && (action.id || null);
}

// Bigrams over normalized whitespace-separated tokens. Cheap, deterministic.
function _bigrams(text) {
  const toks = String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
  if (toks.length < 2) return new Set();
  const out = new Set();
  for (let i = 0; i < toks.length - 1; i++) out.add(toks[i] + ' ' + toks[i + 1]);
  return out;
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// ── Detectors ───────────────────────────────────────────────────────────

function _detectSycophancy(actions) {
  const evidence = [];
  let assistantTurns = 0;
  let hits = 0;
  for (const a of actions) {
    const text = _assistantText(a);
    if (text == null) continue;
    assistantTurns++;
    for (const re of SYCOPHANCY_PATTERNS) {
      if (re.test(text)) { hits++; evidence.push(_id(a)); break; }
    }
  }
  if (assistantTurns === 0) return { score: 0, evidence: [] };
  return { score: Math.min(1, hits / assistantTurns), evidence };
}

function _detectTunnelVision(actions) {
  // Longest run of identical tool names. We only consider records that
  // actually carry a tool name — dialogue turns and decisions slip past
  // and don't break a run.
  const named = [];
  for (const a of actions) {
    const t = _toolName(a);
    if (t) named.push({ tool: t, id: _id(a) });
  }
  if (named.length < TUNNEL_RUN_FLOOR) return { score: 0, evidence: [] };
  let bestStart = 0;
  let bestLen = 1;
  let curStart = 0;
  let curLen = 1;
  for (let i = 1; i < named.length; i++) {
    if (named[i].tool === named[i - 1].tool) {
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = i;
      curLen = 1;
    }
  }
  if (bestLen < TUNNEL_RUN_FLOOR) return { score: 0, evidence: [] };
  const evidence = named.slice(bestStart, bestStart + bestLen).map(x => x.id).filter(Boolean);
  // Per spec: score = consecutive_count / window_size. Window size is
  // the number of named-tool actions we examined.
  const score = Math.min(1, bestLen / Math.max(1, named.length));
  return { score, evidence };
}

function _detectLengthCollapse(actions) {
  // Strictly-downward trend over assistant turns. If recent half is
  // shorter than earlier half AND each consecutive pair in the recent
  // half is non-increasing, fire with score 1 - recent/earlier.
  const lens = [];
  const ids  = [];
  for (const a of actions) {
    const text = _assistantText(a);
    if (text == null) continue;
    lens.push(text.length);
    ids.push(_id(a));
  }
  if (lens.length < 4) return { score: 0, evidence: [] };
  const splitAt = Math.floor(lens.length * (1 - LENGTH_RECENT_HALF));
  const earlier = lens.slice(0, splitAt);
  const recent  = lens.slice(splitAt);
  if (!earlier.length || !recent.length) return { score: 0, evidence: [] };
  // Strictly downward in recent half (allow equal once)?
  let strictlyDown = true;
  let drops = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) { strictlyDown = false; break; }
    if (recent[i] < recent[i - 1]) drops++;
  }
  if (!strictlyDown || drops === 0) return { score: 0, evidence: [] };
  const earlierAvg = earlier.reduce((s, x) => s + x, 0) / earlier.length;
  const recentAvg  = recent.reduce((s, x) => s + x, 0) / recent.length;
  if (earlierAvg <= 0 || recentAvg >= earlierAvg) return { score: 0, evidence: [] };
  const score = Math.max(0, Math.min(1, 1 - (recentAvg / earlierAvg)));
  return { score, evidence: ids.slice(splitAt).filter(Boolean) };
}

function _detectRepetition(actions) {
  // Bigram-Jaccard between recent assistant turns. Score = max pairwise.
  const turns = [];
  for (const a of actions) {
    const text = _assistantText(a);
    if (text == null) continue;
    turns.push({ id: _id(a), grams: _bigrams(text) });
  }
  if (turns.length < 2) return { score: 0, evidence: [] };
  const recent = turns.slice(-REPETITION_RECENT_WINDOW);
  let best = 0;
  let bestPair = null;
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const score = _jaccard(recent[i].grams, recent[j].grams);
      if (score > best) { best = score; bestPair = [recent[i].id, recent[j].id]; }
    }
  }
  if (best <= 0 || !bestPair) return { score: 0, evidence: [] };
  return { score: best, evidence: bestPair.filter(Boolean) };
}

// ── Public API ──────────────────────────────────────────────────────────

// analyzeWindow(actions, opts) → drift report.
//
// `actions` is an array of ActionRecord rows (from state.queryActions),
// or pre-parsed action objects. Order should be chronological (oldest
// first); the analyzer will accept reverse order too — it does not
// re-sort, so callers should pass `order:'asc'` when querying.
//
// `opts` is reserved for future per-detector knobs. The skeleton ignores
// it (signature is forward-compatible).
//
// Returns:
//   {
//     sycophancy:      0..1,
//     tunnel_vision:   0..1,
//     length_collapse: 0..1,
//     repetition:      0..1,
//     signals: [{ kind, score, evidence: [id,...] },...]
//   }
function analyzeWindow(actions, _opts) {
  const empty = {
    sycophancy: 0, tunnel_vision: 0, length_collapse: 0, repetition: 0, signals: []
  };
  if (!Array.isArray(actions) || actions.length === 0) return empty;

  const syc = _detectSycophancy(actions);
  const tun = _detectTunnelVision(actions);
  const len = _detectLengthCollapse(actions);
  const rep = _detectRepetition(actions);

  const signals = [];
  if (syc.score > 0) signals.push({ kind: 'sycophancy',      score: syc.score, evidence: syc.evidence });
  if (tun.score > 0) signals.push({ kind: 'tunnel_vision',   score: tun.score, evidence: tun.evidence });
  if (len.score > 0) signals.push({ kind: 'length_collapse', score: len.score, evidence: len.evidence });
  if (rep.score > 0) signals.push({ kind: 'repetition',      score: rep.score, evidence: rep.evidence });

  return {
    sycophancy:      syc.score,
    tunnel_vision:   tun.score,
    length_collapse: len.score,
    repetition:      rep.score,
    signals
  };
}

module.exports = {
  analyzeWindow,
  // Exported for tests + future tuning. Not part of the stable surface.
  _internal: {
    SYCOPHANCY_PATTERNS,
    TUNNEL_RUN_FLOOR,
    REPETITION_RECENT_WINDOW,
    _bigrams,
    _jaccard
  }
};
