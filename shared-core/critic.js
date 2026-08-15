// SPDX-License-Identifier: AGPL-3.0-only
// Heuristic critic — fires at the Stop boundary to catch obvious "model
// bailed out" responses before they're marked complete. This is the
// sync layer from the proxy's critic.js; the async "Flash second
// opinion" layer isn't feasible in a hook (extra API call per turn),
// so we concentrate on fast pattern checks that have near-zero false
// positive rate.
//
// Each check returns null (pass) or a short reason string (fail). If
// any check fails, the hook blocks the Stop event and forces the
// model to try again with the failure reason in context.

// Patterns that strongly imply the model gave up rather than actually
// completed the task.
const BAILOUT_PATTERNS = [
  /\bI (?:cannot|can't|am unable to|don't have the ability)\b.*\b(?:complete|finish|do|perform)/i,
  /\b(?:unfortunately|regrettably),? (?:I )?(?:cannot|can't|won't be able to)\b/i,
  /\bI (?:would need|need) more information\b.*(?:proceed|continue|complete)/i,
  /\bas an AI (?:language )?model\b/i,
  /\bI do not have access to\b/i
];

// "I'm about to work" with no tool call following. The Stop hook fires
// AFTER all tool calls for the turn, so if the response promises a
// tool but none was made, that's a bail.
const PROMISE_WITHOUT_DELIVERY = [
  /\b(?:let me|i['']ll|i will|i'?m going to) (?:now )?(?:read|look at|check|examine|write|edit|create|add|fix|update|run|execute|implement)\b/i,
  /\b(?:i['']ll|i will) (?:start|begin|proceed) (?:by|with)\b/i
];

// Placeholder markers that signal incomplete work.
const PLACEHOLDER_PATTERNS = [
  /\/\/\s*TODO:?\s*(?:implement|add|complete|finish|write)\b/i,
  /#\s*TODO:?\s*(?:implement|add|complete|finish|write)\b/i,
  /\bpass\s*#\s*placeholder\b/i,
  /\braise NotImplementedError\b/,
  /\bthrow new Error\(['"]not implemented['"]/i
];

// A response so short it's almost certainly a non-answer.
function isTooShort(text, context) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 20) return true;
  // Followed by "?" → genuinely asking a question, pass through.
  if (trimmed.endsWith('?') && trimmed.length < 200) return false;
  return false;
}

function detectBailout(text) {
  for (const re of BAILOUT_PATTERNS) {
    if (re.test(text)) return 'refusal pattern: "' + (re.source.slice(0, 60)) + '…"';
  }
  return null;
}

function detectUndeliveredPromise(text, toolCallsInTurn) {
  if (toolCallsInTurn > 0) return null; // a tool was called, not a broken promise
  for (const re of PROMISE_WITHOUT_DELIVERY) {
    if (re.test(text)) {
      return 'promise without follow-through — response said "I\'ll do X" but no tool calls were executed before Stop';
    }
  }
  return null;
}

function detectPlaceholders(text) {
  const hits = [];
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  if (!hits.length) return null;
  return 'placeholder content present: ' + hits.slice(0, 3).map(h => JSON.stringify(h.slice(0, 60))).join(', ');
}

// ── Layer 2: deterministic HOW-rule rails ──────────────────
// Deep-research: surfacing an operator rule
// in-context does NOT bind behavior; negated/style rules ("no em-dashes")
// are the WORST-binding class. The reliable fix for MECHANICALLY-CHECKABLE
// rules is HARD ENFORCEMENT (block -> regenerate), not reminding. ZERO LLM
// false-positive rate (pure deterministic checks). This is the checkable
// SUBSET of the operator's HOW-rules; semantic/procedural rules go to the
// Layer-3 LLM critic. Gated behind the `how_rails` feature flag (off by
// default; operator-specific). Each rule: { id, scope, check(text)->reason|null }.

// Strip fenced + inline code so a rule never false-blocks on code or quoted
// content that legitimately contains the pattern (e.g. an em-dash in a sample).
function _proseOnly(s) {
  return String(s == null ? '' : s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

const DETERMINISTIC_HOW_RULES = [
  // 'no-em-dash' REMOVED from the deterministic block-rails.
  // The rule is SCOPED to client-facing / shipped content only: UI/UX text,
  // emails, social posts, landing + website copy. Em-dashes in conversational
  // replies to the operator are explicitly fine. "Is this shippable copy" is a
  // SEMANTIC judgment the raw Stop-boundary text cannot make mechanically: note
  // _proseOnly() below strips fenced blocks and checks the prose, so this rule
  // actually blocked the operator-facing chat (which he does NOT care about) and
  // ignored the fenced copy-paste deliverables (which he DOES). Enforcement moves
  // to authoring discipline + the Layer-3 semantic critic, which can see intent.
  {
    id: 'verify-before-edit',
    scope: 'global',
    severity: 'block',
    // Operator rule: verify/read before changing code (no blind assumptions).
    // Trace-check: an Edit whose target file was NOT Read earlier in the same
    // turn. Conservative (Edit only, not Write-to-new). Ran WARN-first for six
    // weeks: four firings, each one a genuinely blind edit — promoted to block
    // on that record.
    check(_text, opts) {
      const seq = (opts && Array.isArray(opts.toolSequence)) ? opts.toolSequence : [];
      if (!seq.length) return null;
      const readTargets = new Set();
      const violations = [];
      for (const t of seq) {
        const name = String((t && t.name) || '').toLowerCase();
        const tgt = (t && t.target) || '';
        if (name === 'read' || name === 'cached_read' || name === 'hashline_read') { if (tgt) readTargets.add(tgt); }
        else if ((name === 'edit' || name === 'hashline_edit' || name === 'notebookedit') && tgt && !readTargets.has(tgt)) violations.push(tgt);
      }
      return violations.length ? ('verify-first HOW-rule: edited ' + violations.slice(0, 3).join(', ') + ' without reading/verifying it first this turn (read before you change).') : null;
    }
  },
  {
    id: 'verify-evidence',
    scope: 'global',
    severity: 'block',
    // Operator rule (stated 100+ times): never claim a fix/success without
    // showing the check. Deterministic PROXY for the semantic Layer-3 rule: a
    // completion/success claim in the prose while the turn ran ZERO tool calls
    // (no build/test/read to back it). The zero-tool guard keeps precision
    // high (if ANY tool ran, evidence was plausibly gathered -> skip). Ran
    // WARN-first for six weeks: six firings, every one a success claim with
    // nothing behind it — the FP-clean window held, promoted to block
    // (feature verify_evidence_block + low measured flag-rate).
    check(text, opts) {
      const calls = (opts && typeof opts.toolCallsInTurn === 'number') ? opts.toolCallsInTurn : 0;
      if (calls > 0) return null; // a tool ran this turn — evidence plausibly shown
      const prose = _proseOnly(text);
      const claim = /\b(?:it'?s|this is|that'?s|it is)\s+(?:now\s+)?(?:fixed|working|resolved|done)\b|\b(?:tests?|the build|it|everything)\s+(?:now\s+)?(?:pass(?:es|ed|ing)?|works?|succeed(?:s|ed)?)\b|\b(?:verified|confirmed)\s+(?:that\s+)?(?:it|this|the)\b|\bshould\s+now\s+work\b/i;
      return claim.test(prose)
        ? 'operator HOW-rule (verify-evidence): claimed success ("fixed"/"works"/"passes"/"verified") without running any verification (no build/test/read this turn). Show the check, or state plainly it is unverified.'
        : null;
    }
  }
];

function checkDeterministicHowRules(text, opts) {
  const out = [];
  for (const rule of DETERMINISTIC_HOW_RULES) {
    if (rule.scope !== 'global') continue; // project scopes resolve on opts.project_id (Layer 2.1)
    try {
      const r = rule.check(text, opts || {});
      if (r) out.push({ severity: rule.severity || 'block', reason: r });
    } catch (_) { /* a rule must never break the critic */ }
  }
  return out;
}

// Public entrypoint. text = last assistant message (stringified tool
// calls stripped); toolCallsInTurn = number of tool_use blocks the
// agent emitted this turn.
function review(text, opts) {
  opts = opts || {};
  const toolCallsInTurn = typeof opts.toolCallsInTurn === 'number' ? opts.toolCallsInTurn : 1;
  const reasons = [];

  if (!text || typeof text !== 'string') return { ok: true };

  const bail = detectBailout(text);
  if (bail) reasons.push(bail);

  const promise = detectUndeliveredPromise(text, toolCallsInTurn);
  if (promise) reasons.push(promise);

  const placeholder = detectPlaceholders(text);
  if (placeholder) reasons.push(placeholder);

  // Layer 2: deterministic HOW-rule enforcement (opt-in via opts.how_rules).
  // block-severity -> reasons (force regenerate); warn-severity -> warnings
  // (surfaced next turn, not blocked). New rules START as warn so false
  // positives get measured before a rule may interrupt anyone; the two
  // verify rules graduated to block after a clean six-week window.
  const warnings = [];
  if (opts.how_rules) {
    for (const v of checkDeterministicHowRules(text, opts)) {
      (v.severity === 'warn' ? warnings : reasons).push(v.reason);
    }
  }

  if (!reasons.length) return { ok: true, warnings };
  return { ok: false, reasons, warnings };
}

module.exports = { review, detectBailout, detectUndeliveredPromise, detectPlaceholders, checkDeterministicHowRules, DETERMINISTIC_HOW_RULES };
