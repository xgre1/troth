// SPDX-License-Identifier: AGPL-3.0-only
// Coherence by derivation (law 1).
//
// The coherence audits traced every "wrong shape" incident to blind
// defaults: backbone troth beside a Claude-subscription-only install,
// local-first dispatch with no local engine, a Kimi-only machine wired like
// a multi-engine one. derive-config.js computes the shape from detected
// engines instead. These tests drive the PURE half with fabricated
// detections (that is what the pure/impure split is for) and pin the
// absent-only + pin + kill-switch precedence of the env fill.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const dc = require(path.join(__dirname, '..', 'shared-core', 'derive-config.js'));

console.log('\nCoherence by derivation (DERIVE):');

test('DERIVE-1: Claude subscription as the only engine gets the Claude Code backbone', () => {
  const d = dc.deriveCoherentConfig({ claude_sub: true, kimi_sub: false, openai_sub: false, api_providers: 0, local: false });
  assert.strictEqual(d.backbone, 'claude_cli');
  assert.strictEqual(d.backbone_engine, 'claude');
  assert.strictEqual(d.dispatch_prefer, 'hosted');
  assert.ok(d.reasons.join(' ').includes('only engine'), 'the output names its reason');
});

test('DERIVE-2: Kimi membership as the only engine rides the harness with the kimi engine', () => {
  const d = dc.deriveCoherentConfig({ claude_sub: false, kimi_sub: true, openai_sub: false, api_providers: 0, local: false });
  assert.strictEqual(d.backbone, 'claude_cli');
  assert.strictEqual(d.backbone_engine, 'kimi');
  assert.strictEqual(d.dispatch_prefer, 'hosted');
});

test('DERIVE-3: local as the only engine stays local-first on the troth loop', () => {
  const d = dc.deriveCoherentConfig({ claude_sub: false, kimi_sub: false, openai_sub: false, api_providers: 0, local: true });
  assert.strictEqual(d.backbone, 'troth');
  assert.strictEqual(d.dispatch_prefer, 'local');
  assert.strictEqual(d.entity_transport, 'local');
});

test('DERIVE-4: multiple engines keep the troth loop as arbiter; nothing configured stays neutral', () => {
  const multi = dc.deriveCoherentConfig({ claude_sub: true, kimi_sub: false, openai_sub: true, api_providers: 2, local: true });
  assert.strictEqual(multi.backbone, 'troth', 'the arbiter loop');
  assert.strictEqual(multi.dispatch_prefer, 'hosted');
  const none = dc.deriveCoherentConfig({ claude_sub: false, kimi_sub: false, openai_sub: false, api_providers: 0, local: false });
  assert.strictEqual(none.backbone, 'troth');
  assert.strictEqual(none.dispatch_prefer, '', 'no preference invented from nothing');
  assert.ok(none.reasons.join(' ').includes('nothing configured'));
});

test('DERIVE-5: the env fill is absent-only, a pin silences it, the kill-switch kills it', () => {
  const sub = { claude_sub: true, kimi_sub: false, openai_sub: false, api_providers: 0, local: false };
  // Empty env → both keys fill (claude engine stays implicit — it is the default).
  let f = dc.deriveEnvFill({}, sub);
  assert.strictEqual(f.TROTH_ENTITY_BACKBONE, 'claude_cli');
  assert.strictEqual(f.TROTH_ENTITY_DISPATCH_PREFER, 'hosted');
  assert.ok(!('TROTH_CLAUDE_ENGINE' in f), 'claude is the default harness engine; no key needed');
  // A stated backbone is NEVER overwritten; prefer still fills when absent.
  f = dc.deriveEnvFill({ TROTH_ENTITY_BACKBONE: 'troth' }, sub);
  assert.ok(!('TROTH_ENTITY_BACKBONE' in f), 'stated values are the operator\'s');
  assert.strictEqual(f.TROTH_ENTITY_DISPATCH_PREFER, 'hosted');
  // The kimi shape names its engine.
  f = dc.deriveEnvFill({}, { claude_sub: false, kimi_sub: true, openai_sub: false, api_providers: 0, local: false });
  assert.strictEqual(f.TROTH_ENTITY_BACKBONE, 'claude_cli');
  assert.strictEqual(f.TROTH_CLAUDE_ENGINE, 'kimi');
  // A pin owns the surface: nothing fills.
  assert.deepStrictEqual(dc.deriveEnvFill({ TROTH_ENTITY_LLM_PIN: '1' }, sub), {});
  // Operator kill-switch.
  assert.deepStrictEqual(dc.deriveEnvFill({ TROTH_DERIVE: '0' }, sub), {});
});

test('DERIVE-6: detection under the hermetic HOME sees a machine with nothing configured', () => {
  // The suite runs under a throwaway HOME (hermetic-db.js) and detection is
  // HOME-rooted by design: credential FILE roads live under HOME and the
  // keychain road is skipped when _TROTH_TEST_HOME is set — otherwise every
  // developer Mac would "detect" its owner's login and test boots would stop
  // being reproducible. Membership env vars are scrubbed for the same reason.
  const savedKimi = process.env.TROTH_KIMI_SUB_KEY;
  delete process.env.TROTH_KIMI_SUB_KEY;
  try {
    const d = dc.detectEngines();
    assert.strictEqual(d.claude_sub, false, 'no credentials under the hermetic HOME');
    assert.strictEqual(d.kimi_sub, false);
    assert.strictEqual(d.api_providers, 0, 'no providers in the hermetic config');
    // Derivation of that emptiness must be the neutral shape.
    const shape = dc.deriveCoherentConfig(d);
    assert.strictEqual(shape.backbone, 'troth');
    assert.strictEqual(shape.dispatch_prefer, '');
  } finally {
    if (savedKimi === undefined) delete process.env.TROTH_KIMI_SUB_KEY;
    else process.env.TROTH_KIMI_SUB_KEY = savedKimi;
  }
});
};
