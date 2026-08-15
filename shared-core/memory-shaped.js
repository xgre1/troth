// SPDX-License-Identifier: AGPL-3.0-only
// The one classifier for "this is a memory question".
//
// Two consumers, one shape: the proxy lane forces tool_choice to recall on
// these prompts (recallforce), and the entity's decision engine answers them
// straight from the substrate when recall is confident (memory dispatch).
// The same question shape drives both, so the patterns live once — a prompt
// the proxy would force is a prompt the entity should answer from memory.
//
// Precision-first, three writing systems: a missed match still has the
// advisory road (instructions, greeting, the memory_session mount), but a
// false match costs a wasted round-trip on one lane and a wrongly-confident
// direct answer on the other. Only unambiguous memory questions match.

'use strict';

const MEMORY_PATTERNS = [
  // English — the question must be about shared past, not just contain a keyword.
  /\bdo you (still )?remember\b/i,
  /\bwhat (did|had) (we|you|i) (say|said|decide|decided|agree|agreed|discuss|discussed)\b/i,
  /\bwhat (were|was) (we|i) (working on|doing)\b/i,
  /\bwhere (did|had) we (leave off|left off|stop|stopped)\b/i,
  /\bdid we (already|ever) (decide|discuss|agree|do|try)\b/i,
  /\bwhat did we leave (off|open|unfinished)\b/i,
  // Greek — same shapes.
  /θυμάσαι|θυμασαι/i,
  /τι (είχαμε|έχουμε|ειχαμε|εχουμε) (πει|αποφασίσει|αποφασισει|συμφωνήσει|συμφωνησει|συζητήσει|συζητησει)/i,
  /πο[υύ] (είχαμε |ειχαμε )?(μείνει|μεινει|σταματήσει|σταματησει)/i,
  /τι (κάναμε|καναμε|δουλεύαμε|δουλευαμε) (χθες|χτες|την προηγούμενη|την προηγουμενη)/i,
  // Greeklish — only the unambiguous spellings; the variants are unbounded
  // and every loose one is a false-force risk.
  /\bth[iy]mas(ai|e)\b/i,
  /\bti (eixame|ixame) pei\b/i,
  /\bpou (eixame |ixame )?(meinei|minei|stamatisame)\b/i
];

function isMemoryShaped(text) {
  if (!text || typeof text !== 'string') return false;
  for (const p of MEMORY_PATTERNS) if (p.test(text)) return true;
  return false;
}

// Lexical grounding between a query and a recalled statement, 0..1 over the
// query's content tokens. Used as the confidence FLOOR for direct answers:
// per-class recall scores are not on one calibrated scale, so a numeric
// threshold over them would be pseudo-precision — token overlap is the
// honest, scale-free measure both sides share.
// Two refinements measured in: interrogative scaffolding ("what", "about")
// carries no content and only dilutes the ratio, and exact-token equality
// is brittle to morphology ("decide" never equals "decision" — the naive-
// keying trap). Tokens compare on a 4-char prefix instead: a cheap stemmer
// whose false positives are absorbed by the two gates stacked on top of
// this one (memory shape + dominance).
const QUESTION_STOP = new Set([
  'what', 'when', 'where', 'which', 'whose', 'about', 'does', 'have',
  'were', 'will', 'would', 'should', 'could', 'remember', 'decided',
  'ποια', 'ποιο', 'πότε', 'ποτε', 'όταν', 'οταν', 'θυμάσαι', 'θυμασαι'
]);
function queryOverlap(query, statement) {
  const tok = (s) => [...new Set(String(s || '').toLowerCase()
    .split(/[^a-z0-9Ͱ-Ͽἀ-῿]+/)
    .filter(t => t.length >= 4))];
  const q = tok(query).filter(t => !QUESTION_STOP.has(t));
  if (!q.length) return 0;
  const stems = new Set(tok(statement).map(t => t.slice(0, 4)));
  let hit = 0;
  for (const t of q) if (stems.has(t.slice(0, 4))) hit++;
  return hit / q.length;
}

module.exports = { isMemoryShaped, queryOverlap, MEMORY_PATTERNS };
