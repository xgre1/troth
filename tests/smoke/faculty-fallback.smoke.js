// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Mirrors the cross-faculty fallback guard in bin/troth-entity.js (~line 1580):
// a transport-aborted turn on a non-router faculty falls back to the router chain
// ONCE, when a different working router orchestrator exists. Proves the decision
// boolean + the retry picks router. (The inline code is not importable — the
// entity boots a daemon on require — so this validates the exact condition.)
const assert = require('assert');

// verbatim copy of the guard + fallback action from the entity handler:
async function withFallback(res, choice, orchestrators, orch, agenticAction, agenticCtx) {
  if (res && res.status === 'aborted' && typeof res.reason === 'string'
      && res.reason.indexOf('transport_') === 0
      && choice.faculty !== 'router' && orchestrators.router && orchestrators.router !== orch) {
    try {
      const _fb = await orchestrators.router.composeAgentic(agenticAction, agenticCtx);
      if (_fb && _fb.status === 'ok') { res = _fb; choice.faculty = 'router'; }
    } catch (_) {}
  }
  return res;
}

module.exports = async function run(t) {
  const routerOrch = { composeAgentic: async () => ({ status: 'ok', text: 'router answer' }) };
  const cliOrch = {};
  const orchestrators = { router: routerOrch, claude_cli: cliOrch };

  await t('fallback: claude_cli transport-abort -> router answers', async () => {
    const choice = { faculty: 'claude_cli' };
    const res = await withFallback({ status: 'aborted', reason: 'transport_providers_exhausted' }, choice, orchestrators, cliOrch, {}, {});
    assert.strictEqual(res.status, 'ok'); assert.strictEqual(res.text, 'router answer');
    assert.strictEqual(choice.faculty, 'router');
  });
  await t('no fallback: turn was OK', async () => {
    const choice = { faculty: 'claude_cli' };
    const res = await withFallback({ status: 'ok', text: 'claude answer' }, choice, orchestrators, cliOrch, {}, {});
    assert.strictEqual(res.text, 'claude answer'); assert.strictEqual(choice.faculty, 'claude_cli');
  });
  await t('no fallback: non-transport abort (timeout) stays put', async () => {
    const choice = { faculty: 'claude_cli' };
    const res = await withFallback({ status: 'aborted', reason: 'timeout' }, choice, orchestrators, cliOrch, {}, {});
    assert.strictEqual(res.reason, 'timeout'); assert.strictEqual(choice.faculty, 'claude_cli');
  });
  await t('no fallback: faculty was already router (no self-retry)', async () => {
    const choice = { faculty: 'router' };
    const res = await withFallback({ status: 'aborted', reason: 'transport_x' }, choice, orchestrators, routerOrch, {}, {});
    assert.strictEqual(res.status, 'aborted');
  });
};
