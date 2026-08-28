// SPDX-License-Identifier: AGPL-3.0-only
// The ground decision reaches the tool an operator actually drives.
//
// The classifier and the profiles are each pinned by their own suite. What
// these tests pin is the wiring: that the shell tool asks which ground a
// command stands on, applies the matching wall, and says so where silence
// would be misleading. Every case runs a real server child against a
// throwaway substrate directory, so nothing here touches the operator's own.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');

console.log('\nGround wiring (GW-1..7):');

// A throwaway machine: substrate directory, partner project ground with two
// projects, one folder the operator opened and one nobody declared.
function makeHome() {
  const home  = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gw-')));
  const troth = path.join(home, '.troth');
  const ws    = path.join(troth, 'workspace');
  fs.mkdirSync(path.join(ws, 'projA'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'projB'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'projA', 'staged.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(ws, 'projB', 'sibling.txt'), 'b-only\n');
  const opened   = path.join(home, 'code', 'mine');
  const stranger = path.join(home, 'code', 'stranger');
  fs.mkdirSync(opened, { recursive: true });
  fs.mkdirSync(stranger, { recursive: true });
  fs.writeFileSync(path.join(troth, 'opened-folders.json'),
                   JSON.stringify({ folders: [{ path: opened }] }, null, 2));
  return { home, troth, ws, opened, stranger };
}

function client(home, troth, startCwd) {
  const env = Object.assign({}, process.env, {
    HOME: home, TROTH_CONFIG_DIR: troth, TROTH_BASH_CWD: startCwd || home
  });
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
  const run = async (command, cwd) => {
    const m = await rpc('tools/call', { name: 'run', arguments: { command, cwd } });
    const c = m.result && m.result.content;
    if (!Array.isArray(c)) return { text: JSON.stringify(m.error || m.result), exit: null };
    const p = c.find((b) => b && b.text && !/^\[troth\] Substrate active/.test(b.text));
    const text = (p && p.text) || '';
    const hit = text.match(/exit: (-?\d+)/);
    return { text, exit: hit ? Number(hit[1]) : null, note: (text.match(/\[troth-bash\][^\n]*/g) || []).join(' ') };
  };
  const init = () => rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return { run, init, kill: () => { try { proc.kill('SIGKILL'); } catch (_) {} } };
}

const live = sb.isAvailable().available;

test('GW-1: a folder the operator opened works as their own machine, and says nothing about it', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  try {
    await c.init();
    const wrote = await c.run('echo x > ok.txt && echo done', m.opened);
    assert.strictEqual(wrote.exit, 0, 'ordinary work must run: ' + wrote.text.slice(0, 200));
    assert.strictEqual(fs.existsSync(path.join(m.opened, 'ok.txt')), true, 'the write must land');
    assert.strictEqual(wrote.note, '',
      'opened ground must stay silent, or every command grows a line nobody reads');
  } finally { c.kill(); }
});

test('GW-2: opened ground cannot read partner project ground, so the interpreter road is closed too', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  const staged = path.join(m.ws, 'projA', 'staged.js');
  try {
    await c.init();
    const read = await c.run('cat ' + JSON.stringify(staged), m.opened);
    assert.notStrictEqual(read.exit, 0, 'partner ground was readable from operator ground');
    const ran = await c.run('node ' + JSON.stringify(staged), m.opened);
    assert.notStrictEqual(ran.exit, 0, 'partner ground ran through an interpreter');
    const copied = await c.run('cp ' + JSON.stringify(staged) + ' ' + JSON.stringify(path.join(m.opened, 'lifted.js')), m.opened);
    assert.notStrictEqual(copied.exit, 0, 'partner ground was copied out without review');
    assert.strictEqual(fs.existsSync(path.join(m.opened, 'lifted.js')), false);
  } finally { c.kill(); }
});

test('GW-3: undeclared ground scopes writes to the folder, keeps reads open, and says so once', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  try {
    await c.init();
    const inside = await c.run('echo x > inside.txt && echo done', m.stranger);
    assert.strictEqual(inside.exit, 0, 'work inside the folder must run: ' + inside.text.slice(0, 200));
    assert.ok(/writes are scoped/.test(inside.note), 'the wall must announce itself once: ' + inside.note);

    const escaped = path.join(m.home, 'escaped.txt');
    const out = await c.run('echo x > ' + JSON.stringify(escaped), m.stranger);
    assert.notStrictEqual(out.exit, 0, 'a write escaped the folder');
    assert.strictEqual(fs.existsSync(escaped), false, 'and it must not have landed');

    const readOut = await c.run('ls ' + JSON.stringify(m.home) + ' >/dev/null && echo done', m.stranger);
    assert.strictEqual(readOut.exit, 0, 'reads must stay open or exploring breaks');

    const again = await c.run('echo again', m.stranger);
    assert.strictEqual(again.note, '', 'the note repeated: ' + again.note);
  } finally { c.kill(); }
});

test('GW-4: the directory tree holding the substrate takes no writes', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  try {
    await c.init();
    const r = await c.run('echo x > landed.txt', m.troth);
    assert.notStrictEqual(r.exit, 0, 'a write landed in the substrate directory');
    assert.strictEqual(fs.existsSync(path.join(m.troth, 'landed.txt')), false);
    assert.ok(/holds the substrate/.test(r.note), 'the refusal must explain itself: ' + r.note);
  } finally { c.kill(); }
});

test('GW-5: partner project ground still jails exactly as it did', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  const projA = path.join(m.ws, 'projA');
  try {
    await c.init();
    const own = await c.run('echo x > mine.txt && echo done', projA);
    assert.strictEqual(own.exit, 0, 'work in its own project must run: ' + own.text.slice(0, 200));
    assert.ok(/workspace jail/.test(own.note), 'the jail note must still print: ' + own.note);
    const sibling = await c.run('cat ' + JSON.stringify(path.join(m.ws, 'projB', 'sibling.txt')), projA);
    assert.notStrictEqual(sibling.exit, 0, 'a sibling project was readable');
    assert.ok(!/b-only/.test(sibling.text), 'sibling contents leaked');
  } finally { c.kill(); }
});

test('GW-6: a path that names one ground and lands in another is refused, never run bare', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  fs.symlinkSync(path.join(m.home, 'code'), path.join(m.ws, 'sneaky'));
  const c = client(m.home, m.troth);
  try {
    await c.init();
    const r = await c.run('echo hi', path.join(m.ws, 'sneaky'));
    assert.strictEqual(r.exit, 126, 'the escape ran instead of being refused: ' + r.text.slice(0, 200));
    assert.ok(/REFUSED/.test(r.text), r.text.slice(0, 200));
  } finally { c.kill(); }
});

test('GW-7: the directory a session starts in is opened ground, and nothing is written to say so', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const started = path.join(m.home, 'code', 'launched');
  fs.mkdirSync(started, { recursive: true });
  const registry = path.join(m.troth, 'opened-folders.json');
  const before = fs.readFileSync(registry, 'utf8');
  const c = client(m.home, m.troth, started);
  try {
    await c.init();
    // Opened rather than confined: a write outside the folder is what tells
    // the two apart, since confinement is exactly what would refuse it.
    const out = await c.run('echo x > ' + JSON.stringify(path.join(m.home, 'sibling.txt')) + ' && echo done', started);
    assert.strictEqual(out.exit, 0, 'the starting directory was confined rather than opened');
    // Opened, not unwalled: partner ground stays unreadable.
    const read = await c.run('cat ' + JSON.stringify(path.join(m.ws, 'projA', 'staged.js')), started);
    assert.notStrictEqual(read.exit, 0, 'the starting directory ran with no wall at all');
    assert.strictEqual(fs.readFileSync(registry, 'utf8'), before,
      'a session grant was persisted to the operator registry');
  } finally { c.kill(); }
});
};
