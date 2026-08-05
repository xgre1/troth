// SPDX-License-Identifier: AGPL-3.0-only
// Structured Envelope — the entity design primitive.
//
// "Substrate ↔ LLM communication is via structured envelope + structured
// response... Response (LLM → substrate, decomposed):
//   claim (factual assertions → Reconciler verifies)
//   action (tool calls → executor with rollback capability)
//   refusal (explicit refusal → logged with reason)
//   question (clarification needed → routed to user with context)
//   meta (uncertainty signals, alternatives considered → drift signals)"
//
// Today's reality: the substrate already INJECTS a structured envelope
// (identity envelope, anchored decisions, precedent block all visible
// in this very session's prefix). What was MISSING is the response side:
// LLM replies are free-form text + tool_use blocks; the substrate has
// to re-parse them after the fact to figure out which sentence was a
// claim vs a question vs a refusal.
//
// This module provides:
//   1. The system-prefix instructions that ASK the LLM to tag its reply
//      with section markers (`<claim>` / `<action>` / `<refusal>` /
//      `<question>` / `<meta>`). Optional per-call — enabled when the
//      caller wants the structured response benefit.
//   2. A parser that extracts the tagged sections back out of the reply
//      text. Tolerant: missing tags fall back to one big claim block;
//      unknown tags pass through as text.
//   3. A `decompose(replyText)` convenience wrapper that returns
//      { claims, actions, refusals, questions, metas } arrays for
//      downstream routing (Reconciler verifies claims, executor handles
//      actions, etc.).
//
// Why XML-style tags vs JSON: every modern LLM (Claude, GPT, Qwen,
// DeepSeek, Gemma) produces clean XML when asked. JSON inside Markdown
// is brittle (escaping, code-fence parsing). Tags survive sloppy
// formatting and partial responses better.

const TAG_RX = /<(claim|action|refusal|question|meta)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

const ENVELOPE_INSTRUCTION = [
  '## Structured response envelope',
  '',
  'When you reply, tag each section so the substrate can route it. Use these tags exactly:',
  '',
  '  <claim>...</claim>          — a factual assertion the substrate may need to verify',
  '  <action>...</action>        — a tool you want invoked (one per tag; tool name + args inside)',
  '  <refusal>...</refusal>      — an explicit refusal with reason',
  '  <question>...</question>    — a clarification you need from the user',
  '  <meta>...</meta>            — uncertainty signals, alternatives considered, confidence',
  '',
  'Free-form text outside any tag is treated as commentary (not verified, not routed).',
  'A reply may have zero or many of any tag. Order does not matter. Missing tags are fine.',
  'Do NOT wrap tags in code fences or escape them; emit them as raw inline tags.'
].join('\n');

// Extract all tagged sections from a reply. Returns:
//   { claims, actions, refusals, questions, metas, untagged }
function decompose(replyText) {
  const out = {
    claims:    [],
    actions:   [],
    refusals:  [],
    questions: [],
    metas:     [],
    untagged:  ''
  };
  if (!replyText || typeof replyText !== 'string') return out;

  const text = replyText;
  let lastEnd = 0;
  const untaggedParts = [];

  // Reset the regex (it has /g flag).
  TAG_RX.lastIndex = 0;
  let m;
  while ((m = TAG_RX.exec(text)) !== null) {
    if (m.index > lastEnd) {
      untaggedParts.push(text.slice(lastEnd, m.index));
    }
    lastEnd = m.index + m[0].length;
    const kind = m[1].toLowerCase();
    const attrs = (m[2] || '').trim();
    const body  = (m[3] || '').trim();
    const item  = { body, attrs };
    switch (kind) {
      case 'claim':    out.claims.push(item);    break;
      case 'action':   out.actions.push(item);   break;
      case 'refusal':  out.refusals.push(item);  break;
      case 'question': out.questions.push(item); break;
      case 'meta':     out.metas.push(item);     break;
    }
  }
  if (lastEnd < text.length) untaggedParts.push(text.slice(lastEnd));
  out.untagged = untaggedParts.join('').trim();

  // If NO tags fired and the model returned plain text, treat the entire
  // body as a single claim. This keeps the contract sane for providers
  // that ignore the envelope instruction (or for legacy callers).
  if (!out.claims.length && !out.actions.length && !out.refusals.length &&
      !out.questions.length && !out.metas.length && out.untagged) {
    out.claims.push({ body: out.untagged, attrs: '' });
    out.untagged = '';
  }

  return out;
}

// Wrap a body block as the canonical envelope tag. Useful for tests
// and for substrate-emitted internal messages.
function wrap(kind, body, attrs) {
  if (!kind || !body) return '';
  const safe = String(body).replace(/<\/(claim|action|refusal|question|meta)>/gi, '');
  const a = attrs ? ' ' + String(attrs).trim() : '';
  return '<' + kind + a + '>' + safe + '</' + kind + '>';
}

// Inject the envelope instructions into a system-prefix string. Idempotent.
function injectInstruction(systemPrefix) {
  const prefix = String(systemPrefix || '');
  if (prefix.indexOf('Structured response envelope') !== -1) return prefix;
  if (!prefix) return ENVELOPE_INSTRUCTION;
  return prefix + '\n\n' + ENVELOPE_INSTRUCTION;
}

module.exports = {
  decompose,
  wrap,
  injectInstruction,
  ENVELOPE_INSTRUCTION
};
