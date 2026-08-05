// SPDX-License-Identifier: AGPL-3.0-only
// Task complexity classifier for the 3-tier router.
//
// Decides which backend tier a request belongs to:
//   simple  — quick completions, small refactors, trivial lookups
//             → prefer LOCAL backend (Ollama / llama-server / any
//               LM-Studio-style endpoint at backendHost:backendPort).
//             Free, fast, no quota consumed.
//
//   medium  — multi-file edits, structured feature work, code review
//             → prefer FREE quota (Alibaba versioned models).
//
//   hard    — architectural design, tricky debugging, security-critical,
//             long-horizon agentic tasks
//             → prefer BYOK paid (Anthropic Opus / DeepSeek / …).
//
// Input: the (already-parsed) request body + optional hints.
// Output: { tier: 'simple'|'medium'|'hard', reasons: [...] }
//
// Pattern-based and cheap. Designed to run on every request with <1 ms
// cost so we don't tax the happy path.

const HARD_SIGNALS = [
  /\barchitect(?:ural)?\b/i,
  /\bdesign\s+(?:the\s+)?system\b/i,
  /\bsecurity\s+(?:audit|review)/i,
  /\brefactor\s+(?:the\s+)?(?:whole|entire|all)/i,
  /\bmigrat(?:ion|e)\b.*(?:database|schema|production)/i,
  /\bperformance\s+(?:bottleneck|problem|issue)/i,
  /\bdebug\s+(?:this\s+)?(?:weird|strange|intermittent|flaky|race)/i,
  /\bautonomous\b/i,
  /\/hard\b/i,   // user invoked the escape-hatch slash command
  /\/ultrareview\b/i,
  /\bthink\s+(?:harder|deeper|more\s+carefully)/i
];

const SIMPLE_SIGNALS = [
  /\b(?:what|where)\s+is\b/i,
  /\bshow\s+me\b/i,
  /\blist\s+(?:the\s+)?(?:files?|tests?|functions?|exports?)/i,
  /\bcount\s+(?:the\s+)?(?:lines?|files?|commits?)/i,
  /\brename\s+(?:this|the)\s+(?:variable|function|file)/i,
  /\btypo\b/i,
  /\bfix\s+(?:the\s+)?import/i,
  /\bformat\b.*\bfile\b/i,
  /\badd\s+(?:a\s+)?(?:comment|docstring|type\s+annotation)/i,
  /^\s*(?:yes|no|ok|thanks|thx|ty)\b/i
];

function extractUserText(body) {
  if (!body || !Array.isArray(body.messages)) return '';
  // Last user message — most indicative of current intent.
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
        .map(c => c.text || '')
        .join('\n');
    }
  }
  return '';
}

function countToolUseBlocks(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let n = 0;
  for (const m of body.messages) {
    if (Array.isArray(m.content)) {
      for (const c of m.content) if (c && c.type === 'tool_use') n++;
    }
  }
  return n;
}

function classify(body, opts) {
  opts = opts || {};
  const text = extractUserText(body);
  const reasons = [];

  if (!text.trim()) {
    return { tier: 'medium', reasons: ['empty_or_non_text_prompt'] };
  }

  // Explicit hard escape-hatch always wins.
  for (const re of HARD_SIGNALS) {
    if (re.test(text)) {
      reasons.push('hard_signal:' + re.source.slice(0, 30));
      return { tier: 'hard', reasons };
    }
  }

  // Long multi-tool-use trajectories → medium or hard. Local can't handle
  // long agentic chains well on a 7B-class model.
  const toolUses = countToolUseBlocks(body);
  if (toolUses > 15) {
    reasons.push('many_prior_tool_uses:' + toolUses);
    return { tier: 'hard', reasons };
  }

  for (const re of SIMPLE_SIGNALS) {
    if (re.test(text)) {
      reasons.push('simple_signal:' + re.source.slice(0, 30));
      return { tier: 'simple', reasons };
    }
  }

  // Very short prompts (< 40 chars) with a prior history suggest simple
  // continuation. Threshold deliberately low so "add pagination to user
  // list with cursor-based filtering" (65 chars, a non-trivial request)
  // stays in medium.
  if (text.trim().length < 40 && toolUses <= 3) {
    reasons.push('short_prompt_shallow_trajectory');
    return { tier: 'simple', reasons };
  }

  // Default: medium. Safe middle tier; Alibaba free quota is abundant
  // enough to absorb the unclassified majority.
  reasons.push('default_medium');
  return { tier: 'medium', reasons };
}

module.exports = { classify, extractUserText, countToolUseBlocks, HARD_SIGNALS, SIMPLE_SIGNALS };
