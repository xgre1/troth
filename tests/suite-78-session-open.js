// SPDX-License-Identifier: AGPL-3.0-only
// The session-open road: the partner opens a folder of the operator's own
// work for one session — a stated purpose on record, a photograph before the
// grant applies, nothing persisted. Two grounds never open, by anyone's hand:
// partner project ground and the tree holding the substrate. The pins below
// hold both the grant's own guards and the classifier's treatment of a
// forged grant, because the two are separate walls and each must hold alone.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

console.log('\nSession-open road (SOPEN-1..11):');

const grants = require('../shared-core/tools/session-grants.js');
const gp = require('../shared-core/tools/ground-policy.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

// Each test pins its own throwaway substrate home, so live machine state
// never decides a verdict, and resets the grant table on the way out.
function withTroth(fn) {
  const prev = process.env.TROTH_CONFIG_DIR;
  const troth = tmpdir('sopen-troth-');
  process.env.TROTH_CONFIG_DIR = troth;
  try { return fn(troth); }
  finally {
    if (prev === undefined) delete process.env.TROTH_CONFIG_DIR;
    else process.env.TROTH_CONFIG_DIR = prev;
    grants._reset();
  }
}

test('SOPEN-1: a granted folder classifies opened, via session-open, subtree included', () => {
  withTroth(() => {
    const dir = tmpdir('sopen-work-');
    fs.mkdirSync(path.join(dir, 'sub'));
    const r = grants.grant(dir, 'run the build for the operator');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.root, dir);
    const c = gp.classifyGround(dir, { sessionOpens: grants.list() });
    assert.strictEqual(c.ground, 'opened');
    assert.strictEqual(c.via, 'session-open');
    const c2 = gp.classifyGround(path.join(dir, 'sub'), { sessionOpens: grants.list() });
    assert.strictEqual(c2.ground, 'opened');
    assert.strictEqual(c2.root, dir);
  });
});

test('SOPEN-2: without the grant the same folder stays unopened', () => {
  withTroth(() => {
    const dir = tmpdir('sopen-cold-');
    const c = gp.classifyGround(dir, { sessionOpens: [] });
    assert.strictEqual(c.ground, 'unopened');
  });
});

test('SOPEN-3: partner project ground never opens — grant refused, forged entry ignored', () => {
  withTroth((troth) => {
    const proj = path.join(troth, 'workspace', 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const r = grants.grant(proj, 'try to open foreign code');
    assert.strictEqual(r.ok, false);
    assert.ok(/partner project ground/.test(r.error), r.error);
    // The classifier answers before any open is consulted, so even a forged
    // sessionOpens entry cannot hand the workspace the operator's walls.
    const c = gp.classifyGround(proj, { sessionOpens: [proj] });
    assert.strictEqual(c.ground, 'project');
  });
});

test('SOPEN-4: the substrate tree and its ancestors never open — and a forged ancestor entry is ignored', () => {
  withTroth((troth) => {
    assert.strictEqual(grants.grant(troth, 'open the substrate').ok, false);
    const parent = path.dirname(troth);
    const r = grants.grant(parent, 'open an ancestor of the substrate');
    assert.strictEqual(r.ok, false);
    assert.ok(/substrate/.test(r.error), r.error);
    // A forged entry naming that ancestor is skipped by the classifier's own
    // guard: ordinary ground under it stays unopened.
    const inner = tmpdir('sopen-inner-');
    const c = gp.classifyGround(inner, { sessionOpens: [parent] });
    assert.strictEqual(c.ground, 'unopened');
  });
});

test('SOPEN-5: a purpose is required, collapsed to one line, and capped', () => {
  withTroth(() => {
    const dir = tmpdir('sopen-why-');
    assert.strictEqual(grants.grant(dir, '').ok, false);
    assert.strictEqual(grants.grant(dir, '   \n\t ').ok, false);
    assert.strictEqual(grants.grant(dir).ok, false);
    const r = grants.grant(dir, 'line one\nline two\t\tspaced');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.purpose, 'line one line two spaced');
    grants._reset();
    const long = grants.grant(dir, 'x'.repeat(5000));
    assert.strictEqual(long.ok, true);
    assert.strictEqual(long.purpose.length, grants.PURPOSE_MAX);
  });
});

test('SOPEN-6: nothing persists — the registry file is never written, the grant dies with the table', () => {
  withTroth((troth) => {
    const dir = tmpdir('sopen-mem-');
    assert.strictEqual(grants.grant(dir, 'prove nothing lands on disk').ok, true);
    assert.strictEqual(fs.existsSync(gp.registryPath()), false,
      'a session grant must never create the operator registry');
    assert.deepStrictEqual(gp.openedFolders(), []);
    grants._reset();
    assert.strictEqual(gp.classifyGround(dir, { sessionOpens: grants.list() }).ground, 'unopened');
  });
});

test('SOPEN-7: a path that resolves into the workspace is refused by its real ground', () => {
  withTroth((troth) => {
    const proj = path.join(troth, 'workspace', 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const outside = tmpdir('sopen-link-');
    const link = path.join(outside, 'innocent');
    fs.symlinkSync(proj, link);
    const r = grants.grant(link, 'open a link that lands in the workspace');
    assert.strictEqual(r.ok, false);
    assert.ok(/partner project ground/.test(r.error), r.error);
  });
});

test('SOPEN-8: wrapFor carries the grant to the ground decision', async () => {
  const modPath = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'workspace-jail.mjs');
  const wj = await import(url.pathToFileURL(modPath).href);
  await withTroth(async () => {
    const dir = tmpdir('sopen-wrap-');
    const cold = wj.wrapFor(dir, { sessionOpens: [] });
    const coldGround = cold.ground;
    const warm = wj.wrapFor(dir, { sessionOpens: [dir] });
    // The spec side may be unavailable on this host (no seatbelt, or already
    // inside a sandbox); the GROUND answer must move regardless.
    assert.strictEqual(coldGround, 'unopened');
    assert.strictEqual(warm.ground, 'opened');
  });
});

test('SOPEN-9: the refusal texts name roads the partner can take', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs'), 'utf8');
  assert.ok(src.includes("name: 'open_ground'"), 'the session-open tool is declared');
  assert.ok(src.includes("name: 'net_allow'"), 'the per-project egress tool is declared');
  assert.ok(src.includes("call open_ground with ' + active.root"), 'the confine refusal names the ground it stands on');
  assert.ok(src.includes('call net_allow with the'), 'the install egress refusal names the per-project road');
  const safe = fs.readFileSync(path.join(__dirname, '..', 'shared-core', 'tools', 'bash-safety.js'), 'utf8');
  assert.ok(safe.includes('they add the host from their shell'), 'the outbound allowlist refusal is honest about its addressee');
});

test('SOPEN-10: a partner addition widens one project alone, never the every-project list', () => {
  withTroth(() => {
    const net = require('../shared-core/tools/net-allowlist.js');
    const proj = tmpdir('sopen-net-');
    const r = net.addHost('npm.example.com', proj);
    assert.strictEqual(r.ok, true);
    const all = net.listAll();
    assert.deepStrictEqual(all.all, [], 'the every-project list stays empty');
    assert.ok(all.projects[r.project] && all.projects[r.project].includes('npm.example.com'));
    assert.ok(net.allowFor(proj).includes('npm.example.com'));
    const other = tmpdir('sopen-net-other-');
    assert.ok(!net.allowFor(other).includes('npm.example.com'));
  });
});

test('SOPEN-11: a ~-relative spelling reaches the real judgment, not a parse dead end', () => {
  // The tool contract accepts ~-relative paths. Before the expansion landed,
  // '~' died as 'no such directory' — a wrong answer wearing a right shape.
  const r = grants.grant('~', 'live check that tilde expands');
  assert.strictEqual(r.ok, false);
  assert.ok(!/no such directory/.test(r.error), 'tilde must expand before resolving: ' + r.error);
  assert.ok(/substrate/.test(r.error), 'home holds the substrate tree, and the refusal says which wall spoke');
  const sub = grants.grant('~/this-folder-does-not-exist-sopen11', 'x');
  assert.strictEqual(sub.ok, false);
  assert.ok(sub.error.includes(os.homedir()), 'the refusal shows the expanded path: ' + sub.error);
});
};
