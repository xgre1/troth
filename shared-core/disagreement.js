// SPDX-License-Identifier: AGPL-3.0-only
// disagreement — G2.
//
// Substrate must NOT silently cave when the user contradicts an active
// commitment. The market default — sycophancy — is the single biggest
// anti-pattern in current agent frameworks (Anthropic published evidence
// that preference models prefer convincingly-written sycophantic
// responses over correct ones; arxiv 2310.13548). The substrate's
// distinguishing claim is that it is the user's COLLABORATOR, not their
// reflective surface. Collaborators push back when they have reason to.
//
// This module provides PURE detection. No I/O, no LLM, no L1 writes.
// Caller wires the result into the decision engine (a new rule that
// fires before the generic LLM-route rule). On hit, the engine prepends
// a "stance preface" to the LLM's system prefix that forces the model
// to either (a) defend the commitment with reason, or (b) formally
// propose revision citing what changed — never silent agreement.
//
// Detection strategy (deterministic, no embeddings required):
//   1. Negation-paired contradiction. User text contains an explicit
//      contradiction marker ("no, actually", "you're wrong", "I disagree",
//      "stop saying", "actually use", "we should X instead") AND token
//      overlap with the commitment's content tokens.
//   2. Direct opposite-pair flip. The substrate maintains an extensible
//      opposites table (tabs↔spaces, concise↔verbose, sqlite↔postgres,
//      etc.); a commitment containing one side, paired with user text
//      containing the other side under positive polarity, fires.
//   3. Polarity inversion. Commitment asserts "X is Y" / "I prefer X" /
//      "always X"; user asserts "X is not Y" / "I prefer Z" / "never X"
//      with overlap on the X stem.
//
// Scope:
//   - SCANS commitments of type ∈ {anchor, hard, hypothesis, opinion,
//     methodology}. NOT refusal (refusal is handled by ruleHonorRefusal
//     in decision-engine — different mechanism, different action).
//     NOT engram, NOT factual (those are observations, not positions).
//   - Per-commitment confidence score [0..1]. Multiple matches OK.
//   - Returns ALL hits sorted by confidence; caller decides threshold.

const STOP_TOKENS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'i','you','he','she','it','we','they','my','your','our','their',
  'and','or','but','not','no','yes','of','to','for','in','on','at',
  'with','by','from','that','this','these','those','have','has','had',
  'do','does','did','will','would','should','could','may','might','can',
  'shall','must','about','as','if','than','then','so','too','very',
  'into','out','over','under','again','also','some','any','all','each',
  'every','only','just','more','most','less','few','many','much','other',
  'such','one','two','three','first','second','last','same','new','old'
]);

// Default opposite-pair table. Pure data. Substrate-extensible via
// opts.opposites (caller merges in domain-specific pairs at construction).
const DEFAULT_OPPOSITES = Object.freeze({
  // Coding style
  'tabs':       ['spaces'],
  'spaces':     ['tabs'],
  'concise':    ['verbose', 'detailed', 'lengthy', 'longwinded'],
  'verbose':    ['concise', 'terse', 'brief'],
  'terse':      ['verbose', 'detailed', 'lengthy'],
  'detailed':   ['concise', 'terse', 'brief'],
  // Editors / tools (frequent in dev contexts)
  'helix':      ['vim', 'neovim', 'vscode', 'emacs', 'sublime', 'cursor'],
  'vim':        ['helix', 'vscode', 'emacs'],
  'vscode':     ['helix', 'vim', 'emacs'],
  'emacs':      ['helix', 'vim', 'vscode'],
  // Databases
  'sqlite':     ['postgres', 'postgresql', 'mysql', 'mongodb', 'redis'],
  'postgres':   ['sqlite', 'mysql', 'mongodb'],
  'mysql':      ['postgres', 'sqlite'],
  // Languages (common dev contradictions)
  'rust':       ['go', 'cpp', 'c++', 'java', 'python', 'typescript'],
  'go':         ['rust', 'java', 'python'],
  'python':     ['rust', 'go', 'typescript', 'javascript'],
  'typescript': ['javascript', 'python', 'go'],
  'javascript': ['typescript'],
  // Generic positions
  'open':       ['closed', 'proprietary'],
  'closed':     ['open', 'opensource', 'open-source'],
  'local':      ['hosted', 'cloud', 'remote'],
  'hosted':     ['local', 'on-premise', 'self-hosted']
});

const CONTRADICTION_MARKERS = [
  /\bno,?\s+actually\b/i,
  /\bactually,?\s+(?:use|do|run|prefer|consider)\b/i,
  /\byou(?:'?re|\s+are)\s+wrong\b/i,
  /\bthat'?s\s+(?:wrong|incorrect|false)\b/i,
  /\bi\s+disagree\b/i,
  /\b(?:stop|quit)\s+(?:saying|insisting|claiming|suggesting|citing|pushing|recommending)\b/i,
  /\bstop\s+\w{4,}ing\b/i,                  // generic "stop Xing" — paired with topic overlap to fire
  /\bdon'?t\s+(?:push|cite|do|use|run|bother|suggest|recommend|insist|maintain)\b/i,
  /\bbut\s+you\s+said\b/i,
  /\bwe\s+should\s+(?:use|do|switch\s+to)\s+\w+\s+instead\b/i,
  /\b(?:forget|ignore)\s+(?:that|what\s+you\s+said)\b/i,
  /\b(?:forget|ignore)\s+\w+,?\s+(?:we|i)\s+should\b/i, // "forget local, we should use hosted"
  /\bchange\s+(?:my|your)\s+mind\b/i,
  /\bnever\s+mind\s+(?:that|what)\b/i,
  /\b(?:never|stop)\s+\w+\s+(?:again|anymore)\b/i      // "never use Rust again"
];

const REVISION_EVIDENCE_MARKERS = [
  /\bnew\s+(?:data|evidence|finding|info|research|paper|benchmark)\b/i,
  /\bturns?\s+out\b/i,
  /\bjust\s+(?:learned|discovered|found\s+out|read|saw)\b/i,
  /\bupdated?\s+(?:study|research|guidance|docs?|recommendation)\b/i,
  /\bthe\s+latest\s+(?:version|release|guidance|spec)\b/i,
  /\b(?:since|because)\s+(?:we|i)\s+(?:learned|discovered|found)\b/i,
  /\bcontext\s+(?:has\s+)?changed\b/i
];

function tokenize(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    // Keep alphanumerics + a few code-relevant punctuation chars (+, #, -)
    // for tokens like "c++", "c#", "well-known". Drop '.' — sentence-end
    // periods would otherwise stick to tokens ("go." ≠ "go") and break
    // opposite-pair set membership checks.
    .replace(/[^a-z0-9\s+#\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOP_TOKENS.has(t));
}

function contentTokenSet(text) {
  return new Set(tokenize(text));
}

// Score how strongly userText contradicts commitmentStatement. Returns
// {score: 0..1, signals: [string list of which heuristics fired]}.
function scoreContradiction(userText, commitmentStatement, opposites) {
  const signals = [];
  const cmTokens = contentTokenSet(commitmentStatement);
  const userTokens = contentTokenSet(userText);
  if (cmTokens.size === 0 || userTokens.size === 0) {
    return { score: 0, signals: [] };
  }

  // Topic overlap — how many content tokens does the user share with the
  // commitment? Without overlap, no contradiction possible (different topic).
  let overlap = 0;
  for (const t of userTokens) if (cmTokens.has(t)) overlap++;
  const overlapRatio = overlap / Math.min(cmTokens.size, userTokens.size);

  // Heuristic 1: explicit contradiction marker. A marker WITHOUT any
  // topic overlap is unrelated to the commitment — would false-fire on
  // arbitrary contradictions. Require at least one shared content token
  // before counting a marker as a hit.
  let markerHit = false;
  if (overlap > 0) {
    for (const re of CONTRADICTION_MARKERS) {
      if (re.test(userText)) { markerHit = true; signals.push('contradiction_marker'); break; }
    }
  }

  // Heuristic 2: opposite-pair flip. For each commitment token that has
  // a known opposite, check if the user mentioned that opposite under
  // positive polarity (no negation prefix in immediate vicinity).
  let oppositeHit = false;
  let oppositePairs = [];
  for (const cmTok of cmTokens) {
    const opps = opposites[cmTok];
    if (!Array.isArray(opps)) continue;
    for (const oppTok of opps) {
      if (userTokens.has(oppTok)) {
        // Verify positive polarity in user text — make sure they're not
        // saying "don't use X" where X is the opposite.
        const negationProx = new RegExp('\\b(?:not|no|never|don\'?t|stop|avoid|skip)\\b\\s+(?:\\w+\\s+){0,3}' + escapeRegex(oppTok), 'i');
        if (!negationProx.test(userText)) {
          oppositeHit = true;
          oppositePairs.push({ commitment: cmTok, user_asserted: oppTok });
          signals.push('opposite_pair:' + cmTok + '->' + oppTok);
        }
      }
    }
  }

  // Heuristic 3: polarity inversion. Commitment asserts a positive
  // position; user negates / suppresses it. Broader positive-marker set
  // covers anchor / methodology / opinion verb forms (cite, push back,
  // hold, maintain, prefer, etc.) so "Stop citing" against "Cite the
  // file path" fires correctly.
  let polarityHit = false;
  if (overlapRatio > 0.10) {
    const cmHasPositive = /\b(?:is|are|prefer|always|use|love|good|best|cite|push(?:\s+back)?|hold|maintain|stand|require|need|should|must|defend|insist)\b/i.test(commitmentStatement);
    const userHasNegative = /\b(?:not|never|don'?t|stop|avoid|skip|wrong|bad|worst|forget|ignore|quit)\b/i.test(userText);
    if (cmHasPositive && userHasNegative) {
      polarityHit = true;
      signals.push('polarity_inversion');
    }
  }

  // Score blend. Weights chosen so any single strong signal hits ~0.6
  // (above default threshold of 0.5), and combining signals raises
  // confidence further. Topic overlap gates the whole thing — without
  // overlap, the contradiction is about a different topic and we
  // shouldn't fire.
  if (overlapRatio < 0.05 && !oppositeHit && !markerHit) {
    return { score: 0, signals: [] };
  }
  let score = 0;
  if (markerHit)   score += 0.55 + 0.15 * overlapRatio;  // marker + any overlap clears 0.5 threshold
  if (oppositeHit) score += 0.6;
  if (polarityHit) score += 0.4 * Math.min(1, overlapRatio * 2);
  if (score > 1) score = 1;

  return { score, signals, overlap_ratio: overlapRatio, opposite_pairs: oppositePairs };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Detect contradictions in user text against an array of commitment
// records (each record is the L1 row shape — needs `output.statement`,
// `output.commitment_type`, `id`).
//
// Returns:
//   {
//     contradicts: bool,                       // any hit above threshold
//     proposes_revision: bool,                 // user supplied new-evidence marker
//     hits: [{
//       commitment_id, kind, statement,
//       score, signals, overlap_ratio
//     }]
//   }
function detect(userText, commitments, opts) {
  opts = opts || {};
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.5;
  const opposites = Object.assign({}, DEFAULT_OPPOSITES, opts.opposites || {});
  const eligibleKinds = opts.kinds || ['anchor', 'hard', 'hypothesis', 'opinion', 'methodology'];

  const hits = [];
  if (typeof userText !== 'string' || !userText.trim() || !Array.isArray(commitments)) {
    return { contradicts: false, proposes_revision: false, hits: [] };
  }

  for (const c of commitments) {
    if (!c || typeof c !== 'object') continue;
    const out = c.output || c; // tolerate raw L1 row OR pre-extracted
    const kind = out.commitment_type;
    const stmt = out.statement;
    const id   = c.id || out.id;
    if (!kind || !stmt || !eligibleKinds.includes(kind)) continue;
    const r = scoreContradiction(userText, stmt, opposites);
    if (r.score >= threshold) {
      hits.push({
        commitment_id: id,
        kind,
        statement: stmt,
        score: r.score,
        signals: r.signals,
        overlap_ratio: r.overlap_ratio,
        opposite_pairs: r.opposite_pairs || []
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);

  // Detect whether user is offering NEW EVIDENCE (revision-friendly) or
  // just dismissing without basis (defend-friendly).
  let proposesRevision = false;
  for (const re of REVISION_EVIDENCE_MARKERS) {
    if (re.test(userText)) { proposesRevision = true; break; }
  }

  return {
    contradicts: hits.length > 0,
    proposes_revision: proposesRevision,
    hits
  };
}

// Compose a "stance preface" the substrate prepends to the LLM system
// prefix when a contradiction fires. The preface forces the LLM into one
// of two structured modes — defend or propose-revision — never silent
// agreement.
//
// The substrate is the COLLABORATOR; the LLM is the speech layer. This
// preface keeps the speech layer honest to substrate-stored positions.
function composeStancePreface(detection) {
  if (!detection || !detection.contradicts || !detection.hits.length) return null;
  const top = detection.hits[0];
  const lines = [];
  lines.push('IMPORTANT: substrate disagreement detected.');
  lines.push('You hold this active commitment (kind=' + top.kind + ', id=' + (top.commitment_id || 'n/a') + '):');
  lines.push('  "' + top.statement + '"');
  lines.push('The user just made a statement that appears to contradict it' +
             (top.signals && top.signals.length ? ' (signals: ' + top.signals.join(', ') + ')' : '') + '.');
  lines.push('');
  if (detection.proposes_revision) {
    lines.push('The user appears to provide NEW EVIDENCE for revision. You may either:');
    lines.push('  (a) Defend the commitment, citing why the new evidence does not yet override it, OR');
    lines.push('  (b) Formally propose REVISION: state the proposed new commitment, the evidence,');
    lines.push('      and ask the user to confirm before recording.');
    lines.push('Do NOT silently accept the new position without (b).');
  } else {
    lines.push('Push back: defend the commitment with concrete reason. The user has not provided');
    lines.push('new evidence — politely-but-clearly maintain the position rather than agreeing for');
    lines.push('the sake of agreement. If you believe the commitment IS wrong, propose formal revision');
    lines.push('citing what changed; do not silently flip.');
  }
  lines.push('');
  if (detection.hits.length > 1) {
    lines.push('Additional commitments potentially in conflict:');
    for (const h of detection.hits.slice(1, 4)) {
      lines.push('  - "' + h.statement + '" (kind=' + h.kind + ', score=' + h.score.toFixed(2) + ')');
    }
  }
  return lines.join('\n');
}

module.exports = {
  detect,
  composeStancePreface,
  scoreContradiction,
  tokenize,
  DEFAULT_OPPOSITES,
  CONTRADICTION_MARKERS,
  REVISION_EVIDENCE_MARKERS
};
