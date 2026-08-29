// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The three controls on the "Taking in" card, driven the way the dashboard
// drives them: over HTTP, against a real proxy, on a fresh HOME.
//
// The unit suite can prove the gate module and pin the routes' source. It
// cannot prove that the routes are REACHABLE. A task can be written, tested
// and registered into a list nothing on this surface reads, and its unit test
// still passes. So this scenario asks the question that decides it: press the
// button, does the product answer.
module.exports.describe = 'pause, look inside the queue, and read a batch now — through the HTTP the dashboard uses';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports.run = async (ctx, check) => {
  const proxy = await ctx.proxy({
    env: { _TROTH_TEST_HOME: ctx.home, TROTH_MAINT_IDLE_MS: '500', TROTH_MAINT_TICK_MS: '500' }
  });

  const readiness = async () => (await proxy.get('/api/memory/readiness')).json || {};

  const r0 = await readiness();
  check('a machine nobody paused reports itself running',
    !!(r0.paused && r0.paused.paused === false), JSON.stringify(r0.paused));

  // ── Pause ────────────────────────────────────────────────────────────────
  const p1 = await proxy.post('/api/memory/pause', { paused: true });
  check('the pause answers', p1.status === 200 && !!(p1.json && p1.json.paused), 'status=' + p1.status + ' ' + p1.body);

  const r1 = await readiness();
  check('and every surface reading readiness now sees it',
    !!(r1.paused && r1.paused.paused === true), JSON.stringify(r1.paused));
  check('described as the operator\'s own act, not a fault',
    (r1.reasons || []).some((s) => /paused by you/.test(s)) &&
    !(r1.reasons || []).some((s) => /no background worker has drained/.test(s)),
    JSON.stringify(r1.reasons));

  // A catch-up that overrode the stop button beside it would make both
  // untrustworthy.
  const refused = await proxy.post('/api/memory/drain-now', {});
  check('"read now" refuses while paused instead of overriding it',
    refused.status === 200 && refused.json && refused.json.ok === false && refused.json.paused === true,
    'status=' + refused.status + ' ' + refused.body);

  const p2 = await proxy.post('/api/memory/pause', { paused: false });
  check('resuming answers and clears it', p2.status === 200 && p2.json && p2.json.paused === false,
    'status=' + p2.status + ' ' + p2.body);

  // ── The queue, with something real in it ─────────────────────────────────
  // Queued through the core's own spool on this scenario's HOME — the same
  // row the Read path writes. Nothing here reaches into the proxy's process.
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-doc-'));
  const docPath = path.join(docDir, 'berth-allocation-notes.md');
  fs.writeFileSync(docPath,
    '# Berth allocation\n\n' +
    'The night shift allocates berths against the bonded schedule, not the manifest. '.repeat(10) + '\n');
  const seeded = execFileSync(ctx.NODE, ['-e',
    'const s=require(process.argv[1]);' +
    'console.log(s.spoolKnowledge({kind:"file",ref:process.argv[2],sha:"journey-sha-1",bytes:900,' +
    'why:"how are berths allocated at night"}) ? "SEEDED" : "NO");',
    path.join(ctx.root, 'shared-core', 'state.js'), docPath
  ], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: ctx.home }) }).trim();
  check('a read document lands in the queue', /SEEDED/.test(seeded), seeded);

  const q1 = await proxy.get('/api/memory/queue');
  const rows1 = (q1.json && q1.json.rows) || [];
  check('the queue is readable by name, not only by count',
    q1.status === 200 && rows1.some((r) => /berth-allocation-notes\.md$/.test(String(r.ref))),
    'status=' + q1.status + ' rows=' + JSON.stringify(rows1.map((r) => r.ref)));
  check('and each row carries the question that was in flight when it was read',
    rows1.some((r) => /how are berths allocated/.test(String(r.why || ''))),
    JSON.stringify(rows1.map((r) => r.why)));
  check('payloads never ride along with the list',
    rows1.every((r) => !Object.prototype.hasOwnProperty.call(r, 'payload')), JSON.stringify(Object.keys(rows1[0] || {})));

  const q2 = await proxy.get('/api/memory/queue?q=' + encodeURIComponent('berths allocated at night'));
  check('searchable by the question as well as the path',
    q2.status === 200 && ((q2.json && q2.json.rows) || []).length === 1,
    'status=' + q2.status + ' ' + String(q2.body).slice(0, 160));

  const q3 = await proxy.get('/api/memory/queue?q=' + encodeURIComponent('nothing-matches-this-xyz'));
  check('a search that matches nothing says nothing, not everything',
    q3.status === 200 && ((q3.json && q3.json.rows) || []).length === 0 && q3.json.total === 0,
    String(q3.body).slice(0, 160));

  // ── Read a batch now ─────────────────────────────────────────────────────
  const now = await proxy.post('/api/memory/drain-now', {});
  check('"read now" runs the real drain and reports what it did',
    now.status === 200 && now.json && now.json.ok === true && typeof now.json.scanned === 'number' && now.json.scanned >= 1,
    'status=' + now.status + ' ' + String(now.body).slice(0, 200));

  // ── Drop ─────────────────────────────────────────────────────────────────
  // Seed a second one so there is something left to remove by hand.
  const dropPath = path.join(docDir, 'vendor-price-list.md');
  fs.writeFileSync(dropPath, 'prices\n'.repeat(40));
  execFileSync(ctx.NODE, ['-e',
    'const s=require(process.argv[1]);' +
    's.spoolKnowledge({kind:"file",ref:process.argv[2],sha:"journey-sha-2",bytes:280,why:"price list"});',
    path.join(ctx.root, 'shared-core', 'state.js'), dropPath
  ], { env: Object.assign({}, process.env, { HOME: ctx.home }) });

  const q4 = await proxy.get('/api/memory/queue?q=' + encodeURIComponent('vendor-price-list'));
  const target = ((q4.json && q4.json.rows) || [])[0];
  check('the one to remove is findable', !!target, String(q4.body).slice(0, 160));
  if (target) {
    const d = await proxy.post('/api/memory/queue/drop', { id: target.id });
    check('dropping it answers', d.status === 200 && d.json && d.json.ok === true, 'status=' + d.status + ' ' + d.body);
    const q5 = await proxy.get('/api/memory/queue?q=' + encodeURIComponent('vendor-price-list'));
    check('and it leaves the queue', ((q5.json && q5.json.rows) || []).length === 0, String(q5.body).slice(0, 160));
  }

  // ── The wiring the whole thing hung on ───────────────────────────────────
  // A proxy-only install must schedule the document reader itself. Before
  // this, it never did — and nothing on the surface said so.
  const log = proxy.log();
  check('the proxy schedules the document reader, not only the indexer',
    /knowledge_drain/.test(log) || /Maintenance:/.test(log),
    log.split('\n').filter((l) => /[Mm]aintenance|knowledge/.test(l)).slice(-3).join(' | ') || '(no maintenance lines)');
};
