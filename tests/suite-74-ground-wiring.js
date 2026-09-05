// SPDX-License-Identifier: AGPL-3.0-only
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
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

test('GW-2: a command that names partner project ground runs inside that project\'s jail, from any ground', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  const staged = path.join(m.ws, 'projA', 'staged.js');
  const escaped = path.join(m.home, 'escaped-by-script.txt');
  // Code from the workspace that tries to reach the operator's home.
  fs.writeFileSync(staged, 'try { require("fs").writeFileSync(' + JSON.stringify(escaped) + ', "x") } catch (e) { console.log("kept in") }\nconsole.log(1)\n');
  try {
    await c.init();
    // Reading it from the operator's own ground works: the command runs
    // inside the project's jail, which reads its own project.
    const read = await c.run('cat ' + JSON.stringify(staged), m.opened);
    assert.strictEqual(read.exit, 0, 'partner ground was not readable through its jail: ' + read.text.slice(0, 200));
    assert.ok(/partner project ground named/.test(read.note), 'the jail did not announce itself: ' + read.note);
    // Running it never reaches the operator's environment: the script runs,
    // its write outside the project does not land.
    const ran = await c.run('node ' + JSON.stringify(staged), m.opened);
    assert.strictEqual(ran.exit, 0, 'the script did not run inside the jail: ' + ran.text.slice(0, 200));
    assert.strictEqual(fs.existsSync(escaped), false, 'workspace code wrote into the operator\'s home');
    // Copying it out is a write outside the project, and the jail refuses it.
    const copied = await c.run('cp ' + JSON.stringify(staged) + ' ' + JSON.stringify(path.join(m.opened, 'lifted.js')), m.opened);
    assert.notStrictEqual(copied.exit, 0, 'partner ground was copied out without review');
    assert.strictEqual(fs.existsSync(path.join(m.opened, 'lifted.js')), false);
  } finally { c.kill(); }
});

test('GW-3: undeclared ground is the operator\'s own machine by default, and the confined ground is a choice that scopes writes, keeps reads open and stays quiet until a write is refused', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  // The default: the partner's own work runs with the operator's
  // environment. Nothing is said, and a write into the operator's own tree
  // lands.
  {
    const m = makeHome();
    const c = client(m.home, m.troth);
    try {
      await c.init();
      const inside = await c.run('echo x > inside.txt && echo done', m.stranger);
      assert.strictEqual(inside.exit, 0, 'work inside the folder must run: ' + inside.text.slice(0, 200));
      assert.strictEqual(inside.note, '', 'a wall announced itself on open ground: ' + inside.note);
      const own = path.join(m.home, 'own.txt');
      const out = await c.run('echo x > ' + JSON.stringify(own), m.stranger);
      assert.strictEqual(out.exit, 0, 'a write into the operator\'s own tree was refused on open ground: ' + out.text.slice(0, 200));
      assert.strictEqual(fs.existsSync(own), true, 'and it must have landed');
      assert.strictEqual(out.note, '', 'open ground carried a note: ' + out.note);
    } finally { c.kill(); }
  }
  // The choice: l4.sandbox.partner_ground = confine puts the OS walls around
  // the working tree, exactly as before.
  {
    const m = makeHome();
    fs.writeFileSync(path.join(m.troth, 'config.json'), JSON.stringify({ l4: { sandbox: { partner_ground: 'confine' } } }));
    const c = client(m.home, m.troth);
    try {
      await c.init();
      const inside = await c.run('echo x > inside.txt && echo done', m.stranger);
      assert.strictEqual(inside.exit, 0, 'work inside the folder must run: ' + inside.text.slice(0, 200));
      assert.strictEqual(inside.note, '', 'a wall announced itself before it did anything: ' + inside.note);
      const escaped = path.join(m.home, 'escaped.txt');
      const out = await c.run('echo x > ' + JSON.stringify(escaped), m.stranger);
      assert.notStrictEqual(out.exit, 0, 'a write escaped the folder');
      assert.strictEqual(fs.existsSync(escaped), false, 'and it must not have landed');
      assert.ok(/writes here are scoped/.test(out.note),
        'the refusal was left looking like an unexplained permission error: ' + out.note);
      assert.ok(/troth open/.test(out.note), 'the refusal does not name the way through: ' + out.note);
      const readOut = await c.run('ls ' + JSON.stringify(m.home) + ' >/dev/null && echo done', m.stranger);
      assert.strictEqual(readOut.exit, 0, 'reads must stay open or exploring breaks');
      const again = await c.run('echo again', m.stranger);
      assert.strictEqual(again.note, '', 'a later ordinary command carried a note: ' + again.note);
    } finally { c.kill(); }
  }
});

test('GW-8: confinement follows the project, not the current directory', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  // A repository is navigated. A wall that moves with every cd refuses a test
  // written from the source directory and staging from anywhere but the top,
  // which is the ordinary shape of working in a project rather than the
  // accident this layer exists to catch.
  const m = makeHome();
  // Confinement is the operator's choice here; the default runs open.
  fs.writeFileSync(path.join(m.troth, 'config.json'), JSON.stringify({ l4: { sandbox: { partner_ground: 'confine' } } }));
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

test('GW-4: the files of the substrate tree that decide what runs next take no writes from a partner command', async () => {
  if (!live) return skip('sandbox-exec unavailable');
  const m = makeHome();
  const c = client(m.home, m.troth);
  try {
    await c.init();
    // The proxy's own command line, named by the working directory alone:
    // the tool road resolves a relative target against the directory the
    // command runs in. And the profiles every wall is built from, named
    // outright. Neither is written; the refusal names the file.
    const cases = [
      ['echo x > bin/troth', path.join(m.troth, 'bin', 'troth')],
      ['echo x > ' + JSON.stringify(path.join(m.troth, 'sandbox-profiles', 'x.sb')), path.join(m.troth, 'sandbox-profiles', 'x.sb')]
    ];
    for (const [cmd, file] of cases) {
      const r = await c.run(cmd, m.troth);
      assert.notStrictEqual(r.exit, 0, 'a write landed in the substrate tree: ' + cmd);
      assert.strictEqual(fs.existsSync(file), false, 'and it must not have landed: ' + file);
      assert.ok(/refused/.test(r.note) && r.note.includes(file), 'the refusal must name the file: ' + r.note);
    }
    // An ordinary file there changes nothing and is not refused; the
    // workspace under it is partner project ground and stays open.
    const plain = await c.run('echo x > landed.txt', m.troth);
    assert.strictEqual(plain.exit, 0, 'an ordinary file in the substrate tree was refused: ' + plain.note);
    const ok = await c.run('echo x > ' + JSON.stringify(path.join(m.ws, 'projA', 'note.txt')), m.opened);
    assert.strictEqual(ok.exit, 0, 'a write into a workspace project was refused: ' + ok.text.slice(0, 200) + ' ' + ok.note);
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
    // Opened, not unwalled: a command that names partner project ground runs
    // inside that project's jail, and says so.
    const read = await c.run('cat ' + JSON.stringify(path.join(m.ws, 'projA', 'staged.js')), started);
    assert.strictEqual(read.exit, 0, 'partner ground was not readable through its jail: ' + read.text.slice(0, 200));
    assert.ok(/partner project ground named/.test(read.note), 'the starting directory ran workspace code with no wall at all: ' + read.note);
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
    // The operator's own tree is open ground: a vendored repository inside a
    // project reaches the project above it, as the operator's own hands do.
    assert.strictEqual((await c.run('echo x > ../../top.txt', inner)).exit, 0,
      'a vendored tree was refused the project above it on open ground');
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
    // The interpreter road: a filesystem call carried inside an interpreter
    // argument names its destination in the command text, and the tool road
    // reads it there. On the operator's open ground no kernel wall stands
    // behind that road, so this is the refusal such a write meets; `troth
    // open` would not lift it.
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
