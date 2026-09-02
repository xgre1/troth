// SPDX-License-Identifier: AGPL-3.0-only
// proxy-extractor — the instance/identity extractor as one call through the
// operator's own troth proxy (/v1/messages, Anthropic shape). The proxy holds
// the credentials and picks the engine from the model id (a gpt-5* id reaches
// the ChatGPT-plan lane); this process never sees a key or a token. Same
// contract as instance-consolidation.makeLlamacppExtractor: llmCall(prompt)
// resolves to the model's text, and the caller parses the JSON out of it.
//   TROTH_PROXY_HOST        default http://127.0.0.1:8000
//   TROTH_PROXY_EXTRACT_MODEL  default gpt-5.4-mini
'use strict';

function makeProxyExtractor(cfg) {
  cfg = cfg || {};
  const host = String(cfg.host || process.env.TROTH_PROXY_HOST || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const model = cfg.model || process.env.TROTH_PROXY_EXTRACT_MODEL || 'gpt-5.4-mini';
  const timeoutMs = cfg.timeout_ms || 120 * 1000;
  const maxTokens = cfg.max_tokens || 2048;
  return async function llmCall(prompt) {
    const body = {
      model,
      max_tokens: maxTokens,
      stream: false,
      // The extraction prompt is the whole instruction; the system line only
      // keeps the reply to the JSON the parser expects.
      system: 'You extract structured memory from a user\'s own statements. Reply with the JSON object asked for and nothing else.',
      messages: [{ role: 'user', content: prompt }],
    };
    const res = await fetch(host + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-troth-source': 'longmemeval-extract', 'x-troth-raw': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error('proxy extractor http ' + res.status + ': ' + text.slice(0, 300));
    const j = JSON.parse(text);
    return (Array.isArray(j.content) ? j.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('');
  };
}

module.exports = { makeProxyExtractor };
