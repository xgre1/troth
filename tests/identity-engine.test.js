#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// Identity reads where the operator lets it: with the local engine only by
// default, with their engine once opened, never at all when off. The engine
// road takes the smallest model of each lane unless a model was chosen, and
// the daily cap is theirs to set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'troth-identity-')), 'config.json');
process.env.TROTH_CONFIG_PATH = cfgPath;
delete process.env.TROTH_IDENTITY_ENGINE;
delete process.env.TROTH_IDENTITY_MODEL;
delete process.env.TROTH_IDENTITY_DAILY_TURNS;
delete process.env.TROTH_UNDERSTANDING_DAILY_TURNS;
const ie = require('../shared-core/identity-engine.js');
function writeCfg(obj) { fs.writeFileSync(cfgPath, JSON.stringify(obj)); }

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch((e) => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== identity engine ===\n');

(async () => {
  await t('without a block Identity reads with the local engine only, 400 calls a day', () => {
    writeCfg({});
    assert.deepStrictEqual(ie.settings(), { engine: 'auto', model: '', daily_turns: 400 });
    assert.strictEqual(ie.engineAllowed(), false);
    assert.strictEqual(ie.patternsOnly(), false);
  });

  await t('the block opens the engine, names a model and sets the cap; an unknown word falls back to auto', () => {
    writeCfg({ identity: { engine: 'on', model: 'gpt-5.4-mini', daily_turns: 50 } });
    assert.deepStrictEqual(ie.settings(), { engine: 'on', model: 'gpt-5.4-mini', daily_turns: 50 });
    assert.strictEqual(ie.engineAllowed(), true);
    writeCfg({ identity: { engine: 'sometimes' } });
    assert.strictEqual(ie.settings().engine, 'auto');
    writeCfg({ identity: { engine: 'off' } });
    assert.strictEqual(ie.patternsOnly(), true);
  });

  await t('env overrides win over the block, and the older daily-turns name still counts', () => {
    writeCfg({ identity: { engine: 'off', daily_turns: 10 } });
    process.env.TROTH_IDENTITY_ENGINE = 'on';
    process.env.TROTH_UNDERSTANDING_DAILY_TURNS = '7';
    assert.strictEqual(ie.settings().engine, 'on');
    assert.strictEqual(ie.settings().daily_turns, 7);
    delete process.env.TROTH_IDENTITY_ENGINE;
    delete process.env.TROTH_UNDERSTANDING_DAILY_TURNS;
  });

  await t('the chain takes the local engine first, then each lane with its smallest model, the plans last', () => {
    const providers = {
      local: { enabled: true, model: 'qwen.gguf' },
      openai_sub: { enabled: true, model: 'gpt-5.6-sol' },
      anthropic: { enabled: true, apiKey: 'k', model: 'claude-sonnet-5' },
      deepinfra: { enabled: true, apiKey: 'k', model: 'deepseek-ai/DeepSeek-V4-Flash' },
      google_ai: { enabled: false, apiKey: 'k' },
    };
    const chain = ie.orderChain(providers, { localUp: true });
    assert.deepStrictEqual(chain.map((c) => c.provider), ['local', 'deepinfra', 'anthropic', 'openai_sub']);
    assert.deepStrictEqual(chain.map((c) => c.model), ['qwen.gguf', 'deepseek-ai/DeepSeek-V4-Flash', 'claude-haiku-4-5-20251001', 'gpt-5.4-mini']);
    const down = ie.orderChain(providers, { localUp: false });
    assert.strictEqual(down[0].provider, 'deepinfra', 'a local engine that is down is skipped');
  });

  await t('a chosen model pins its lane first and keeps the rest as fallback', () => {
    const providers = { openai_sub: { enabled: true, model: 'gpt-5.6-sol' }, anthropic: { enabled: true, apiKey: 'k' } };
    const chain = ie.orderChain(providers, { pick: 'claude-sonnet-5', localUp: false });
    assert.deepStrictEqual(chain[0], { provider: 'anthropic', model: 'claude-sonnet-5' });
    assert.deepStrictEqual(chain.slice(1).map((c) => c.provider + ':' + c.model), ['anthropic:claude-haiku-4-5-20251001', 'openai_sub:gpt-5.4-mini']);
  });

  await t('the reader walks the chain, returns the first answer with its lane, and is null when none answers', async () => {
    writeCfg({ identity: { engine: 'on' } });
    const calls = [];
    const adapters = {
      providers: { deepinfra: { enabled: true, apiKey: 'k', model: 'flash' }, openai_sub: { enabled: true } },
      call: {
        deepinfra: async (body, model) => { calls.push('deepinfra:' + model); return null; },
        openai_sub: async (body, model) => { calls.push('openai_sub:' + model); return '{"facts":[]}'; },
      },
    };
    const read = ie.makeReader(adapters, {});
    const out = await read('hello', { max_tokens: 100 });
    assert.deepStrictEqual(out, { text: '{"facts":[]}', provider: 'openai_sub', model: 'gpt-5.4-mini' });
    assert.deepStrictEqual(calls, ['deepinfra:flash', 'openai_sub:gpt-5.4-mini']);
    assert.strictEqual(read.last.provider, 'openai_sub');
    const none = ie.makeReader({ providers: {}, call: {} }, {});
    assert.strictEqual(await none('x'), null);
  });

  await t('status names the setting, the cap and the road of the last run; describe puts it in words', () => {
    writeCfg({ identity: { engine: 'auto' } });
    const st = ie.status();
    assert.strictEqual(st.engine, 'auto');
    assert.strictEqual(st.daily_turns, 400);
    assert.ok(st.budget && st.budget.limit === 400, JSON.stringify(st));
    assert.strictEqual(ie.describe(st), 'waiting for an engine');
    assert.strictEqual(ie.describe({ engine: 'off' }), 'patterns only');
    assert.strictEqual(ie.describe({ engine: 'on', road: 'engine', model: '', budget: { used: 3, limit: 400 } }), 'your engine, 3/400 today');
    assert.strictEqual(ie.describe({ engine: 'auto', road: 'local' }), 'local model');
  });

  console.log('\nidentity-engine: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
