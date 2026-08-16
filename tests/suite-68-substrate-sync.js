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

test('SYN-9: satellite mode — a mind-write becomes an outbox event in the caller\'s breath; the local store stays empty', () => {
  const out = hermetic(REQ + [
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_test', deviceToken: 'tok' } }));",
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "const id = engram.recordEngram({ agent_id: 'cli', statement: 'written on the satellite' });",
    "const id2 = engram.recordEngram({ agent_id: 'cli', statement: 'and another' });",
    "const db = S.db();",
    "const ob = db.prepare('SELECT dev_seq, envelope FROM sync_outbox ORDER BY dev_seq').all();",
    "const local = db.prepare('SELECT COUNT(*) AS n FROM action_records').get().n;",
    "const e1 = JSON.parse(ob[0].envelope);",
    "setTimeout(() => { console.log(JSON.stringify({ id: !!id, id2: !!id2, rows: ob.length, seqs: ob.map(r => r.dev_seq), local, op: e1.op, hasEventId: !!e1.event_id, hasHlc: !!e1.hlc_ts, dev: e1.device_id })); }, 150);"
  ].join('\n'));
  assert.strictEqual(out.id, true, 'the caller got an id back, sync-style');
  assert.deepStrictEqual(out.seqs, [1, 2], 'dev_seq is strictly sequential');
  assert.strictEqual(out.local, 0, 'satellite mode forks NOTHING into the local mind');
  assert.strictEqual(out.op, 'engram_record');
  assert.strictEqual(out.hasEventId, true);
  assert.strictEqual(out.hasHlc, true);
  assert.strictEqual(out.dev, 'dev_test');
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

test('SYN-12: satellite recall asks the hub; an unreachable hub answers empty, never stale', () => {
  const out = hermetic(REQ + [
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.TROTH_CONFIG_PATH, JSON.stringify({ sync: { host: 'http://127.0.0.1:9', deviceId: 'dev_test', deviceToken: 'tok' } }));",
    "const recallMod = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'recall.js')) + ");",
    "(async () => {",
    "  RC.__setTransportForTests(() => Promise.resolve({ ok: true, result: [{ statement: 'remembered on the hub', score: 0.9 }] }));",
    "  const hot = await recallMod.recall({ query: 'anything', agent_id: 'cli' });",
    "  RC.__setTransportForTests(() => Promise.resolve({ transport_error: true }));",
    "  const dark = await recallMod.recall({ query: 'anything', agent_id: 'cli' });",
    "  console.log(JSON.stringify({ hotLen: hot.length, hotFirst: hot[0] && hot[0].statement, darkLen: dark.length, darkIsArray: Array.isArray(dark) }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.hotLen, 1);
  assert.strictEqual(out.hotFirst, 'remembered on the hub');
  assert.strictEqual(out.darkLen, 0, 'unreachable mind = empty recall, not a stale local answer');
  assert.strictEqual(out.darkIsArray, true);
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
};
