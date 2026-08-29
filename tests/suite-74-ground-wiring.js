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
const { spawn, spawnSync } = require('child_process');

const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');

console.log('\nGround wiring (GW-1..10):');

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

test('GW-3: undeclared ground scopes writes to the project, keeps reads open, and stays quiet until a write is actually refused', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  try {
    await c.init();
    const inside = await c.run('echo x > inside.txt && echo done', m.stranger);
    assert.strictEqual(inside.exit, 0, 'work inside the folder must run: ' + inside.text.slice(0, 200));
    // Nothing is said while nothing has gone wrong. A warning on every result
    // is one the reader learns to skip, and it arrives with nothing to act on.
    assert.strictEqual(inside.note, '', 'a wall announced itself before it did anything: ' + inside.note);

    const escaped = path.join(m.home, 'escaped.txt');
    const out = await c.run('echo x > ' + JSON.stringify(escaped), m.stranger);
    assert.notStrictEqual(out.exit, 0, 'a write escaped the folder');
    assert.strictEqual(fs.existsSync(escaped), false, 'and it must not have landed');
    // Here it is worth saying, because it is the answer to the error above.
    assert.ok(/writes here are scoped/.test(out.note),
      'the refusal was left looking like an unexplained permission error: ' + out.note);
    assert.ok(/troth open/.test(out.note), 'the refusal does not name the way through: ' + out.note);

    const readOut = await c.run('ls ' + JSON.stringify(m.home) + ' >/dev/null && echo done', m.stranger);
    assert.strictEqual(readOut.exit, 0, 'reads must stay open or exploring breaks');

    const again = await c.run('echo again', m.stranger);
    assert.strictEqual(again.note, '', 'a later ordinary command carried a note: ' + again.note);
  } finally { c.kill(); }
});

test('GW-8: confinement follows the project, not the current directory', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  // A repository is navigated. A wall that moves with every cd refuses a test
  // written from the source directory and staging from anywhere but the top,
  // which is the ordinary shape of working in a project rather than the
  // accident this layer exists to catch.
  const m = makeHome();
  const repo = path.join(m.home, 'code', 'navrepo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  const c = client(m.home, m.troth);
  try {
    await c.init();
    assert.strictEqual((await c.run('git init -q .', repo)).exit, 0, 'creating the repository failed');
    const src = path.join(repo, 'src');
    assert.strictEqual((await c.run('echo x > a.js', src)).exit, 0, 'writing in the current directory failed');
    assert.strictEqual((await c.run('echo x > ../tests/a.test.js', src)).exit, 0,
      'a sibling directory of the same project was refused');
    assert.strictEqual((await c.run('echo {} > ../package.json', src)).exit, 0,
      'the project manifest was refused from a subdirectory');
    assert.strictEqual((await c.run('git add -A', src)).exit, 0,
      'staging from a subdirectory was refused');
    // The backstop still holds at the project boundary.
    const outside = path.join(m.home, 'code', 'not-mine.txt');
    assert.notStrictEqual((await c.run('echo x > ' + JSON.stringify(outside), src)).exit, 0,
      'a write left the project');
    assert.strictEqual(fs.existsSync(outside), false);
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

test('GW-9: the shapes a real checkout actually takes still work end to end', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  // Every case here was found by running real work rather than by reading the
  // design: a monorepo, a linked working tree, a repository inside a
  // repository. Each one refused something ordinary before it was pinned.
  const m = makeHome();
  const c = client(m.home, m.troth);
  const code = path.join(m.home, 'code');
  try {
    await c.init();

    const mono = path.join(code, 'mono');
    fs.mkdirSync(path.join(mono, 'packages', 'a', 'src'), { recursive: true });
    fs.mkdirSync(path.join(mono, 'packages', 'b'), { recursive: true });
    fs.writeFileSync(path.join(mono, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(mono, 'packages', 'a', 'package.json'), '{}\n');
    assert.strictEqual((await c.run('git init -q .', mono)).exit, 0);
    const deep = path.join(mono, 'packages', 'a', 'src');
    assert.strictEqual((await c.run('echo x > ../../b/f.txt', deep)).exit, 0,
      'a sibling package was refused');
    assert.strictEqual((await c.run('echo {} > ../../../package.json', deep)).exit, 0,
      'the top-level manifest was refused');
    assert.strictEqual((await c.run('git add -A', deep)).exit, 0,
      'staging from deep inside the repository was refused');

    const main = path.join(code, 'wtmain');
    fs.mkdirSync(main, { recursive: true });
    assert.strictEqual((await c.run('git init -q .', main)).exit, 0);
    assert.strictEqual((await c.run(
      'echo x > a.txt && git add -A && git -c user.email=a@b -c user.name=n commit -qm init', main)).exit, 0);
    // The tree is created OUTSIDE the walls, the way the operator creates one
    // in their own shell. Creating it through the walls writes a sibling
    // directory and is refused, which silently skipped every assertion below
    // it and left this whole road untested.
    const tree = path.join(code, 'wtside');
    const added = spawnSync('git', ['worktree', 'add', '-q', '-b', 'side', tree],
                            { cwd: main, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(added.status, 0, 'could not create a linked working tree: ' + added.stderr);
    assert.strictEqual(fs.statSync(path.join(tree, '.git')).isFile(), true,
      'this case only means anything while a linked tree keeps its repository elsewhere');
    assert.strictEqual((await c.run('git status --porcelain >/dev/null', tree)).exit, 0);
    assert.strictEqual((await c.run(
      'echo y > b.txt && git add -A && git -c user.email=a@b -c user.name=n commit -qm w', tree)).exit, 0,
      'committing from a linked working tree was refused');

    const sup = path.join(code, 'super');
    const inner = path.join(sup, 'vendor', 'lib');
    fs.mkdirSync(inner, { recursive: true });
    assert.strictEqual((await c.run('git init -q .', sup)).exit, 0);
    assert.strictEqual((await c.run('git init -q .', inner)).exit, 0);
    // The scope is the nearest repository, so a vendored tree does not reach
    // the project it sits in. That is the price of not letting one stray
    // repository high in a tree join unrelated checkouts together.
    assert.notStrictEqual((await c.run('echo x > ../../top.txt', inner)).exit, 0,
      'a vendored tree reached the project above it');
    assert.strictEqual((await c.run('echo x > own.txt', inner)).exit, 0,
      'work inside the vendored tree was refused');
  } finally { c.kill(); }
});

test('GW-10: a refusal caused by a machine-executed file explains that ground is not the reason', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  try {
    await c.init();
    // The interpreter road: the plain shell spelling is already refused by
    // the text road with its own explanation, so the kernel — and this note
    // — is what a filesystem call carried inside an interpreter argument
    // meets. On opened ground the wall is thin, and `troth open` would not
    // lift this refusal.
    const gitcfg = path.join(m.home, '.gitconfig');
    const viaNode = 'node -e ' + JSON.stringify(
      'require("fs").appendFileSync(' + JSON.stringify(gitcfg) + ', "x")');
    const out = await c.run(viaNode, m.opened);
    assert.notStrictEqual(out.exit, 0, 'a machine-executed file was writable from opened ground');
    assert.ok(out.note.includes(gitcfg), 'the refusal does not name the file: ' + out.note);
    assert.ok(!/troth open/.test(out.note), 'the note promises a lift that never comes: ' + out.note);
    // From undeclared ground the same cause gets the same explanation, not
    // the scope note whose remedy would change nothing.
    const out2 = await c.run(viaNode, m.stranger);
    assert.notStrictEqual(out2.exit, 0);
    assert.ok(out2.note.includes(gitcfg) && !/troth open/.test(out2.note),
      'undeclared ground blamed the scope for a wall that holds everywhere: ' + out2.note);
  } finally { c.kill(); }
});
};
