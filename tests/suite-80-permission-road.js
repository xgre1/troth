// SPDX-License-Identifier: AGPL-3.0-only
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A wall that stops a command asks for the operator's OK and never hands
// them the command: the refusal names the key, the OK comes back in
// `permission`, once runs one call, always is kept and a fresh server runs
// without asking. A read of the machine on walled ground runs outside the
// wall with that OK. Secrets keep no permission road.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');

console.log('\nPermission road (PR-1..5):');

function makeHome() {
  const home  = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pr-')));
  const troth = path.join(home, '.troth');
  fs.mkdirSync(troth, { recursive: true });
  const mine = path.join(home, 'code', 'mine');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(troth, 'opened-folders.json'), JSON.stringify({ folders: [{ path: mine }] }, null, 2));
  return { home, troth, mine };
}

function client(home, troth, startCwd) {
  const env = Object.assign({}, process.env, { HOME: home, TROTH_CONFIG_DIR: troth, TROTH_BASH_CWD: startCwd || home });
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = ''; const pending = new Map(); let id = 1;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m && m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  proc.stderr.on('data', () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const myId = id++;
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 60000);
    pending.set(myId, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const run = async (command, cwd, extra) => {
    const m = await rpc('tools/call', { name: 'run', arguments: Object.assign({ command, cwd }, extra || {}) });
    const c = m.result && m.result.content;
    if (!Array.isArray(c)) return { text: JSON.stringify(m.error || m.result), exit: null, error: true };
    const p = c.find((b) => b && b.text && !/^\[troth\] Substrate active/.test(b.text));
    const text = (p && p.text) || '';
    const hit = text.match(/exit: (-?\d+)/);
    return { text, exit: hit ? Number(hit[1]) : null, error: !!(m.result && m.result.isError) };
  };
  const init = () => rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return { run, init, kill: () => { try { proc.kill('SIGKILL'); } catch (_) {} } };
}

const live = sb.isAvailable().available;

test('PR-1: a destructive shape asks for the OK and names the key; a one-time OK runs it', async () => {
  const m = makeHome();
  const c = client(m.home, m.troth);
  const victim = path.join(m.mine, 'build');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'a.txt'), 'x');
  try {
    await c.init();
    const asked = await c.run('rm -rf ' + JSON.stringify(victim), m.mine);
    assert.ok(asked.error, 'the command ran without the OK');
    assert.ok(/needs the operator's OK \(danger:rm_rf\)/.test(asked.text), 'the refusal did not name the key: ' + asked.text.slice(0, 200));
    assert.ok(!/re-call with acknowledge_danger/.test(asked.text), 'the old wording came back');
    assert.ok(fs.existsSync(victim), 'the refusal must not run anything');
    const ran = await c.run('rm -rf ' + JSON.stringify(victim), m.mine, { permission: { words: 'yes, delete it', scope: 'once' } });
    assert.strictEqual(ran.exit, 0, 'the OK did not run the command: ' + ran.text.slice(0, 200));
    assert.ok(/permission danger:rm_rf \(once\)/.test(ran.text), 'the use of the OK was not noted: ' + ran.text.slice(0, 200));
    assert.strictEqual(fs.existsSync(victim), false);
    assert.strictEqual(fs.existsSync(path.join(m.troth, 'permissions.json')), false, 'once must not be kept');
  } finally { c.kill(); }
});

test('PR-2: an OK for always is kept, and a fresh server runs the same shape without asking', async () => {
  const m = makeHome();
  const c = client(m.home, m.troth);
  const v1 = path.join(m.mine, 'b1'); const v2 = path.join(m.mine, 'b2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  try {
    await c.init();
    const ran = await c.run('rm -rf ' + JSON.stringify(v1), m.mine, { permission: { words: 'always for build folders', scope: 'always' } });
    assert.strictEqual(ran.exit, 0, ran.text.slice(0, 200));
    const kept = JSON.parse(fs.readFileSync(path.join(m.troth, 'permissions.json'), 'utf8')).permissions;
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].key, 'danger:rm_rf');
    assert.strictEqual(kept[0].words, 'always for build folders');
  } finally { c.kill(); }
  const c2 = client(m.home, m.troth);
  try {
    await c2.init();
    const again = await c2.run('rm -rf ' + JSON.stringify(v2), m.mine);
    assert.strictEqual(again.exit, 0, 'the standing OK was not honoured: ' + again.text.slice(0, 200));
    assert.ok(/permission danger:rm_rf \(always\)/.test(again.text), again.text.slice(0, 200));
    assert.strictEqual(fs.existsSync(v2), false);
  } finally { c2.kill(); }
});

test('PR-3: the bare acknowledge still reads as a one-time OK', async () => {
  const m = makeHome();
  const c = client(m.home, m.troth);
  const v = path.join(m.mine, 'b3'); fs.mkdirSync(v);
  try {
    await c.init();
    const ran = await c.run('rm -rf ' + JSON.stringify(v), m.mine, { acknowledge_danger: true });
    assert.strictEqual(ran.exit, 0, ran.text.slice(0, 200));
    assert.strictEqual(fs.existsSync(v), false);
  } finally { c.kill(); }
});

test('PR-4: a read of the machine on walled ground asks for its road, and with the OK runs outside the wall', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  // The operator chose the confined ground for the partner's own work; an
  // undeclared folder stands behind the wall, the opened one does not.
  fs.writeFileSync(path.join(m.troth, 'config.json'), JSON.stringify({ l4: { sandbox: { partner_ground: 'confine' } } }, null, 2));
  const walled = path.join(m.home, 'work');
  fs.mkdirSync(walled, { recursive: true });
  const c = client(m.home, m.troth);
  try {
    await c.init();
    const asked = await c.run('ps -Ao pid,comm | head -3', walled);
    assert.ok(asked.error, 'ps ran on walled ground without the OK: ' + asked.text.slice(0, 200));
    assert.ok(/needs the operator's OK \(ground:process-inspect\)/.test(asked.text), asked.text.slice(0, 200));
    const ran = await c.run('ps -Ao pid,comm | head -3', walled, { permission: { words: 'ok, look at the processes', scope: 'session' } });
    assert.strictEqual(ran.exit, 0, 'the OK did not run the read outside the wall: ' + ran.text.slice(0, 300));
    assert.ok(/PID/.test(ran.text), 'no process listing came back: ' + ran.text.slice(0, 200));
    assert.ok(/outside the ground wall with the operator's permission \(process-inspect\)/.test(ran.text), ran.text.slice(0, 300));
    // The session OK holds for the next call in this process.
    const next = await c.run('ps -Ao pid,comm | head -2', walled);
    assert.strictEqual(next.exit, 0, 'the session OK was not honoured: ' + next.text.slice(0, 200));
    // Opened ground never asks: it is the operator's own machine.
    const own = await c.run('ps -Ao pid,comm | head -2', m.mine);
    assert.strictEqual(own.exit, 0, own.text.slice(0, 200));
    assert.ok(!/needs the operator's OK/.test(own.text));
  } finally { c.kill(); }
});

test('PR-5: a secret keeps no permission road', async () => {
  const m = makeHome();
  const c = client(m.home, m.troth);
  const key = path.join(m.home, '.ssh', 'id_ed25519');
  fs.mkdirSync(path.dirname(key), { recursive: true });
  fs.writeFileSync(key, 'PRIVATE');
  try {
    await c.init();
    const r = await c.run('cat ' + JSON.stringify(key), m.mine, { permission: { words: 'ok', scope: 'always' } });
    assert.ok(r.error || r.exit !== 0, 'a private key was read: ' + r.text.slice(0, 200));
    assert.ok(!/PRIVATE/.test(r.text), 'the key text came back');
    assert.ok(!/needs the operator's OK/.test(r.text), 'a secret must not offer a permission road: ' + r.text.slice(0, 200));
  } finally { c.kill(); }
});
};
