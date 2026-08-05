// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Fidelity critic (Layer 3): the substrate holding the current (the LLM) faithful
// to the operator HOW-rules (working-style / process), not the WHAT (task content).
//
// Stateless and provider-agnostic. The HOST injects:
//   - judge: an async (prompt) -> Promise<string|null> backed by a CHEAP REASONING
//     model (never a non-reasoning "flash" model; router.callFlash hardcodes
//     think:false and is the wrong base for judgment).
//   - rules: the operator SCOPED HOW-rules, already filtered by the host to the
//     active cwd/project + time window so a client rule cannot bleed elsewhere.
//
// Deterministic checkable rules (em-dash, read-before-edit) live in critic.js (Layer 2).
// This layer judges the SEMANTIC rules regex cannot ("did it assume", "did it downscope",
// "did it give an A/B/C fork instead of a recommendation").
//
// WARN-first by contract: returns advisories only. It NEVER blocks and NEVER throws
// (every path fails open to "clean"). The host decides logging + next-turn surfacing.

const MAX_TURN_CHARS = 6000;   // keep judge calls cheap (mirrors proxy critic truncation)
const MAX_TOOLSEQ = 12;

function _clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
}

// A rule shape: { id, rule, good?, bad?, scope? }. id = stable slug (e.g. a feedback
// engram slug); rule = the HOW stated plainly; good/bad = optional reference examples
// (rubric + reference example sharply lowers LLM-judge false positives).
function buildVerdictPrompt(rules, turnText, toolSequence, opts) {
  opts = opts || {};
  const ruleLines = (rules || []).map(function (r, i) {
    return (i + 1) + '. [' + r.id + '] ' + r.rule +
      (r.good ? '\n   GOOD: ' + r.good : '') +
      (r.bad ? '\n   BAD: ' + r.bad : '');
  }).join('\n');
  const seq = (toolSequence || []).slice(0, MAX_TOOLSEQ).map(function (t) {
    return '- ' + (t.name || '') + (t.target ? ' ' + _clip(t.target, 120) : '');
  }).join('\n');
  const parts = [
    'You are a FIDELITY checker. You do NOT judge whether the task was solved.',
    'You judge ONLY whether the assistant followed the operator working-style rules below (the HOW, not the WHAT).',
    'Be strict but evidence-based: quote the exact phrase that violates a rule. If you are not sure, do NOT flag it.',
    '',
    'OPERATOR RULES (scoped to this project and time window):',
    ruleLines || '(none)',
    ''
  ];
  if (seq) parts.push('TOOLS USED THIS TURN:\n' + seq + '\n');
  parts.push(
    'ASSISTANT TURN UNDER REVIEW:',
    '"""',
    _clip(turnText, MAX_TURN_CHARS),
    '"""',
    '',
    'On the FIRST line respond exactly LGTM if no listed rule was violated.',
    'Otherwise output one line per violation, each formatted exactly:',
    '[<rule_id>] <the exact violating phrase or behavior> :: <confidence between 0 and 1>',
    'Judge ONLY the rules listed above. Do not invent rules. Do not comment on task correctness.'
  );
  return parts.join('\n');
}

// Parse a verdict into structured violations. Tolerant of chain-of-thought / preamble:
// strips <think>...</think>, scans every line for the [rule_id] ... :: confidence shape.
// Unknown rule_ids are dropped (anti "master-key" hallucinated rule). A clean/LGTM
// answer (or null) yields no violations.
function parseVerdict(raw, knownRuleIds) {
  const out = { clean: true, violations: [], raw: String(raw == null ? '' : raw) };
  if (!raw) return out;                       // null judge => fail-open clean
  const known = new Set((knownRuleIds || []).map(String));
  const text = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const re = /\[([a-z0-9_\-]+)\]\s*(.+?)(?:\s*::\s*([01](?:\.\d+)?))?\s*$/i;
  text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (line) {
    if (/^lgtm\b/i.test(line)) return;
    const m = re.exec(line);
    if (!m) return;
    const rule_id = m[1];
    if (known.size && !known.has(rule_id)) return;   // drop hallucinated rule ids
    const confidence = m[3] != null ? Math.max(0, Math.min(1, parseFloat(m[3]))) : 0.6;
    out.violations.push({ rule_id: rule_id, evidence: _clip(m[2], 240), confidence: confidence });
  });
  out.clean = out.violations.length === 0;
  return out;
}

// Top-level. args: { turnText, toolSequence, rules, judge, minChars?, minConfidence? }.
// Returns { clean, violations[], raw?, skipped? } and NEVER throws.
async function runFidelityCritic(args) {
  args = args || {};
  const judge = args.judge;
  const rules = args.rules;
  const minChars = typeof args.minChars === 'number' ? args.minChars : 40;
  const minConf = typeof args.minConfidence === 'number' ? args.minConfidence : 0.5;
  try {
    if (typeof judge !== 'function') return { clean: true, violations: [], skipped: 'no_judge' };
    if (!Array.isArray(rules) || !rules.length) return { clean: true, violations: [], skipped: 'no_rules' };
    const text = String(args.turnText == null ? '' : args.turnText);
    if (text.trim().length < minChars) return { clean: true, violations: [], skipped: 'too_short' };
    const prompt = buildVerdictPrompt(rules, text, args.toolSequence, args);
    const raw = await judge(prompt);
    const parsed = parseVerdict(raw, rules.map(function (r) { return r.id; }));
    parsed.violations = parsed.violations.filter(function (v) { return v.confidence >= minConf; });
    parsed.clean = parsed.violations.length === 0;
    return parsed;
  } catch (_) {
    return { clean: true, violations: [], skipped: 'error' };   // fail-open
  }
}

module.exports = { buildVerdictPrompt, parseVerdict, runFidelityCritic, MAX_TURN_CHARS, MAX_TOOLSEQ };
