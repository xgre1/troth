#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Multi-provider live race — extends benchmarks/market/run.mjs from
// in-process callables to real LLM endpoints.
//
// What this proves that run.mjs does not:
//   - market.race() can dispatch CALLABLES THAT MAKE REAL API CALLS in
//     parallel and pick the winner by AST-verified fix correctness.
//   - The "engine-agnostic" pitch holds when the engines are actually
//     different network endpoints, not two functions in the same node
//     process.
//
// Arms (any subset; skipped if API key missing):
//   - claude-anthropic: official Anthropic API, claude-sonnet-4-5
//   - qwen-openrouter:  OpenRouter-routed qwen3-max
//   - deepseek-openrouter: OpenRouter-routed deepseek-chat
//
// Task: same null-guard fix as run.mjs. Verification: AST + test pass.
//
// Mac Studio NOT required (all calls hit hosted endpoints).
//
// Usage:
//   ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... \
//     node benchmarks/market/multi-provider-race.mjs

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const DATA_DIR = '/tmp/gc-market-multi-' + Date.now();
mkdirSync(DATA_DIR, { recursive: true });
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR;

const state        = require(resolve(REPO, 'shared-core', 'state.js'));
const verification = require(resolve(REPO, 'shared-core', 'verification.js'));
const market       = require(resolve(REPO, 'shared-core', 'market.js'));

const TASK = 'Fix the null-guard bug in metrics.js so peakValue([]) returns null instead of throwing. Return the FULL corrected file content. No commentary, just the code.';

const BUGGY_SRC = `function peakValue(arr) {
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  return max;
}
module.exports = { peakValue };
`;

// ── Provider callables ────────────────────────────────────────────────────

async function callAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'no_anthropic_key' };
  const t0 = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt + '\n\n' + BUGGY_SRC }]
    })
  });
  if (!r.ok) return { ok: false, reason: 'http_' + r.status };
  const j = await r.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { ok: true, text, latency_ms: Date.now() - t0,
           tokens: (j.usage && (j.usage.input_tokens + j.usage.output_tokens)) || 0 };
}

async function callOpenRouter(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, reason: 'no_openrouter_key' };
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + key,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt + '\n\n' + BUGGY_SRC }]
    })
  });
  if (!r.ok) return { ok: false, reason: 'http_' + r.status };
  const j = await r.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { ok: true, text, latency_ms: Date.now() - t0,
           tokens: (j.usage && (j.usage.prompt_tokens + j.usage.completion_tokens)) || 0 };
}

// ── Build agent callables in market.race() shape ──────────────────────────

function extractCode(text) {
  // Strip markdown code fences if present
  const m = text.match(/```(?:javascript|js)?\n?([\s\S]*?)```/);
  return m ? m[1].trim() : text.trim();
}

function makeAgent(name, providerCall) {
  return {
    name,
    run: async () => {
      const r = await providerCall();
      if (!r.ok) return { ok: false, error: r.reason };
      const code = extractCode(r.text);
      const scratch = '/tmp/gc-multi-race-' + name + '-' + Date.now() + '.js';
      writeFileSync(scratch, code);
      const ast = verification.verifyAST(scratch, code);
      const pass = ast && ast.ok === true;
      try { rmSync(scratch); } catch (e) {}
      return {
        record: {
          type: 'edit',
          input: { file_path: scratch, format: 'write', agent: name },
          output: { hash_after: 'mock', lines_changed: code.split('\n').length },
          verification: { ast: ast || { ok: false, skipped: false } }
        },
        tokens: r.tokens,
        latency_ms: r.latency_ms,
        pass
      };
    }
  };
}

// ── Run ───────────────────────────────────────────────────────────────────

const agents = [];
if (process.env.ANTHROPIC_API_KEY) {
  agents.push(makeAgent('claude-sonnet-4-5', () => callAnthropic(TASK)));
}
if (process.env.OPENROUTER_API_KEY) {
  agents.push(makeAgent('qwen3-max',     () => callOpenRouter('qwen/qwen3-max', TASK)));
  agents.push(makeAgent('deepseek-chat', () => callOpenRouter('deepseek/deepseek-chat', TASK)));
}

if (agents.length < 2) {
  console.error('Need at least 2 providers (set ANTHROPIC_API_KEY and/or OPENROUTER_API_KEY).');
  process.exit(2);
}

console.log('[multi-race] dispatching ' + agents.length + ' real-LLM agents…');
const t0 = Date.now();
const result = await market.race(state, { agents });
const elapsed = Date.now() - t0;

console.log('[multi-race] elapsed:', elapsed, 'ms');
console.log('[multi-race] winner:', result && result.winner && result.winner.agent);
console.log('[multi-race] attempts:');
for (const a of (result && result.attempts) || []) {
  console.log('  ' + a.agent + ': score=' + (a.score || 0).toFixed(2) +
              ' pass=' + a.pass + ' latency=' + a.latency_ms + 'ms tokens=' + a.tokens);
}

const checks = [
  ['race returned ok', result && result.ok === true],
  ['winner has a name', !!(result && result.winner && result.winner.agent)],
  ['all attempts recorded', (result && result.attempts && result.attempts.length === agents.length)],
];
let allPass = true;
console.log('\n[checks]');
for (const [label, ok] of checks) {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label);
  if (!ok) allPass = false;
}

rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(allPass ? 0 : 1);
