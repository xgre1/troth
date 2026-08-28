// SPDX-License-Identifier: AGPL-3.0-only
// The egress proxy: the one road out of an install jail.
//
// Everything here runs against local listeners — no test touches the real
// registries. What is pinned: the host matcher's boundaries, the resolved-
// address guard that keeps the proxy from carrying a jailed child back to
// loopback or a private range, the CONNECT tunnel and plain-HTTP forward
// actually moving bytes, the refusal record, and — where the sandbox is
// available — that a jailed child reaches a target THROUGH the proxy while
// its direct road to the same target is refused by the kernel.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const eg = require(path.join(__dirname, '..', 'shared-core', 'tools', 'egress-proxy.js'));
const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));

console.log('\nEgress proxy (EG-1..9):');

test('EG-1: the host matcher honors exact names, label boundaries and pinned ports', () => {
  const allow = ['registry.npmjs.org', '*.pythonhosted.org', 'mirror.example:8443'];
  assert.strictEqual(eg.hostAllowed('registry.npmjs.org', 443, allow), true);
  assert.strictEqual(eg.hostAllowed('registry.npmjs.org', 80, allow), true);
  assert.strictEqual(eg.hostAllowed('registry.npmjs.org', 8443, allow), false, 'a bare entry admits 443/80 only');
  assert.strictEqual(eg.hostAllowed('files.pythonhosted.org', 443, allow), true);
  assert.strictEqual(eg.hostAllowed('pythonhosted.org', 443, allow), true, 'the wildcard covers the apex');
  assert.strictEqual(eg.hostAllowed('evil-pythonhosted.org', 443, allow), false, 'a label boundary is not a string prefix');
  assert.strictEqual(eg.hostAllowed('registry.npmjs.org.evil.example', 443, allow), false);
  assert.strictEqual(eg.hostAllowed('mirror.example', 8443, allow), true);
  assert.strictEqual(eg.hostAllowed('mirror.example', 443, allow), false, 'a pinned port admits that port only');
  assert.strictEqual(eg.hostAllowed('anything.example', 443, []), false);
});

test('EG-2: the address guard refuses loopback, private and mangled addresses, and passes the public ones', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
                    '169.254.9.9', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::5', 'nonsense']) {
    assert.strictEqual(eg._privateAddress(ip), true, ip + ' must be refused');
  }
  for (const ip of ['8.8.8.8', '151.101.1.63', '2606:4700::6810:84e5', '172.15.0.1', '172.32.0.1']) {
    assert.strictEqual(eg._privateAddress(ip), false, ip + ' must pass');
  }
});

const withEcho = (fn) => new Promise((resolve, reject) => {
  const target = net.createServer((c) => { c.on('data', (d) => c.write(d)); });
  target.listen(0, '127.0.0.1', () => {
    Promise.resolve(fn(target.address().port))
      .then((v) => { target.close(); resolve(v); },
            (e) => { target.close(); reject(e); });
  });
});

const rawThrough = (proxyPort, request) => new Promise((resolve, reject) => {
  const c = net.connect({ host: '127.0.0.1', port: proxyPort });
  let buf = '';
  const t = setTimeout(() => { c.destroy(); resolve(buf); }, 4000);
  c.on('data', (d) => { buf += d.toString('latin1'); });
  c.on('error', reject);
  c.on('close', () => { clearTimeout(t); resolve(buf); });
  c.on('connect', () => c.write(request));
});

test('EG-3: a CONNECT tunnel moves bytes for an admitted target and turns a stranger away on the record', async () => {
  await withEcho(async (targetPort) => {
    const proxy = await eg.startEgressProxy({
      allow: ['localhost:' + targetPort], allowLoopbackTargets: true
    });
    try {
      const since = Date.now();
      const ok = await new Promise((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port: proxy.port });
        let phase = 'head'; let buf = '';
        const t = setTimeout(() => { c.destroy(); reject(new Error('tunnel timeout: ' + buf)); }, 5000);
        c.on('error', reject);
        c.on('data', (d) => {
          buf += d.toString('latin1');
          if (phase === 'head' && buf.indexOf('\r\n\r\n') !== -1) {
            assert.ok(/^HTTP\/1\.1 200/.test(buf), 'tunnel not established: ' + buf.slice(0, 80));
            phase = 'echo'; buf = '';
            c.write('ping-through-tunnel');
          } else if (phase === 'echo' && buf.indexOf('ping-through-tunnel') !== -1) {
            clearTimeout(t); c.destroy(); resolve(true);
          }
        });
        c.on('connect', () => c.write('CONNECT localhost:' + targetPort + ' HTTP/1.1\r\nHost: localhost\r\n\r\n'));
      });
      assert.strictEqual(ok, true);
      const refusal = await rawThrough(proxy.port,
        'CONNECT stranger.example:443 HTTP/1.1\r\nHost: stranger.example\r\n\r\n');
      assert.ok(/^HTTP\/1\.1 403/.test(refusal), 'a stranger must be turned away: ' + refusal.slice(0, 80));
      assert.deepStrictEqual(proxy.refusalsSince(since), ['stranger.example:443'],
        'the refusal must land on the record');
    } finally { proxy.close(); }
  });
});

test('EG-4: plain HTTP forwards for an admitted host and refuses the rest', async () => {
  const server = http.createServer((req, res) => { res.end('hello-from-origin'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const originPort = server.address().port;
  const proxy = await eg.startEgressProxy({
    allow: ['localhost:' + originPort], allowLoopbackTargets: true
  });
  try {
    const ok = await rawThrough(proxy.port,
      'GET http://localhost:' + originPort + '/x HTTP/1.1\r\nHost: localhost:' + originPort + '\r\nConnection: close\r\n\r\n');
    assert.ok(ok.indexOf('hello-from-origin') !== -1, 'the origin body must come back: ' + ok.slice(0, 120));
    const no = await rawThrough(proxy.port,
      'GET http://stranger.example/x HTTP/1.1\r\nHost: stranger.example\r\nConnection: close\r\n\r\n');
    assert.ok(/^HTTP\/1\.1 403/.test(no), 'a stranger must be refused: ' + no.slice(0, 80));
  } finally { proxy.close(); server.close(); }
});

test('EG-5: a name on the list whose address lands in a protected range is still refused', async () => {
  await withEcho(async (targetPort) => {
    // Same shape as EG-3 but WITHOUT the test-only flag: the name is
    // admitted, the resolved address is loopback, and loopback is what the
    // jail exists to keep away from — the proxy must not carry it back.
    const proxy = await eg.startEgressProxy({ allow: ['localhost:' + targetPort] });
    try {
      const out = await rawThrough(proxy.port,
        'CONNECT localhost:' + targetPort + ' HTTP/1.1\r\nHost: localhost\r\n\r\n');
      assert.ok(/^HTTP\/1\.1 403/.test(out), 'the proxy carried a jailed child back to loopback: ' + out.slice(0, 80));
    } finally { proxy.close(); }
  });
});

test('EG-6: a jailed child reaches its target through the proxy while its direct road is refused by the kernel', async () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  const server = http.createServer((req, res) => { res.end('through-the-one-door'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const originPort = server.address().port;
  const proxy = await eg.startEgressProxy({
    allow: ['localhost:' + originPort], allowLoopbackTargets: true
  });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'egj-')));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  try {
    const spec = sb.jailSpawnSpec({ cwd: proj, network: 'proxy', proxyPort: proxy.port, env: {
      http_proxy: 'http://127.0.0.1:' + proxy.port, HTTP_PROXY: 'http://127.0.0.1:' + proxy.port
    } });
    assert.ok(spec.ok, 'proxy-mode jail spec failed: ' + spec.error);
    // spawn, never spawnSync: the proxy lives in THIS process, and a
    // synchronous child freezes the event loop it answers from — the child
    // would then time out against a proxy that is merely blocked, and the
    // test would be measuring its own harness.
    const run = (cmd) => new Promise((resolve) => {
      const p = spawn(spec.exec, spec.args.concat(['/bin/bash', '-lc', cmd]),
        { cwd: proj, env: spec.env });
      let out = '', err = '';
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 30000);
      p.stdout.on('data', (d) => { out += d.toString('utf8'); });
      p.stderr.on('data', (d) => { err += d.toString('utf8'); });
      p.on('exit', (code) => { clearTimeout(t); resolve({ status: code, stdout: out, stderr: err }); });
    });
    const through = await run('curl -s --max-time 8 http://localhost:' + originPort + '/x');
    assert.strictEqual(through.status, 0, 'the proxied road must work: ' + through.stderr);
    assert.ok(through.stdout.indexOf('through-the-one-door') !== -1,
      'the body must arrive through the tunnel: ' + through.stdout.slice(0, 120));
    const direct = await run('curl -s --max-time 4 --noproxy "*" http://127.0.0.1:' + originPort + '/x');
    assert.notStrictEqual(direct.status, 0, 'the direct road must stay closed');
    const stranger = await run('curl -s --max-time 6 -o /dev/null -w "%{http_code}" http://stranger.example/x');
    assert.strictEqual(stranger.stdout.trim(), '403',
      'a host off the list must be turned away by the proxy, not merely fail: ' + stranger.stdout);
    assert.strictEqual(sb.jailSpawnSpec({ cwd: proj, network: 'proxy' }).ok, false,
      'proxy mode without a port must refuse, not silently widen');
  } finally { proxy.close(); server.close(); }
});

test('EG-7: a token carries one project’s allowlist, and a command without one gets the defaults', async () => {
  const server = http.createServer((req, res) => { res.end('extra-host-body'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const originPort = server.address().port;
  // The default list does NOT carry this host; only the grant does.
  const proxy = await eg.startEgressProxy({ allow: [], allowLoopbackTargets: true });
  try {
    const token = proxy.grant(['localhost:' + originPort]);
    const auth = 'Proxy-Authorization: Basic ' + Buffer.from(token + ':').toString('base64');
    const withToken = await rawThrough(proxy.port,
      'GET http://localhost:' + originPort + '/x HTTP/1.1\r\nHost: localhost\r\n' + auth + '\r\nConnection: close\r\n\r\n');
    assert.ok(withToken.indexOf('extra-host-body') !== -1,
      'the granted host must be reachable with the token: ' + withToken.slice(0, 80));
    const without = await rawThrough(proxy.port,
      'GET http://localhost:' + originPort + '/x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.ok(/^HTTP\/1\.1 403/.test(without), 'a command without the token must not inherit it: ' + without.slice(0, 80));
    const stale = 'Proxy-Authorization: Basic ' + Buffer.from('g999-nosuch:').toString('base64');
    const unknown = await rawThrough(proxy.port,
      'GET http://localhost:' + originPort + '/x HTTP/1.1\r\nHost: localhost\r\n' + stale + '\r\nConnection: close\r\n\r\n');
    assert.ok(/^HTTP\/1\.1 403/.test(unknown), 'an unknown token must fall back to the defaults, not to a grant');
    // A host outside this grant is refused AND charged to the command that
    // asked for it, which is what makes the note on that command's result
    // true rather than merely plausible.
    const off = await rawThrough(proxy.port,
      'CONNECT stranger.example:443 HTTP/1.1\r\nHost: stranger.example\r\n' + auth + '\r\n\r\n');
    assert.ok(/^HTTP\/1\.1 403/.test(off), 'a host outside the grant must be refused');
    assert.deepStrictEqual(proxy.refusalsFor(token), ['stranger.example:443'],
      'the refusal must be charged to the command that caused it');
    proxy.revoke(token);
    const revoked = await rawThrough(proxy.port,
      'GET http://localhost:' + originPort + '/x HTTP/1.1\r\nHost: localhost\r\n' + auth + '\r\nConnection: close\r\n\r\n');
    assert.ok(/^HTTP\/1\.1 403/.test(revoked), 'a revoked token must stop working: ' + revoked.slice(0, 80));
    assert.deepStrictEqual(proxy.refusalsFor(token), ['stranger.example:443'],
      'a revoked token collects nothing further — its command is over');
  } finally { proxy.close(); server.close(); }
});

test('EG-8: the per-project list adds hosts for that project only, and a broken file falls back to the defaults', () => {
  const na = require(path.join(__dirname, '..', 'shared-core', 'tools', 'net-allowlist.js'));
  const saved = process.env.TROTH_CONFIG_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nal-')));
  process.env.TROTH_CONFIG_DIR = path.join(root, '.troth');
  fs.mkdirSync(process.env.TROTH_CONFIG_DIR, { recursive: true });
  try {
    const projA = path.join(root, 'a'); const projB = path.join(root, 'b');
    fs.mkdirSync(projA); fs.mkdirSync(projB);
    assert.ok(na.allowFor(projA).indexOf('registry.npmjs.org') !== -1, 'the defaults always apply');
    assert.strictEqual(na.addHost('npm.example.com', projA).ok, true);
    assert.strictEqual(na.addHost('codeload.example', null).ok, true);
    assert.ok(na.allowFor(projA).indexOf('npm.example.com') !== -1, 'the project entry must apply to its project');
    assert.strictEqual(na.allowFor(projB).indexOf('npm.example.com'), -1,
      'one project’s registry must not be lent to another');
    assert.ok(na.allowFor(projB).indexOf('codeload.example') !== -1, 'an every-project entry applies everywhere');
    assert.strictEqual(na.addHost('http://npm.example.com/path', projA).ok, false, 'a URL is not a host');
    assert.strictEqual(fs.statSync(na.allowlistPath()).mode & 0o777, 0o600, 'the list is owner-only');
    // Fail closed, and never overwrite what the operator wrote.
    fs.writeFileSync(na.allowlistPath(), '{ not json');
    assert.deepStrictEqual(na.allowFor(projA), eg.DEFAULT_REGISTRY_HOSTS.slice(),
      'an unreadable list must fall back to the defaults, never to everything');
    assert.strictEqual(na.addHost('x.example', projA).ok, false, 'a corrupt list refuses the write');
  } finally {
    if (saved === undefined) delete process.env.TROTH_CONFIG_DIR; else process.env.TROTH_CONFIG_DIR = saved;
  }
});

test('EG-9: the allowlist file is refused on the tool road and by the kernel rules', () => {
  const policy = require(path.join(__dirname, '..', 'shared-core', 'tools', 'path-policy.js'));
  const entry = policy.BLOCKED_PREFIXES.find((e) => e.name === 'net_allowlists');
  assert.ok(entry, 'the tool road does not name the egress allowlist');
  assert.strictEqual(policy.isWritablePath(entry.prefix, {}).allowed, false,
    'the partner could widen its own egress through the tool road');
  assert.ok(sb._policyPaths().some((p) => path.basename(p) === 'net-allowlists.json'),
    'the kernel rules do not cover the egress allowlist');
});
};
