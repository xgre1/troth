// SPDX-License-Identifier: AGPL-3.0-only
// Being on 127.0.0.1 does not make a caller the operator.
//
// Until  the proxy treated every loopback request as authenticated.
// A probe drove /api/config/reveal, /api/substrate/forget and /api/runs from a
// page carrying Origin: https://evil.example and got 200 on all three: any
// site the user had open could read their stored API keys and erase their
// substrate. The DNS-rebinding variant, where the attacker's hostname is
// re-resolved to 127.0.0.1 so the page becomes same-origin and can READ the
// reply, went through as well.
//
// checkRemoteAuth is exercised directly rather than over a socket: these are
// header decisions, and a unit test pins them without a live port. The three
// signals below cannot be forged from JavaScript in a browser, and no
// non-browser caller sends any of them.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

console.log('\nLoopback origin guard:');

// The proxy binds a port and starts timers on require, so the guard is
// evaluated in a child that only loads the function and reports verdicts.
function verdicts(cases) {
  const script = `
    const Module = require('module');
    const fs = require('fs');
    const src = fs.readFileSync(${JSON.stringify(path.join(__dirname, '..', 'proxy', 'server.js'))}, 'utf8');
    // Lift the two functions out of the server without booting it.
    const start = src.indexOf('function isBrowserDrivenFromElsewhere');
    const end   = src.indexOf('function readJsonBody');
    const body  = src.slice(start, end);
    const REMOTE_TOKEN = 'test-token-value';
    const fn = new Function('REMOTE_TOKEN', body + '; return { checkRemoteAuth, isBrowserDrivenFromElsewhere };')(REMOTE_TOKEN);
    const cases = ${JSON.stringify(cases)};
    console.log(JSON.stringify(cases.map((c) => fn.checkRemoteAuth({
      headers: c.headers || {},
      socket: { remoteAddress: c.remoteAddress || '127.0.0.1' }
    }))));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error('guard probe failed: ' + String(r.stderr).slice(-400));
  return JSON.parse(String(r.stdout).trim().split('\n').pop());
}

test('CSRF-1: a page the user is visiting cannot drive the proxy from loopback', () => {
  const [crossSite, crossOrigin, formPost] = verdicts([
    { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: '127.0.0.1:8000' } },
    { headers: { origin: 'https://evil.example', host: '127.0.0.1:8000' } },
    // A cross-origin form POST carries no Sec-Fetch-Site value we can trust
    // beyond 'cross-site', and no Origin on some older browsers; the Host
    // check is what remains.
    { headers: { 'sec-fetch-site': 'same-site', host: '127.0.0.1:8000' } },
  ]);
  assert.strictEqual(crossSite, false, 'cross-site fetch must be refused');
  assert.strictEqual(crossOrigin, false, 'foreign Origin must be refused even without Sec-Fetch-Site');
  assert.strictEqual(formPost, false, "'same-site' is not 'same-origin' and must be refused");
});

test('CSRF-2: a rebound hostname resolving to loopback is refused', () => {
  const [rebound, reboundWithPort] = verdicts([
    { headers: { host: 'evil.example' } },
    { headers: { host: 'evil.example:8000' } },
  ]);
  assert.strictEqual(rebound, false, 'attacker Host must be refused');
  assert.strictEqual(reboundWithPort, false, 'the port must not smuggle a foreign Host past the check');
});

test('CSRF-3: the operator\'s own tools and dashboard keep working', () => {
  const [cli, dashboard, ipv6, sameOriginFetch] = verdicts([
    // curl, the CLI and the in-process MCP server send no browser headers.
    { headers: {} },
    { headers: { origin: 'http://localhost:8000', host: 'localhost:8000', 'sec-fetch-site': 'same-origin' } },
    { headers: { host: '[::1]:8000' }, remoteAddress: '::1' },
    { headers: { 'sec-fetch-site': 'none', host: '127.0.0.1:8000' } },
  ]);
  assert.strictEqual(cli, true, 'a non-browser loopback caller must still be allowed');
  assert.strictEqual(dashboard, true, 'the dashboard is same-origin and must be allowed');
  assert.strictEqual(ipv6, true, 'IPv6 loopback must be allowed');
  assert.strictEqual(sameOriginFetch, true, "'none' means a user-initiated load, not a foreign page");
});

test('CSRF-4: a bearer token still authorises deliberate remote access', () => {
  const [tokenFromLan, wrongToken, noTokenFromLan] = verdicts([
    { headers: { authorization: 'Bearer test-token-value', host: 'host.example' }, remoteAddress: '100.64.0.9' },
    { headers: { authorization: 'Bearer wrong' }, remoteAddress: '100.64.0.9' },
    { headers: { host: 'host.example' }, remoteAddress: '100.64.0.9' },
  ]);
  assert.strictEqual(tokenFromLan, true, 'a token holder off-box is deliberate access, Host is legitimately not loopback');
  assert.strictEqual(wrongToken, false, 'a wrong token is refused');
  assert.strictEqual(noTokenFromLan, false, 'no token off-box is refused; a tailnet is not a trust boundary');
});

// The agent host's own config is executable surface: a hooks entry in
// settings.json runs a command on every tool use. It sat outside
// BLOCKED_PREFIXES until  while ~/.zshenv was blocked for the same
// reason, and bin/troth.js proves the file is a real write target.
test('PATHPOL-1: agent-host config is not partner-writable', () => {
  const { isWritablePath, BLOCKED_PREFIXES } = require('../shared-core/tools/path-policy.js');
  // Ask the policy which HOME it expanded rather than the environment: other
  // suites move process.env.HOME after this module has already captured it,
  // and a test that disagrees with the code it checks proves nothing.
  const H = BLOCKED_PREFIXES.find((b) => b.name === 'ssh_dir').prefix.replace(/\/\.ssh\/$/, '');
  for (const rel of ['/.claude/settings.json', '/.claude/settings.local.json',
                     '/.claude/hooks/x.sh', '/.claude/plugins/p/index.js',
                     '/.claude/agents/a.md']) {
    const r = isWritablePath(H + rel);
    assert.strictEqual(r.allowed, false, rel + ' must be refused');
    assert.strictEqual(r.reason, 'blocked_system_path', rel + ' must be refused as a system path');
  }
});

test('PATHPOL-2: ordinary project files stay writable', () => {
  const { isWritablePath, BLOCKED_PREFIXES } = require('../shared-core/tools/path-policy.js');
  const H = BLOCKED_PREFIXES.find((b) => b.name === 'ssh_dir').prefix.replace(/\/\.ssh\/$/, '');
  assert.strictEqual(isWritablePath(H + '/Documents/anything/src/app.js').allowed, true);
  assert.strictEqual(isWritablePath(process.cwd() + '/scratch.txt').allowed, true);
});

// A link planted inside an authorised root used to carry a write straight out
// of it: the policy judged the path it was handed, never the file it pointed
// at, while README promised realpath containment.
test('PATHPOL-3: a symlink cannot smuggle a write out of the root', () => {
  const fs = require('fs'); const os = require('os'); const pathM = require('path');
  const { isWritablePath, BLOCKED_PREFIXES } = require('../shared-core/tools/path-policy.js');
  const H = BLOCKED_PREFIXES.find((b) => b.name === 'ssh_dir').prefix.replace(/\/\.ssh\/$/, '');
  const root = fs.mkdtempSync(pathM.join(os.tmpdir(), 'troth-symlink-'));
  try {
    fs.mkdirSync(pathM.join(H, '.ssh'), { recursive: true });
    fs.symlinkSync(pathM.join(H, '.ssh'), pathM.join(root, 'escape'));
    // A link whose target does not exist yet is equally dangerous: writing
    // through it is what creates the target.
    fs.symlinkSync(pathM.join(H, '.zshenv'), pathM.join(root, 'rc'));
    const ctx = { cwd: root };
    assert.strictEqual(isWritablePath(pathM.join(root, 'escape/config'), ctx).allowed, false,
      'a link into a blocked directory must be refused');
    assert.strictEqual(isWritablePath(pathM.join(root, 'rc'), ctx).allowed, false,
      'a dangling link at a blocked target must be refused');
    assert.strictEqual(isWritablePath(pathM.join(root, 'notes.md'), ctx).allowed, true,
      'an ordinary file in the root stays writable');
    assert.strictEqual(isWritablePath(pathM.join(root, 'a/b/c.js'), ctx).allowed, true,
      'a path whose parents do not exist yet stays writable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Every gate below used to fall through to "allow" when it could not run.
test('FAILCLOSED-1: an unreadable invariants table refuses the transition', () => {
  const fs = require('fs'); const os = require('os'); const pathM = require('path');
  const sm = require('../shared-core/state-machine.js');
  const prev = process.env.STATE_DB_PATH;
  const dir = fs.mkdtempSync(pathM.join(os.tmpdir(), 'troth-sm-'));
  try {
    // No substrate yet, and a pre-migrate substrate, genuinely have no
    // invariants: those must still pass, or a clean install cannot start.
    process.env.STATE_DB_PATH = pathM.join(dir, 'absent.db');
    assert.strictEqual(sm.validateTransition({ proposed: {}, context: {} }).ok, true, 'first run has no invariants to violate');

    // A file that exists but cannot be read is NOT the same as no rules.
    const corrupt = pathM.join(dir, 'corrupt.db');
    fs.writeFileSync(corrupt, 'this is not a database');
    process.env.STATE_DB_PATH = corrupt;
    const r = sm.validateTransition({ proposed: {}, context: {} });
    assert.strictEqual(r.ok, false, 'an unreadable rule set must not approve');
    assert.strictEqual(r.violations[0].reason, 'invariants_unreadable');
  } finally {
    if (prev === undefined) delete process.env.STATE_DB_PATH; else process.env.STATE_DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Credentials belong to the host they were issued for.
test('REDIRECT-1: credentials do not survive a hop to another origin', () => {
  const { _headersForHop } = require('../shared-core/tools/web-fetch.js');
  const headers = { Authorization: 'Bearer secret', Cookie: 's=1', 'X-Api-Key': 'k', 'X-Trace-Id': 'keep' };
  const same = _headersForHop('https://api.example.com/a', 'https://api.example.com/b', headers);
  assert.deepStrictEqual(Object.keys(same).sort(), Object.keys(headers).sort(), 'a path change keeps everything');
  for (const to of ['https://cdn.other.net/x', 'http://api.example.com/a', 'not a url']) {
    const out = _headersForHop('https://api.example.com/a', to, headers);
    assert.ok(!('Authorization' in out), 'Authorization must not reach ' + to);
    assert.ok(!('Cookie' in out), 'Cookie must not reach ' + to);
    assert.strictEqual(out['X-Trace-Id'], 'keep', 'non-credential headers survive');
  }
});

// Every argument was in the wrong position, so this seam verified nothing.
test('KEYHSM-1: the file backend verifies a signature it just made', () => {
  const backend = require('../shared-core/host/keyhsm/file.js');
  const opKey = require('../shared-core/operator-key.js');
  if (typeof backend.verify !== 'function' || typeof opKey.generate !== 'function') return;
  const kp = opKey.generate();
  const pub = kp.publicKeyPem || kp.publicKey || kp.pub;
  const priv = kp.privateKeyPem || kp.privateKey || kp.priv;
  if (!pub || !priv || typeof opKey.sign !== 'function') return;
  const bytes = 'canonical-payload';
  const sig = opKey.sign(priv, bytes);
  assert.strictEqual(backend.verify(bytes, sig, pub), true, 'a valid signature must verify');
  assert.strictEqual(backend.verify('tampered', sig, pub), false, 'a tampered payload must not verify');
});

// A clock that spawns workers is the one thing in the open tree that can act
// with no human present. Until  its 60-second timer started on every
// proxy boot, and a fired schedule runs `git worktree add` in the operator's
// repository, while README promised background self-operation was not here.
test('SCHED-1: the scheduler timer does not start unless the operator asks', () => {
  const fs = require('fs'); const os = require('os'); const pathM = require('path');
  const home     = fs.mkdtempSync(pathM.join(os.tmpdir(), 'troth-sched-'));
  const prevHome = process.env.HOME;
  const prevFlag = process.env.TROTH_ENABLE_SCHEDULER;
  const modPath  = require.resolve('../proxy/modules/scheduler.js');
  // The module resolves ~/.troth/schedules.json at load, so point HOME at a
  // throwaway before requiring it: this test writes schedules.
  process.env.HOME = home;
  delete process.env.TROTH_ENABLE_SCHEDULER;
  delete require.cache[modPath];
  try {
    const sched = require(modPath);
    assert.strictEqual(sched.schedulingEnabled(), false, 'unset means off');
    assert.strictEqual(sched.start(), false, 'booting is not asking');
    assert.strictEqual(sched.stop(), false, 'no timer was created, so there is none to clear');

    // A schedule that cannot fire must say so at the moment it is stored,
    // rather than sitting on disk looking like queued work.
    const added = sched.addSchedule('every 5m', 'do a thing', home);
    assert.strictEqual(added.ok, true, 'storing still works with the timer off');
    assert.strictEqual(added.willFire, false);
    assert.ok(/TROTH_ENABLE_SCHEDULER/.test(added.note || ''), 'the note names the switch to flip');

    // And when the operator does ask, it genuinely runs.
    process.env.TROTH_ENABLE_SCHEDULER = '1';
    assert.strictEqual(sched.schedulingEnabled(), true);
    assert.strictEqual(sched.start(), true, 'the operator asked; the timer runs');
    assert.strictEqual(sched.addSchedule('hourly', 'another', home).willFire, true);
    assert.strictEqual(sched.stop(), true, 'the interval was real enough to clear');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevFlag === undefined) delete process.env.TROTH_ENABLE_SCHEDULER; else process.env.TROTH_ENABLE_SCHEDULER = prevFlag;
    delete require.cache[modPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Every success path in cmd-tenant.js used a bare `return`, which only leaves
// run(ctx); the CLI router then carried on. `tenant current` printed its answer
// and went straight into first-run onboarding, writing a config file and trying
// to open a browser, and `tenant list` fell through into the interactive REPL
// and never exited. A read-only query should answer and stop.
test('TENANT-1: a tenant query answers, changes nothing, and exits', () => {
  const fs = require('fs'); const os = require('os'); const pathM = require('path');
  const home = fs.mkdtempSync(pathM.join(os.tmpdir(), 'troth-tenant-'));
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'troth.js'), 'tenant', 'current'], {
      encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { HOME: home })
    });
    assert.strictEqual(r.signal, null, 'the command must not have to be killed');
    assert.strictEqual(r.status, 0, 'a successful query exits 0, stderr: ' + String(r.stderr).slice(-200));
    assert.ok(/using global state\.db/.test(String(r.stdout)), 'it answers the question it was asked');
    // Falling through to onboarding is what wrote this file.
    assert.ok(!fs.existsSync(pathM.join(home, '.troth', 'config.json')),
      'asking which tenant is active must not write a config');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
};
