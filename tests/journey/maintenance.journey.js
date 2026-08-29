// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The dashboard-only topology, healed — the exact install that froze at
// "28 memories still indexing / 20,682 archive chunks still embedding" for
// two days (Linux, `troth start` + browser, no entity daemon anywhere).
// The proxy hosts the maintenance worker, so THIS journey
// is the product promise: a proxy alone produces a drain heartbeat the
// readiness surface can prove, and the "where do I SEE the memories" page
// answers. Runs identically on the checkout, the DMG bundle's core, and
// the docker Linux export — the friend's machine is the third one.
//
// Determinism: fresh HOME, no models, no embedder — the heartbeat comes
// from the run LEDGER (a run that honestly reports "no missing embeddings"
// still proves the worker lives). The readiness/status polls are excluded
// from the worker's foreground-activity signal on purpose; this journey
// polling readiness WHILE the worker goes idle is itself the regression
// test for that exclusion (a gauge must not freeze the machine it reads).
module.exports.describe = 'the proxy alone keeps memory maintenance alive and proves it on the readiness surface';

module.exports.run = async (ctx, check) => {
  const proxy = await ctx.proxy({
    env: {
      _TROTH_TEST_HOME: ctx.home,
      // Tight idle/tick so the first heartbeat lands inside journey budget;
      // production defaults are 60s/30s (same code path, longer waits).
      TROTH_MAINT_IDLE_MS: '500',
      TROTH_MAINT_TICK_MS: '500'
    }
  });

  const r1 = await proxy.get('/api/memory/readiness');
  check('readiness answers with a drain block', r1.status === 200 && !!(r1.json && r1.json.drain !== undefined),
    'status=' + r1.status + ' body=' + String(r1.body).slice(0, 160));

  // Up to ~20s for the first idle window + tick + ledger write.
  let drain = null, alive = false;
  for (let i = 0; i < 20 && !alive; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r2 = await proxy.get('/api/memory/readiness');
    drain = (r2.json && r2.json.drain) || null;
    alive = !!(drain && drain.alive);
  }
  check('the proxy ALONE produces a drain heartbeat (no entity daemon anywhere)', alive, JSON.stringify(drain));
  check('the heartbeat is a real ledger timestamp', !!(drain && typeof drain.last_run_ts === 'number' && drain.last_run_ts > 0),
    JSON.stringify(drain));

  const rec = await proxy.get('/api/memory/recent');
  check('the recent-memories surface answers (where a human SEES what import produced)',
    rec.status === 200 && !!(rec.json && Array.isArray(rec.json.memories)),
    'status=' + rec.status + ' body=' + String(rec.body).slice(0, 120));

  const r3 = await proxy.get('/api/memory/readiness');
  const reasons = (r3.json && r3.json.reasons) || [];
  check('a fresh empty home neither claims nor begs a drain (no owed-work verdicts)',
    !reasons.some((s) => /no background worker/.test(s)), JSON.stringify(reasons));
};
