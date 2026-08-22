// SPDX-License-Identifier: AGPL-3.0-only
// A fact the substrate can check, not just recall.
//
// The failure mode is not forgetting — it is remembering WRONG and bridging the
// gap with a story when the world disagrees (premise resistance; frontier
// models measure 55% on STALE). What this suite pins
// is the geometry that makes that impossible for claimed facts: one live
// value per slot BY INDEX, supersession as an explicit transaction with an
// event trail, a probe mismatch flipping the row to disputed and OUT of
// every serving path, an unreachable world never counting as contradiction,
// and resolution as the only road back.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nVerifiable claims (VCL):');

function hermetic(script) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vcl-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const r = cp.spawnSync('node', ['-e', script], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
    }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 300));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const REQ = "const C = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'claims.js')) + ");" +
            "const S = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");";

test('VCL-1: one live value per slot — supersession is a transaction, a second live row is impossible by index', () => {
  const out = hermetic(REQ + [
    "const a = C.assertClaim({ subject: 's', predicate: 'p', value: 'one' });",
    "const b = C.assertClaim({ subject: 's', predicate: 'p', value: 'two' });",
    "let raced = false;",
    "try { S._dbForQuery().prepare(\"INSERT INTO claims (id,subject,predicate,value,valid_from,status,volatility,source_rank,created_at) VALUES ('x','s','p','three',1,'live','slow',2,1)\").run(); raced = true; } catch (_) {}",
    "const live = C.liveClaims({ subject: 's' });",
    "const events = S._dbForQuery().prepare('SELECT kind FROM claim_events ORDER BY ts').all().map(e => e.kind);",
    "console.log(JSON.stringify({ aAct: a.action, bAct: b.action, sup: b.superseded === a.id, raced, liveCount: live.length, liveVal: live[0] && live[0].value, events }));"
  ].join('\n'));
  assert.strictEqual(out.aAct, 'asserted');
  assert.strictEqual(out.bAct, 'superseded');
  assert.strictEqual(out.sup, true, 'the new row names what it replaced');
  assert.strictEqual(out.raced, false, 'a raw second live INSERT hits the unique index and dies');
  assert.strictEqual(out.liveCount, 1, 'exactly one live value per slot');
  assert.strictEqual(out.liveVal, 'two');
  assert.ok(out.events.includes('superseded') && out.events.includes('asserted'), 'the trail reads like history');
});

test('VCL-2: a probe mismatch is a contradiction event — disputed, excluded, and only resolution brings it back', () => {
  const out = hermetic(REQ + [
    "const missing = require('path').join(process.env.HOME, 'not-there.txt');",
    "C.assertClaim({ subject: 'f', predicate: 'exists', value: 'yes', volatility: 'fast', probe: { kind: 'file_exists', path: missing, expect: true } });",
    "S._dbForQuery().prepare('UPDATE claims SET verified_at=0').run();",
    "C.verifyDue((res) => {",
    "  const excluded = C.liveClaims({}).length === 0 && C.disputedClaims().length === 1;",
    "  const r = C.resolveDispute(C.disputedClaims()[0].id, { action: 'supersede', value: 'no', reason: 'the probe observed absence' });",
    "  const after = C.liveClaims({});",
    "  console.log(JSON.stringify({ disputes: res.disputes.length, excluded, resolved: r.ok, liveVal: after[0] && after[0].value, rank: after[0] && after[0].source_rank }));",
    "  process.exit(0);",
    "});"
  ].join('\n'));
  assert.strictEqual(out.disputes, 1, 'the mismatch surfaced as a dispute');
  assert.strictEqual(out.excluded, true, 'a disputed row serves nothing — fail-closed');
  assert.strictEqual(out.resolved, true);
  assert.strictEqual(out.liveVal, 'no', 'resolution wrote what the world showed');
  assert.strictEqual(out.rank, 0, 'observation outranks the claim it replaced');
});

test('VCL-3: an unreachable world never disputes — absence of evidence is not contradiction', () => {
  const out = hermetic(REQ + [
    "C.assertClaim({ subject: 'svc', predicate: 'up', value: 'yes', volatility: 'fast', probe: { kind: 'http_status', url: 'http://127.0.0.1:1/none', expect_status: 200 } });",
    "S._dbForQuery().prepare('UPDATE claims SET verified_at=0').run();",
    "C.verifyDue((res) => { console.log(JSON.stringify({ disputes: res.disputes.length, stillLive: C.liveClaims({}).length })); process.exit(0); });"
  ].join('\n'));
  assert.strictEqual(out.disputes, 0, 'no reachability, no verdict');
  assert.strictEqual(out.stillLive, 1, 'the claim stands until the world actually answers');
});

test('VCL-4: a wrong instrument is corrected in place — same value plus a new probe returns a disputed row to live', () => {
  const out = hermetic(REQ + [
    "const p = require('path').join(process.env.HOME, 'real.txt');",
    "require('fs').writeFileSync(p, 'x');",
    "C.assertClaim({ subject: 'f2', predicate: 'exists', value: 'yes', volatility: 'fast', probe: { kind: 'file_exists', path: p + '.wrong', expect: true } });",
    "S._dbForQuery().prepare('UPDATE claims SET verified_at=0').run();",
    "C.verifyDue(() => {",
    "  const wasDisputed = C.disputedClaims().length === 1;",
    "  const r = C.assertClaim({ subject: 'f2', predicate: 'exists', value: 'yes', probe: { kind: 'file_exists', path: p, expect: true } });",
    "  console.log(JSON.stringify({ wasDisputed, action: r.action, liveAgain: C.liveClaims({}).length === 1 }));",
    "  process.exit(0);",
    "});"
  ].join('\n'));
  assert.strictEqual(out.wasDisputed, true);
  assert.strictEqual(out.action, 'probe_corrected', 'the fact stood; the check was wrong — first field case, 2026-08-15');
  assert.strictEqual(out.liveAgain, true);
});

test('VCL-5: disputes reach the operator at session start, and the sweep runs detached (source pins)', () => {
  const ss = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'session-start.mjs'), 'utf8');
  assert.ok(/DISPUTED-CLAIMS/.test(ss), 'standing disagreements are said out loud');
  assert.ok(/bridge the gap with a story/.test(ss), 'and the failure mode is named at the moment it tempts');
  assert.ok(/detached: true/.test(ss), 'the probe sweep never makes the hook wait');
  const st = fs.readFileSync(path.join(ROOT, 'shared-core', 'state.js'), 'utf8');
  assert.ok(/claims_live_slot/.test(st), 'the unique slot index is schema, not convention');
});
};
