// SPDX-License-Identifier: AGPL-3.0-only
// suite-19 — router pinned-engine fail-fast.
//
// The operator pinned ChatGPT (routing.pin='openai_sub'); the plan hit its
// usage cap so the pinned lane 429'd, health marked it unhealthy, activeByok
// excluded it, the pin failed closed (empty chain), and the proxy returned a
// GENERIC 503 all_providers_unavailable. The claude CLI riding the proxy
// retries 5xx/429 with exponential backoff, so the operator stared at 128+
// seconds of silence instead of being told "your ChatGPT plan hit its limit".
//
// These tests pin the contract: a pinned-but-unavailable engine yields a
// DISTINCT fail-fast descriptor (HTTP 400, Anthropic-shaped invalid_request
// error that names the engine + reason + way out); non-pinned mode is
// unchanged (chain exhaustion still resolves the generic null).
'use strict';

module.exports = function run({ test }) {
  const assert = require('assert');
  // suite-04 swaps a FAKE router into require.cache to exercise an adapter and
  // restores the ORIGINAL only if one was cached at capture time. Depending on
  // suite order that can leave a stub (or nothing) behind, so evict any cached
  // router entry and require the real module fresh. Nothing else in the suite
  // relies on module identity, so a clean re-require is safe.
  try { delete require.cache[require.resolve('../proxy/modules/router')]; } catch (_) {}
  const router = require('../proxy/modules/router');
  const errortax = require('../proxy/modules/errortax');
  const T = router.__test;

  console.log('\nRouter pinned-engine fail-fast (behavior):');

  assert.ok(T, 'router must expose its __test surface for this suite');

  // Snapshot + restore the in-memory state each test touches so this suite
  // never leaks a pin / cooldown / provider-enable into the others.
  function snapshot() {
    return {
      pin: T.routingPrefs.pin,
      dispatch_prefer: T.routingPrefs.dispatch_prefer,
      openai_sub: JSON.parse(JSON.stringify(T.providers.openai_sub)),
      local: JSON.parse(JSON.stringify(T.providers.local)),
    };
  }
  function restore(s) {
    T.routingPrefs.pin = s.pin;
    T.routingPrefs.dispatch_prefer = s.dispatch_prefer;
    T.providers.openai_sub = s.openai_sub;
    T.providers.local = s.local;
    T.markProviderHealthy('openai_sub');
    T.markProviderHealthy('local');
    errortax.reset();
  }

  const body = JSON.stringify({
    model: 'claude-sonnet-4', max_tokens: 256, stream: false,
    messages: [{ role: 'user', content: 'quick sanity question, answer briefly' }],
  });

  test('PIN-FAIL-1: pinned engine in cooldown yields a distinct 400 invalid_request_error naming the engine + reason', async () => {
    const s = snapshot();
    try {
      // Reproduce the incident: openai_sub enabled, plan hit its cap (429 on
      // record), health marked it unhealthy so activeByok excludes it, and the
      // operator has it pinned. No token/network is touched — the exclusion is
      // via the health cooldown, exactly like the live path.
      errortax.reset();
      errortax.record(429, 'rate limited', 'openai_sub');
      T.providers.openai_sub.enabled = true;
      T.markProviderFailed('openai_sub');
      assert.strictEqual(T.isProviderHealthy('openai_sub'), false, 'setup: openai_sub must be in cooldown');
      T.routingPrefs.pin = 'openai_sub';

      const fbOpts = { pinFailure: null };
      const result = await router.callFallbackChain(body, fbOpts);

      // The chain still resolves null (preserves every existing caller +
      // the entity transport's _exhausted path + simulator p9).
      assert.strictEqual(result, null, 'pinned-unusable chain must still resolve null');

      const pf = fbOpts.pinFailure;
      assert.ok(pf && pf.set, 'pinFailure descriptor must be filled');
      assert.strictEqual(pf.status, 400, 'status must be 400 (fatal to upstream CLIs, no retry storm)');
      assert.strictEqual(pf.provider, 'openai_sub');

      // Anthropic-error shape so the CLI renders it verbatim.
      assert.strictEqual(pf.body.type, 'error');
      assert.strictEqual(pf.body.error.type, 'invalid_request_error');
      const msg = pf.body.error.message;
      assert.ok(msg.includes('ChatGPT subscription'), 'message must name the pinned engine by its operator-facing name; got: ' + msg);
      assert.ok(/rate limit/i.test(msg), 'message must state the reason (plan rate limit); got: ' + msg);
      assert.ok(/Settings/.test(msg), 'message must state the way out (Settings); got: ' + msg);
      assert.ok(/No fallback because the engine is pinned/.test(msg), 'message must explain there is no fallback; got: ' + msg);
    } finally {
      restore(s);
    }
  });

  test('PIN-FAIL-2: reason mapping is honest — 401 -> sign-in expired, no-enable -> turned off', () => {
    const s = snapshot();
    try {
      // 401 / sign-in expired path.
      errortax.reset();
      errortax.record(401, 'auth_expired', 'openai_sub');
      T.providers.openai_sub.enabled = true;
      T.markProviderHealthy('openai_sub');
      const reason401 = T.detectPinReason('openai_sub');
      assert.ok(/sign-in expired/i.test(reason401), '401 must map to sign-in expired; got: ' + reason401);

      // Disabled provider takes precedence — "turned off in Settings".
      errortax.reset();
      T.providers.openai_sub.enabled = false;
      const reasonOff = T.detectPinReason('openai_sub');
      assert.ok(/turned off/i.test(reasonOff), 'disabled engine must map to turned off; got: ' + reasonOff);
    } finally {
      restore(s);
    }
  });

  test('PIN-FAIL-3: NON-pinned exhaustion is UNCHANGED — no pinFailure descriptor, chain still resolves null', async () => {
    const s = snapshot();
    try {
      // No pin set. Force total exhaustion: openai_sub in cooldown, local
      // disabled, nothing else enabled. The generic machinery must stay as-is:
      // the chain resolves null and NO pin-failure descriptor is produced.
      errortax.reset();
      T.routingPrefs.pin = '';
      T.providers.openai_sub.enabled = true;
      T.markProviderFailed('openai_sub');
      T.providers.local.enabled = false;

      const fbOpts = { pinFailure: null };
      const result = await router.callFallbackChain(body, fbOpts);

      assert.strictEqual(result, null, 'non-pinned exhaustion still resolves the generic null');
      assert.ok(!fbOpts.pinFailure, 'non-pinned mode must NOT set a pinFailure descriptor (generic fallback stays intact)');
    } finally {
      restore(s);
    }
  });
};
