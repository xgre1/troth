// SPDX-License-Identifier: AGPL-3.0-only
// lability-reconsolidation — Lability-Window Reconsolidation
// graduation from the substrate design work.
//
// What the paper says: emulating the neurobiological reconsolidation
// mechanism — memories are rewritten every time they are fetched.
// When the substrate retrieves a commitment to fulfill a prompt,
// that commitment enters a 10-minute lability window. If the agent's
// subsequent actions CONTRADICT the retrieved memory (high prediction
// error), the substrate writes a reconsolidated successor commitment
// that supersedes the prior one. If actions ALIGN, the access counter
// is incremented, deepening the memory's half-life and preventing
// decay.
//
// Pre-this-ship: Phase E TMMA gave us write-time contradiction
// flagging (`engram-verify.js`), which is the cousin mechanism. PLR
// adds the retrieval-time companion: not just "this NEW write
// contradicts a prior one" but "this OLD memory is now contradicted
// by fresh action-stream evidence."
//
// Falsifiability spec from the paper:
//   Insert a false architectural fact into the database
//   Force the agent to retrieve it
//   Provide ground-truth feedback that contradicts the fact
//   Within 10 minutes, the substrate must autonomously overwrite
//     the original SQLite entry with the corrected fact
//
// Schema fit: commitments are append-only; "supersedes" is recorded
// in `output.lifetime.supersedes` per action-record.js TYPES.
// commitment doc. Reconsolidation = write a NEW commitment with a
// supersedes pointer; the "current view" follows the supersession
// chain. Phase E TMMA tier='flagged' is used for the contradicted
// engram so the injector skips it.
//
// What we DO:
//   1. markRetrieved(state, engram_id, opts) — bump access counter
//      and lability window timestamp on the engram (retrieval
//      reinforces; per the paper, "increments an access reinforcement
//      counter, deepening the memory's half-life")
//   2. assessActionAgainstRetrieved(state, retrieved_ids, action_text,
//      opts) — for each retrieved engram in its lability window
//      (default 10 min), compute Jaccard overlap with the action's
//      text; flag high-disagreement pairs
//   3. reconsolidate(state, prior_engram, new_statement, opts) —
//      write a new commitment with output.lifetime.supersedes
//      pointing at prior_engram.id, and (as a side effect) tag the
//      prior engram tier='flagged' via Phase E if shared-core/
//      engram-verify.js is reachable
//
// What we DO NOT do:
//   Modify existing commitments in-place (event-sourced principle).
//   Use real prediction error from a generative model — Jaccard
//     overlap is the prototype scope (matches PRWF's & engram-
//     verify.js's existing approach so signals stay comparable).

const DEFAULT_LABILITY_MS = 10 * 60 * 1000; // 10 minutes per paper
const DEFAULT_CONTRADICTION_THRESHOLD = 0.30; // Jaccard ≤ 0.30 → likely contradicts
// Expanded to mirror engram-verify.js vocabulary. Prior
// minimal set never matched the actual contradiction signals operators
// produce ("dislike", "hate", "avoid" never tripped polarity_flip),
// leaving lifetime.supersedes=0 across 30-day production windows.
// Adding the verb-family negators closes the detection gap.
const NEGATION_TOKENS = new Set([
  'not','never','no','none','nothing','neither','nor','without',
  'cannot','cant','wont','isnt','wasnt','arent','werent','dont','doesnt',
  'didnt','hasnt','havent','shouldnt','wouldnt','couldnt',
  'dislike','dislikes','hate','hates','avoid','avoids',
  'reject','rejects','refuse','refuses','disable','disables'
]);

// Verb pairs that flip polarity without explicit negation token.
// Mirror engram-verify.js NEGATION_OPPOSITES — same map used at write-
// time should drive read-time reconsolidation, otherwise the two
// detectors disagree on what counts as contradiction.
const NEGATION_OPPOSITES = Object.freeze({
  'love':'hate', 'hate':'love',
  'loves':'hates', 'hates':'loves',
  'like':'dislike', 'dislike':'like',
  'likes':'dislikes', 'dislikes':'likes',
  'prefer':'avoid', 'avoid':'prefer',
  'prefers':'avoids', 'avoids':'prefers',
  'always':'never', 'never':'always',
  'use':'avoid', 'uses':'avoids',
  'enable':'disable', 'disable':'enable',
  'enables':'disables', 'disables':'enables'
});

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/).filter(t => t && t.length >= 3)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function hasNegationFlip(a, b) {
  // Detect polarity contradiction via two signals:
  // 1. Explicit negation token in one side, absent from the other
  // 2. Verb-pair opposite present (love/hate, like/dislike, etc.)
  //    that flips polarity even without explicit "not"
  let aNeg = false, bNeg = false;
  for (const t of a) if (NEGATION_TOKENS.has(t)) aNeg = true;
  for (const t of b) if (NEGATION_TOKENS.has(t)) bNeg = true;
  if (aNeg !== bNeg) return true;
  // Verb-pair opposites: any token in a that has its opposite in b
  for (const t of a) {
    const opp = NEGATION_OPPOSITES[t];
    if (opp && b.has(opp)) return true;
  }
  return false;
}

// markRetrieved bumps in-memory accounting for the retrieved engram.
// Since commitments are immutable, we don't UPDATE the row — instead
// we write a `decision` record with kind='engram_retrieval' carrying
// the engram_id. Later assessment reads recent retrievals to find
// labile engrams.
function markRetrieved(opts) {
  opts = opts || {};
  const state = opts.state;
  const engram_id = opts.engram_id;
  if (!state || !engram_id) return null;
  const ar = require('./action-record.js');
  const rec = {
    id: ar.uuidv7(),
    timestamp: Date.now(),
    type: 'decision',
    agent_id: opts.agent_id || 'troth-deliberator',
    cwd: opts.cwd || null,
    user_id: opts.user_id || 'default',
    input: {
      kind: 'engram_retrieval',
      signals: { engram_id }
    },
    output: { decision: 'retrieved', reason: 'lability_window_open' }
  };
  const v = ar.validate(rec);
  if (!v.ok) return null;
  state.recordAction(rec, ar.toSearchText(rec));
  return rec.id;
}

// Pull recent engram_retrieval records (last lability_ms), look up
// the underlying engram statements, score each against the new
// action's text. Returns a list of suspected-contradictions:
// [{engram_id, similarity, contradiction_kind, prior_statement}].
function assessActionAgainstRetrieved(opts) {
  opts = opts || {};
  const state = opts.state;
  const action_text = opts.action_text || '';
  const labilityMs = opts.lability_ms || DEFAULT_LABILITY_MS;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_CONTRADICTION_THRESHOLD;
  if (!state || !action_text) return [];
  const since = Date.now() - labilityMs;
  //  (single-mind) — PLR-revival root-cause fix. The lability
  // window is PERSON-scoped, not cwd-scoped: the substrate is ONE mind
  // (substrate-as-subject; anchors/identity are cross-cwd),
  // so a belief retrieved in one project and contradicted in another is
  // STILL a reconsolidation candidate. The prior cwd filter (WHERE cwd=@cwd)
  // silently dropped EVERY retrieval markRetrieved'd without a cwd — which is
  // exactly the engram.js:_triggerPLR path (it calls markRetrieved with no
  // cwd) — so the assessment pool was always empty from that surface and
  // reconsolidation_candidate count stayed 0 forever an internal audit. This is
  // the same cwd-partitioning bug class fixed in recall.js. Query retrievals
  // person-wide; the contradiction signal itself (Jaccard + negation) is what
  // gates a candidate, not which folder the turn happened in.
  const decisions = state.queryActions({
    type: 'decision', since, limit: 200, order: 'desc'
  }) || [];
  const labileEngramIds = new Set();
  for (const row of decisions) {
    const inp = (typeof row.input === 'string') ? safeJson(row.input) : row.input;
    if (!inp || inp.kind !== 'engram_retrieval') continue;
    const eid = inp.signals && inp.signals.engram_id;
    if (eid) labileEngramIds.add(eid);
  }
  if (!labileEngramIds.size) return [];

  const actionTokens = tokenize(action_text);
  const out = [];
  for (const eid of labileEngramIds) {
    const engRow = state.getAction && state.getAction(eid);
    if (!engRow) continue;
    const eo = (typeof engRow.output === 'string') ? safeJson(engRow.output) : engRow.output;
    const stmt = eo && eo.statement;
    if (!stmt) continue;
    const stmtTokens = tokenize(stmt);
    const sim = jaccard(actionTokens, stmtTokens);
    const negationFlip = hasNegationFlip(actionTokens, stmtTokens);
    // Two contradiction signals:
    //   1. Low Jaccard but shared key tokens → topic-mismatch
    //   2. Negation flip with high overlap → polarity-flip
    let contradiction_kind = null;
    if (negationFlip && sim >= 0.30) contradiction_kind = 'polarity_flip';
    else if (sim < threshold && sim > 0) contradiction_kind = 'topic_mismatch';
    if (contradiction_kind) {
      out.push({
        engram_id: eid,
        similarity: sim,
        contradiction_kind,
        prior_statement: stmt
      });
    }
  }
  return out;
}

// Reconsolidate: write a new commitment with output.lifetime.supersedes
// pointing at the prior engram. Tags the new record commitment_type
// matching the prior. Side-effect: tries to flag the prior engram via
// Phase E engram-verify if available.
function reconsolidate(opts) {
  opts = opts || {};
  const state = opts.state;
  const prior_engram = opts.prior_engram;
  const new_statement = opts.new_statement;
  if (!state || !prior_engram || !new_statement) return null;
  const ar = require('./action-record.js');
  const priorOut = (typeof prior_engram.output === 'string') ? safeJson(prior_engram.output) : prior_engram.output;
  if (!priorOut) return null;

  const rec = {
    id: ar.uuidv7(),
    timestamp: Date.now(),
    type: 'commitment',
    agent_id: opts.agent_id || prior_engram.agent_id || 'troth-deliberator',
    cwd: opts.cwd || prior_engram.cwd || null,
    user_id: opts.user_id || prior_engram.user_id || 'default',
    parent_id: prior_engram.id,
    // L1/L2 PLR completion: inherit audience +
    // memory_class from the prior. Without this the successor lands
    // NULL → self-heal backfills to substrate_internal+operational,
    // which is the WRONG audience/class for the corrected fact and
    // makes the supersession invisible at recall time (predecessor's
    // class differs from successor's, audience filter excludes the
    // successor from model_visible queries). The corrected fact has
    // the same identity as the original; it must surface where the
    // original would have.
    audience:     prior_engram.audience     || 'model_visible',
    memory_class: prior_engram.memory_class || 'episodic',
    input: {
      source: 'lability_reconsolidation',
      trigger_text: opts.trigger_text || ''
    },
    output: {
      statement: new_statement,
      commitment_type: priorOut.commitment_type || 'engram',
      salience: typeof priorOut.salience === 'number' ? priorOut.salience : 1.0,
      // opts.tier lets callers (e.g. identity pool cleanup)
      // write the successor as 'flagged' so it doesn't itself surface in
      // default recall. Default 'working' preserves PE-gated reconsolidation
      // semantics where the successor IS the new canonical fact.
      tier: opts.tier || 'working',
      truth_score: (typeof opts.truth_score === 'number') ? opts.truth_score : undefined,
      // Preserve scope so the successor matches the prior's domain
      // routing (handoff:* keeps handoff:* etc) — recall and the
      // derivation table both key off scope.
      scope: (priorOut && priorOut.scope) || null,
      lifetime: {
        supersedes: prior_engram.id,
        reason: opts.reason || 'contradicted_by_subsequent_action'
      }
    }
  };
  // Strip undefined truth_score so JSON.stringify doesn't emit it; absence
  // means recall uses the default (1.0). Caller passing truth_score=0
  // explicitly de-ranks the successor; caller passing nothing keeps the
  // PE-gated semantics intact.
  if (rec.output.truth_score === undefined) delete rec.output.truth_score;
  const v = ar.validate(rec);
  if (!v.ok) return null;
  state.recordAction(rec, ar.toSearchText(rec));
  return rec.id;
}

// ── Corrected-fact extraction ────────────────────────────────── PLR §4 in
// the paper calls for "autonomous overwrite within 10 minutes with the
// CORRECTED fact." The background reconsolidation_review ships flag-only —
// substrate retires the wrong prior but doesn't claim a new fact. The
// corrected-fact path closes that gap: when consensus passes AND the
// contradicting evidence is rich enough to extract a corrected statement, an
// LLM micro- call distills the new fact and the BG task writes it as the
// superseder at tier='working'. Falls back to flag-only on any extract failure
// so the safety property of phase 1 is preserved. Driver injection same shape
// as mind-state.distillProject — substrate code never makes API calls
// directly. Tests pass deterministic mocks; production passes
// makeReconsolidationDriverFromEnv() (HTTP to OpenAI-compatible endpoint,
// env-configured, zero deps).

async function extractCorrectedStatement(opts) {
  opts = opts || {};
  const prior = String(opts.prior_statement || '').trim();
  const evidence = Array.isArray(opts.contradicting_excerpts)
    ? opts.contradicting_excerpts.filter((s) => typeof s === 'string' && s.trim()).slice(0, 5)
    : [];
  if (!prior || !evidence.length || typeof opts.driver !== 'function') {
    return { ok: false, reason: 'missing_input' };
  }

  const evidenceBlock = evidence.map((s, i) => '  ' + (i + 1) + '. ' + s.trim().slice(0, 600)).join('\n');
  const prompt =
    'A prior fact in the substrate has been contradicted by the agent\'s subsequent actions.\n' +
    '\n' +
    'PRIOR FACT (now suspect):\n' +
    '  ' + prior.slice(0, 600) + '\n' +
    '\n' +
    'CONTRADICTING EVIDENCE (assistant turns that disagreed):\n' +
    evidenceBlock + '\n' +
    '\n' +
    'TASK: Extract the CORRECTED fact from the evidence above. Output ONLY a single declarative\n' +
    'sentence stating the corrected fact, no preamble, no quotes, no list markers.\n' +
    '\n' +
    'If the evidence does not contain a clear corrected fact (e.g., it merely disagrees without\n' +
    'asserting an alternative), output the literal token NO_CORRECTED_FACT and nothing else.';

  let response;
  try {
    response = await opts.driver({ prompt });
  } catch (e) {
    return { ok: false, reason: 'driver_threw', detail: String(e && e.message || e) };
  }
  const corrected = (typeof response === 'string'
    ? response
    : (response && typeof response.text === 'string' ? response.text
        : (response && typeof response.summary === 'string' ? response.summary : ''))).trim();
  if (!corrected) return { ok: false, reason: 'empty_response' };
  if (/^NO_CORRECTED_FACT\b/i.test(corrected)) return { ok: false, reason: 'no_corrected_fact_in_evidence' };
  // Defensive: refuse outputs that look like a flagged template, contain
  // the prior verbatim, or exceed a sensible single-sentence cap.
  if (corrected.length > 600) return { ok: false, reason: 'response_too_long' };
  if (/^\[reconsolidated/i.test(corrected)) return { ok: false, reason: 'response_is_flag_template' };
  return { ok: true, corrected_statement: corrected };
}

// HTTP driver factory — mirror of mind-state.makeHttpDistillDriverFromEnv.
// Returns a driver function suitable for extractCorrectedStatement when a
// TROTH_RECONSOLIDATION_ENDPOINT (or fallback TROTH_MIND_DISTILL_ENDPOINT)
// is set. Returns null if neither endpoint is configured — caller treats
// that as "extract unavailable, fall back to flag-only."
function makeReconsolidationDriverFromEnv(envOverride) {
  const env = envOverride || process.env;
  const endpoint = env.TROTH_RECONSOLIDATION_ENDPOINT
                || env.TROTH_MIND_DISTILL_ENDPOINT;
  if (!endpoint) return null;
  const model   = env.TROTH_RECONSOLIDATION_MODEL
              || env.TROTH_MIND_DISTILL_MODEL
              || 'qwen2.5:7b';
  const timeout = parseInt(env.TROTH_RECONSOLIDATION_TIMEOUT, 10) || 30000;

  const http  = require('http');
  const https = require('https');
  const { URL } = require('url');

  return function driver(args) {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: args.prompt }],
      max_tokens: 200,
      temperature: 0.2,
      stream: false
    });
    let url;
    try { url = new URL('/v1/chat/completions', endpoint); }
    catch (_) { return Promise.reject(new Error('bad_endpoint_url')); }

    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        method:   'POST',
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('http_status_' + res.statusCode));
          }
          try {
            const parsed = JSON.parse(chunks);
            const text = parsed && parsed.choices && parsed.choices[0]
              && parsed.choices[0].message && parsed.choices[0].message.content;
            if (typeof text !== 'string' || !text.trim()) {
              return reject(new Error('empty_completion'));
            }
            resolve(text.trim());
          } catch (_) { reject(new Error('parse_error')); }
        });
      });
      req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => reject(e));
      req.write(body);
      req.end();
    });
  };
}

module.exports = {
  markRetrieved,
  assessActionAgainstRetrieved,
  reconsolidate,
  extractCorrectedStatement,
  makeReconsolidationDriverFromEnv,
  tokenize,
  jaccard,
  hasNegationFlip,
  DEFAULT_LABILITY_MS,
  DEFAULT_CONTRADICTION_THRESHOLD
};
