// SPDX-License-Identifier: AGPL-3.0-only
// The sandbox that exists on every Mac.
//
// Before this adapter, the selector's chain (apple-container → docker →
// bare-refuse) meant a stock Mac — no Docker Desktop, no `container` CLI —
// never had a working sandbox: third-party code the partner installed and
// ran (npm packages, project scripts) executed straight on the operator's
// host with the operator's whole filesystem and env. Seatbelt closes that:
// deny-default jail, the project dir is the only writable ground, the
// child env is BUILT (never inherited), network off unless asked.
//
// These tests run REAL sandbox-exec on darwin (no network needed) and pin
// the four walls: write-inside works, read-outside refuses, listing a home
// dir refuses even though stat metadata is allowed, parent env stays in
// the parent. On non-darwin the whole suite skips.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));
const rt = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-runtime.js'));

console.log('\nSeatbelt jail (SANDBOX-1..14):');

const avail = sb.isAvailable();
const here = avail.available;

test("SANDBOX-9: on Linux the adapter self-reports unavailable and the selector moves on", () => {
  // No CI minutes and no Linux box needed: the platform branch is pinned
  // by faking process.platform in a child. On a real Linux host this is
  // exactly the code that runs, and the chain falls through to docker/bare.
  const { spawnSync } = require("child_process");
  const adapterPath = path.join(__dirname, "..", "shared-core", "tools", "sandbox-seatbelt.js");
  const probe = [
    'Object.defineProperty(process, "platform", { value: "linux" });',
    'const sb = require(process.argv[1]);',
    'console.log(JSON.stringify(sb.isAvailable({ fresh: true })));'
  ].join('');
  const r = spawnSync(process.execPath, ["-e", probe, adapterPath], { encoding: "utf8", timeout: 15000 });
  const a = JSON.parse(String(r.stdout).trim());
  assert.strictEqual(a.available, false, "linux must not claim seatbelt");
  assert.ok(/macOS-only/.test(a.error || ""), "says why");
});

test('SANDBOX-1: selector knows seatbelt, ordered above bare', () => {
  const pri = rt.ADAPTER_PRIORITY;
  assert.ok(pri.includes('seatbelt'), 'seatbelt registered');
  assert.ok(pri.indexOf('seatbelt') < pri.indexOf('bare'), 'seatbelt tried before the refusal fallback');
});

test('SANDBOX-2: profile is deny-default and never names a user home', () => {
  const p = sb._profile('none');
  assert.ok(p.indexOf('(deny default)') !== -1, 'deny default present');
  assert.ok(p.indexOf(os.homedir()) === -1, 'no home path baked into policy');
  assert.ok(p.indexOf('(allow network*)') === -1, 'offline profile has no network');
  assert.ok(sb._profile('full').indexOf('(allow network*)') !== -1, 'full profile has network');
});

test('SANDBOX-3: child env is built, not inherited', () => {
  process.env.TROTH_SB_CANARY = 'must-not-cross';
  const env = sb._buildEnv('/j/home', '/j/tmp', '/t/bin', { EXTRA_OK: 'yes' });
  delete process.env.TROTH_SB_CANARY;
  assert.strictEqual(env.TROTH_SB_CANARY, undefined, 'parent env var did not cross');
  assert.strictEqual(env.HOME, '/j/home', 'HOME points into the jail');
  assert.strictEqual(env.EXTRA_OK, 'yes', 'declared extras do cross');
});

if (!here) {
  // Registered as tests that skip, not as a bare skip(): skip() throws, and
  // only test() catches it. At suite top level it escaped to the module
  // loader and took the entire run down — invisible on darwin, fatal on
  // every other platform. One entry per check so the skipped count stays
  // honest about how much coverage the host could not offer.
  for (const id of ['SANDBOX-4', 'SANDBOX-5', 'SANDBOX-6', 'SANDBOX-7', 'SANDBOX-8']) {
    test(id + ': live-jail check (darwin-only)',
         () => skip('sandbox-exec unavailable: ' + (avail.error || '?')));
  }
} else {
  // One shared jail for the live checks; a sibling dir holds the "secret"
  // that must stay unreadable. Both under a fresh mkdtemp root.
  const root   = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sb-suite-'));
  const jail   = path.join(root, 'project');
  const secret = path.join(root, 'outside');
  fs.mkdirSync(jail, { recursive: true });
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(secret, 'key.txt'), 'the-secret');

  test('SANDBOX-4: writes land inside the jail and nowhere else is needed', async () => {
    const r = await sb.runInSandbox('echo jail-write > made.txt && cat made.txt', { cwd: jail });
    assert.strictEqual(r.exit_code, 0, 'write+read inside jail works: ' + (r.stderr || r.detail || ''));
    assert.ok(/jail-write/.test(r.stdout), 'content round-tripped');
    assert.strictEqual(r.sandboxed, true);
    assert.strictEqual(r.sandbox_kind, 'seatbelt');
    assert.ok(fs.existsSync(path.join(jail, 'made.txt')), 'file really exists in the project');
  });

  test('SANDBOX-5: a file one directory outside the jail is unreadable', async () => {
    const r = await sb.runInSandbox('cat ' + JSON.stringify(path.join(secret, 'key.txt')), { cwd: jail });
    assert.notStrictEqual(r.exit_code, 0, 'read outside the jail must fail');
    assert.ok(!/the-secret/.test(r.stdout || ''), 'secret content did not leak');
  });

  test('SANDBOX-6: stat metadata is allowed but directory listing still refuses', async () => {
    // The realpath-ancestor tradeoff: stat may answer, readdir must not.
    const r = await sb.runInSandbox('ls ' + JSON.stringify(secret), { cwd: jail });
    assert.notStrictEqual(r.exit_code, 0, 'listing outside the jail must fail');
    assert.ok(!/key\.txt/.test(r.stdout || ''), 'entry names did not leak');
  });

  test('SANDBOX-7: offline jail has no network path at all', async () => {
    const r = await sb.runInSandbox(
      '/usr/bin/curl -s -m 3 https://registry.npmjs.org/ >/dev/null && echo REACHED; true',
      { cwd: jail, network: 'none' });
    assert.ok(!/REACHED/.test(r.stdout || ''), 'no socket left the offline jail');
  });

  test('SANDBOX-11: the jail leaves no scratch behind in the operator project', async () => {
    // The scratch home used to be <project>/.troth-sandbox: one npm install
    // staged 632 files and 3 MB of npm cache into the operator's next
    // commit, and even a read-only command created the directory. It now
    // lives outside the work, keyed to the project.
    const clean = path.join(jail, 'cleanliness');
    fs.mkdirSync(clean, { recursive: true });
    const r = await sb.runInSandbox('echo hello > note.txt', { cwd: clean });
    assert.strictEqual(r.exit_code, 0, 'ordinary write works');
    const left = fs.readdirSync(clean).sort();
    assert.deepStrictEqual(left, ['note.txt'], 'project holds only the operator\'s own file, got: ' + left.join(' '));
    assert.ok(fs.existsSync(sb._scratchDirFor(fs.realpathSync(clean))), 'scratch exists, outside the project');
  });

  test('SANDBOX-12: a networked jail reaches the internet but never a local service', async () => {
    // The operator's own machine runs privileged listeners — troth's proxy
    // holds the vault and the engine keys. Untrusted code that can call
    // them has escaped the jail without touching a single file. Hermetic:
    // the "local service" is this test's own server on an ephemeral port.
    const http = require('http');
    const srv = http.createServer((_q, res) => { res.end('LOCAL_SERVICE_REACHED'); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      let r = await sb.runInSandbox(
        '/usr/bin/curl -s -m 4 http://127.0.0.1:' + port + '/ ; echo', { cwd: jail, network: 'full' });
      assert.ok(!/LOCAL_SERVICE_REACHED/.test(r.stdout || ''), 'loopback by address must be denied');
      r = await sb.runInSandbox(
        '/usr/bin/curl -s -m 4 http://localhost:' + port + '/ ; echo', { cwd: jail, network: 'full' });
      assert.ok(!/LOCAL_SERVICE_REACHED/.test(r.stdout || ''), 'loopback by name must be denied too');
      // And the same jail with network off cannot even open a socket.
      r = await sb.runInSandbox(
        '/usr/bin/curl -s -m 3 http://127.0.0.1:' + port + '/ ; echo', { cwd: jail, network: 'none' });
      assert.ok(!/LOCAL_SERVICE_REACHED/.test(r.stdout || ''), 'offline jail has no socket at all');
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  test('SANDBOX-13: commits carry the operator identity, never a fabricated one', async () => {
    // HOME is redirected, so git cannot see the global config and silently
    // invents an author from the hostname — stamping the machine's LAN
    // address into every workspace commit. The identity is read by the
    // parent and handed in.
    const repo = path.join(jail, 'identity');
    fs.mkdirSync(repo, { recursive: true });
    const r = await sb.runInSandbox(
      'git init -q . && echo x > f.txt && git add -A && git commit -qm t && git log -1 --format=%ae',
      { cwd: repo, network: 'none' });
    const email = (r.stdout || '').trim().split('\n').pop() || '';
    const configured = !!sb._buildEnv(path.join(repo, 'h'), '/j/tmp', '/t/bin', {}).GIT_AUTHOR_EMAIL;
    if (configured) {
      assert.ok(!/@\d+\.\d+\.\d+\.\d+$/.test(email), 'author must not be host-derived (got an IP-shaped address)');
      assert.ok(!/\.local$/.test(email), 'author must not be hostname-derived');
    } else {
      // No identity to inherit: refusing is correct, inventing one is not.
      assert.notStrictEqual(r.exit_code, 0, 'commit without an identity must refuse');
      assert.ok(!/@/.test(email), 'nothing was committed under a fabricated author, got: ' + email);
    }
  });

  test('SANDBOX-14: reachability settings pass through, identity-bearing env does not', () => {
    const env = sb._buildEnv('/j/home', '/j/tmp', '/t/bin', {});
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in env) && !('ANTHROPIC_API_KEY' in env), 'no credential-shaped inheritance');
    // The passthrough list is about being able to REACH a registry at all.
    const before = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    const env2 = sb._buildEnv('/j/home', '/j/tmp', '/t/bin', {});
    if (before === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = before;
    assert.strictEqual(env2.HTTPS_PROXY, 'http://proxy.internal:3128', 'proxy settings must reach the jail');
  });

  test('SANDBOX-10: the policy governing the jail is unreachable from inside it', async () => {
    // The profile used to live in WORK, which the jailed process owns. Our
    // rewrite-before-every-spawn hid it, but a long-lived jailed process
    // (dev server, watcher, MCP bridge) could swap the file in the window
    // between that write and sandbox-exec's read, handing the NEXT command
    // an "(allow default)" policy. The fix is ground it cannot touch.
    const policy = path.join(sb.PROFILE_DIR, 'profile-none.sb');
    let r = await sb.runInSandbox('printf %s "(version 1)(allow default)" > ' + JSON.stringify(policy) + ' && echo REWROTE || echo REFUSED', { cwd: jail });
    assert.ok(/REFUSED/.test(r.stdout || ''), 'policy rewrite from inside must refuse, got: ' + (r.stdout || '').trim());
    r = await sb.runInSandbox('ls ' + JSON.stringify(sb.PROFILE_DIR), { cwd: jail });
    assert.notStrictEqual(r.exit_code, 0, 'the policy directory is not even listable');
    // And the walls still stand for the run that follows the attempt.
    r = await sb.runInSandbox('cat ' + JSON.stringify(path.join(secret, 'key.txt')), { cwd: jail });
    assert.notStrictEqual(r.exit_code, 0, 'walls intact after a tampering attempt');
  });

  test('SANDBOX-8: parent process env never enters the jail', async () => {
    process.env.TROTH_SB_LIVE_CANARY = 'leak-me';
    const r = await sb.runInSandbox('printenv TROTH_SB_LIVE_CANARY; true', { cwd: jail });
    delete process.env.TROTH_SB_LIVE_CANARY;
    assert.strictEqual((r.stdout || '').trim(), '', 'canary stayed in the parent');
  });
}
};
