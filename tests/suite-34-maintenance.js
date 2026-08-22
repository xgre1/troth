// SPDX-License-Identifier: AGPL-3.0-only
// Maintenance topology (field report): dashboards froze at
// "28 still indexing / 20,682 still embedding" for TWO DAYS because the
// drain lived only in the entity daemon and a dashboard-only install never
// runs one. The cure has three legs, each pinned here: the worker is
// hostable by ANY process with a lease so proxy + entity never double-work
// one queue (MAINT-1/2), the run record carries its notes so readiness has
// a heartbeat to read (MAINT-2), and auto import-sync flows ONLY sources a
// human already imported once — raw half only, the distill half spends
// model quota and stays on the explicit button (MAINT-3).
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const bw = require(path.join(ROOT, 'shared-core', 'background-worker.js'));
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar = require(path.join(ROOT, 'shared-core', 'action-record.js'));

console.log('\nMaintenance worker (MAINT):');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ledgerRow = (task, ts, notes) => {
  const id = ar.uuidv7();
  return state.recordAction({ id, timestamp: ts, type: 'decision',
    agent_id: 'maintenance', cwd: null, user_id: 'default',
    audience: 'substrate_internal', memory_class: 'operational',
    input: { kind: 'background_task_run', task: task, signals: { scheduler: true } },
    output: { decision: 'ran', reason: 'startWorker', notes: notes || '' } }, 'background task run');
};

test('MAINT-1: a fresh ledger row IS the lease — the local worker yields the cadence window', async () => {
  assert.ok(ledgerRow('maint_probe_a', Date.now(), 'x'), 'fresh row persisted');
  let runs = 0;
  const w = bw.startWorker({
    tasks: [{ name: 'maint_probe_a', cadence_ms: 60 * 1000, run: () => { runs++; return { events: [], notes: [] }; } }],
    cross_process_lease: true, idle_threshold_ms: 0, tick_ms: 40,
    submit: () => {}, getView: () => ({})
  });
  await sleep(280); w.stop();
  assert.strictEqual(runs, 0, 'another process ran it inside the cadence — this one must not: runs=' + runs);
});

test('MAINT-2: a stale lease does not suppress, and the run record carries its notes', async () => {
  assert.ok(ledgerRow('maint_probe_b', Date.now() - 10 * 60 * 1000, 'old'), 'stale row persisted');
  let runs = 0; const recs = [];
  const w = bw.startWorker({
    tasks: [{ name: 'maint_probe_b', cadence_ms: 60 * 1000, run: () => { runs++; return { events: [], notes: ['probe note b'] }; } }],
    cross_process_lease: true, idle_threshold_ms: 0, tick_ms: 40,
    submit: (ev) => { recs.push(ev); }, getView: () => ({})
  });
  await sleep(280); w.stop();
  assert.ok(runs >= 1, 'a 10-min-old row is outside the 60s cadence — the task fires: runs=' + runs);
  const rec = recs.find((e) => e && e.input && e.input.kind === 'background_task_run' && e.input.task === 'maint_probe_b');
  assert.ok(rec && /probe note b/.test(String(rec.output && rec.output.notes)),
    'the ledger record carries the notes readiness renders: ' + JSON.stringify(rec && rec.output));
});

test('MAINT-3: import_sync flows only consented sources; env kills win; dry mode never spawns', async () => {
  const fs = require('fs'); const os = require('os');
  const t = bw.tasks.importSync;
  assert.ok(t && t.name === 'import_sync', 'the task is exported for hosts');
  process.env.TROTH_IMPORT_SYNC_DRY = '1';
  try {
    let r = await t.run({});
    assert.ok(String(r.notes.join(' ')).indexOf('nothing consented') !== -1,
      'no prior human import → no auto-sync (first import stays a human act): ' + r.notes);
    // Consent: the source root exists AND a human-imported provenance row does.
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'projects'), { recursive: true });
    const id = ar.uuidv7();
    assert.ok(state.recordAction({ id, timestamp: Date.now(), type: 'commitment',
      agent_id: 'local-agent', cwd: null, user_id: 'default',
      memory_class: 'semantic', audience: 'model_visible',
      input: { source: 'import:claude-cli:cons-1' },
      output: { statement: 'consent marker chunk', commitment_type: 'engram', salience: 1, scope: 'docs:chats' } },
      'consent marker'), 'provenance marker persisted');
    r = await t.run({});
    assert.ok(String(r.notes.join(' ')).indexOf('would sync claude-cli') !== -1,
      'a consented source auto-syncs (dry names it, spawns nothing): ' + r.notes);
    process.env.TROTH_IMPORT_SYNC = '0';
    r = await t.run({});
    assert.ok(String(r.notes.join(' ')).indexOf('disabled by env') !== -1, 'the env kill-switch wins: ' + r.notes);
  } finally {
    delete process.env.TROTH_IMPORT_SYNC;
    delete process.env.TROTH_IMPORT_SYNC_DRY;
  }
});

test('MAINT-4: the proxy hosts EVERY upkeep task — including the two that had no runner here (source pin)', () => {
  // The topology promise itself: a dashboard-only install (`troth start`)
  // drains, syncs AND backs up because THIS block exists — before it, a
  // proxy-only machine never took a backup in its life. Pin the wiring
  // the journey exercises; the thinking tasks stay the entity's alone.
  //
  // knowledge_drain and outcome_fold were the same bug one layer in. Both
  // were written, tested and registered — in DEFAULT_TASKS, which only the
  // entity daemon runs. On a Claude Code + proxy machine nothing referenced
  // them, so the document queue had no reader and 183 documents sat unread
  // while the card reported a healthy drain. The suite passed
  // throughout, because it asserted membership in DEFAULT_TASKS and never
  // asked which list the RUNNING process uses. This asks.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const at = src.indexOf('bw.tasks.embeddingBackfill,');
  assert.ok(at > 0, 'the proxy maintenance worker hosts the embedding drain');
  const block = src.slice(Math.max(0, at - 1200), at + 1600);
  for (const t of ['knowledgeDrain', 'outcomeFold', 'importSync', 'backup', 'walReplicate', 'ledgerPrune']) {
    assert.ok(block.indexOf('bw.tasks.' + t) !== -1, 'the proxy hosts ' + t + ' — a task nothing here runs is a task that never runs');
  }
  assert.ok(/cross_process_lease:\s*true/.test(block), 'with the cross-process lease on');
  assert.ok(/TROTH_MAINTENANCE/.test(block), 'and a kill-switch');
  assert.ok(/substrate_internal/.test(block), 'ledger rows stay out of every recall pool (substrate_internal)');
  // And the map the proxy reads them from actually carries them.
  assert.ok(bw.tasks.knowledgeDrain && bw.tasks.knowledgeDrain.name === 'knowledge_drain', 'exported by name');
  assert.ok(bw.tasks.outcomeFold && bw.tasks.outcomeFold.name === 'outcome_fold', 'exported by name');
});

test('MAINT-5: only non-GET requests count as foreground — an open dashboard cannot freeze the drain (source pin)', () => {
  // The dashboard breathes GETs (stats 5s, logs 3s, connection 10s): with
  // any GET counting as activity, WATCHING the frozen numbers would be
  // what froze them. The journey proves the live half (heartbeat goes
  // alive under readiness polling); this pins the rule to every GET.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const at = src.indexOf('noteForegroundActivity()');
  assert.ok(at > 0, 'the activity ping exists');
  const block = src.slice(Math.max(0, at - 400), at + 100);
  assert.ok(/req\.method !== 'GET'/.test(block), 'the ping is gated on non-GET: ' + block.slice(-200));
  assert.ok(!/indexOf\('\/api\/memory\/readiness'\)/.test(block), 'no per-endpoint exclusion list to rot');
});

test('MAINT-6: the lease finds a long-cadence run through ANY amount of ledger noise', () => {
  // A weekly backup's last run must be visible to the lease even when the
  // 30s drain has written thousands of rows since — the windowed scan
  // version missed it and re-ran weekly tasks daily.
  const backupTs = Date.now() - 2 * 24 * 60 * 60 * 1000;
  assert.ok(ledgerRow('probe_weekly_task', backupTs, 'weekly ran'), 'old weekly row persisted');
  for (let i = 0; i < 450; i++) {
    assert.ok(ledgerRow('probe_noisy_task', Date.now() - i * 1000, 'n' + i), 'noise row ' + i);
  }
  const found = state.lastBackgroundRun('probe_weekly_task', 7 * 24 * 60 * 60 * 1000);
  assert.ok(found && Math.abs(found.timestamp - backupTs) < 2000,
    'the 2-day-old run is found through 450 fresher rows: ' + JSON.stringify(found));
  assert.ok(/weekly ran/.test(String(found.notes)), 'with its notes intact');
});

test('MAINT-7: ledger pruning drops aged bookkeeping, keeps each task\'s newest row, touches nothing else', () => {
  const d = state._dbForQuery();
  const countTask = (t) => d.prepare("SELECT COUNT(*) AS n FROM action_records WHERE type='decision' AND json_extract(input,'$.task') = ?").get(t).n;
  const nonLedgerBefore = d.prepare("SELECT COUNT(*) AS n FROM action_records WHERE NOT (type='decision' AND json_extract(input,'$.kind')='background_task_run')").get().n;
  const OLD = Date.now() - 9 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 5; i++) assert.ok(ledgerRow('probe_prune_a', OLD - i * 1000, 'a' + i), 'aged row a' + i);
  assert.ok(ledgerRow('probe_prune_b', OLD - 500, 'b-last'), 'aged row b (its newest overall)');
  assert.ok(ledgerRow('probe_prune_a', Date.now(), 'a-fresh'), 'fresh row a');
  const removed = state.pruneBackgroundRunLedger(7 * 24 * 60 * 60 * 1000);
  assert.ok(removed >= 5, 'aged duplicates were removed: ' + removed);
  assert.strictEqual(countTask('probe_prune_a'), 1, 'task a keeps only its fresh row');
  assert.strictEqual(countTask('probe_prune_b'), 1, 'task b keeps its NEWEST row even though it is old (the lease anchor)');
  const nonLedgerAfter = d.prepare("SELECT COUNT(*) AS n FROM action_records WHERE NOT (type='decision' AND json_extract(input,'$.kind')='background_task_run')").get().n;
  assert.strictEqual(nonLedgerAfter, nonLedgerBefore, 'not one non-ledger row was touched');
});

test('MAINT-8: the usage ledger prunes past 30 days — every reachable plan-window read survives', () => {
  // plan-window serves at most a 168h trailing window; rows older than 30d
  // serve nothing and grew forever (20K rows in days of real use).
  const d = state._dbForQuery();
  d.prepare('INSERT INTO usage_ledger (ts, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?)')
    .run(Date.now() - 40 * 24 * 60 * 60 * 1000, 'probe-model-old', 10, 5);
  d.prepare('INSERT INTO usage_ledger (ts, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?)')
    .run(Date.now() - 1000, 'probe-model-fresh', 10, 5);
  const removed = state.pruneUsageLedger(30 * 24 * 60 * 60 * 1000);
  assert.ok(removed >= 1, 'the 40-day-old row went: ' + removed);
  const old = d.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE model = 'probe-model-old'").get().n;
  const fresh = d.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE model = 'probe-model-fresh'").get().n;
  assert.strictEqual(old, 0, 'aged usage rows are gone');
  assert.strictEqual(fresh, 1, 'recent usage — everything a plan-window can read — survives');
});
};
