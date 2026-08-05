// SPDX-License-Identifier: AGPL-3.0-only
// suite-23 — kimi-cli-lane: `troth classic` routes Claude Code straight to the
// Kimi Code membership endpoint (Anthropic-compatible) instead of the proxy,
// which has no subscription lane. Pure resolver, so these are plain unit tests.
'use strict';
module.exports = function run({ test }) {
  const assert = require('assert');
  const { resolveKimiLane, DEFAULT_BASE } = require('../shared-core/kimi-cli-lane.js');

  test('KIMI-LANE-1: env TROTH_KIMI_SUB_KEY is the highest-priority source', () => {
    const r = resolveKimiLane({ env: { TROTH_KIMI_SUB_KEY: 'ek' } });
    assert.strictEqual(r.chosen, true, 'env key means Kimi is chosen');
    assert.ok(r.lane, 'a lane is returned');
    assert.strictEqual(r.lane.key, 'ek', 'the env key rides the lane');
    assert.strictEqual(r.lane.base, DEFAULT_BASE, 'default Kimi Code base');
  });

  test('KIMI-LANE-2: TROTH_KIMI_SUB_BASE overrides the endpoint; model rides through', () => {
    const r = resolveKimiLane({ env: { TROTH_KIMI_SUB_KEY: 'ek', TROTH_KIMI_SUB_BASE: 'https://x/', TROTH_KIMI_SUB_MODEL: 'kimi-for-coding' } });
    assert.strictEqual(r.lane.base, 'https://x/', 'base override honored');
    assert.strictEqual(r.lane.model, 'kimi-for-coding', 'model carried');
  });

  test('KIMI-LANE-3: OSS config (cli_engine:kimi + kimi_sub_key) yields a lane', () => {
    const r = resolveKimiLane({ ossConfig: { cli_engine: 'kimi', kimi_sub_key: 'ok', kimi_sub_model: 'm' } });
    assert.strictEqual(r.chosen, true);
    assert.ok(r.lane && r.lane.key === 'ok' && r.lane.model === 'm', 'oss key + model on the lane');
    assert.strictEqual(r.lane.base, DEFAULT_BASE);
  });

  test('KIMI-LANE-4: paid-app config (engine_pin:kimi_sub + kimi_sub_key) yields a lane', () => {
    const r = resolveKimiLane({ appConfig: { engine_pin: 'kimi_sub', kimi_sub_key: 'ak' } });
    assert.strictEqual(r.chosen, true);
    assert.ok(r.lane && r.lane.key === 'ak', 'app key on the lane, no extra setup for app users');
  });

  test('KIMI-LANE-5: precedence env > oss > app', () => {
    const r = resolveKimiLane({
      env: { TROTH_KIMI_SUB_KEY: 'ENV' },
      ossConfig: { cli_engine: 'kimi', kimi_sub_key: 'OSS' },
      appConfig: { engine_pin: 'kimi_sub', kimi_sub_key: 'APP' },
    });
    assert.strictEqual(r.lane.key, 'ENV', 'env wins');
    const r2 = resolveKimiLane({
      ossConfig: { cli_engine: 'kimi', kimi_sub_key: 'OSS' },
      appConfig: { engine_pin: 'kimi_sub', kimi_sub_key: 'APP' },
    });
    assert.strictEqual(r2.lane.key, 'OSS', 'oss beats app when env absent');
  });

  test('KIMI-LANE-6: Kimi chosen but NO key -> chosen:true, lane:null (caller warns, no silent misroute)', () => {
    const oss = resolveKimiLane({ ossConfig: { cli_engine: 'kimi' } });
    assert.strictEqual(oss.chosen, true, 'the intent is recognized');
    assert.strictEqual(oss.lane, null, 'but no lane without a key');
    const app = resolveKimiLane({ appConfig: { engine_pin: 'kimi_sub', kimi_sub_key: '   ' } });
    assert.strictEqual(app.chosen, true);
    assert.strictEqual(app.lane, null, 'a blank key is not a key');
  });

  test('KIMI-LANE-7: no Kimi choice anywhere -> chosen:false, lane:null (proxy path)', () => {
    assert.deepStrictEqual(resolveKimiLane({}), { chosen: false, lane: null });
    const other = resolveKimiLane({ ossConfig: { cli_engine: 'chatgpt' }, appConfig: { engine_pin: 'openai_sub' } });
    assert.strictEqual(other.chosen, false, 'a different engine is not Kimi');
    assert.strictEqual(other.lane, null);
  });

  test('KIMI-LANE-8: engine_pin match is case-insensitive and trims', () => {
    const r = resolveKimiLane({ appConfig: { engine_pin: '  KIMI_SUB ', kimi_sub_key: 'k' } });
    assert.ok(r.lane && r.lane.key === 'k', 'trim + case fold on the engine token');
  });
};
