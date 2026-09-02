// SPDX-License-Identifier: AGPL-3.0-only
// Engram — substrate-side semantic memory.
//
// Dialogue-memory captures full turns chronologically. Engram captures
// distinct salient FACTS (codewords, preferences, commitments,
// observations) and indexes them by semantic embedding so the substrate
// can surface only the most relevant memories per call — not flood the
// prefix with everything.
//
// Two retrieval modes:
//   1. semantic — uses an embedding endpoint (llama-server's
//      `/embedding`) to compute query + memory vectors, returns top-K
//      by cosine similarity.
//   2. lexical (fallback) — token-overlap scoring, no network. Used
//      when no embedding endpoint is configured.
//
// Storage: ActionRecord rows of type=`commitment` with
// commitment_type='engram'. Same L1 surface as everything else; survives
// daemon restarts; participates in the substrate's causal lineage.
//
// This is the substrate's "long-term memory" relative to dialogue-
// memory's "working memory". The dream's continuous-identity property
// requires both — recent context (dialogue) AND persistent recallable
// facts (engram).

const http = require('http');
const https = require('https');
const { URL } = require('url');

const actionRec = require('./action-record.js');
const state     = require('./state.js');
const projectId = require('./project-id.js');

const COMMITMENT_TYPE = 'engram';

// B7 — PLR per-retrieval triggering, biology-grounded.
//
// Sevenster, Beckers, Kindt (2013, Science 339:830–833) proved reactivation
// alone is insufficient — reconsolidation requires prediction-error mismatch.
// Lee, Nader, Schiller (2017, Nat Rev Neurosci 18:531–545) §temporal dynamics
// says re-stabilization "mostly complete by 1h" — that's our refractory floor.
// Schiller (2010, Nature 463:49–53) bounds the reconsolidation window
// 10min–6h. Park 2023 §A.2 uses top-K≤5 for retrieval salience.
//
// v1 defaults (engineering knobs, tunable post-telemetry):
//   top-K salience gate: K=3 (middle of Park's band)
//   refractory window: 1h (Lee re-stabilization)
//   PE threshold: 0.3 absolute (v2 → streaming p90 of last 1000 PEs)
//   PE definition: 1 - score (v2 → baseline-adjusted per-engram rolling mean)
//
// In-process refractory cache: { engram_id → last_marked_ts_ms }. Survives
// across calls within process lifetime; cleared on restart (acceptable —
// background-worker also fires periodic PLR review independently).
const _plrRefractoryCache = new Map();
const _PLR_TOP_K          = 3;
const _PLR_REFRACTORY_MS  = 60 * 60 * 1000; // 1 hour (Lee 2017)
const _PLR_PE_THRESHOLD   = 0.3;            // v1 absolute; v2 → streaming p90

function _triggerPLR(results) {
  if (!Array.isArray(results) || !results.length) return;
  let lability;
  try { lability = require('./lability-reconsolidation.js'); }
  catch (_) { return; }
  if (!lability || typeof lability.markRetrieved !== 'function') return;
  const now = Date.now();
  const top = results.slice(0, _PLR_TOP_K);
  for (const r of top) {
    if (!r || !r.id) continue;
    // PE proxy: low score = familiar (low surprise); high score = surprising.
    // For score in [0,1] with 1 = perfect match: PE = 1 - score. A row
    // with score 1.0 has PE 0.0 (no surprise); score 0.3 has PE 0.7
    // (very surprising — but also low relevance, already filtered by
    // recall's min_overlap floor). Threshold 0.3 catches the band where
    // the engram was retrieved meaningfully but didn't perfectly match —
    // Sevenster's "mismatch from expectation" zone.
    const pe = 1 - (typeof r.score === 'number' ? r.score : 0);
    if (pe < _PLR_PE_THRESHOLD) continue;
    // Refractory: skip if marked within last hour (Lee re-stabilization).
    const lastMarked = _plrRefractoryCache.get(r.id) || 0;
    if (now - lastMarked < _PLR_REFRACTORY_MS) continue;
    try {
      lability.markRetrieved({ state, engram_id: r.id });
      _plrRefractoryCache.set(r.id, now);
    } catch (_) { /* PLR is best-effort — never block recall on it */ }
  }
  // Bound cache memory: drop entries older than 2× refractory window.
  if (_plrRefractoryCache.size > 1000) {
    const cutoff = now - 2 * _PLR_REFRACTORY_MS;
    for (const [id, ts] of _plrRefractoryCache) {
      if (ts < cutoff) _plrRefractoryCache.delete(id);
    }
  }
}

// emphasis-based salience heuristic.
//
// 'STOP DOING THAT' and 'we usually do this' should NOT write at the
// same salience. Detects CAPS, repetition, profanity, "always/never"
// intensifiers — each adds an additive boost (capped at +1.0).
// Used at write-time in recordEngram AND by working-memory consolidation
// (Phase E) to score dialogue turns for auto-promotion to engrams.
//
// Signals scored (additive, capped at +1.0):
//   CAPS ratio > 0.30 on a >12-char statement   → +0.4
//   intensifier verbs (always/never/must/stop/critical) → +0.2 (once)
//   repetition (same word >=3x)                 → +0.2
//   exclamation marks (>=2)                     → +0.1
//   profanity markers (cursing implies emotional weight) → +0.2
function detectEmphasis(s) {
  if (!s || typeof s !== 'string' || s.length < 6) return 0;
  let boost = 0;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const caps = letters.replace(/[^A-Z]/g, '').length / letters.length;
    if (caps > 0.30) boost += 0.4;
  }
  const lower = s.toLowerCase();
  const INTENSIFIERS = ['always','never','must','stop','critical','urgent','important','required','forbidden','immediately'];
  let intensifierHits = 0;
  for (const w of INTENSIFIERS) {
    const re = new RegExp('\\b' + w + '\\b', 'g');
    if (re.test(lower)) intensifierHits++;
  }
  if (intensifierHits >= 1) boost += 0.2;
  const exclam = (s.match(/!/g) || []).length;
  if (exclam >= 2) boost += 0.1;
  const PROFANITY_MARKERS = ['fuck','shit','damn','wtf','goddamn','fucking'];
  for (const w of PROFANITY_MARKERS) {
    if (lower.indexOf(w) >= 0) { boost += 0.2; break; }
  }
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  for (const [, c] of counts) if (c >= 3) { boost += 0.2; break; }
  return Math.min(boost, 1.0);
}

// ── Storage ─────────────────────────────────────────────────────────────

function recordEngram(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  const user_id  = opts.user_id || 'default';
  const cwd      = opts.cwd || null;
  const statement = String(opts.statement || '').trim();
  const source    = String(opts.source || 'unspecified');
  if (!agent_id || !statement) return null;

  try {
    // implementation step — write-time quality control via engram-verify.
    //  default flipped to ON. Schnider 2003
    // confabulation evidence + our own audit (which found Phase E was
    // dormant because nobody passed auto_verify=true) make this the right
    // default — verification is bounded, deterministic, and the cost of
    // NOT running it is silent trust-decay across the engram pool. Bulk
    // writers (chameleon ingest at scale) can opt out via auto_verify=false.
    let verifyOut = null;
    const wantsVerify = (opts.auto_verify === false) ? false : true;
    if (wantsVerify) {
      try {
        const verify = require('./engram-verify.js');
        // Pull a bounded existing-pool sample to compare against. Same
        // scope as the new write so we don't compare cross-corpora
        // (research vs identity vs system:drift produce different
        // negation-pair semantics).
        const existing = listEngrams({
          agent_id,
          cwd,
          scope: opts.scope || null,
          limit: 200
        });
        verifyOut = verify.verifyStatement({
          statement,
          existing,
          dup_threshold:     opts.dup_threshold,
          related_threshold: opts.related_threshold
        });
      } catch (_) { verifyOut = null; }
    }
    const _emphasisBoost = detectEmphasis(statement);
    const _baseSalience = typeof opts.salience === 'number' ? opts.salience : 1.0;
    // Additive only — never elevate explicit low-salience writes (tombstones,
    // gc fixtures, demotion markers). Caller's salience floor is preserved;
    // emphasis just adds on top. Capped at 2.0.
    const _effectiveSalience = Math.min(2.0, _baseSalience + _emphasisBoost);

    // A replicated write carries its author's id so every copy of the mind
    // holds ONE record, not one per machine.
    const id = (typeof opts.id === 'string' && /^[0-9a-f][0-9a-f-]{15,}$/i.test(opts.id)) ? opts.id : actionRec.uuidv7();
    // provenance fields wire engrams to their on-disk anchor
    // (file_path, codelens entity, source module). Substrate gains the
    // ability to answer "which file/symbol does this commitment live near?"
    // the missing bridge to CodeLens. All fields optional, additive only.
    const provenance = {};
    if (opts.file_path) provenance.file_path = String(opts.file_path);
    if (opts.codelens_entity_id) provenance.codelens_entity_id = String(opts.codelens_entity_id);
    if (opts.source_module) provenance.source_module = String(opts.source_module);
    if (Array.isArray(opts.lines) && opts.lines.length === 2) {
      provenance.lines = [Number(opts.lines[0]) | 0, Number(opts.lines[1]) | 0];
    }
    // WHOSE words these are.
    //
    // 'operator' — something the operator wrote or handed over.
    // 'external' — text fetched from the open web, or any source nobody here
    //              vouches for.
    //
    // Deliberately NOT the `audience` field: audienceOk() in recall.js is an
    // exact match against what the caller asked for, so tagging a fetched page
    // 'synthesis_of_external' does not lower its trust, it removes it from
    // recall entirely. Knowledge that never answers is not knowledge. This is
    // a mark that travels WITH the passage instead: it comes back, and it says
    // where it came from.
    //
    // Callers passing a whole provenance object were silently ignored before
    // this — the builder above only ever read file_path / codelens_entity_id /
    // source_module, so chameleon's ingest set a tier that never reached disk.
    if (opts.provenance && typeof opts.provenance === 'object') {
      if (opts.provenance.tier) provenance.tier = String(opts.provenance.tier);
      if (opts.provenance.ref)  provenance.ref  = String(opts.provenance.ref).slice(0, 300);
    }
    if (opts.provenance_tier) provenance.tier = String(opts.provenance_tier);
    if (opts.provenance_ref)  provenance.ref  = String(opts.provenance_ref).slice(0, 300);
    // Truth/tier defaults: when auto_verify ran, honor its output;
    // otherwise allow the caller to pass explicit truth_score/tier;
    // otherwise fall back to safe defaults (working tier, full trust).
    const truth_score = (verifyOut && typeof verifyOut.truth_score === 'number')
      ? verifyOut.truth_score
      : (typeof opts.truth_score === 'number' ? opts.truth_score : 1.0);
    const tier = (verifyOut && typeof verifyOut.tier === 'string')
      ? verifyOut.tier
      : (typeof opts.tier === 'string' ? opts.tier : 'working');
    const contradiction_refs = (verifyOut && Array.isArray(verifyOut.contradiction_refs) && verifyOut.contradiction_refs.length)
      ? verifyOut.contradiction_refs
      : (Array.isArray(opts.contradiction_refs) ? opts.contradiction_refs : null);
    const duplicate_of = (verifyOut && verifyOut.duplicate_of) || (opts.duplicate_of || null);
    //  audience + memory_class derivation
    // design note (audience) + design note (memory class). Engrams default
    // model_visible (they ARE user-facing memory) but two scope-driven
    // exceptions: handoff:* are agent-to-agent memos (substrate_internal +
    // operational), and identity-scoped engrams are the always-on identity
    // pool (identity class). docs:* scope from chameleon ingest is research-
    // knowledge (semantic class). Everything else falls to episodic class.
    // Caller can always override via opts.audience / opts.memory_class.
    const _scope = opts.scope || null;
    const _isHandoff  = typeof _scope === 'string' && _scope.indexOf('handoff:') === 0;
    const _isInternal = typeof _scope === 'string' && _scope.indexOf('internal:') === 0;
    const _isIdentity = _scope === 'identity';
    // Entity registry rows (entity-identity.js, scope entity:<slug>) are the
    // cast, not episodes: read by loadRegistry (scope prefix) and mounted by
    // the identity-cast arm. As episodic-class rows they competed in the
    // general pool and took up to 5 of 10 mount slots on identity-shaped
    // questions (measured 2026-09-02, 23-question probe). Identity class
    // keeps them out of class:'all' ranking without touching how the cast
    // is read.
    const _isEntity   = typeof _scope === 'string' && _scope.indexOf('entity:') === 0;
    const _isDocs     = typeof _scope === 'string' && _scope.indexOf('docs:') === 0;
    const _isResearch = typeof _scope === 'string' && _scope.indexOf('research:') === 0;
    // Operator-curated memory (migrated ~/.claude memory/*.md, scope memory:*).
    // Treat like docs/research: semantic-class, model_visible — so the
    // class:'all' auto-recall injector surfaces it (the injector drops
    // identity-class), instead of the model falling back to Bash-grepping the
    // .md files because recall "found nothing".
    const _isMemory   = typeof _scope === 'string' && _scope.indexOf('memory:') === 0;
    const _isDecision = typeof _scope === 'string' && _scope.indexOf('decision:') === 0;
    // B5: orchestration scopes from agent-supervisor.js (role:*,
    // progress:role:*, complete:role:*) are inter-agent coordination chatter,
    // not user-facing memory. Per workflow-engine pattern (AWS Step Functions
    // execution events ≠ workflow output; Conductor task logs ≠ workflow
    // output): inter-worker chatter is observability/operational, only
    // completion artifacts join the persistent retrieval pool. Auto-derive
    // these to substrate_internal+operational so they don't pollute partner's
    // recall. If a /team orchestration wants its merged result user-facing,
    // mergeResults should re-write a separate scope='briefing:<group_id>'
    // engram with explicit audience='model_visible' (operator decision: TBD).
    const _isOrchestration = typeof _scope === 'string' && (
      _scope.indexOf('role:')          === 0 ||
      _scope.indexOf('progress:role:') === 0 ||
      _scope.indexOf('complete:role:') === 0 ||
      _scope.indexOf('progress:')      === 0   // bare progress:* for legacy callers
    );
    // reshape: project_thesis / canonical /
    // compact_handoff as SEPARATE scope categories were external-config-
    // on-top-of-substrate (file convention + bespoke scopes). Reverted
    // for substrate-as-mind discipline: thesis content lives as
    // operator_confirmed identity engrams (Build 1 authority tier ranks
    // them above weaker identity). Canonical docs = operator_confirmed
    // procedural-class engrams. Forbidden patterns = refusal commitments
    // + thesis_anchored_check STVC invariant (Build 5). Compact handoff
    // = existing PreCompact decision-record mechanism (pre-AGENT-
    // CONTINUITY pattern, already worked).
    // What survives from Builds 1-6:
    //   source_authority tier (universal, applies to ALL engrams)
    //   thesis_anchored_check STVC predicate (universal predicate kind)
    //   taskPurposeRefresh background task (writes substrate_internal
    //     current_focus engram — not a separate scope category, just an
    //     operational engram)
    // What was reverted:
    //   project_thesis:* scope (collapsed → identity scope)
    //   canonical:* scope (collapsed → procedural scope w/ operator auth)
    //   compact_handoff:* scope (revert to pre-Build-6 PreCompact mechanism)
    //   -.troth-config/ file convention + project-bootstrap.js
    //   taskProjectBootstrap background task
    // L1/L2 invariant fix: for scopes with a hard derivation
    // rule (handoff/internal/orchestration/identity/docs/research/decision),
    // SUBSTRATE WINS over caller opts. Earlier behavior treated opts.audience
    // / opts.memory_class as override, which let LLM-supplied proposals
    // (operations-dispatcher pattern, retired) escape audience routing. Per
    // L1-L2-RECONSTRUCTION-PAPER design note: "Each writer module has a
    // single line that stamps audience" — substrate stamps, not caller.
    //
    // For unrecognized scopes (custom domains), caller's opts.audience /
    // opts.memory_class remain honored as a soft default, since the
    // substrate has no derivation rule and would otherwise force everything
    // into episodic+model_visible.
    //
    // The caller's REQUEST (when it differs from substrate's derivation) is
    // preserved on the engram as output.requested_audience /
    // output.requested_memory_class for audit visibility.
    const _hasHardDerivation = (
      _isHandoff || _isInternal || _isOrchestration ||
      _isIdentity || _isEntity || _isDocs || _isResearch || _isDecision || _isMemory
    );
    const _derivedAudience = (
      (_isHandoff || _isInternal || _isOrchestration) ? 'substrate_internal' : 'model_visible'
    );
    const _derivedClass = (
      (_isHandoff || _isInternal || _isOrchestration) ? 'operational' :
      (_isIdentity || _isEntity)   ? 'identity' :
      (_isDocs || _isResearch || _isMemory) ? 'semantic' :
      _isDecision                  ? 'procedural' :
                                     'episodic'
    );
    const audience = _hasHardDerivation
      ? _derivedAudience
      : (opts.audience || _derivedAudience);
    const memory_class = _hasHardDerivation
      ? _derivedClass
      : (opts.memory_class || _derivedClass);
    // Capture caller request when it disagrees with the substrate's
    // hard-derived value — substrate still wins, but the request is
    // visible for audit (operator can see "module X tried to set audience
    // Y for scope Z" without scanning logs).
    const _requestedAudience = (_hasHardDerivation && opts.audience && opts.audience !== _derivedAudience)
      ? opts.audience : null;
    const _requestedClass = (_hasHardDerivation && opts.memory_class && opts.memory_class !== _derivedClass)
      ? opts.memory_class : null;
    // authority tier on facts.
    // 4-level enum, ordered strongest→weakest:
    //   operator_confirmed — explicit operator action (CLI, dashboard,
    //                        chameleon ingest of operator-curated docs)
    //   plr_evolved        — substrate's own reconsolidation (lab.reconsolidate
    //                        successors, write-time TMMA dedup outcomes)
    //   llm_inferred       — LLM faculty proposal (operations-dispatcher
    //                        path when it ships; today's substrate-tools
    //                        engram_record calls)
    //   regex_extracted    — pattern-based extraction from text without
    //                        operator confirmation (identity-extract, etc)
    //
    // Default = regex_extracted (weakest). Writers that have stronger
    // grounding pass opts.source_authority explicitly. recall.js truthFactor
    // multiplies by tier weight so high-authority facts outrank low.
    //
    // L1/L2 SECURITY HARDENING  — integration point fix.
    //
    // Source-string heuristic for AUTHORITY TIER REMOVED.
    //
    // A source-string test — if (s.includes('operator')) → 'operator_confirmed'
    // — lets any caller, including LLM-faculty writes, launder itself into the
    // top tier just by putting 'operator' in the source
    // string. The 4-tier authority gradient is supposed to be ambient
    // (derived from authenticated calling surface), NEVER declared in
    // caller-controlled payload content.
    //
    // New rule: tier MUST be passed explicitly via opts.source_authority.
    // No string parsing. Default = 'regex_extracted' (weakest tier) so any
    // forgetful caller fails closed at the bottom of the gradient, NOT
    // escalates to the top.
    //
    // Callers that need higher tiers must pass explicitly:
    //   update_identity tool: opts.source_authority = 'operator_confirmed'
    //     (dashboards/CLI dedicated entry points stamp this themselves)
    //   lability-reconsolidation.reconsolidate: opts.source_authority = 'plr_evolved'
    //   hypothesis-generator / wm_consolidation: opts.source_authority = 'plr_evolved'
    //   operations-dispatcher / substrate-tools.engram_record: opts.source_authority = 'llm_inferred'
    //   identity-extract (regex pipeline): opts.source_authority = 'regex_extracted'
    //
    // Audit trail: legacy callers that omit opts.source_authority now show
    // up as regex_extracted in the engram pool. Grep for ad-hoc writers
    // and stamp them explicitly.
    const source_authority = opts.source_authority || 'regex_extracted';
    // L1/L2 SECURITY HARDENING  — integration point fix.
    //
    // Cryptographic operator-write binding. operator_confirmed tier
    // writes MUST carry an Ed25519 signature over the engram's canonical
    // body (statement + scope + source_authority + extra_output, sans
    // signature itself). Without this check, any in-process caller of
    // engram.write could pass opts.source_authority='operator_confirmed'
    // unsigned and forge top-tier authority — making the gradient theatre.
    //
    // Tier-constrained supersedes (integration point) protects the OVERRIDE flow.
    // This protects the WRITE flow.
    //
    // Verification chain:
    //   1. Find operator's active public key. Prefer the substrate-stored
    //      engram (scope='operator_key:active'); fall back to the
    //      filesystem (bootstrap state before any engram exists).
    //   2. Recompute the canonical body from the inbound args.
    //   3. ed25519-verify the signature against pubkey + canonical body.
    //   4. On any failure: refuse the write (return null). Don't silently
    //      downgrade to llm_inferred — that would let forged-looking
    //      operator engrams persist at a lower tier where they could
    //      still mislead recall consumers.
    //
    // Pre-bootstrap (no operator key yet): operator-tier writes are
    // refused. The bootstrap protocol is the only path that creates the
    // first operator_key:active engram, and it uses a dedicated init
    // flow rather than going through this gate.
    if (source_authority === 'operator_confirmed') {
      const opKeyMod = require('./operator-key.js');
      const incomingSig =
        (opts.signature) ||
        (opts.extra_output && opts.extra_output.signature) ||
        null;
      if (!incomingSig) return null;
      // design: multi-pubkey verifier chain.
      //
      // The verifier accepts a signature from ANY of:
      //   1. operator_key:active (substrate, primary)
      //   2. recovery_directive's pre-authorized successor key
      //      (substrate, backup — enables key rotation if primary lost)
      //   3. filesystem getActivePublicKey (bootstrap fallback only,
      //      before any substrate pubkey exists)
      //
      // Order matters only for short-circuit: substrate-first keeps the
      // happy path fast. Filesystem is consulted only when substrate
      // returns nothing (pre-bootstrap). Recovery key being a valid
      // verifier is the structural enabler of the recover flow — a
      // re-anchor write signed by the recovery key needs integration point to
      // accept it, which means integration point must trust the directive's
      // pre-authorized key. Tier-constrained supersedes (integration point)
      // remains the wall against forged retire-ops.
      const pubCandidates = [];
      try {
        const activeRows = listEngrams({
          principal: null, audience: 'all',
          scope:    'operator_key:active', limit: 1
        }) || [];
        const c0 = activeRows[0];
        if (c0) {
          const p = (c0.public_key_pem) ||
                    (c0.output && c0.output.public_key_pem) || null;
          if (p) pubCandidates.push({ source: 'substrate:active', pem: p });
        }
      } catch (_) {}
      try {
        const recRows = listEngrams({
          principal: null, audience: 'all',
          scope: 'recovery_directive', limit: 1
        }) || [];
        const r0 = recRows[0];
        if (r0) {
          const p = (r0.recovery_public_key_pem) ||
                    (r0.output && r0.output.recovery_public_key_pem) || null;
          if (p) pubCandidates.push({ source: 'substrate:recovery', pem: p });
        }
      } catch (_) {}
      // design: inheritance_directive pubkey accepted as verifier.
      try {
        const inhRows = listEngrams({
          principal: null, audience: 'all',
          scope: 'inheritance_directive', limit: 1
        }) || [];
        const i0 = inhRows[0];
        if (i0) {
          const p = (i0.inheritance_public_key_pem) ||
                    (i0.output && i0.output.inheritance_public_key_pem) || null;
          if (p) pubCandidates.push({ source: 'substrate:inheritance', pem: p });
        }
      } catch (_) {}
      if (!pubCandidates.length) {
        try {
          const fsKey = opKeyMod.getActivePublicKey();
          if (fsKey) pubCandidates.push({ source: 'filesystem:bootstrap', pem: fsKey.public_key_pem });
        } catch (_) {}
      }
      if (!pubCandidates.length) return null; // pre-bootstrap; refuse all op-tier writes
      // Strip the signature out of the body before canonicalizing — the
      // signature must not commit to itself.
      const xoForSig = Object.assign({}, opts.extra_output || {});
      delete xoForSig.signature;
      delete xoForSig.signed_at;
      const canonicalBody = opKeyMod.canonicalEngramBody({
        statement,
        scope:            opts.scope || null,
        source_authority: 'operator_confirmed',
        extra_output:     xoForSig
      });
      let verifiedBy = null;
      for (const cand of pubCandidates) {
        if (opKeyMod.verify(cand.pem, canonicalBody, incomingSig)) {
          verifiedBy = cand.source;
          break;
        }
      }
      if (!verifiedBy) return null;
      // Verified. Stamp the signature onto extra_output so future readers
      // can re-verify against the same canonical body.
      opts.extra_output = Object.assign({}, opts.extra_output || {}, {
        signature: incomingSig,
        signed_at: Date.now()
      });
    }
    // L1/L2 SECURITY HARDENING  — integration point fix.
    //
    // Tier-constrained supersession: a writer cannot retire engrams whose
    // source_authority outranks the writer's own. Without this, an
    // LLM-faculty write (llm_inferred tier) could supersede an operator_
    // confirmed fact via `extra_output.lifetime.supersedes`, silently
    // retiring it from default recall — making the authority gradient
    // theatre. The check runs at WRITE time so invalid supersedes never
    // persist; recall.js + listEngrams supersedes scans need no change.
    //
    // Tier order (high→low): operator_confirmed > plr_evolved > llm_inferred > regex_extracted.
    // Writer with authority X can only supersede targets with authority ≤ X.
    if (opts.extra_output && opts.extra_output.lifetime && opts.extra_output.lifetime.supersedes) {
      const TIER_RANK = { operator_confirmed: 4, plr_evolved: 3, llm_inferred: 2, regex_extracted: 1 };
      const writerRank = TIER_RANK[source_authority] || 1;
      const raw = opts.extra_output.lifetime.supersedes;
      const targetIds = Array.isArray(raw) ? raw.filter(Boolean) : (raw ? [raw] : []);
      const validTargets = [];
      const rejected = [];
      for (const tid of targetIds) {
        try {
          const tRow = state.getAction(tid);
          if (!tRow) { validTargets.push(tid); continue; } // unknown target — let downstream FK handle
          let tOut;
          try { tOut = typeof tRow.output === 'string' ? JSON.parse(tRow.output) : (tRow.output || {}); }
          catch (_) { tOut = {}; }
          const targetAuth = (tOut && tOut.source_authority) || 'regex_extracted';
          const targetRank = TIER_RANK[targetAuth] || 1;
          if (writerRank >= targetRank) validTargets.push(tid);
          else rejected.push({ id: tid, target_authority: targetAuth, writer_authority: source_authority });
        } catch (_) { /* fail closed — drop on lookup error */ rejected.push({ id: tid, reason: 'lookup_failed' }); }
      }
      // Rewrite extra_output.lifetime to retain only valid targets. If all
      // rejected, strip supersedes entirely so the row writes without it.
      if (rejected.length) {
        opts.extra_output = Object.assign({}, opts.extra_output, {
          lifetime: Object.assign({}, opts.extra_output.lifetime, {
            supersedes: validTargets.length ? (validTargets.length === 1 ? validTargets[0] : validTargets) : undefined,
            supersedes_rejected: rejected  // audit trail of what was filtered
          })
        });
        if (!validTargets.length) {
          // Nothing left — remove supersedes key entirely so recall doesn't see undefined.
          delete opts.extra_output.lifetime.supersedes;
        }
      }
    }

    const rec = {
      id,
      timestamp: Date.now(),
      type: 'commitment',
      agent_id,
      cwd,
      user_id,
      parent_id: opts.parent_id || null,
      context_id: opts.context_id || null,
      audience,
      memory_class,
      input:  { source },
      // ACL FIX: extra_output must NEVER override substrate-
      // derived fields. Earlier shape (Object.assign(substrate, extra_output))
      // let callers escalate scope/audience/commitment_type/truth_score/
      // statement via extra_output — confirmed reproducible. Spread extra
      // first, then substrate-controlled fields last, so substrate wins
      // on any key collision. Caller can still attach NEW keys via
      // extra_output (skill payloads, anticipation metadata, etc.).
      output: Object.assign(
        {},
        (opts.extra_output && typeof opts.extra_output === 'object') ? opts.extra_output : {},
        {
          statement,
          commitment_type: COMMITMENT_TYPE,
          embedding: Array.isArray(opts.embedding) ? opts.embedding : null,
          salience: _effectiveSalience,
          scope:    opts.scope || null,
          provenance: Object.keys(provenance).length ? provenance : null,
          // Phase E fields. truth_score/tier are always present (default
          // 1.0/'working') so retrieval code can rely on them without
          // null checks. contradiction_refs/duplicate_of only present
          // when verifier flagged something — null otherwise.
          truth_score,
          tier,
          contradiction_refs,
          duplicate_of,
          // L1/L2 invariant audit trail. Present only when caller asked for
          // an audience/memory_class that the substrate's derivation
          // overrode. Lets `/audit l1` (or grep) surface modules that try
          // to escape the discipline.
          requested_audience:    _requestedAudience,
          requested_memory_class: _requestedClass,
          // fact authority tier
          source_authority,
          // Phase A — project_id auto-derive.
          // Stamped at write time from cwd via project-id.resolveProjectId
          // (.troth/project.json →.git root basename → cwd basename →
          // '__ephemeral__'). Used as soft topic anchor for project-shaped
          // prefix blocks (decisions/current_focus/handoff) so parallel
          // conversations in different projects don't cross-poison. Caller
          // can override by passing opts.project_id explicitly (e.g.,
          // partner's update_identity tool tags "this is freelance work").
          // Identity engrams keep project_id but the identity prefix block
          // is cross-project — person-level facts span all topics.
          project_id: opts.project_id || projectId.resolveProjectId(cwd)
        }
      )
    };
    const v = actionRec.validate(rec);
    if (!v.ok) return null;
    // honor state.recordAction return value. Earlier code returned
    // local `id` even when recordAction returned null (e.g. STVC reject, FK
    // violation, dup id). Callers received a non-null id pointing at a row
    // that did not actually persist. Now: return null when the write failed
    // so callers can react appropriately.
    const writeId = state.recordAction(rec, actionRec.toSearchText(rec));
    if (!writeId) return null;
    //  index the inline embedding into engram_embeddings on write.
    // recordAction persists the vector ONLY inside output JSON, but the dense-
    // recall arm + per-turn cosine rerank read vectors EXCLUSIVELY from
    // engram_embeddings (state.getEmbedding / streamRecallableEmbeddings). Without
    // mirroring here, a just-captured fact (remember-tool, auto-judge, chameleon
    // ingest, identity vector) stays keyword-only until the idle backfill re-
    // embeds it — so paraphrase recall of a fresh memory returns nothing. Mirror
    // the backfill write (background-worker.js:1162) at capture time. Best-effort:
    // FTS + backfill still cover the row if this throws; backfill remains the net
    // for rows written WITHOUT an inline vector.
    if (Array.isArray(opts.embedding) && opts.embedding.length) {
      try { state.setEmbedding(id, opts.embedding, { model: opts.embedding_model || null }); }
      catch (_) { /* dense-index mirror is best-effort */ }
    }
    // One mind, many devices: a successful local write also becomes a
    // journal event carrying THIS id, so every replica lands the same
    // record. _local marks an apply of someone else's event — never
    // re-queued, or the fleet would echo forever.
    if (!opts._local) {
      try {
        const _evArgs = {
          id,
          statement,
          salience: typeof opts.salience === 'number' ? opts.salience : undefined,
          scope:    typeof opts.scope === 'string' ? opts.scope : undefined,
          audience: typeof opts.audience === 'string' ? opts.audience : undefined
        };
        const _evCtx = { agent_id, user_id, cwd };
        const rc = require('./sync/remote-client.js');
        if (rc.active()) rc.queueWrite('engram_record', _evArgs, _evCtx);
        else require('./sync/hub-journal.js').maybeJournal('engram_record', _evArgs, _evCtx);
      } catch (_) { /* the local write stands; the flusher retries the ride */ }
    }
    return id;
  } catch (_) { return null; }
}

function listEngrams(opts) {
  opts = opts || {};
  // Substrate-as-mind invariant: the BRAIN identity at READ
  // time is `principal_id`, not `agent_id`. principal defaults to
  // TROTH_PRINCIPAL || 'partner' so a fresh install reads its own
  // unified personal mind across every surface that wrote to it.
  // agent_id is now an OPTIONAL secondary hard filter — preserves test
  // isolation + lets operator audit views ask "what did surface X write".
  // Pass principal:null to opt out of principal filtering entirely
  // (admin / migration / cross-brain analysis).
  const agent_id = opts.agent_id || null;
  const principal_id = (opts.principal === null)
    ? null
    : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  // No early-return on missing identity: the default path (no opts)
  // intentionally hits the partner brain. principal:null + no agent_id
  // is the explicit "no isolation" admin/migration mode and returns
  // every engram regardless of pool — caller asked for it.
  const limit    = Math.max(1, Math.min(2000, opts.limit || 200));
  const strict = !!opts.strict_isolation;
  const cwd    = strict ? (opts.cwd || null) : null;
  // Scope filter: when set, only return engrams whose `scope` matches.
  // Lets a single substrate hold multiple disjoint corpora — e.g.,
  // user-facts (scope=null), docs:legal-2026 (scope='legal-2026'),
  // docs:codebase-current (scope='codebase-current'). Pass scope=null
  // explicitly to fetch ONLY scopeless engrams.
  const scopeFilter = opts.scope === undefined ? '__any__' : opts.scope;
  const scopePrefix = typeof opts.scope_prefix === 'string' && opts.scope_prefix ? opts.scope_prefix : null;
  // Audience filter (defense-in-depth — R17, the design work). Most callers
  // hit the recall.recall() path which already enforces audience; this
  // catches the legacy retrieveRelevant fallback + future direct
  // listEngrams readers (proxy injector, hooks). Default 'all' preserves
  // backward-compat with callers that don't pass audience. Set
  // 'model_visible' explicitly to block substrate_internal handoff/
  // operational rows from leaking into model context.
  const audienceFilter = opts.audience || 'all';
  try {
    // When scope filter is set, overfetch — we filter in JS after
    // hydrating because the scope lives inside the JSON output blob.
    const fetchLimit = (scopeFilter === '__any__' && !scopePrefix) ? limit : Math.min(limit * 8, 2000);
    // SQL-level commitment_type filter: type='commitment' fans out into
    // many sub-kinds (anchor/refusal/opinion/hard/...). Without this,
    // the LIMIT clip routinely drops engrams in busy substrates because
    // non-engram commitments dominate the recent window. JS-side filter
    // below stays as defense-in-depth + tombstone exclusion.
    // opts.commitment_type overrides: identity-envelope asks
    // for the 'anchor' sub-kind — this arm was silently ignored and the
    // hardcoded 'engram' filter meant real anchors NEVER reached the
    // always-on identity block on any surface.
    const wantCommitmentType = opts.commitment_type || COMMITMENT_TYPE;
    const rows = state.queryActions({
      type: 'commitment',
      commitment_type: wantCommitmentType,
      agent_id: agent_id || undefined,
      principal_id: principal_id || undefined,
      cwd,
      // RECALL-FIX  (Step 1): when a SPECIFIC scope is requested, push it
      // into the SQL WHERE so the 1000-row recency cap operates on scope-matched
      // rows. Previously scope was filtered in JS AFTER a scope-BLIND recency clip,
      // so any corpus older than the most-recent ~1000 commitments (e.g. research
      // ingested 60k writes ago) never entered the candidate pool -> 0 hits. The
      // '__any__' (no-scope) path passes undefined -> SQL unchanged -> the per-turn
      // recall path is byte-identical (no regression).
      scope: (scopeFilter === '__any__') ? undefined : scopeFilter,
      scope_prefix: scopePrefix || undefined,
      limit: fetchLimit,
      order: 'desc'
    }) || [];
    // L1/L2 PLR completion: the substrate writes
    // supersession pointers (lability-reconsolidation.reconsolidate +
    // engram-verify on contradiction) but until now NO consumer
    // followed them. The "current view follows the supersession chain"
    // is documented intent in lability-reconsolidation.js:30 but was
    // never implemented end-to-end. This block completes it.
    //
    // Scan candidate pool for output.lifetime.supersedes pointers;
    // build the set of retired ids; exclude them from default reads.
    // Opt-in to see retired engrams via opts.include_superseded
    // (audit / "what did I correct?" queries).
    const supersededIds = new Set();
    if (!opts.include_superseded) {
      for (const row of rows) {
        let inOut;
        try { inOut = (typeof row.output === 'string') ? JSON.parse(row.output) : row.output; }
        catch (_) { continue; }
        const sup = inOut && inOut.lifetime && inOut.lifetime.supersedes;
        if (!sup) continue;
        // Phase B: accept array (identity drift multi-supersede) or single id.
        if (Array.isArray(sup)) {
          for (const s of sup) if (s) supersededIds.add(s);
        } else {
          supersededIds.add(sup);
        }
      }
      // The window scan misses a successor that fell outside this fetch;
      // the persisted superseded_ids index (state.js) does not. Union both
      // — fail-open to the pure window behaviour.
      try { for (const id of state.listSupersededIds()) supersededIds.add(id); } catch (_) {}
    }
    const out = [];
    for (const row of rows) {
      const rec = actionRec.fromRow(row);
      if (!rec || !rec.output || rec.output.commitment_type !== wantCommitmentType) continue;
      if (supersededIds.has(rec.id)) continue;   // PLR-retired, hidden from default view
      const recScope = rec.output.scope || null;
      if (scopeFilter !== '__any__' && recScope !== scopeFilter) continue;
      if (scopePrefix && (typeof recScope !== 'string' || recScope.indexOf(scopePrefix) !== 0)) continue;
      if (audienceFilter !== 'all') {
        // Treat NULL audience as substrate_internal (matches recall.js
        // audienceOk semantics + the sentinel convention for legacy
        // pre- rows). Effective === filter required to surface.
        const effective = rec.audience || 'substrate_internal';
        if (effective !== audienceFilter) continue;
      }
      out.push({
        id: rec.id,
        ts: rec.timestamp,
        statement: rec.output.statement,
        embedding: rec.output.embedding || null,
        salience: rec.output.salience || 1,
        scope:    recScope,
        source:   (rec.input && rec.input.source) || null,
        // cwd + agent_id + principal_id as METADATA so callers can
        // apply soft boosts (current-cwd / current-surface) and audit
        // views (per-pool inspection) without losing cross-folder /
        // cross-surface recall. Substrate-as-mind invariant.
        cwd:          rec.cwd          || null,
        agent_id:     rec.agent_id     || null,
        principal_id: rec.principal_id || null,
        // Phase E projection — present even on pre-Phase-E rows
        // (defaults: working tier, full truth, no contradictions).
        tier:                 rec.output.tier || 'working',
        truth_score:          (typeof rec.output.truth_score === 'number')
          ? rec.output.truth_score : 1.0,
        contradiction_refs:   rec.output.contradiction_refs || null,
        duplicate_of:         rec.output.duplicate_of || null,
        // fact authority tier
        source_authority:     rec.output.source_authority || 'regex_extracted',
        // auto-derived topic anchor
        project_id:           rec.output.project_id || null,
        // autonomous step — cryptographic operator-write fields. Bootstrap
        // (operator_key:active) + signed operator-tier engrams carry
        // these; surfacing them via the projection lets integration point
        // verification read substrate-stored pubkeys instead of
        // falling back to filesystem, and lets the dashboard / CLI
        // re-verify signatures over recalled engrams.
        signature:            rec.output.signature      || null,
        signed_at:            rec.output.signed_at      || null,
        public_key_id:        rec.output.public_key_id  || null,
        public_key_pem:       rec.output.public_key_pem || null,
        // design: recovery_directive successor key. Stored
        // under a distinct field name so the recovery flow can find it
        // and the active operator key engram's own public_key_pem stays
        // separate from the directive's pre-authorized successor.
        recovery_public_key_pem: rec.output.recovery_public_key_pem || null,
        recovery_public_key_id:  rec.output.recovery_public_key_id  || null,
        // design: inheritance_directive successor key (operator-death case).
        inheritance_public_key_pem: rec.output.inheritance_public_key_pem || null,
        inheritance_public_key_id:  rec.output.inheritance_public_key_id  || null,
        dormancy_threshold_ms:      rec.output.dormancy_threshold_ms || null,
        // Reason field used by global_pause/global_resume so the
        // kill-switch UI / predicate can echo it back to operator.
        reason:               rec.output.reason         || null,
        // design: intent + capability projection passthrough.
        // Lets STVC predicates + dispatchers read structured fields
        // off `listEngrams` rows without re-parsing JSON for every
        // candidate. All nullable; only intent/capability engrams
        // populate them.
        payload:                rec.output.payload                || null,
        capability_ref:         rec.output.capability_ref         || null,
        grounded_in:            rec.output.grounded_in            || null,
        irreversibility_class:  rec.output.irreversibility_class  || null,
        seals:                  rec.output.seals                  || null,
        parent_intent_id:       rec.output.parent_intent_id       || null,
        partner_id:             rec.output.partner_id             || null,
        idempotency_key:        rec.output.idempotency_key        || null,
        // Capability-specific:
        payload_schema:         rec.output.payload_schema         || null,
        max_irreversibility:    rec.output.max_irreversibility    || null,
        expiry:                 rec.output.expiry                 || null,
        revoked:                !!rec.output.revoked,
        scope_glob:             rec.output.scope_glob             || null,
        parent_capability_id:   rec.output.parent_capability_id   || null,
        // Observation-specific (Phase 1.7):
        observes_intent:        rec.output.observes_intent        || null
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (_) { return []; }
}

// ── Embedding (best-effort, fallback-safe) ──────────────────────────────

function embedRequest(host, content) {
  return new Promise((resolve) => {
    const url = new URL('/embedding', host);
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ content });
    const req = lib.request({
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers:  {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: 8000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          // llama-server returns either array of objects or a single object
          if (Array.isArray(j) && j[0] && Array.isArray(j[0].embedding)) {
            // The embedding may itself be a 2D array (per-token vectors).
            // Mean-pool over tokens to a single vector.
            const e = j[0].embedding;
            if (Array.isArray(e[0])) return resolve(meanPool(e));
            return resolve(e);
          }
          if (j && Array.isArray(j.embedding)) {
            const e = j.embedding;
            if (Array.isArray(e[0])) return resolve(meanPool(e));
            return resolve(e);
          }
        } catch (_) { /* fall through */ }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function meanPool(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return [];
  const dim = matrix[0].length;
  const out = new Array(dim).fill(0);
  for (const row of matrix) {
    for (let i = 0; i < dim; i++) out[i] += row[i] || 0;
  }
  for (let i = 0; i < dim; i++) out[i] /= matrix.length;
  return out;
}

function cosine(a, b) {
  // Accept any array-like (plain Array OR Float32Array). state.getEmbedding
  // returns a Float32Array, so an Array.isArray guard here silently returned 0
  // for every stored vector — making semantic rerank a no-op.
  if (!a || !b || typeof a.length !== 'number' || typeof b.length !== 'number') return 0;
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Lexical fallback ────────────────────────────────────────────────────

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zα-ωа-я0-9_]+/i)
    .filter(t => t && t.length > 2);
}

function lexicalScore(query, statement) {
  const qt = new Set(tokenize(query));
  const st = new Set(tokenize(statement));
  if (!qt.size || !st.size) return 0;
  let overlap = 0;
  for (const t of qt) if (st.has(t)) overlap++;
  // Jaccard-ish, weighted toward query coverage so a short query
  // matching a long statement still scores meaningfully.
  return overlap / qt.size;
}

// ── Retrieval ───────────────────────────────────────────────────────────

async function retrieveRelevant(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id || null;
  const query    = String(opts.query || '');
const _WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function _parseTimeWindow(query, referenceTs) {
  const q = String(query || '').toLowerCase();
  const ref = Number.isFinite(referenceTs) ? referenceTs : Date.now();
  const m = /\b(?:past|last)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)?\s*(day|week|month|year)s?\b/.exec(q);
  if (!m) return null;
  const n = m[1] ? (_WORD_NUM[m[1]] || parseInt(m[1], 10) || 1) : 1;
  const unitMs = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 }[m[2]];
  if (!unitMs) return null;
  return { since: ref - n * unitMs, until: ref };
}

  const _countShaped = /\b(how many|how much|how often|total|count|number of|order of|first to last|earliest to latest|the (two|three|four|five|six|seven) )\b|πόσ(α|ες|ους|η|ο)\b|σύνολ|με τη σειρά/i.test(String(opts.query || ''));
  const _reqShaped = /\b(can you (recommend|suggest)|any (tips|suggestions|recommendations|ideas)|what should i|could you (recommend|suggest)|suggest some|recommend some|what time|when did i|what day)\b/i.test(String(opts.query || ''));
  const k        = Math.max(1, Math.min(20, (opts.k || 5) + (_countShaped ? 6 : 0) + (!_countShaped && _reqShaped ? 6 : 0)));
  if (!query) return [];

  // Cross-type unified retrieval.
  //
  // A commitment-engram-only look-up is wrong for the no-scope path: the
  // substrate's user-meaningful memory is overwhelmingly dialogue.turn
  // (memory_class=episodic) and lessons (memory_class=semantic), so a
  // commitment-only search returns empty and the model reports no memory
  // for conversations the substrate holds verbatim.
  //
  // recall.recall already does the cross-type pull correctly, routing by
  // memory_class (not type) with token-overlap + recency-weighted scoring.
  // When the caller has NOT scoped to a specific corpus, we now ride that
  // surface and layer the legacy commitment+embedding rerank on top.
  //
  // Three paths stay on the legacy commitment+embedding pipeline:
  //   1. opts.scope set — chameleon-style corpus queries (one named pool)
  //   2. opts.agent_id set — sub-brain isolation (sibling-agent recall, NOT
  //      the partner brain default). agent_id absent = partner brain;
  //      agent_id present = explicit silo. Tests + multi-tenant callers
  //      that pin agent_id see the same engram shape they wrote.
  //   3. opts.commitment_only=true — operations that semantically apply
  //      ONLY to commitment-engrams (e.g. /forget tombstones — you can't
  //      "forget" a dialogue turn, it's immutable history). Caller opts
  //      out of cross-type recall explicitly.
  if (opts.scope === undefined && !opts.agent_id && !opts.commitment_only) {
    const recall = require('./recall.js');
    // Phase K: recall is async now (optional embedding rerank).
    const items = await recall.recall({
      query,
      class:    'all',
      audience: opts.audience || 'model_visible',
      cwd:      opts.cwd || null,
      // The caller's precision tier rides through: a deliberate lookup that
      // asked for the cross-encoder gets it on this road too.
      rerank:   opts.rerank,
      // Wider candidate pool than k so embedding boost (below) has material
      // to re-rank. Cap at recall's max (50).
      limit:    Math.min(50, Math.max(k * 5, 10))
    });
    // 'between X and Y' questions need BOTH events retrieved; a single
    // similarity query returns neighbors of the whole sentence and routinely
    // misses one side. Each side runs as its own sub-query and the union
    // feeds the shared rerank — additive only, never replaces the main pool.
    const _between = /\bbetween\s+([\s\S]{4,80}?)\s+and\s+([\s\S]{4,80}?)(?:[?.!]|$)/i.exec(query);
    // Counted-noun sub-query: 'how many projects have I led' needs every
    // PROJECT mention, and the full-sentence similarity spends its budget on
    // 'how many have I led'. The noun phrase after the count cue runs as its
    // own sub-query — same additive union as the between-events split.
    const _counted = _countShaped
      ? /\b(?:how many|how much|number of|order of|the (?:two|three|four|five|six|seven))\s+([a-z][a-z \-]{3,40}?)(?:\s+(?:have|has|had|did|do|does|i|we|are|is|were|was|in|from|that)\b|[?.!]|$)/i.exec(query)
      : null;
    const _subParts = [];
    if (_between) { _subParts.push(_between[1], _between[2]); }
    if (_counted && _counted[1]) { _subParts.push(_counted[1].trim()); }
    if (_subParts.length) {
      const seen = new Set(items.map((it) => it.id));
      for (const part of _subParts) {
        try {
          const extra = await recall.recall({
            query: part, class: 'all', audience: opts.audience || 'model_visible',
            cwd: opts.cwd || null, rerank: opts.rerank, limit: Math.max(4, Math.ceil(k / 2))
          });
          for (const it of extra) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            items.push(it);
          }
        } catch (_) { /* sub-query is additive, never fatal */ }
      }
    }
    if (!items.length) return [];
    // Hybrid rerank (the core of associative recall): recall.recall gives a
    // lexical-ranked candidate pool; we fuse it with a SEMANTIC ranking from
    // the in-process embedder so paraphrase queries (zero keyword overlap)
    // still surface the right memory. Fusion is RRF (rank-based, scale-free):
    //   rrf = 1/(C+lexRank) [+ 1/(C+semRank) when this candidate has a vector]
    // Candidates without a stored embedding (not yet backfilled, or the
    // embedder is unavailable) keep only the lexical term — degraded, never
    // broken, and progressively better as the backfill populates vectors.
    // Cost: one query embed (~11ms) + cheap SQLite vector reads + cosine over
    // the small pool. Disable explicitly with opts.semantic:false.
    let ranked = items;
    if (opts.semantic !== false) {
      let qvec = null;
      try {
        const embedder = require('./local-embedder.js');
        qvec = await embedder.embed(query, { role: 'query' });
      } catch (_) { qvec = null; }
      if (qvec) {
        const C = 60; // standard RRF constant
        // Semantic ranking over candidates that have a stored vector.
        const sims = [];
        for (let i = 0; i < items.length; i++) {
          const vec = state.getEmbedding(items[i].id);
          const sim = vec ? cosine(qvec, vec) : null;
          sims.push({ i, sim });
        }
        const semRank = new Map();
        sims.filter(s => s.sim != null)
            .sort((a, b) => b.sim - a.sim)
            .forEach((s, r) => semRank.set(s.i, r));
        ranked = items
          .map((it, i) => {
            let rrf = 1 / (C + i); // lexical rank = current order
            if (semRank.has(i)) rrf += 1 / (C + semRank.get(i));
            return { it, rrf };
          })
          .sort((a, b) => b.rrf - a.rrf)
          .map(x => x.it);
      }
    }
    const final = ranked.slice(0, k).map(it => ({
      id:        it.id,
      ts:        it.ts,
      statement: it.statement,
      score:     it.score,
      memory_class: it.class,
      source:    it.source || null
    }));
    // Temporal window arm. A query that NAMES a time span ('the three trips
    // in the past three months') often needs evidence sharing no vocabulary
    // with it — similarity cannot reach 'day hike to Muir Woods' from
    // 'trips'. When a window parses, a session-diverse sample of dialogue
    // turns inside it is APPENDED after the ranked results (archive-arm
    // pattern: bounded labeled depth, never released into the general pool).
    const _win = _countShaped ? _parseTimeWindow(query, opts.reference_ts) : null;
    if (_win) {
      try {
        const seenIds = new Set(final.map((it) => it.id));
        const rows = state.queryActions({
          type: 'tool_call', since: _win.since, until: _win.until,
          limit: 200, order: 'desc'
        }) || [];
        const turns = [];
        for (const row of rows) {
          if (seenIds.has(row.id)) continue;
          let inp = null, out = null;
          try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input; } catch (_) { continue; }
          if (!inp || inp.tool_name !== 'dialogue.turn') continue;
          try { out = typeof row.output === 'string' ? JSON.parse(row.output) : row.output; } catch (_) { out = {}; }
          const u = (inp.args && inp.args.user_text) || '';
          const a = (out && out.assistant_text) || '';
          if (!u && !a) continue;
          turns.push({ row, sess: row.session_id || 'none', u, a });
        }
        // Rank INSIDE the window by cosine to the query. Corpus-wide, evidence
        // sharing no vocabulary with the query loses to thousands of stronger
        // neighbors; inside a 200-row window the competition is small enough
        // for weak-but-real similarity to surface it. Blind newest-per-session
        // sampling covered ~4 of ~20 window sessions and missed the evidence.
        let qv = null;
        try { qv = await require('./local-embedder.js').embed(query, { role: 'query' }); } catch (_) { qv = null; }
        if (qv) {
          for (const t of turns) {
            const ev = state.getEmbedding(t.row.id);
            t.cos = ev ? Math.max(0, cosine(qv, ev)) : 0;
          }
          turns.sort((x, y) => (y.cos || 0) - (x.cos || 0));
        }
        const perSession = new Set();
        let added = 0;
        for (const t of turns) {
          if (added >= 4) break;
          if (perSession.has(t.sess)) continue;
          perSession.add(t.sess);
          seenIds.add(t.row.id);
          final.push({
            id: t.row.id,
            ts: t.row.timestamp,
            statement: (t.u ? 'user: ' + t.u : '') + (t.u && t.a ? ' / ' : '') + (t.a ? 'asst: ' + t.a : ''),
            score: 0,
            memory_class: t.row.memory_class || 'episodic',
            source: 'dialogue-window'
          });
          added++;
        }
      } catch (_) { /* window arm is additive — never fatal */ }
    }
    const _nounHead = _counted && _counted[1] ? _counted[1].trim().split(/\s+/).pop().toLowerCase() : null;
    // Instance-pool arm — on count-shaped queries the UNDERSTOOD stratum
    // reads first: typed occurrences distilled by consolidation, already
    // deduplicated by identity, status-resolved, provenance-counted. The
    // raw-turn sweep below stays — a count reads instances and sweeps the
    // primary record for reconciliation; the two strata compose, neither
    // replaces the other. Instances live as substrate_internal so the
    // general pool never mounts them; a count-shaped query is the ONE
    // deliberate lift (audience:'all' here is that lift, not a leak).
    if (_countShaped) {
      try {
        const qLow = query.toLowerCase();
        const qTokens = qLow.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
        const querySlugs = new Set();
        try {
          const ident = require('./entity-identity.js');
          for (const h of ident.lookupFromText(query, { agent_id })) querySlugs.add(h.identity.slug);
        } catch (_) {}
        const _nounHead2 = [];
        if (_nounHead) {
          _nounHead2.push(_nounHead);
          if (_nounHead.endsWith('s') && !_nounHead.endsWith('ss')) _nounHead2.push(_nounHead.slice(0, -1));
          if (_nounHead.length >= 7 && _nounHead.endsWith('ing')) _nounHead2.push(_nounHead.slice(0, -3));
        }
        const poolRows = listEngrams({
          scope_prefix: 'instance:', audience: 'all',
          agent_id: agent_id || undefined, limit: 1000
        }) || [];
        const candidates = [];
        for (const r of poolRows) {
          const inst = r && r.payload && r.payload.instance;
          if (!inst) continue;
          const blob = String(r.statement || '').toLowerCase();
          let sc = 0;
          if (inst.entity_slug && querySlugs.has(inst.entity_slug)) sc += 2;
          if (_nounHead2 && _nounHead2.some((v) => blob.indexOf(v) >= 0)) sc += 2;
          for (const t of qTokens) if (blob.indexOf(t) >= 0) sc += 1;
          candidates.push({ r, sc });
        }
        // Hyponyms are invisible to token overlap — a sweater never contains
        // the word "clothing" — and the pool carries vectors like every other
        // recallable row. Rank-fuse the token ordering with a cosine ordering
        // when the embedder answers; token order alone when it does not —
        // degraded, never broken. Zero-token rows enter only semantically.
        const lexOrder = candidates.filter((c) => c.sc > 0)
          .sort((x, y) => y.sc - x.sc || (x.r.ts || 0) - (y.r.ts || 0));
        let mounted = lexOrder;
        try {
          const _emb = require('./local-embedder.js');
          const qv = await _emb.embed(query, { role: 'query' });
          if (qv) {
            const withCos = candidates.map((c) => {
              let ev = null;
              try { ev = state.getEmbedding(c.r.id); } catch (_) {}
              return { c, cos: ev ? Math.max(0, cosine(qv, ev)) : null };
            });
            const lexRank = new Map(lexOrder.map((c, i) => [c, i + 1]));
            const semOrder = withCos.filter((x) => x.cos != null).sort((a, b) => b.cos - a.cos);
            const semRank = new Map(semOrder.map((x, i) => [x.c, i + 1]));
            const C = 60;
            // Zero-lexical rows enter semantically or not at all: without a
            // similarity floor every vaguely-related instance rides into the
            // enumeration surface as the pool grows, and padded counts teach
            // the user to distrust every number. Floor picked against the
            // measured recovery case (a citrus event reachable only by
            // similarity) with margin below typical same-topic cosines.
            const SEM_FLOOR = 0.25;
            mounted = withCos
              .filter((x) => lexRank.has(x.c) || (x.cos != null && x.cos >= SEM_FLOOR))
              .map((x) => ({
                c: x.c,
                rrf: (lexRank.has(x.c) ? 1 / (C + lexRank.get(x.c)) : 0) +
                     (semRank.has(x.c) ? 1 / (C + semRank.get(x.c)) : 0)
              }))
              .filter((x) => x.rrf > 0)
              .sort((a, b) => b.rrf - a.rrf)
              .map((x) => x.c);
          }
        } catch (_) { /* embedder absent — token order stands */ }
        // A count needs the whole matching class, not the likeliest dozen —
        // measured: the third doctor scored low on keyword overlap, fell
        // below a 12-row cut, and the count came back one short. Forty rows
        // (~800 tokens) covers every observed pool's relevant subset.
        for (const { r } of mounted.slice(0, 40)) {
          let attested = 1;
          let _refs = [];
          try {
            const raw = state.getAction(r.id);
            const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : (raw.output || {});
            if (Array.isArray(out.provenance_ref)) { attested = out.provenance_ref.length; _refs = out.provenance_ref.map(String); }
          } catch (_) {}
          final.push({
            id: r.id,
            ts: r.ts || 0,
            statement: '[instance] ' + r.statement + ' (attested ×' + attested + ')',
            score: 0,
            memory_class: 'semantic',
            source: 'instance-pool',
            refs: _refs
          });
        }
        // Provenance completion — a ledger line whose receipts are absent from
        // the mounted statements used to carry a flag admitting it ("attested
        // outside the shown statements"). The receipts are turn ids the pool
        // already holds, so those turns mount too: both strata present for
        // every member of the counted class — measured missing on the
        // third-doctor run, where neither stratum surfaced the specialist.
        try {
          const have = new Set(final.map((it) => String(it.id)));
          const wantTurns = [];
          for (const it of final) {
            if (it.source !== 'instance-pool') continue;
            for (const ref of (it.refs || [])) {
              const tid = String(ref).replace(/^dialogue\.turn:/, '');
              if (!have.has(tid) && wantTurns.indexOf(tid) === -1) wantTurns.push(tid);
            }
          }
          // Receipts are evidence sentences, not transcripts: each mounted
          // turn is clipped and the whole completion runs under a character
          // budget — an unbounded mount once pushed the biggest haystacks
          // past every compose clock. A receipt that stays unmounted leaves
          // its ledger line carrying the existing honesty flag ("attested
          // outside the shown statements"), so truncation is never silent.
          const TURN_CLIP = 600;
          const COMPLETION_BUDGET = 12000;
          let spent = 0;
          for (const tid of wantTurns.slice(0, 30)) {
            if (spent >= COMPLETION_BUDGET) break;
            let raw = null;
            try { raw = state.getAction(tid); } catch (_) { continue; }
            if (!raw) continue;
            let inp = null, out = null;
            try { inp = typeof raw.input === 'string' ? JSON.parse(raw.input) : raw.input; } catch (_) { continue; }
            try { out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output; } catch (_) { out = {}; }
            const u = (inp && inp.args && inp.args.user_text) || '';
            const a = (out && out.assistant_text) || '';
            if (!u && !a) continue;
            let text = (u ? 'user: ' + u : '') + (u && a ? ' / ' : '') + (a ? 'asst: ' + a : '');
            if (text.length > TURN_CLIP) text = text.slice(0, TURN_CLIP) + ' …';
            spent += text.length;
            have.add(tid);
            final.push({
              id: tid,
              ts: raw.timestamp || 0,
              statement: text,
              score: 0,
              memory_class: raw.memory_class || 'episodic',
              source: 'provenance'
            });
          }
        } catch (_) { /* completion is additive — never fatal */ }
        // Identity cast — a "how many different doctors" question counts
        // PEOPLE, and the registry holds exactly that: canonical identities
        // with their role or relation. The cast of the mounted material rides
        // along (lookupFromText over what is already mounted — no new
        // ontology), so distinctness is counted over identities while the
        // ledger stays the evidence of what each one actually did.
        try {
          const identReg = require('./entity-identity.js');
          const mountedText = final.map((it) => it.statement || '').join('\n');
          const hits = identReg.lookupFromText(mountedText, { agent_id: agent_id || undefined }) || [];
          let castAdded = 0;
          for (const h of hits) {
            if (castAdded >= 15) break;
            const idn = h && h.identity;
            if (!idn || !idn.canonical) continue;
            const cid = 'identity:' + idn.slug;
            if (final.some((it) => String(it.id) === cid)) continue;
            const otherNames = (idn.aliases || []).filter((a) => String(a).toLowerCase() !== String(idn.canonical).toLowerCase());
            // Names the view may LINK on: only those the registry resolves to
            // exactly this one identity — shared aliases render but never join.
            let linkNames = [String(idn.canonical).toLowerCase()];
            try { linkNames = identReg.linkableNames(idn, { agent_id: agent_id || undefined }).map((n) => String(n).toLowerCase()); } catch (_) {}
            final.push({
              id: cid,
              ts: 0,
              statement: '[cast] ' + idn.canonical +
                (idn.relation ? ' — ' + idn.relation : (idn.kind ? ' — ' + idn.kind : '')) +
                (otherNames.length ? ' (also: ' + otherNames.join(', ') + ')' : ''),
              link_names: linkNames,
              score: 0,
              memory_class: 'semantic',
              source: 'identity-cast'
            });
            castAdded++;
          }
        } catch (_) { /* cast is additive — never fatal */ }
      } catch (_) { /* instance pool arm is additive — never fatal */ }
    }
    if (_nounHead && _nounHead.length >= 3) {
      try {
        const seenSweep = new Set(final.map((it) => it.id));
        const ftsRows = state.searchActionsFull('"' + _nounHead.replace(/"/g, '') + '"', {
          type: 'tool_call', rank: true, limit: 200
        }) || [];
        const cands = [];
        for (const row of ftsRows) {
          if (seenSweep.has(row.id)) continue;
          let inp = null, out = null;
          try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input; } catch (_) { continue; }
          if (!inp || inp.tool_name !== 'dialogue.turn') continue;
          const u = (inp.args && inp.args.user_text) || '';
          if (!u) continue;
          const _uLow = u.toLowerCase();
          const _variants = [_nounHead];
          if (_nounHead.endsWith('s') && !_nounHead.endsWith('ss')) _variants.push(_nounHead.slice(0, -1));
          if (_nounHead.length >= 7 && _nounHead.endsWith('ing')) _variants.push(_nounHead.slice(0, -3));
          if (!_variants.some((v) => _uLow.indexOf(v) >= 0)) continue;
          try { out = typeof row.output === 'string' ? JSON.parse(row.output) : row.output; } catch (_) { out = {}; }
          cands.push({ row, sess: row.session_id || 'none', u, a: (out && out.assistant_text) || '' });
        }
        const bySess = new Map();
        for (const t of cands) {
          const prev = bySess.get(t.sess);
          if (!prev || t.row.timestamp < prev.row.timestamp) bySess.set(t.sess, t);
        }
        const picked = [...bySess.values()].sort((x, y) => x.row.timestamp - y.row.timestamp).slice(0, 8);
        for (const t of picked) {
          seenSweep.add(t.row.id);
          final.push({
            id: t.row.id,
            ts: t.row.timestamp,
            statement: (t.u ? 'user: ' + t.u : '') + (t.u && t.a ? ' / ' : '') + (t.a ? 'asst: ' + t.a : ''),
            score: 0,
            memory_class: t.row.memory_class || 'episodic',
            source: 'instance-sweep'
          });
        }
      } catch (_) { /* instance sweep is additive — never fatal */ }
    }
    // Continuation arm. A "what did you tell me / remind me what you said"
    // question paraphrases the user's ASK, so retrieval lands on the ask
    // turn — while the assistant's specific content (the names, the list,
    // the text they want back) lives in the turns immediately AFTER it in
    // the same session. For those questions, each retrieved dialogue turn
    // pulls its next two session-neighbours, bounded and labeled like the
    // window and sweep arms — never released into the general pool.
    const _ssaShaped = /\b(what did you (say|tell|recommend|suggest|write)|you (told|gave|recommended|suggested|wrote) (me|us)|remind me (what|of the|about)|our (previous|last|earlier) (conversation|chat|discussion)|going back to our)\b/i.test(query);
    if (_ssaShaped) {
      try {
        const seenCont = new Set(final.map((it) => it.id));
        const added = [];
        for (const it of final.slice(0, k)) {
          const src = state.getAction(it.id);
          if (!src || !src.session_id) continue;
          let inp0 = null;
          try { inp0 = typeof src.input === 'string' ? JSON.parse(src.input) : src.input; } catch (_) { continue; }
          if (!inp0 || inp0.tool_name !== 'dialogue.turn') continue;
          const next = state.queryActions({
            type: 'tool_call', session_id: src.session_id,
            since: src.timestamp + 1, limit: 2, order: 'asc'
          }) || [];
          for (const row of next) {
            if (seenCont.has(row.id) || added.length >= 6) continue;
            let inp = null, out = null;
            try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input; } catch (_) { continue; }
            if (!inp || inp.tool_name !== 'dialogue.turn') continue;
            try { out = typeof row.output === 'string' ? JSON.parse(row.output) : row.output; } catch (_) { out = {}; }
            const u = (inp.args && inp.args.user_text) || '';
            const a = (out && out.assistant_text) || '';
            if (!u && !a) continue;
            seenCont.add(row.id);
            added.push({
              id: row.id,
              ts: row.timestamp,
              statement: (u ? 'user: ' + u : '') + (u && a ? ' / ' : '') + (a ? 'asst: ' + a : ''),
              score: 0,
              memory_class: row.memory_class || 'episodic',
              source: 'dialogue-continuation'
            });
          }
        }
        for (const it of added) final.push(it);
      } catch (_) { /* continuation arm is additive — never fatal */ }
    }
    _triggerPLR(final);
    return final;
  }

  // Scope-locked legacy path: caller wants a specific commitment corpus
  // (chameleon docs:* etc). Keep the commitment+embedding pipeline intact.
  // cwd here is BOOST context, not filter — items recorded under the
  // same cwd as the current turn get a small score multiplier so the
  // current-folder context floats slightly higher in the ranking, but
  // cross-cwd memories remain reachable. Pass strict_isolation:true
  // for the legacy hard-filter behavior (multi-tenant / strict tests).
  const boostCwd = opts.cwd || null;
  const cwdMatchBoost = typeof opts.cwd_match_boost === 'number' ? opts.cwd_match_boost : 1.20;
  const listOpts = {
    limit: opts.candidate_limit || 200,
    strict_isolation: !!opts.strict_isolation,
    // Default audience filter mirrors the recall.recall() path: callers
    // that don't specify audience get model_visible (no substrate_internal
    // handoff/operational rows). 'all' available for admin/diagnostic.
    audience: opts.audience || 'model_visible'
  };
  // RECALL-FIX  (Step 2): a corpus (scope) query reads the UNIFIED
  // partner brain — the scope IS the isolation. The agent_id silo is a
  // multi-tenant leftover that wrongly zeroed corpora written under a different
  // agent_id (research corpora were written under the original operator collab agent_id; the MCP/entity ctx passes
  // 'mcp-substrate'/'local-agent' -> hard SQL agent_id mismatch -> 0 hits).
  // Honor the agent_id hard filter ONLY when NO scope is requested (genuine
  // sub-brain isolation); for corpus queries, read principal='partner'.
  if (agent_id && opts.scope === undefined) listOpts.agent_id = agent_id;
  if (opts.principal !== undefined) listOpts.principal = opts.principal;
  if (opts.strict_isolation) listOpts.cwd = boostCwd;
  // Scope-restricted retrieval: caller passes opts.scope to limit
  // the candidate pool to one corpus (e.g., 'legal-2026'). Omitted →
  // all scopes including null.
  if (opts.scope !== undefined) listOpts.scope = opts.scope;
  const candidates = listEngrams(listOpts);
  if (!candidates.length) return [];
  const host = opts.embedding_host || null;
  let queryEmbedding = null;
  if (host) {
    try { queryEmbedding = await embedRequest(host, query); } catch (_) { queryEmbedding = null; }
  }
  // Hybrid retrieval (RRF — Reciprocal Rank Fusion): combine the
  // semantic score with the lexical-overlap score so neither path
  // alone has to be perfect. Bench eval-1 showed pooled embeddings
  // alone gave 0% top-1 / 10% top-3 precision on 30 facts × 10
  // queries. RRF lifts that materially because lexical catches
  // shared keywords that the embedding can't disambiguate at this
  // size, and semantic catches paraphrases that lexical misses.
  const scored = [];
  // Compute both scores for every candidate, then merge with the
  // standard RRF formula score = sum(1 / (k_const + rank)) over both
  // rankings. We use a simpler weighted-mean variant since we have
  // continuous similarity values, not just ranks.
  const semanticWeight = typeof opts.semantic_weight === 'number' ? opts.semantic_weight : 0.6;
  const lexicalWeight  = typeof opts.lexical_weight  === 'number' ? opts.lexical_weight  : 0.4;
  for (const c of candidates) {
    // TMMA tier='flagged' exclusion at the RECALL surface (mirror of every
    // recall.recall arm + identity-envelope). listEngrams keeps flagged rows
    // visible on purpose (drift-resolution reasons about contradictions), but
    // this is a recall primitive: a contradicted / operator-forgotten engram
    // must not come back as a live memory. include_flagged opts into audit.
    if (!opts.include_flagged && c.tier === 'flagged') continue;
    let semantic = 0;
    if (queryEmbedding && Array.isArray(c.embedding) && c.embedding.length) {
      semantic = Math.max(0, cosine(queryEmbedding, c.embedding));
    }
    const lexical = lexicalScore(query, c.statement);
    // cwd-match boost: when boostCwd is set AND this engram was recorded
    // under the same cwd, multiply final score by cwd_match_boost (default
    // 1.20). Items from other cwds remain reachable but rank slightly
    // lower than equally-relevant local ones — matches "I remember this
    // from when I was in this room more vividly" intuition.
    const cwdBoost = (boostCwd && c.cwd && c.cwd === boostCwd) ? cwdMatchBoost : 1.0;
    let score;
    if (queryEmbedding) {
      score = semanticWeight * semantic + lexicalWeight * lexical;
    } else {
      score = lexical;
    }
    score *= (c.salience || 1);
    score *= cwdBoost;
    if (score > 0) scored.push({ ...c, score, _semantic: semantic, _lexical: lexical, _cwd_boost: cwdBoost });
  }
  scored.sort((a, b) => b.score - a.score);
  const finalLegacy = scored.slice(0, k);
  _triggerPLR(finalLegacy);
  return finalLegacy;
}

function renderRetrieval(items, opts) {
  opts = opts || {};
  if (!Array.isArray(items) || !items.length) return '';
  const lines = ['Substrate engram (relevant memories):'];
  for (const it of items) {
    const s = String(it.statement || '').replace(/\s+/g, ' ').trim();
    if (s) lines.push('  - ' + s);
  }
  let block = lines.join('\n');
  const cap = opts.max_chars || 1000;
  if (block.length > cap) block = block.slice(0, cap - 16) + '\n  …(truncated)';
  return block;
}

// B3 — provenance-axis audit, NOT a retrieval primitive.
//
// Per W3C PROV-O `prov:wasAttributedTo`: agent_id is provenance metadata,
// independent of entity content. PROV separates *who wrote* (queryable as
// a side-graph) from *what it is* (the primary read surface). Reads must
// default to entity (`principal_id`), never to agent_id — the
// substrate-as-mind invariant. This function violates that pattern if
// used at retrieval time; it exists ONLY for audit/diagnostic views.
//
// Canonical name: `auditEngramsByAgent` (preferred — communicates intent).
// Backward-compat alias `listAgentsWithEngrams` exported below; new
// callers must use the new name. Production retrieval surfaces MUST NOT
// import this — use listEngrams (principal-scoped) instead.
//
// Returns metadata only (agent_id + count) — never engram contents.
function auditEngramsByAgent(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(50, opts.limit || 20));
  try {
    if (!state._dbForQuery) return [];
    const c = state._dbForQuery();
    if (!c) return [];
    const rows = c.prepare(
      "SELECT agent_id, COUNT(*) AS n FROM action_records " +
      "WHERE type='commitment' " +
      "GROUP BY agent_id ORDER BY n DESC LIMIT ?"
    ).all(limit) || [];
    return rows.map(function(r) { return { agent_id: r.agent_id, count: r.n }; });
  } catch (_) { return []; }
}

// The head noun of a count-shaped question ('how many WEDDINGS have I…' →
// 'weddings'), null when the question is not count-shaped. The same pattern
// the count arm's counted-noun sub-query uses; exported so the reconciled
// view can scope its cast counting clause to what is actually being counted.
function countNounHead(query) {
  const m = /\b(?:how many|how much|number of|order of|the (?:two|three|four|five|six|seven))\s+([a-z][a-z \-]{3,40}?)(?:\s+(?:have|has|had|did|do|does|i|we|are|is|were|was|in|from|that)\b|[?.!]|$)/i.exec(String(query || ''));
  return m && m[1] ? m[1].trim().split(/\s+/).pop().toLowerCase() : null;
}

module.exports = {
  recordEngram,
  listEngrams,
  auditEngramsByAgent,
  countNounHead,
  // Deprecated alias — kept for backward compat with pre- callers.
  // New code MUST use auditEngramsByAgent (intent-communicating name).
  listAgentsWithEngrams: auditEngramsByAgent,
  retrieveRelevant,
  renderRetrieval,
  embedRequest,
  cosine,
  // shared emphasis heuristic
  detectEmphasis,
  COMMITMENT_TYPE
};
