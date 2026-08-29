// SPDX-License-Identifier: AGPL-3.0-only
// Two questions the operator asked while watching the intake card, both of
// which the surface could not answer:
//
//   "Can I stop this?"  The embedder runs on this machine's own CPU. A backlog
//   of a few thousand passages keeps the fans up for an hour, and the only
//   ways to stop it were killing the proxy or setting an environment variable
//   and restarting — neither of which is a button, and neither of which comes
//   back on its own. PAUSE-1..4 pin the button, and pin that EVERY runner
//   honours it: a pause one of three processes ignores is not a pause.
//
//   "What's left?"  The card could say 183 and could not say WHICH 183.
//   A queue you can only count is a queue you have to trust. QUEUE-1..3 pin
//   the searchable list, the drop, and the routes that serve them.
module.exports = function run({ test }) {
const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const gate  = require(path.join(ROOT, 'shared-core', 'maintenance-gate.js'));
const bw    = require(path.join(ROOT, 'shared-core', 'background-worker.js'));
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const mr    = require(path.join(ROOT, 'shared-core', 'memory-readiness.js'));

console.log('\nPause and the visible queue (PAUSE/QUEUE):');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('PAUSE-1: pausing writes one readable file; resuming removes it', () => {
  try {
    assert.strictEqual(gate.isPaused().paused, false, 'a machine nobody paused is running');
    const r = gate.pause({ by: 'suite', reason: 'the laptop is frying' });
    assert.ok(r.ok, 'the pause was written: ' + JSON.stringify(r));
    const p = gate.isPaused();
    assert.strictEqual(p.paused, true, 'and it reads back as paused');
    assert.ok(p.since > 0, 'stamped, so the surface can say since when');
    assert.strictEqual(p.reason, 'the laptop is frying', 'and keeps the operator\'s own words');
    // A file, on purpose: an operator whose UI is down can remove it by hand,
    // and no crashed process can leave the machine paused in a way nothing
    // else can read.
    assert.ok(fs.existsSync(gate.gatePath()), 'it is a file on disk: ' + gate.gatePath());
    assert.ok(gate.gatePath().indexOf('.troth') !== -1, 'inside the operator\'s own .troth');
  } finally { gate.resume(); }
  assert.strictEqual(gate.isPaused().paused, false, 'resume puts it back');
  assert.strictEqual(gate.resume().ok, true, 'and resuming twice is not an error');
});

test('PAUSE-2: a worker already running stops mid-flight, and picks back up', async () => {
  let runs = 0;
  const probe = { name: 'pause_probe_' + Date.now(), cadence_ms: 60 * 1000,
    run: () => { runs++; return { events: [], notes: [] }; } };
  let w = null;
  try {
    gate.pause({ by: 'suite' });
    w = bw.startWorker({
      tasks: [probe], idle_threshold_ms: 0, tick_ms: 40,
      submit: () => {}, getView: () => ({})
    });
    await sleep(260);
    // The whole point is that it lands on a worker that is ALREADY up. A pause
    // that needs a restart is a config flag wearing a button's clothes.
    assert.strictEqual(runs, 0, 'nothing ran while paused: runs=' + runs);
    gate.resume();
    await sleep(300);
    assert.ok(runs >= 1, 'and it resumes without a restart: runs=' + runs);
  } finally { if (w) w.stop(); gate.resume(); }
});

test('PAUSE-3: the one-shot scheduler honours it too — hooks cannot restart what you stopped', async () => {
  let runs = 0;
  try {
    gate.pause({ by: 'suite' });
    const r = await bw.runDueTasks({
      tasks: [{ name: 'pause_oneshot_' + Date.now(), cadence_ms: 24 * 60 * 60 * 1000,
        run: () => { runs++; return { events: [], notes: [] }; } }],
      submit: () => {}, getView: () => ({ substrate_ctx: { agent_id: 'suite', cwd: null } })
    });
    assert.strictEqual(runs, 0, 'the due task did not fire: runs=' + runs);
    assert.strictEqual(r.paused, true, 'and it says why rather than reporting a quiet success');
  } finally { gate.resume(); }
});

test('PAUSE-4: a stall you caused is never reported as a fault', () => {
  try {
    gate.pause({ by: 'suite' });
    const r = mr.readiness();
    assert.strictEqual(r.paused && r.paused.paused, true, 'readiness carries the state');
    const reasons = (r.reasons || []).join(' | ');
    assert.ok(/paused by you/.test(reasons), 'and says so in the operator\'s terms: ' + reasons);
    // Telling someone their machine is broken immediately after they pressed
    // the button that stopped it is how a surface loses its credibility for
    // the warnings that matter.
    assert.ok(!/no background worker has drained/.test(reasons),
      'without also alarming them about their own decision: ' + reasons);
  } finally { gate.resume(); }
});

test('PAUSE-5: every surface that reports the drain knows about the pause', () => {
  // Three places render this verdict, and each one had to be found by hand.
  // The card was fixed first; `troth doctor` would still have called the
  // operator's own decision a stalled drain, which is the same defect wearing
  // a CLI. The REPL banner needs nothing — it prints readiness.reasons
  // verbatim, so it inherited the truth the moment readiness carried it.
  const doctor = fs.readFileSync(path.join(ROOT, 'bin', 'troth.js'), 'utf8');
  const at = doctor.indexOf('"Background drain"');
  assert.ok(at > 0, 'doctor reports a drain verdict');
  const block = doctor.slice(Math.max(0, at - 900), at + 1400);
  assert.ok(/paused by you/.test(block), 'and names a pause as a pause, not a stall: ' + block.slice(-260));

  const chat = fs.readFileSync(path.join(ROOT, 'bin', 'troth-chat.js'), 'utf8');
  assert.ok(/readiness\(\)/.test(chat) && /reasons/.test(chat),
    'the REPL banner renders readiness reasons rather than re-deriving a verdict of its own');
});

test('QUEUE-1: the queue is searchable by the file AND by what was being asked', () => {
  const stamp = 'q' + Date.now();
  assert.ok(state.spoolKnowledge({ kind: 'file', ref: require('os').tmpdir() + '/' + stamp + '/harbour-tariffs.pdf', sha: stamp + 'a', bytes: 4096,
    why: 'what does the bonded warehouse schedule cost' }), 'queued a document');
  assert.ok(state.spoolKnowledge({ kind: 'file', ref: require('os').tmpdir() + '/' + stamp + '/lease-appendix.docx', sha: stamp + 'b', bytes: 8192,
    why: 'when does the reconciliation window close' }), 'queued a second');
  assert.ok(state.spoolKnowledge({ kind: 'web', ref: 'https://example.test/' + stamp + '/rates', sha: stamp + 'c', bytes: 2048,
    payload: 'body', why: 'current transhipment rates' }), 'queued a page');

  const byName = state.searchPendingKnowledge({ q: 'harbour-tariffs' });
  assert.strictEqual(byName.rows.length, 1, 'found by file name: ' + JSON.stringify(byName.rows.map(r => r.ref)));
  assert.ok(/harbour-tariffs\.pdf$/.test(byName.rows[0].ref), 'the right one');

  // An operator remembers the file name OR the question, never reliably the
  // same one of the two.
  const byQuestion = state.searchPendingKnowledge({ q: 'reconciliation window' });
  assert.strictEqual(byQuestion.rows.length, 1, 'found by the question in flight: ' + JSON.stringify(byQuestion.rows.map(r => r.why)));
  assert.ok(/lease-appendix/.test(byQuestion.rows[0].ref), 'and it resolves to the document that answered it');

  const all = state.searchPendingKnowledge({ q: stamp });
  assert.strictEqual(all.rows.length, 3, 'all three are pending');
  assert.strictEqual(all.total, 3, 'and total agrees with what is shown when nothing is truncated');
  // Payloads are never returned: a web capture can be megabytes and this
  // feeds a list, not a reader.
  assert.ok(!Object.prototype.hasOwnProperty.call(all.rows[0], 'payload'), 'no payload rides along');

  const capped = state.searchPendingKnowledge({ q: stamp, limit: 2 });
  assert.strictEqual(capped.rows.length, 2, 'the limit is honoured');
  assert.strictEqual(capped.total, 3, 'and total still tells the truth about what is behind it');
});

test('QUEUE-2: dropping one takes it out of the queue and keeps the reason', () => {
  const stamp = 'd' + Date.now();
  const ref = require('os').tmpdir() + '/' + stamp + '/vendor-manual.pdf';
  assert.ok(state.spoolKnowledge({ kind: 'file', ref, sha: stamp, bytes: 128 }), 'queued');
  const before = state.searchPendingKnowledge({ q: stamp });
  assert.strictEqual(before.rows.length, 1, 'it is waiting');
  assert.strictEqual(state.dropPendingKnowledge(before.rows[0].id), true, 'dropped');
  assert.strictEqual(state.searchPendingKnowledge({ q: stamp }).rows.length, 0, 'and it is out of the queue');
  // Marked done rather than deleted: "why is this not in memory" keeps an
  // answer instead of becoming a silence.
  const row = state._dbForQuery().prepare('SELECT done_at, result FROM knowledge_spool WHERE ref = ?').get(ref);
  assert.ok(row && row.done_at, 'closed, not erased');
  assert.ok(/dropped by operator/.test(String(row.result)), 'with who closed it: ' + JSON.stringify(row));
  assert.strictEqual(state.dropPendingKnowledge(before.rows[0].id), false, 'dropping it twice changes nothing');
});

test('QUEUE-3: the proxy serves the queue, the pause and the drop — all behind the same auth gate (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  // The route name appears twice — once in the GET allowlist, once as the
  // branch that answers it. Pin the BRANCH; the allowlist entry alone would
  // let an unimplemented route pass its own test.
  assert.ok(src.indexOf("url === '/api/memory/queue'") > 0, 'the queue is in the read allowlist');
  const read = src.indexOf("else if (url === '/api/memory/queue')");
  assert.ok(read > 0, 'and a branch answers it');
  assert.ok(/searchPendingKnowledge/.test(src.slice(read, read + 1200)), 'through the shared query, not a second SQL road');

  for (const route of ['/api/memory/pause', '/api/memory/queue/drop', '/api/memory/drain-now']) {
    const at = src.indexOf("url === '" + route + "'");
    assert.ok(at > 0, route + ' exists');
    assert.ok(/checkRemoteAuth/.test(src.slice(at, at + 300)),
      route + ' is gated — a proxy bound beyond loopback must not let a stranger stop the operator\'s memory');
  }
  assert.ok(/maintenance-gate\.js/.test(src), 'the pause goes through the one gate every runner reads');

  // "Read now" is bounded, and it obeys the stop button beside it. An
  // unbounded catch-up is the bulk run that cooked the machine once; a
  // catch-up that ignores the pause makes both buttons untrustworthy.
  const now = src.indexOf("url === '/api/memory/drain-now'");
  const block = src.slice(now, now + 1200);
  assert.ok(/isPaused\(\)\.paused/.test(block), 'it refuses while paused rather than overriding the operator');
  assert.ok(/budget:\s*25\b/.test(block), 'and it drains ONE bounded batch, never the whole queue');
  assert.ok(/knowledge-drain\.js/.test(block), 'through the same drain the idle worker runs, not a second road');
});

test('QUEUE-4: the card offers all three controls, and still invents no numbers (source pin)', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'proxy', 'ui', 'dashboard.html'), 'utf8');
  assert.ok(/onclick="setIntakePause\(/.test(ui), 'there is a pause button, not a paragraph about environment variables');
  assert.ok(/onclick="openIntakeQueue\(\)"/.test(ui), 'and a way to look inside the queue');
  assert.ok(/\/api\/memory\/queue\?limit=/.test(ui), 'which reads the real queue');
  assert.ok(/onclick="drainIntakeNow\(this\)"/.test(ui), 'and a way to say do it now instead of waiting a day for 8-per-15-minutes');
  // The rate constants that produced "~6 h" beside "indexed 100%" were the
  // worker's budget and cadence copied into the renderer by hand.
  assert.ok(!/queued\s*\|\|\s*0\)\s*\/\s*8\)/.test(ui), 'no hand-copied worker budget');
  assert.ok(/res\.docs_per_hour/.test(ui) && /ix\.passages_per_hour/.test(ui),
    'the estimate comes from measured throughput');
  // Two lanes, two heartbeats: the indexer being alive said nothing about
  // whether anything was reading the documents.
  assert.ok(/res\.reader_alive/.test(ui), 'and the card reads the document reader\'s own heartbeat');
  // The "just taken in" list is DOCUMENTS. Gating it on the indexer's
  // heartbeat would hide a reader that is working, or vouch for one that is
  // not — the same wrong-lane mistake one line further down the page.
  // Anchored on the intake stream's own constant, not on 'var live =' — that
  // name appears elsewhere on the page, and the first version of this
  // assertion matched a plugin-status line instead.
  const fresh = ui.indexOf('var FRESH_MS');
  assert.ok(fresh > 0, 'the freshly-read list exists');
  assert.ok(/res\.reader_alive/.test(ui.slice(fresh, fresh + 400)),
    'and is gated on the reader, not the indexer: ' + ui.slice(fresh, fresh + 260));
});
};
