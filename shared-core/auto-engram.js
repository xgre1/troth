// SPDX-License-Identifier: AGPL-3.0-only
// Auto-Engram via LLM-as-Judge — substrate self-reflection.
//
// Earlier the demo used regex patterns to spot "remember X" / "my Y is Z"
// in user input and engram-extract from there. That's brittle: it misses
// implicit declarations, idiomatic variants, and anything the user
// states across multiple turns.
//
// This module asks the language faculty itself to act as a judge over
// each completed turn: "given this exchange, what DURABLE facts should
// the substrate commit to long-term memory?". The response is forced
// into a JSON schema so we can parse it deterministically. Each fact
// gets engrammed with an embedding for later semantic recall.
//
// Designed to be fire-and-forget from the orchestrator's hot path —
// caller may `void judgeTurn(...)` so the user-facing response is not
// blocked on the judge call. Failures are silent (best-effort
// substrate self-reflection; the conversation is unaffected if the
// judge times out or returns malformed JSON).

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const cfg    = require('./transport-config.js');
const engram = require('./engram.js');

const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: { type: 'string', minLength: 4, maxLength: 240 }
    }
  },
  required: ['facts']
};

// Single non-streaming POST to llama-server's /v1/chat/completions
// with json_schema enforcement. Returns the parsed JSON object or null.
function jsonChatRequest(host, body) {
  return new Promise((resolve) => {
    const url = new URL('/v1/chat/completions', host);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers:  {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(data),
        'connection':     'close'
      },
      agent:    false,
      timeout:  30000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const top = JSON.parse(buf);
          const content = top && top.choices && top.choices[0] && top.choices[0].message && top.choices[0].message.content;
          if (typeof content !== 'string' || !content) return resolve(null);
          try { resolve(JSON.parse(content)); }
          catch (_) {
            // Some models wrap JSON in code fences; strip and retry.
            const stripped = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
            try { resolve(JSON.parse(stripped)); } catch (_) { resolve(null); }
          }
        } catch (_) { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

function buildJudgePrompt(userText, assistantText) {
  return [
    'Given this single conversation turn, identify any DURABLE FACTS the substrate should',
    'commit to long-term memory. Examples of durable facts:',
    '  - user preferences ("user prefers tabs over spaces")',
    '  - user identity / context ("user lives in Lisbon", "user is allergic to peanuts")',
    '  - commitments the assistant made ("assistant agreed to use only bash, not zsh")',
    '  - codewords / passwords / shared secrets',
    'NOT durable: greetings, acks, general explanations, transient discussion.',
    '',
    'If nothing durable, return an empty list.',
    '',
    'User said: ' + (userText || '').slice(0, 800),
    'Faculty replied: ' + (assistantText || '').slice(0, 800),
    '',
    'Reply with JSON: {"facts": ["..."]}.'
  ].join('\n');
}

async function judgeTurn(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  const user_id  = opts.user_id || 'default';
  const cwd      = opts.cwd || null;
  const user_text      = String(opts.user_text || '');
  const assistant_text = String(opts.assistant_text || '');
  if (!agent_id || (!user_text && !assistant_text)) return { facts: [], recorded: 0 };

  const host = opts.host || cfg.llamacppHost();
  const model = opts.model || cfg.llamacppModel();
  const embeddingHost = opts.embedding_host || cfg.embeddingHost();

  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are the substrate self-reflection judge. Output strict JSON only.' },
      { role: 'user',   content: buildJudgePrompt(user_text, assistant_text) }
    ],
    stream: false,
    cache_prompt: true,
    n_predict: 256,
    chat_template_kwargs: { enable_thinking: false },
    json_schema: FACTS_SCHEMA
  };

  const parsed = await jsonChatRequest(host, body);
  if (!parsed || !Array.isArray(parsed.facts)) return { facts: [], recorded: 0 };

  // Filter + dedupe
  const facts = [];
  const seen = new Set();
  for (const raw of parsed.facts) {
    if (typeof raw !== 'string') continue;
    const stmt = raw.trim();
    if (stmt.length < 4 || stmt.length > 240) continue;
    const key = stmt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(stmt);
  }
  if (!facts.length) return { facts: [], recorded: 0 };

  let recorded = 0;
  for (const stmt of facts) {
    let embedding = null;
    try { embedding = await engram.embedRequest(embeddingHost, stmt); }
    catch (_) { embedding = null; }
    const id = engram.recordEngram({
      agent_id, user_id, cwd,
      statement: stmt,
      source: 'auto_judge',
      salience: 1.2, // slightly above default — judge believes these are worth keeping
      embedding
    });
    if (id) recorded++;
  }
  return { facts, recorded };
}

module.exports = {
  judgeTurn,
  buildJudgePrompt,
  FACTS_SCHEMA
};
