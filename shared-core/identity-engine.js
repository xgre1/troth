// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// identity-engine.js — the engine behind Identity: the passes that read what
// the operator says about themselves, what happens to them and what they
// read, and write it to memory. One block in config.json decides where they
// read and what it may cost:
//   identity.engine       auto | off | on
//     auto  the local engine on this machine when it answers; otherwise the
//           passes wait and nothing of the operator's plan is spent
//     off   the English patterns only; the passes never call an engine
//     on    the local engine, else the operator's own engine through the
//           proxy under the daily cap, with the smallest model of the lane
//   identity.model        a model id the operator chose; '' takes the
//                         smallest model of whichever lane answers
//   identity.daily_turns  calls a day on the operator's engine
// Env overrides: TROTH_IDENTITY_ENGINE, TROTH_IDENTITY_MODEL,
// TROTH_IDENTITY_DAILY_TURNS (TROTH_UNDERSTANDING_DAILY_TURNS still counts).

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINES = ['auto', 'off', 'on'];
const DEFAULT_DAILY_TURNS = 400;

// The smallest model of a lane. A lane absent here reads with the model it
// is configured with; the lanes below default to a flagship the chat uses.
const SMALL_MODELS = Object.freeze({
  openai_sub: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  google_ai: 'gemini-3.8-flash',
});

// The order a small read tries the lanes: the local engine first, then the
// lanes billed per token or riding a free tier, the flat-rate plans last so
// a day's reads never all land on one plan window.
const LANES = Object.freeze([
  'local', 'alibaba', 'deepseek', 'deepinfra', 'nvidia', 'google_ai', 'openrouter',
  'zai', 'moonshot', 'xai', 'custom_openai', 'anthropic', 'kimi_sub', 'openai_sub',
]);

function _configPath() {
  return process.env.TROTH_CONFIG_PATH || path.join(process.env.HOME || os.homedir(), '.troth', 'config.json');
}
function _readConfig() {
  try { return JSON.parse(fs.readFileSync(_configPath(), 'utf8')) || {}; } catch (_) { return {}; }
}

function settings(cfg) {
  const block = (cfg || _readConfig()).identity;
  const b = (block && typeof block === 'object') ? block : {};
  let engine = String(process.env.TROTH_IDENTITY_ENGINE || b.engine || 'auto').trim().toLowerCase();
  if (!ENGINES.includes(engine)) engine = 'auto';
  const model = String(process.env.TROTH_IDENTITY_MODEL || b.model || '').trim();
  const rawCap = process.env.TROTH_IDENTITY_DAILY_TURNS || process.env.TROTH_UNDERSTANDING_DAILY_TURNS || b.daily_turns;
  const cap = Number(rawCap);
  const daily_turns = (rawCap !== undefined && rawCap !== null && rawCap !== '' && Number.isFinite(cap) && cap >= 0) ? cap : DEFAULT_DAILY_TURNS;
  return { engine, model, daily_turns };
}

function engineAllowed() { return settings().engine === 'on'; }
function patternsOnly() { return settings().engine === 'off'; }

function laneAvailable(providers, name, localUp) {
  const p = providers && providers[name];
  if (!p || !p.enabled) return false;
  if (name === 'local') return !!localUp;
  if (name === 'openai_sub') return true;
  return !!p.apiKey;
}

function laneModel(providers, name) {
  const p = providers && providers[name];
  if (!p) return null;
  if (SMALL_MODELS[name]) return SMALL_MODELS[name];
  return (p.model && String(p.model).trim()) || null;
}

// The ordered {provider, model} attempts for one read. A chosen model pins
// its lane first; the lanes then follow in LANES order with their smallest
// model, so a lane that fails hands the read to the next one.
function orderChain(providers, opts) {
  opts = opts || {};
  providers = providers || {};
  const chain = [];
  const seen = new Set();
  const push = (provider, model) => {
    const key = provider + '|' + (model || '');
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ provider, model: model || null });
  };
  if (opts.pick) {
    let prov = null;
    try { prov = require('./fidelity-judge.js').providerForModel(providers, opts.pick); } catch (_) { prov = null; }
    if (prov && laneAvailable(providers, prov, opts.localUp)) push(prov, opts.pick);
  }
  for (const name of LANES) {
    if (!laneAvailable(providers, name, opts.localUp)) continue;
    push(name, laneModel(providers, name));
  }
  return chain;
}

// Wire the order to injected lane adapters, the same shape the fidelity
// judge takes: { providers: object|fn, isLocalAvailable?: fn,
// call: { <lane>(bodyStr, model) -> Promise<text|null> } }. Returns
// read(prompt, { max_tokens }) -> { text, provider, model } or null; every
// failure is null, never a throw.
function makeReader(adapters, opts) {
  opts = opts || {};
  adapters = adapters || {};
  const call = adapters.call || {};
  const last = { provider: null, model: null, at: 0 };
  async function read(prompt, o) {
    try {
      const providers = (typeof adapters.providers === 'function') ? adapters.providers() : (adapters.providers || {});
      const localUp = adapters.isLocalAvailable ? !!adapters.isLocalAvailable() : false;
      const pick = (opts.pick !== undefined) ? opts.pick : settings().model;
      const chain = orderChain(providers, { pick, localUp });
      const maxTokens = (o && Number(o.max_tokens)) || Number(opts.max_tokens) || 400;
      const body = adapters.buildBody
        ? adapters.buildBody(prompt, maxTokens)
        : JSON.stringify({ model: 'any', max_tokens: maxTokens, stream: false, messages: [{ role: 'user', content: String(prompt) }] });
      for (const step of chain) {
        const fn = call[step.provider];
        if (typeof fn !== 'function') continue;
        let text = null;
        try { text = await fn(body, step.model); } catch (_) { text = null; }
        if (text && String(text).trim()) {
          last.provider = step.provider; last.model = step.model; last.at = Date.now();
          return { text: String(text), provider: step.provider, model: step.model };
        }
      }
    } catch (_) {}
    return null;
  }
  read.last = last;
  return read;
}

// What Identity is set to and what its passes did last: the road named in
// the last self-facts run and the day's spend on the operator's engine.
function status() {
  const s = settings();
  let budget = null;
  try { const b = require('./instance-consolidation.js').engineBudget(); budget = { used: b.used, limit: b.limit }; } catch (_) {}
  let road = null, last_run_ts = null;
  try {
    const state = require('./state.js');
    const row = state.lastBackgroundRun ? state.lastBackgroundRun('wm_consolidation', 7 * 24 * 60 * 60 * 1000) : null;
    if (row && row.timestamp) {
      last_run_ts = row.timestamp;
      const m = String((row.output && row.output.notes) || '').match(/wm_consolidation \(([a-z]+)\)/);
      if (m) road = m[1];
    }
  } catch (_) {}
  return { engine: s.engine, model: s.model, daily_turns: s.daily_turns, road, last_run_ts, budget };
}

// One line a surface can print.
function describe(st) {
  st = st || status();
  if (st.engine === 'off') return 'patterns only';
  if (st.road === 'local') return 'local model';
  if (st.road === 'engine') return 'your engine' + (st.model ? ' (' + st.model + ')' : '') + (st.budget ? ', ' + st.budget.used + '/' + st.budget.limit + ' today' : '');
  if (st.engine === 'on') return 'your engine' + (st.budget ? ', ' + st.budget.used + '/' + st.budget.limit + ' today' : '');
  return 'waiting for an engine';
}

module.exports = { settings, engineAllowed, patternsOnly, orderChain, makeReader, status, describe, laneModel, laneAvailable, SMALL_MODELS, LANES, ENGINES, DEFAULT_DAILY_TURNS };
