// SPDX-License-Identifier: AGPL-3.0-only
// LLM family taxonomy — hardcoded per design C.2 cross-family rule.
//
// design grounding: family classification is STRUCTURAL (hardcoded
// in-tree), not operator-editable. R17 demands structural enforcement;
// an editable taxonomy is soft-instruction-equivalent (operator could
// silently demote a family to bypass cross-family rule).
//
// Citations:
//   - design C.2 (reflection model independence): "reflection model
//     MUST be different family from the executing worker's model"
//   - MT-Bench (Zheng 2306.05685) §3.2: self-enhancement bias —
//     judges prefer their own-family outputs; cross-family mitigates.
//   - Self-Refine (Madaan 2303.17651) ablations: same-model self-judging
//     DEGRADES on reasoning tasks. Cross-family avoids this.

'use strict';

// Family → matchers. Matched in order; first match wins. Patterns are
// case-insensitive substring matches against the model id string.
//
// Adding a family: append below + add representative model id patterns.
// New providers should also extend TOOL_CAPABILITIES if they expose tools.
const FAMILY_PATTERNS = Object.freeze([
  { family: 'anthropic',  patterns: ['claude'] },
  { family: 'openai',     patterns: ['gpt-', 'o1-', 'o3-', 'o4-', 'openai'] },
  { family: 'google',     patterns: ['gemini', 'palm', 'bard', 'gemma'] },
  { family: 'meta',       patterns: ['llama', 'codellama'] },
  { family: 'mistral',    patterns: ['mistral', 'mixtral'] },
  { family: 'qwen',       patterns: ['qwen'] },
  { family: 'deepseek',   patterns: ['deepseek'] },
  { family: 'minimax',    patterns: ['minimax'] },
  { family: 'nvidia',     patterns: ['nvidia', 'nemotron'] },
  // Moonshot / Kimi: membership ids are terse (k3, k3[1m]) so the k3
  // pattern is anchored via the exact-id check in familyOf below; the
  // substring patterns cover kimi-k3 / kimi-for-coding / moonshot-v1.
  // Without this family every Kimi id classified 'unknown', which the
  // cross-family sorter treats as same-family-as-everything — the fidelity
  // judge then let Kimi judge Kimi.
  { family: 'moonshot',   patterns: ['kimi', 'moonshot'] },
  { family: 'grok',       patterns: ['grok'] },
  { family: 'zhipu',      patterns: ['glm-', 'chatglm'] },
  // 'local' is a residual bucket — anything that doesn't match a known
  // provider family. v1 conservatively groups all local-hosted unknowns
  // as one family (so e.g. two unknown local fine-tunes are considered
  // SAME family — strictest interpretation of cross-family rule).
  { family: 'local',      patterns: ['local'] }
]);

// Returns one of the known family names OR 'unknown'.
function familyOf(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'unknown';
  const lower = modelId.toLowerCase();
  // Kimi membership ids are bare version tags (k3, k3[1m], k2.7…) with no
  // vendor substring — anchor them explicitly before the pattern walk.
  if (/^k\d+(\.\d+)?(\[|-|$)/.test(lower)) return 'moonshot';
  for (const entry of FAMILY_PATTERNS) {
    for (const p of entry.patterns) {
      if (lower.indexOf(p) >= 0) return entry.family;
    }
  }
  return 'unknown';
}

// Returns the list of all known family names (for diagnostics).
function listFamilies() {
  return FAMILY_PATTERNS.map(e => e.family);
}

// True iff a and b are different families AND both are known.
// Unknown family treated as worst-case SAME-family — refuses to certify
// cross-family-ness when we can't classify (fail-closed per R17).
function isCrossFamily(a, b) {
  const fa = familyOf(a);
  const fb = familyOf(b);
  if (fa === 'unknown' || fb === 'unknown') return false;
  return fa !== fb;
}

module.exports = {
  familyOf,
  listFamilies,
  isCrossFamily,
  FAMILY_PATTERNS
};
