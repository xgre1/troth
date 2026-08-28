// SPDX-License-Identifier: AGPL-3.0-only
// The install interception: a package installation on the operator's own
// ground moves into the OS jail, scoped to the nearest project.
//
// The classifier's misses fail OPEN into the ordinary ground walls, so what
// these tests pin is the other three edges: the verbs that must be caught,
// the home-target spellings that must NOT be (a jail would strand their
// artifact in the throwaway jail home), and that the jail the command lands
// in really does keep the real home unreadable and unwritable while the
// project stays ordinary.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ic = require(path.join(__dirname, '..', 'shared-core', 'tools', 'install-intercept.js'));
const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));

console.log('\nInstall interception (II-1..4):');

test('II-1: the classifier catches project-scoped installs and leaves everything else its ground', () => {
  const yes = [
    'npm install', 'npm i', 'npm ci', 'npm install express',
    'NODE_ENV=dev npm install express', '/usr/local/bin/npm install x',
    'pnpm add -D vitest', 'pnpm dlx create-vite', 'yarn', 'pnpm',
    'yarn add react', 'bun add zod', 'npx cowsay hi', 'bunx prettier .',
    'uv add requests', 'uv sync', 'cargo add serde', 'cargo update',
    'composer require monolog/monolog', 'composer create-project x/y',
    'cd api && npm install', 'cd api && npm ci && cd ../web && npm ci'
  ];
  for (const c of yes) {
    assert.strictEqual(ic.classifyInstall(c).install, true, 'missed: ' + c);
  }
  const no = [
    // not installs
    'npm run build', 'npm test', 'npm start', 'node server.js', 'npm',
    'yarn build', 'pnpm exec vitest', 'git clone x', 'cargo build', 'ls',
    // home-target by design: a jail would strand the artifact
    'npm install -g typescript', 'yarn global add x', 'npm i --global x',
    'pip install requests', 'pip3 install --user x', 'pipx install poetry',
    'cargo install ripgrep', 'gem install rails', 'bundle install',
    'go install golang.org/x/tools/gopls@latest', 'brew install jq',
    // mixed with ordinary work: the ground keeps it
    'npm install && node server.js', 'npm ci; ./run.sh',
    'echo hi && npm install', 'npm install | tee log.txt',
    // glue that redirects is not glue
    'cd api > f && npm install'
  ];
  for (const c of no) {
    assert.strictEqual(ic.classifyInstall(c).install, false, 'over-caught: ' + c);
  }
  assert.strictEqual(ic.classifyInstall('npm install x').manager, 'npm');
});

test('II-2: the wrap moves thin and confined ground into the jail, and leaves every other kind alone', async () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  const wj = await import(path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'workspace-jail.mjs'));
  const savedHome = process.env.HOME;
  const savedTroth = process.env.TROTH_CONFIG_DIR;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ii-')));
  process.env.HOME = home;
  process.env.TROTH_CONFIG_DIR = path.join(home, '.troth');
  fs.mkdirSync(process.env.TROTH_CONFIG_DIR, { recursive: true });
  try {
    const proj = path.join(home, 'proj');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    for (const kind of ['thin', 'confine']) {
      const iw = wj.installWrapFor('npm install', { kind, root: proj, ground: 'x' }, proj);
      assert.ok(iw && iw.kind === 'install-jail', kind + ' ground must intercept: ' + JSON.stringify(iw));
      assert.strictEqual(iw.root, fs.realpathSync(proj), 'the jail scopes to the project');
      assert.strictEqual(iw.manager, 'npm');
    }
    // The nearest project wins over the wider ground root: from a subdir of
    // the project, the jail still scopes to the project, not the subdir.
    const sub = path.join(proj, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const deep = wj.installWrapFor('npm install', { kind: 'thin', root: home, ground: 'opened' }, sub);
    assert.ok(deep && deep.root === fs.realpathSync(proj),
      'the nearest project decides the jail, not the cwd or the opened root: ' + (deep && deep.root));
    for (const w of [{ kind: 'jail', root: proj }, { kind: 'home' }, { off: 'operator' }, null]) {
      assert.strictEqual(wj.installWrapFor('npm install', w, proj), null,
        'must not intercept for wrap ' + JSON.stringify(w));
    }
    assert.strictEqual(wj.installWrapFor('npm run build', { kind: 'thin', root: proj }, proj), null,
      'a non-install stays on its ground');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedTroth === undefined) delete process.env.TROTH_CONFIG_DIR; else process.env.TROTH_CONFIG_DIR = savedTroth;
  }
});

test('II-3: inside the install jail the real home is invisible and unwritable, the project ordinary', async () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  const wj = await import(path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'workspace-jail.mjs'));
  const savedHome = process.env.HOME;
  const savedTroth = process.env.TROTH_CONFIG_DIR;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'iij-')));
  process.env.HOME = home;
  process.env.TROTH_CONFIG_DIR = path.join(home, '.troth');
  fs.mkdirSync(process.env.TROTH_CONFIG_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(home, 'secret.txt'), 'operator-only\n');
    const proj = path.join(home, 'proj');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const iw = wj.installWrapFor('npm install', { kind: 'thin', root: proj, ground: 'opened' }, proj);
    assert.ok(iw && iw.kind === 'install-jail');
    const run = (cmd) => spawnSync(iw.exec, iw.args.concat(['/bin/bash', '-lc', cmd]),
      { cwd: proj, env: iw.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(run('echo x > inside.txt').status, 0, 'the project must stay writable');
    const read = run('cat ' + JSON.stringify(path.join(home, 'secret.txt')));
    assert.notStrictEqual(read.status, 0, 'the real home was readable from the install jail');
    assert.ok(read.stdout.indexOf('operator-only') === -1, 'home contents leaked');
    assert.notStrictEqual(run('echo x > ' + JSON.stringify(path.join(home, 'leak.txt'))).status, 0,
      'the real home was writable from the install jail');
    assert.ok(!fs.existsSync(path.join(home, 'leak.txt')));
    // $HOME inside the jail is the throwaway jail home — a global-target
    // artifact would land there and evaporate, which is WHY those spellings
    // are excluded from interception.
    const fake = run('echo "$HOME"');
    assert.notStrictEqual(fake.stdout.trim(), home, 'the jail must not hand out the real home');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedTroth === undefined) delete process.env.TROTH_CONFIG_DIR; else process.env.TROTH_CONFIG_DIR = savedTroth;
  }
});

test('II-4: through the real server, an install says it ran jailed and ordinary work says nothing new', async () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  const probe = spawnSync('/bin/bash', ['-lc', 'command -v npm'], { encoding: 'utf8', timeout: 10000 });
  if (probe.status !== 0) return skip('npm not on this machine');
  const { spawn } = require('child_process');
  const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'iis-')));
  const troth = path.join(home, '.troth');
  fs.mkdirSync(troth, { recursive: true });
  const opened = path.join(home, 'code', 'mine');
  fs.mkdirSync(path.join(opened, '.git'), { recursive: true });
  fs.writeFileSync(path.join(troth, 'opened-folders.json'),
    JSON.stringify({ folders: [{ path: opened }] }));
  const env = Object.assign({}, process.env, { HOME: home, TROTH_CONFIG_DIR: troth, TROTH_BASH_CWD: opened });
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
  const rpc = (method, params) => new Promise((res, rej) => {
    const myId = id++;
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 60000);
    pending.set(myId, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const runCmd = async (command) => {
    const m = await rpc('tools/call', { name: 'run', arguments: { command, cwd: opened } });
    const c = m.result && m.result.content;
    const text = (Array.isArray(c) && c.map((b) => b.text || '').join('\n')) || '';
    return { text, note: (text.match(/\[troth-bash\][^\n]*/g) || []).join(' ') };
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const jailed = await runCmd('npm install --help');
    assert.ok(/install jail \(npm\)/.test(jailed.note),
      'the mode switch must announce itself: ' + jailed.note);
    const ordinary = await runCmd('echo done');
    assert.ok(!/install jail/.test(ordinary.note), 'ordinary work grew an install note: ' + ordinary.note);
    const globalTarget = await runCmd('npm install -g --help');
    assert.ok(!/install jail/.test(globalTarget.note),
      'a global-target spelling must keep its ground: ' + globalTarget.note);
    const mixed = await runCmd('npm install --help && node -e "0"');
    assert.ok(!/install jail/.test(mixed.note),
      'a mixed command must keep its ground: ' + mixed.note);
  } finally {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
});
};
