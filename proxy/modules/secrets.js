// SPDX-License-Identifier: AGPL-3.0-only
// Secret redaction — scrub credentials from logs/responses before they hit
// disk or screen. Defense in depth on top of guardrails.detectSecrets.

const PATTERNS = [
  // API keys (common formats)
  [/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED:openai-style-key]'],
  [/sk-ant-[a-zA-Z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-access-key]'],
  [/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED:google-api-key]'],
  [/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED:github-token]'],
  [/glpat-[a-zA-Z0-9_-]{20}/g, '[REDACTED:gitlab-token]'],
  [/xox[baprs]-[a-zA-Z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED:jwt]'],
  // Private keys
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED:private-key-block]'],
  // Bearer tokens
  [/Bearer\s+[a-zA-Z0-9_.\-+/=]{20,}/g, 'Bearer [REDACTED]'],
  // Authorization headers (raw)
  [/Authorization:\s*[a-zA-Z0-9_.\-+/=]{20,}/gi, 'Authorization: [REDACTED]'],
  // Generic password=... in URLs/connection strings
  [/(password|passwd|pwd)=([^&\s]+)/gi, '$1=[REDACTED]'],
];

function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Recursively redact object values
function redactObject(obj) {
  if (!obj) return obj;
  if (typeof obj === 'string') return redact(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      // Common secret keys → fully redact value.
      //
      // Anchored on the whole name, so any COMPOUND name slipped through:
      // `remoteToken` — the bearer that gates every remote /api call — came
      // back in cleartext from GET and POST /api/config, on the same endpoint
      // whose comment promises "never the raw merged config". Match a secret
      // word anywhere in the name instead of only as the entire name.
      if (/^(api_?key|apikey|password|secret|token|authorization|bearer)$/i.test(k) ||
          /(api_?key|password|secret|token|bearer|passphrase)/i.test(k)) {
        // Empty is state, not a secret: masking "" as [REDACTED] told the
        // dashboard a credential exists on lanes the operator had revoked.
        out[k] = (v === '' || v == null) ? v : '[REDACTED]';
      } else {
        out[k] = redactObject(v);
      }
    }
    return out;
  }
  return obj;
}

// Walk an Anthropic-shape request body and redact secrets out of every
// tool_result text block before the body is forwarded upstream.
//
// This is the primary defense against the LLM ingesting credentials it
// just read off disk: when Claude Code executes a Read on
// `~/.troth/config.json`, `.env`, `.aws/credentials`, etc., the file
// contents come back into the next request as a tool_result. We redact
// AT THE PROXY so the upstream model (Anthropic, Qwen, etc.) only ever
// sees `[REDACTED:...]` markers — not the raw secrets — and so logs /
// telemetry / cache entries downstream of the model can't capture them
// either.
//
// Mutates a shallow-cloned shape, never the caller's body. Returns
// { body, redactions } so callers can log how many tool_results were
// scrubbed without re-walking the tree.
function redactToolResults(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, redactions: 0 };
  }
  let redactions = 0;
  const messages = body.messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const content = msg.content.map((block) => {
      if (!block || block.type !== 'tool_result') return block;
      // tool_result.content can be a string OR an array of content blocks
      if (typeof block.content === 'string') {
        const cleaned = redact(block.content);
        if (cleaned !== block.content) redactions++;
        return Object.assign({}, block, { content: cleaned });
      }
      if (Array.isArray(block.content)) {
        const subContent = block.content.map((sub) => {
          if (!sub || sub.type !== 'text' || typeof sub.text !== 'string') return sub;
          const cleaned = redact(sub.text);
          if (cleaned !== sub.text) redactions++;
          return Object.assign({}, sub, { text: cleaned });
        });
        return Object.assign({}, block, { content: subContent });
      }
      return block;
    });
    return Object.assign({}, msg, { content });
  });
  return { body: Object.assign({}, body, { messages }), redactions };
}

module.exports = { redact, redactObject, redactToolResults };
