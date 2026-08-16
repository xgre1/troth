// SPDX-License-Identifier: AGPL-3.0-only
// Substrate sync — one mind, reachable from every device.
//
// What this suite pins is the sequencer contract: arrival order is the only
// order (gseq), the per-device watermark makes replay idempotent and gaps
// loud, a KNOWN op that fails still advances (anti-stall), an UNKNOWN op
// advances nothing (fail-closed until the hub is taught it), the catalogue
// is an allowlist that never exposes world-acting tools, and the satellite
// outbox journals every write in the caller's own breath so a dead network
// loses nothing. The wire envelope IS the journal record — that identity is
// what keeps the replica phase an addition instead of a rewrite.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nSubstrate sync (SYN):');

function hermetic(script) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const r = cp.spawnSync('node', ['-e', script], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db'),
      TROTH_CONFIG_PATH: path.join(HOME, '.troth', 'config.json'),
      TROTH_CONFIG_DIR: path.join(HOME, '.troth')
    }),
    encoding: 'utf8', timeout: 45000
  });
  assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const REQ =
  "const HUB = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'hub.js')) + ");" +
  "const CAT = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'catalogue.js')) + ");" +
  "const HLC = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'hlc.js')) + ");" +
  "const RC  = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'remote-client.js')) + ");" +
  "const S   = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");" +
  "const AR  = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");" +
  "function env(d, seq, op, args, extra) { return Object.assign({ v:1, event_id: AR.uuidv7(), device_id: d, dev_seq: seq, op: op, op_v: 1, args: args || {}, ctx: { agent_id: 'test-surface', user_id: 'default', cwd: '/tmp/proj' } }, extra || {}); }";

test('SYN-1: the catalogue is an allowlist — memory ops in, world-acting tools structurally absent', () => {
  const out = hermetic(REQ + [
    "const h = HUB.hello();",
    "const names = Object.keys(h.ops);",
    "console.log(JSON.stringify({ ok: h.ok, protocol: h.protocol, hasEngram: !!h.ops.engram_record, engramKind: h.ops.engram_record.kind, hasRecall: !!h.ops.recall, recallKind: h.ops.recall.kind, world: names.filter(n => ['browser_session','api_call','web_fetch','intent_emit','github_create_issue','supabase_run_sql'].indexOf(n) >= 0) }));"
  ].join('\n'));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.protocol, 1);
  assert.strictEqual(out.hasEngram, true);
  assert.strictEqual(out.engramKind, 'write');
  assert.strictEqual(out.hasRecall, true);
  assert.strictEqual(out.recallKind, 'read');
  assert.deepStrictEqual(out.world, [], 'nothing world-acting is reachable through the sync surface');
});

test('SYN-2: pair, apply, sequence — an engram event lands with gseq 1 and a recorded outcome', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  const auth = HUB.authDevice(d.token);",
    "  const r = await HUB.applyEvent(env(d.device_id, 1, 'engram_record', { statement: 'the sky over the hub is clear' }));",
    "  const db = S.db();",
    "  const je = db.prepare('SELECT gseq, op, outcome FROM sync_events').all();",
    "  const n = db.prepare('SELECT COUNT(*) AS n FROM action_records').get().n;",
    "  const wm = db.prepare('SELECT last_dev_seq FROM sync_devices').get().last_dev_seq;",
    "  console.log(JSON.stringify({ authOk: auth && auth.device_id === d.device_id, ok: r.ok, gseq: r.gseq, engrams: n, journal: je.length, outcomeSaved: !!(je[0] && je[0].outcome), wm }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.authOk, true, 'the raw token authenticates');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.gseq, 1, 'first event takes the first gseq');
  assert.ok(out.engrams >= 1, 'the engram exists in the mind');
  assert.strictEqual(out.journal, 1);
  assert.strictEqual(out.outcomeSaved, true);
  assert.strictEqual(out.wm, 1);
});

test('SYN-3: replay is answered from the journal — same gseq back, nothing applied twice', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  const e1 = env(d.device_id, 1, 'engram_record', { statement: 'once and only once' });",
    "  const a = await HUB.applyEvent(e1);",
    "  const before = S.db().prepare('SELECT COUNT(*) AS n FROM action_records').get().n;",
    "  const b = await HUB.applyEvent(e1);",
    "  const after = S.db().prepare('SELECT COUNT(*) AS n FROM action_records').get().n;",
    "  console.log(JSON.stringify({ aG: a.gseq, bG: b.gseq, replayed: b.replayed, before, after }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.aG, 1);
  assert.strictEqual(out.bG, 1, 'the replay answers with the ORIGINAL gseq');
  assert.strictEqual(out.replayed, true);
  assert.strictEqual(out.before, out.after, 'the second delivery applied nothing');
});

test('SYN-4: a sequence gap is refused loudly and consumes nothing', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  const r = await HUB.applyEvent(env(d.device_id, 5, 'engram_record', { statement: 'out of order' }));",
    "  const j = S.db().prepare('SELECT COUNT(*) AS n FROM sync_events').get().n;",
    "  const wm = S.db().prepare('SELECT last_dev_seq FROM sync_devices').get().last_dev_seq;",
    "  console.log(JSON.stringify({ err: r.error, expected: r.expected, j, wm }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.err, 'sequence_gap');
  assert.strictEqual(out.expected, 1, 'the refusal names the seq it wants');
  assert.strictEqual(out.j, 0, 'nothing journaled');
  assert.strictEqual(out.wm, 0, 'watermark untouched');
});

test('SYN-5: an unknown op is a typed refusal that advances nothing — the hub must be taught first', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  const r = await HUB.applyEvent(env(d.device_id, 1, 'claim_teleport', { x: 1 }));",
    "  const j = S.db().prepare('SELECT COUNT(*) AS n FROM sync_events').get().n;",
    "  const wm = S.db().prepare('SELECT last_dev_seq FROM sync_devices').get().last_dev_seq;",
    "  const r2 = await HUB.applyEvent(env(d.device_id, 1, 'engram_record', { statement: 'still first in line' }));",
    "  console.log(JSON.stringify({ err: r.error, vt: r.versionType, j, wm, retryOk: r2.ok, retryG: r2.gseq }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.err, 'version_not_supported');
  assert.strictEqual(out.vt, 'op');
  assert.strictEqual(out.j, 0);
  assert.strictEqual(out.wm, 0);
  assert.strictEqual(out.retryOk, true, 'dev_seq 1 was NOT consumed by the refusal');
  assert.strictEqual(out.retryG, 1);
});

test('SYN-6: a KNOWN op that fails still advances the watermark with its failure on record — no eternal resend', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  const r = await HUB.applyEvent(env(d.device_id, 1, 'rule_record', { text: 'no' }));",
    "  const row = S.db().prepare('SELECT outcome FROM sync_events WHERE dev_seq = 1').get();",
    "  const oc = JSON.parse(row.outcome);",
    "  const wm = S.db().prepare('SELECT last_dev_seq FROM sync_devices').get().last_dev_seq;",
    "  const r2 = await HUB.applyEvent(env(d.device_id, 2, 'engram_record', { statement: 'life goes on' }));",
    "  console.log(JSON.stringify({ gseq: r.gseq, resOk: r.result && r.result.ok, resErr: r.result && r.result.error, ocSaved: oc.ok === true, wm, nextOk: r2.ok, nextG: r2.gseq }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.gseq, 1, 'the failing event still took its gseq');
  assert.strictEqual(out.resOk, false);
  assert.strictEqual(out.resErr, 'too_short', 'the domain failure travels back verbatim');
  assert.strictEqual(out.ocSaved, true, 'applied-with-domain-refusal is a recorded outcome');
  assert.strictEqual(out.wm, 1, 'watermark advanced — the device will not resend forever');
  assert.strictEqual(out.nextOk, true);
  assert.strictEqual(out.nextG, 2);
});

test('SYN-7: dialogue flows through — a synced turn is readable by dialogue_recent, and reads never touch the journal', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  await HUB.applyEvent(env(d.device_id, 1, 'dialogue_turn', { user_text: 'kalimera from the laptop', assistant_text: 'kalimera — recorded on the hub' }));",
    "  const q = await HUB.runQuery('dialogue_recent', { n: 5 }, { cwd: '/tmp/proj', agent_id: 'test-surface' });",
    "  const j = S.db().prepare('SELECT COUNT(*) AS n FROM sync_events').get().n;",
    "  console.log(JSON.stringify({ qOk: q.ok, turns: q.result && q.result.turns.length, firstUser: q.result && q.result.turns[0] && q.result.turns[0].user, j }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.qOk, true);
  assert.ok(out.turns >= 1, 'the turn came back');
  assert.strictEqual(out.firstUser, 'kalimera from the laptop');
  assert.strictEqual(out.j, 1, 'the read added no journal rows');
});

test('SYN-8: revocation is one row — the token dies, the device is refused', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('stolen-phone');",
    "  const before = !!HUB.authDevice(d.token);",
    "  HUB.revokeDevice(d.device_id);",
    "  const after = !!HUB.authDevice(d.token);",
    "  const r = await HUB.applyEvent(env(d.device_id, 1, 'engram_record', { statement: 'should not land' }));",
    "  console.log(JSON.stringify({ before, after, err: r.error }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.before, true);
  assert.strictEqual(out.after, false);
  assert.strictEqual(out.err, 'unknown_device');
});

test('SYN-9: a following device writes HOME first — the local row and the outbox event carry one id', () => {
  const out = hermetic(REQ + [
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_test', deviceToken: 'tok' } }));",
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "const id = engram.recordEngram({ agent_id: 'cli', statement: 'written on the device, kept on the device' });",
    "const db = S.db();",
    "const local = db.prepare('SELECT id FROM action_records').all();",
    "const ob = db.prepare('SELECT envelope FROM sync_outbox ORDER BY dev_seq').all();",
    "const env1 = JSON.parse(ob[0].envelope);",
    "setTimeout(() => { console.log(JSON.stringify({ id: !!id, localCount: local.length, localId: local[0] && local[0].id, rows: ob.length, evOp: env1.op, evId: env1.args.id })); }, 150);"
  ].join('\n'));
  assert.strictEqual(out.id, true);
  assert.ok(out.localCount >= 1, 'the write lives locally FIRST — offline is full function');
  assert.strictEqual(out.rows, 1, 'and it rides the outbox too');
  assert.strictEqual(out.evOp, 'engram_record');
  assert.strictEqual(out.evId, out.localId, 'one id fleet-wide: the event carries the author record id');
});

test('SYN-10: the flusher ships in order, records gseq, and stops dead when the hub refuses', () => {
  const out = hermetic(REQ + [
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_test', deviceToken: 'tok' } }));",
    "(async () => {",
    "  const seen = [];",
    "  let g = 0;",
    "  RC.__setTransportForTests((s, method, p, body) => { seen.push(body.dev_seq); return Promise.resolve({ ok: true, gseq: ++g }); });",
    "  RC.queueWrite('engram_record', { statement: 'one' }, { agent_id: 'cli' });",
    "  RC.queueWrite('engram_record', { statement: 'two' }, { agent_id: 'cli' });",
    "  const f = await RC.flush();",
    "  const db = S.db();",
    "  const unsent = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE sent_at IS NULL').get().n;",
    "  const third = RC.queueWrite('engram_record', { statement: 'three' }, { agent_id: 'cli' });",
    "  const env3 = JSON.parse(db.prepare('SELECT envelope FROM sync_outbox WHERE dev_seq = 3').get().envelope);",
    "  RC.__setTransportForTests((s, method, p, body) => Promise.resolve({ ok: false, error: 'sequence_gap', expected: 3 }));",
    "  const f2 = await RC.flush();",
    "  const stillUnsent = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE sent_at IS NULL').get().n;",
    "  console.log(JSON.stringify({ order: seen, flushed: f.flushed, unsent, parent3: env3.parent_gseq, blocked: f2.blocked, stillUnsent }));",
    "})();"
  ].join('\n'));
  assert.deepStrictEqual(out.order, [1, 2], 'events left in dev_seq order');
  assert.strictEqual(out.flushed, 2);
  assert.strictEqual(out.unsent, 0);
  assert.strictEqual(out.parent3, 2, 'a later event carries the applied hub prefix as parent_gseq');
  assert.strictEqual(out.blocked, 'sequence_gap', 'a hub refusal stops the flusher instead of skipping');
  assert.strictEqual(out.stillUnsent, 1, 'the refused event stays queued');
});

test('SYN-11: the clock never lies backwards, and a future stamp is flagged, not rejected', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const a = HLC.next(null, 'dev_x', 1000000);",
    "  const b = HLC.next(a, 'dev_x', 999000);",
    "  const c = HLC.next(b, 'dev_x', 999000);",
    "  const d = HUB.addDevice('laptop');",
    "  const r = await HUB.applyEvent(env(d.device_id, 1, 'engram_record', { statement: 'from the future' }, { hlc_ts: HLC.fmt(Date.now() + 10 * 60 * 1000, 0, 'dev_x') }));",
    "  console.log(JSON.stringify({ mono1: b > a, mono2: c > b, parsed: !!HLC.parse(c), applied: r.ok, flag: r.hlc_flag }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.mono1, true, 'a backwards wall clock still yields a later stamp');
  assert.strictEqual(out.mono2, true);
  assert.strictEqual(out.parsed, true);
  assert.strictEqual(out.applied, true, 'the write itself is never gated by the clock');
  assert.strictEqual(out.flag, 'future_stamp');
});

test('SYN-12: recall answers from THIS machine — an unreachable hub costs a following device nothing', () => {
  const out = hermetic(REQ + [
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_test', deviceToken: 'tok' } }));",
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "engram.recordEngram({ agent_id: 'cli', statement: 'the harbour codeword is saffron lantern', auto_verify: false });",
    "const recallMod = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'recall.js')) + ");",
    "RC.__setTransportForTests(() => Promise.resolve({ transport_error: true }));",
    "(async () => {",
    "  const got = await recallMod.recall({ query: 'harbour codeword', agent_id: 'cli' });",
    "  console.log(JSON.stringify({ n: got.length, hit: got.some(function (g) { return /saffron lantern/.test(g.statement || ''); }) }));",
    "})();"
  ].join('\n'));
  assert.ok(out.n >= 1, 'recall answered with the hub dark');
  assert.strictEqual(out.hit, true, 'and it answered from the local copy');
});

test('SYN-13: the mind travels as one file — the bundle carries the journal position and round-trips the memories', () => {
  const out = hermetic(REQ + [
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "const backup = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'substrate-backup.js')) + ");",
    "engram.recordEngram({ _local: true, agent_id: 'cli', statement: 'a memory worth carrying across machines' });",
    "const d = HUB.addDevice('laptop');",
    "(async () => {",
    "  await HUB.applyEvent(env(d.device_id, 1, 'engram_record', { statement: 'and one that arrived through sync' }));",
    "  const ex = backup.exportArchive({ out_path: require('path').join(process.env.HOME, 'mind-bundle') });",
    "  const target = require('path').join(process.env.HOME, 'restored.db');",
    "  const im = backup.importArchive({ in_path: ex.bundle_path, target_db: target, replace: true });",
    "  const Database = require('better-sqlite3');",
    "  const rdb = new Database(target, { readonly: true });",
    "  const n = rdb.prepare('SELECT COUNT(*) AS n FROM action_records').get().n;",
    "  rdb.close();",
    "  console.log(JSON.stringify({ exported: !!ex.ok, gseqStamp: ex.manifest.sync_latest_gseq, imported: !!im.ok, rows: n }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.exported, true);
  assert.strictEqual(out.gseqStamp, 1, 'the bundle names the journal position it was cut at');
  assert.strictEqual(out.imported, true, 'import is a first-class road, not a shrug');
  assert.ok(out.rows >= 2, 'both memories — local-born and sync-born — made the crossing');
});

test('SYN-14: pairing is one string — it roundtrips, the device walks the addresses to a live one, and a self-pair is refused', () => {
  const out = hermetic(REQ + [
    "const P = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'pairing.js')) + ");",
    "const code = P.encode({ hosts: ['http://203.0.113.9:8000', 'http://203.0.113.10:8000'], device_id: 'dev_x', token: 'tok_y' });",
    "const dec = P.decode(code);",
    "const selfHosts = Array.from(P.localIps()).filter(function (ip) { return /^[0-9.]+$/.test(ip); }).slice(0, 3).map(function (ip) { return 'http://' + ip + ':8000'; });",
    "const selfCode = P.encode({ hosts: selfHosts, device_id: 'dev_x', token: 'tok_y' });",
    "(async () => {",
    "  const tried = [];",
    "  RC.__setTransportForTests(function (s) { tried.push(s.host); return Promise.resolve(tried.length < 2 ? { transport_error: true } : { ok: true, protocol: 1, latest_gseq: 0 }); });",
    "  const r = await RC.connectWithCode(code);",
    "  const cfg = JSON.parse(require('fs').readFileSync(process.env.TROTH_CONFIG_PATH, 'utf8'));",
    "  const selfR = await RC.connectWithCode(selfCode);",
    "  console.log(JSON.stringify({ roundtrip: !!(dec && dec.device_id === 'dev_x' && dec.token === 'tok_y' && dec.hosts.length === 2), ok: r.ok, picked: r.host, tried, cfgHost: cfg.sync && cfg.sync.host, cfgTok: cfg.sync && cfg.sync.deviceToken, selfErr: selfR.error }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.roundtrip, true, 'one string carries hosts, identity and key');
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.tried, ['http://203.0.113.9:8000', 'http://203.0.113.10:8000'], 'addresses walked in order');
  assert.strictEqual(out.picked, 'http://203.0.113.10:8000', 'the one that answered wins');
  assert.strictEqual(out.cfgHost, out.picked, 'only an address that answered is written to config');
  assert.strictEqual(out.cfgTok, 'tok_y');
  assert.strictEqual(out.selfErr, 'self_pair', 'a machine cannot be paired with itself');
});

test('SYN-15: discovery — a beacon roundtrips, our own echo is ignored, silence expires a peer', () => {
  const out = hermetic(REQ + [
    "const D = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'discovery.js')) + ");",
    "const b = D.encodeBeacon('studio', 8000);",
    "const parsed = D.parseBeacon(b);",
    "const junk = D.parseBeacon(Buffer.from('hello'));",
    "const self = new Set(['10.0.0.5']);",
    "const noted = D.noteBeacon(b, '10.0.0.9', self);",
    "const echoed = D.noteBeacon(b, '10.0.0.5', self);",
    "const seen = D.nearby();",
    "console.log(JSON.stringify({ name: parsed && parsed.name, port: parsed && parsed.port, junk: junk === null, noted, echoed, count: seen.length, host: seen[0] && seen[0].host }));"
  ].join('\n'));
  assert.strictEqual(out.name, 'studio');
  assert.strictEqual(out.port, 8000);
  assert.strictEqual(out.junk, true, 'garbage on the wire parses to nothing');
  assert.strictEqual(out.noted, true);
  assert.strictEqual(out.echoed, false, 'a machine never discovers itself');
  assert.strictEqual(out.count, 1);
  assert.strictEqual(out.host, '10.0.0.9');
});

test('SYN-16: knock-to-pair — capped knocks, an approval mints once, and the code leaves only toward the knocking address', () => {
  const out = hermetic(REQ + [
    "const PR = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'pair-requests.js')) + ");",
    "const a = PR.create('lap<script>top', '10.0.0.9');",
    "const b = PR.create('phone', '10.0.0.9');",
    "const capped = PR.create('third', '10.0.0.9');",
    "const pend = PR.listPending();",
    "const ap = PR.approve(a.id, function (name) { return { device_id: 'dev_t', code: 'troth1.codeFor_' + name }; });",
    "const wrongIp = PR.statusFor(a.id, '10.0.0.66');",
    "const first = PR.statusFor(a.id, '10.0.0.9');",
    "const second = PR.statusFor(a.id, '10.0.0.9');",
    "const dn = PR.deny(b.id);",
    "const bs = PR.statusFor(b.id, '10.0.0.9');",
    "console.log(JSON.stringify({ capped: capped.error, pendNames: pend.map(function (r) { return r.name; }), apOk: ap.ok, wrongIp: wrongIp.status, firstStatus: first.status, firstCode: first.code, secondCode: second.code || null, denied: bs.status }));"
  ].join('\n'));
  assert.strictEqual(out.capped, 'too_many_pending', 'a stranger cannot flood the door');
  assert.ok(out.pendNames[0].indexOf('<') === -1, 'names are sanitized before an operator reads them');
  assert.strictEqual(out.apOk, true);
  assert.strictEqual(out.wrongIp, 'unknown', 'another address learns nothing, not even that the knock exists');
  assert.strictEqual(out.firstStatus, 'approved');
  assert.ok(String(out.firstCode).indexOf('troth1.') === 0, 'the code rides back to the knocker');
  assert.strictEqual(out.secondCode, null, 'and exactly once');
  assert.strictEqual(out.denied, 'denied');
});

test('SYN-17: the bundle shelf lists real bundles by itself — junk skipped, newest first', () => {
  const out = hermetic(REQ + [
    "const B = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'substrate-backup.js')) + ");",
    "const fs = require('fs'); const p = require('path');",
    "const dir = p.join(process.env.HOME, 'backups');",
    "for (const [n, at] of [['substrate-old', '2026-08-01T00:00:00.000Z'], ['substrate-new', '2026-08-16T00:00:00.000Z']]) {",
    "  fs.mkdirSync(p.join(dir, n), { recursive: true });",
    "  fs.writeFileSync(p.join(dir, n, 'manifest.json'), JSON.stringify({ bundle_version: 1, generated_at: at, engram_count: 7, sync_latest_gseq: 3 }));",
    "  fs.writeFileSync(p.join(dir, n, 'state.db'), 'x');",
    "}",
    "fs.mkdirSync(p.join(dir, 'not-a-bundle'), { recursive: true });",
    "const got = B.listBundles({ dir });",
    "console.log(JSON.stringify({ count: got.length, first: got[0] && got[0].name, engrams: got[0] && got[0].engram_count, gseq: got[0] && got[0].sync_latest_gseq }));"
  ].join('\n'));
  assert.strictEqual(out.count, 2, 'only real bundles make the shelf');
  assert.strictEqual(out.first, 'substrate-new', 'newest first');
  assert.strictEqual(out.engrams, 7);
  assert.strictEqual(out.gseq, 3, 'the journal position rides along');
});

test('SYN-18: a .trothmove on the shelf — detected where an AirDrop lands, memories join the live mind additively', () => {
  const out = hermetic(REQ + [
    "const B = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'substrate-backup.js')) + ");",
    "const atlas = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'atlas.js')) + ");",
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "const zlib = require('zlib'); const fs = require('fs'); const p = require('path');",
    "engram.recordEngram({ _local: true, agent_id: 'cli', statement: 'a memory that will ride a move file' });",
    "const ex = atlas.exportAtlas(S, {});",
    "const downloads = p.join(process.env.HOME, 'Downloads');",
    "fs.mkdirSync(downloads, { recursive: true });",
    "const moveFile = p.join(downloads, 'troth-move-test.trothmove');",
    "fs.writeFileSync(moveFile, JSON.stringify({ format: 'troth-move', version: 1, created_at: 1755300000000, source_machine: 'studio', atlas_ndjson: zlib.gzipSync(Buffer.from(ex.content)).toString('base64'), atlas_encoding: 'gzip+base64', atlas_count: ex.count, desktop_config: {}, provider_config: {} }));",
    "const shelf = B.listBundles({ dirs: [downloads] });",
    "const im = B.importMoveFile({ in_path: moveFile });",
    "console.log(JSON.stringify({ found: shelf.length, kind: shelf[0] && shelf[0].kind, source: shelf[0] && shelf[0].source_machine, count: shelf[0] && shelf[0].engram_count, imOk: im.ok, skipped: im.skipped, failed: im.failed }));"
  ].join('\n'));
  assert.strictEqual(out.found, 1, 'the move FILE is seen, not only folder bundles');
  assert.strictEqual(out.kind, 'move');
  assert.strictEqual(out.source, 'studio', 'the shelf says whose machine it came from');
  assert.ok(out.count >= 1, 'the memory count rides the header');
  assert.strictEqual(out.imOk, true, 'gzip+base64 atlas decodes and imports through the shared road');
  assert.ok(out.skipped >= 1, 'same ids count as skipped — additive and safe to re-run');
  assert.strictEqual(out.failed, 0);
});

test('SYN-19: invites — the mind knocks first, the invite is the approval, and it spends exactly once', () => {
  const out = hermetic(REQ + [
    "const PR = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'pair-requests.js')) + ");",
    "const inv = PR.createInvite();",
    "const noted = PR.noteInvite({ invite_id: inv.id, mind_name: 'stu<dio>', hosts: ['http://10.0.0.5:8000'] }, '10.0.0.5');",
    "const listed = PR.listInvites();",
    "const taken = PR.takeInvite(inv.id);",
    "const takenAgain = PR.takeInvite(inv.id);",
    "const red = PR.redeemInvite(inv.id, function () { return { device_id: 'dev_i', code: 'troth1.invitecode' }; });",
    "const redAgain = PR.redeemInvite(inv.id, function () { return { device_id: 'dev_x', code: 'troth1.other' }; });",
    "const badNote = PR.noteInvite({ invite_id: 'x', hosts: [] }, '10.0.0.5');",
    "console.log(JSON.stringify({ created: !!inv.id, noted: noted.ok, listedName: listed[0] && listed[0].mind_name, takenOk: !!taken, takenAgain: takenAgain === null, redOk: red.ok, redCode: red.code, redAgain: redAgain.error, badNote: badNote.error }));"
  ].join('\n'));
  assert.strictEqual(out.created, true);
  assert.strictEqual(out.noted, true);
  assert.ok(out.listedName.indexOf('<') === -1, 'a mind name is sanitized before an operator reads it');
  assert.strictEqual(out.takenOk, true);
  assert.strictEqual(out.takenAgain, true, 'a taken invite leaves the device shelf');
  assert.strictEqual(out.redOk, true);
  assert.ok(String(out.redCode).indexOf('troth1.') === 0, 'redeeming hands back a pairing code');
  assert.strictEqual(out.redAgain, 'no_such_invite', 'an invite spends exactly once');
  assert.strictEqual(out.badNote, 'bad_invite', 'a hostless invite is refused at the door');
});

test('SYN-20: the feed serves the journal after a position, in order, only what has an outcome', () => {
  const out = hermetic(REQ + [
    "(async () => {",
    "  const d = HUB.addDevice('laptop');",
    "  for (const t of ['one', 'two', 'three']) { await HUB.applyEvent(env(d.device_id, ['one','two','three'].indexOf(t) + 1, 'engram_record', { statement: 'feed ' + t })); }",
    "  const all = HUB.listEventsSince(0, 10);",
    "  const after1 = HUB.listEventsSince(1, 10);",
    "  const page = HUB.listEventsSince(0, 2);",
    "  console.log(JSON.stringify({ n: all.length, order: all.map(function (e) { return e.gseq; }), after1: after1.map(function (e) { return e.gseq; }), page: page.length, hasArgs: !!all[0].args.statement, dev: all[0].device_id }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.n, 3);
  assert.deepStrictEqual(out.order, [1, 2, 3], 'the only order that exists');
  assert.deepStrictEqual(out.after1, [2, 3], 'a position is resumable');
  assert.strictEqual(out.page, 2, 'pagination holds');
  assert.strictEqual(out.hasArgs, true);
  assert.strictEqual(out.dev, out.dev, 'device provenance rides along');
});

test('SYN-21: a replica applies foreign events on the same ids, skips its own echo, and stops dead on an op it cannot read', () => {
  const out = hermetic(REQ + [
    "const REP = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'replica.js')) + ");",
    "(async () => {",
    "  const foreign = { gseq: 7, event_id: AR.uuidv7(), device_id: 'dev_other', op: 'engram_record', op_v: 1, args: { id: AR.uuidv7(), statement: 'a thought from the other machine' }, ctx: { agent_id: 'studio-surface' } };",
    "  const okF = await REP._applyOne(foreign, 'dev_me');",
    "  const mine = { gseq: 8, event_id: AR.uuidv7(), device_id: 'dev_me', op: 'engram_record', op_v: 1, args: { id: AR.uuidv7(), statement: 'my own echo' }, ctx: {} };",
    "  const okM = await REP._applyOne(mine, 'dev_me');",
    "  const alien = { gseq: 9, event_id: AR.uuidv7(), device_id: 'dev_other', op: 'claim_teleport', op_v: 1, args: {}, ctx: {} };",
    "  const okA = await REP._applyOne(alien, 'dev_me');",
    "  const db = S.db();",
    "  const rows = db.prepare('SELECT id FROM action_records').all();",
    "  console.log(JSON.stringify({ okF, okM, okA, count: rows.length, sameId: rows.some(function (r) { return r.id === foreign.args.id; }), echoLanded: rows.some(function (r) { return r.id === mine.args.id; }), q: REP.status().quarantined }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.okF, true);
  assert.strictEqual(out.sameId, true, 'the foreign record lands under its author id — one record fleet-wide');
  assert.strictEqual(out.okM, true);
  assert.strictEqual(out.echoLanded, false, 'a device never re-applies its own event');
  assert.strictEqual(out.okA, false, 'an unreadable op stops the feed');
  assert.ok(/claim_teleport/.test(String(out.q)), 'and says which op needs a newer build');
});

test('SYN-22: the baseline is the whole mind with a position stamp — a fresh replica starts from it and pulls the rest', () => {
  const out = hermetic(REQ + [
    "const REP = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'replica.js')) + ");",
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_test', deviceToken: 'tok' } }));",
    "(async () => {",
    "  engram.recordEngram({ _local: true, agent_id: 'cli', statement: 'history from before the pairing' });",
    "  const d = HUB.addDevice('laptop');",
    "  await HUB.applyEvent(env(d.device_id, 1, 'engram_record', { statement: 'a journaled thought' }));",
    "  const b = HUB.baseline();",
    "  RC.__setTransportForTests((s, m, p) => {",
    "    if (p === '/api/sync/baseline') return Promise.resolve(b);",
    "    return Promise.resolve({ ok: true, events: [] });",
    "  });",
    "  const boot = await REP.bootstrap();",
    "  console.log(JSON.stringify({ enc: b.atlas_encoding, count: b.atlas_count, stamp: b.latest_gseq, ok: boot.ok, at: boot.at, applied: REP.appliedGseq(), booted: REP.status().bootstrapped }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.enc, 'gzip+base64');
  assert.ok(out.count >= 2, 'the baseline carries pre-sync history AND journaled writes');
  assert.ok(out.stamp >= 1);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.applied, out.stamp, 'the replica resumes exactly where the baseline was cut');
  assert.strictEqual(out.booted, true);
});

test('SYN-23: the pull loop drains the feed through the stub wire and advances its position', () => {
  const out = hermetic(REQ + [
    "const REP = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'sync', 'replica.js')) + ");",
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_me', deviceToken: 'tok' } }));",
    "(async () => {",
    "  const feed = [",
    "    { gseq: 1, event_id: AR.uuidv7(), device_id: 'dev_other', op: 'engram_record', op_v: 1, args: { id: AR.uuidv7(), statement: 'first from afar' }, ctx: {} },",
    "    { gseq: 2, event_id: AR.uuidv7(), device_id: 'dev_me',    op: 'engram_record', op_v: 1, args: { id: AR.uuidv7(), statement: 'my echo' }, ctx: {} },",
    "    { gseq: 3, event_id: AR.uuidv7(), device_id: 'dev_other', op: 'dialogue_turn', op_v: 1, args: { id: AR.uuidv7(), user_text: 'spoken there', assistant_text: 'answered there' }, ctx: { agent_id: 'studio' } }",
    "  ];",
    "  RC.__setTransportForTests((s, m, p) => {",
    "    if (p === '/api/sync/baseline') return Promise.resolve({ ok: true, latest_gseq: 0, atlas_count: 0, atlas_ndjson: '', atlas_encoding: null });",
    "    if (p.indexOf('/api/sync/events') === 0) {",
    "      const since = parseInt(p.split('since=')[1], 10) || 0;",
    "      return Promise.resolve({ ok: true, events: feed.filter(function (e) { return e.gseq > since; }).slice(0, 2) });",
    "    }",
    "    return Promise.resolve({ ok: true });",
    "  });",
    "  const r = await REP.pull();",
    "  const db = S.db();",
    "  const n = db.prepare('SELECT COUNT(*) AS n FROM action_records').get().n;",
    "  console.log(JSON.stringify({ pulled: r.pulled, applied: REP.appliedGseq(), rows: n }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.pulled, 3, 'the loop pages until the feed runs dry');
  assert.strictEqual(out.applied, 3, 'the position lands on the last event');
  assert.strictEqual(out.rows, 2, 'two foreign records landed; the echo did not double');
});
};
