// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Time-to-serve, as an invariant rather than a hope.
//
// The proxy used to walk and parse the project before it called listen(), so on
// a clean machine the dashboard was unreachable for 75 seconds and read as
// broken; the desktop app aims that walk at the operator's entire home
// directory. Moving the call after listen() changed nothing on its own,
// because synchronous work blocks the loop and a blocked loop cannot answer an
// open port. What matters is not where the call sits but whether a person can
// get in, so that is what is measured.
module.exports.describe = 'a person can get in while the machine is still waking up';

const BUDGET_MS = parseInt(process.env.TROTH_JOURNEY_BOOT_BUDGET_MS || '5000', 10);

module.exports.run = async (ctx, check) => {
  // Point the indexer at a real tree with real source in it — the product's
  // own — so this is not measured against an empty directory.
  const t0 = Date.now();
  const proxy = await ctx.proxy({ env: { GF_WATCH_DIR: ctx.root }, bootMs: 90000 });
  const probe = await proxy.get('/api/setup/local');
  const servedMs = Date.now() - t0;

  check('the proxy answers at all', probe.status === 200, 'status=' + probe.status + ' ' + (probe.error || ''));
  check('it answers within ' + BUDGET_MS + 'ms of spawn (was 9737ms)', servedMs <= BUDGET_MS,
    'took ' + servedMs + 'ms');

  // Answering once is not the same as staying answerable: the indexing that
  // follows must not take the loop away again.
  const during = [];
  for (let i = 0; i < 6; i++) {
    const t = Date.now();
    const r = await proxy.get('/api/setup/local');
    during.push({ ms: Date.now() - t, ok: r.status === 200 });
    await new Promise((r2) => setTimeout(r2, 600));
  }
  const stalled = during.filter((d) => !d.ok || d.ms > 3000);
  check('it stays answerable while the project is being indexed', stalled.length === 0,
    JSON.stringify(during));

  // Turning the module off must actually save the work, not merely refuse to
  // use it: with codelens disabled the boot still spent 8777ms building an
  // index that every query then declined to read.
  const log = proxy.log();
  const claimsIndexing = /\[CodeLens\] Indexed/.test(log);
  const saysOff = /CodeLens: off/.test(log);
  check('the log says what it did with the project', claimsIndexing || saysOff,
    'neither an index nor an off-notice in the log');
};
