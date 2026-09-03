#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What the partner read becomes what it knows: the knowledge pass reads each
// new document source once, writes the durable facts it states as knowledge
// with their source and day, links a fact to an open goal it answers, moves
// its watermark, and a question then finds the fact. The reader is given, so
// no engine runs.
process.env.TROTH_CONFIG_PATH = require('os').tmpdir() + '/troth-ku-' + process.pid + '-config.json';
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-ku-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const CORE = path.join(__dirname, '..', 'shared-core');
const ku = require(path.join(CORE, 'knowledge-understanding.js'));
const engram = require(path.join(CORE, 'engram.js'));
const goalStatus = require(path.join(CORE, 'goal-status.js'));
const typedGoal = require(path.join(CORE, 'typed-goal.js'));
const recall = require(path.join(CORE, 'recall.js'));
const state = require(path.join(CORE, 'state.js'));

process.env.TROTH_EMBED_PORT = '9';
process.env.TROTH_EMBEDDING_HOST = 'http://127.0.0.1:9';
process.env.TROTH_RECALL_CONCERNS = '0';

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== what was read becomes what is known ===\n');
const A = 'ku-test';
const ctx = { substrate_ctx: { agent_id: A, user_id: 'default', cwd: null } };
const chunk = (scope, title, n, text, ref, ts) => engram.recordEngram({
  agent_id: A, user_id: 'default', cwd: null,
  statement: '[' + title + ' #' + n + '] ' + text,
  scope, source: 'knowledge_drain', source_authority: 'regex_extracted', memory_class: 'semantic', auto_verify: false,
  provenance_tier: ref ? 'external' : 'operator', provenance_ref: ref || null
});

(async () => {
  const goalId = engram.recordEngram({ agent_id: A, user_id: 'default', cwd: null, statement: '[research] which local LLM models run well on Apple Silicon through llama.cpp', scope: 'goal', salience: 2, source: 'test', source_authority: 'plr_evolved', auto_verify: false });
  assert.ok(goalId, 'a goal exists');
  chunk('docs:web:huggingface.co', 'Qwen3-27B model card', 1, 'Qwen3-27B is a 27 billion parameter model released under Apache 2.0. It runs on Apple Silicon through llama.cpp in GGUF form, and the Q4_K_M quantisation fits in 20 GB of memory.', 'https://huggingface.co/Qwen/Qwen3-27B');
  chunk('docs:web:huggingface.co', 'Qwen3-27B model card', 2, 'Downloads this month: 40,000. Like this model? Sign in to like. Navigation: Models Datasets Spaces.', 'https://huggingface.co/Qwen/Qwen3-27B');
  chunk('docs:seen:kitchen', 'stand mixer manual', 1, 'The KitchenAid Artisan stand mixer has a 4.8 litre bowl and ten speeds, and the bowl is dishwasher safe.', null);

  const reads = [];
  const view = Object.assign({}, ctx, { read_knowledge: async (text) => {
    reads.push(text);
    if (/Qwen3-27B/.test(text)) return [
      { what: 'Qwen3-27B runs on Apple Silicon through llama.cpp in GGUF form, and its Q4_K_M quantisation fits in 20 GB of memory.', subject: 'Qwen3-27B' },
      { what: 'Sign in to like this model.', subject: 'model' },
      { what: 'Llama 4 was released in 2025.', subject: 'Llama 4' }
    ];
    if (/KitchenAid/.test(text)) return [{ what: 'The KitchenAid Artisan stand mixer has a 4.8 litre bowl and ten speeds.', subject: 'KitchenAid Artisan' }];
    return [];
  } });

  await t('a source is read once and its durable facts become knowledge with their source and day', async () => {
    const r = await ku.run(view);
    assert.ok(/sources=2 facts=2/.test(r.notes[0]), r.notes[0]);
    const rows = engram.listEngrams({ scope_prefix: 'knowledge:', audience: 'all', agent_id: A, limit: 20 }) || [];
    assert.strictEqual(rows.length, 2, rows.map((x) => x.statement).join(' | '));
    const q = rows.find((x) => /Qwen3-27B/.test(x.statement));
    assert.ok(q, 'the model fact');
    assert.strictEqual(q.scope, 'knowledge:web:huggingface.co');
    assert.strictEqual(q.payload.source_title, 'Qwen3-27B model card');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(q.payload.read_day), 'the day it was read');
    const raw = JSON.parse(state.getAction(q.id).output);
    assert.strictEqual(raw.provenance && raw.provenance.tier, 'external', JSON.stringify(raw.provenance));
    assert.strictEqual(raw.provenance.ref, 'https://huggingface.co/Qwen/Qwen3-27B');
    assert.ok(!rows.some((x) => /Sign in/.test(x.statement)), 'a sentence about the page is not knowledge');
    assert.ok(!rows.some((x) => /Llama 4/.test(x.statement)), 'a subject the excerpt does not name is not knowledge');
  });

  await t('a fact that answers an open goal is recorded as its finding', async () => {
    const g = typedGoal.getGoal(goalId);
    assert.strictEqual(g.findings, 1, JSON.stringify(g));
    const f = goalStatus.listFindings(goalId);
    assert.strictEqual(f.length, 1);
    assert.ok(/Qwen3-27B/.test(f[0].statement), f[0].statement);
    assert.strictEqual(g.status, 'open', 'a finding does not close the goal');
  });

  await t('the watermark moves and the same sources are not read again', async () => {
    const before = reads.length;
    const r = await ku.run(view);
    assert.ok(/no new documents/.test(r.notes[0]), r.notes[0]);
    assert.strictEqual(reads.length, before);
  });

  await t('a question finds the knowledge', async () => {
    const hits = await recall.recall({ query: 'Qwen3-27B llama.cpp Apple Silicon', class: 'all', audience: 'model_visible', limit: 5 });
    assert.ok(hits.some((h) => /Q4_K_M quantisation fits in 20 GB/.test(String(h.statement))), hits.map((h) => String(h.statement).slice(0, 60)).join(' | '));
  });

  await t('the pass says so when no reader answers', async () => {
    process.env.TROTH_KNOWLEDGE_LLM = '0';
    const r = await ku.run(ctx);
    assert.ok(/no reader/.test(r.notes[0]), r.notes[0]);
    delete process.env.TROTH_KNOWLEDGE_LLM;
  });

  await t('the reader takes an engine on this machine, a named host only when opened, the proxy engine only when knowledge_engine is on', async () => {
    const fs = require('fs');
    const tc = require(path.join(CORE, 'transport-config.js'));
    const cfg = process.env.TROTH_CONFIG_PATH;
    process.env.TROTH_LLAMACPP_HOST = 'http://engine-box.local:1234';
    assert.strictEqual(tc.understandingHost(), null, 'a named host is not taken on its own');
    assert.strictEqual(tc.flag('knowledge_engine'), false, 'the proxy engine is closed by default');
    fs.writeFileSync(cfg, JSON.stringify({ understanding_named_host: true, knowledge_engine: true }));
    assert.strictEqual(tc.understandingHost(), 'http://engine-box.local:1234', 'config.json opens the named host');
    assert.strictEqual(tc.flag('knowledge_engine'), true, 'config.json opens the proxy engine');
    fs.unlinkSync(cfg);
    process.env.TROTH_LLAMACPP_HOST = 'http://127.0.0.1:11436';
    assert.strictEqual(tc.understandingHost(), 'http://127.0.0.1:11436', 'a host on this machine is always taken');
    delete process.env.TROTH_LLAMACPP_HOST;
  });

  console.log('\nknowledge-understanding: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
