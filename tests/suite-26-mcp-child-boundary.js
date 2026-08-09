// SPDX-License-Identifier: AGPL-3.0-only
// What an MCP child is allowed to know.
//
// Before this boundary, startDownstream handed every downstream server —
// including npx-fetched third-party bridges — a full copy of process.env
// (whatever keys the proxy was launched with) and the operator's entire
// filesystem. Now the env is BUILT (working base + the entry's declared
// env, $vault-resolved) and the npx bridge runs inside the seatbelt jail
// where one exists, with a stable per-server jail HOME so its own OAuth
// state persists while everything else stays invisible.
//
// The live test drives a REAL long-lived jailed child over stdio pipes —
// the exact shape an MCP bridge runs in — and proves the conversation
// works while a read outside the jail refuses.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const mcp = require(path.join(__dirname, '..', 'shared-core', 'tools', 'mcp-client.js'));
const sb  = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));

console.log('\nMCP child boundary (MCPCHILD-1..4):');

test('MCPCHILD-1: child env is built — parent secrets never cross, declared env does', () => {
  process.env.TROTH_MCP_CANARY = 'proxy-secret';
  const env = mcp._buildChildEnv({ DECLARED_TOKEN: 'from-entry' });
  delete process.env.TROTH_MCP_CANARY;
  assert.strictEqual(env.TROTH_MCP_CANARY, undefined, 'parent env did not cross');
  assert.strictEqual(env.DECLARED_TOKEN, 'from-entry', 'declared entry env crosses');
  assert.ok(env.PATH && env.HOME, 'workable base present');
});

test('MCPCHILD-2: the http/sse bridge contract is unchanged (npx mcp-remote)', () => {
  const spec = mcp._toSpawnSpec('gh', { type: 'http', url: 'https://mcp.example/sse' });
  assert.strictEqual(spec.command, 'npx');
  assert.deepStrictEqual(spec.args.slice(0, 2), ['-y', 'mcp-remote']);
});

test('MCPCHILD-3: per-server jail dirs are distinct, stable, and cannot escape the jail root', () => {
  const a = mcp._bridgeJailDir('linear');
  const b = mcp._bridgeJailDir('notion');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, mcp._bridgeJailDir('linear'), 'stable across calls');
  // The security property is containment: whatever the name, the RESOLVED
  // dir stays strictly under mcp-jail. Dot-only names are the path.join
  // escape this pins against.
  const jailRoot = path.resolve(path.join(process.env.HOME || os.homedir(), '.troth', 'mcp-jail'));
  for (const name of ['../../../etc', '..', '.', '', 'a/b/c', 'api.example']) {
    const dir = path.resolve(mcp._bridgeJailDir(name));
    assert.ok(dir !== jailRoot && dir.indexOf(jailRoot + path.sep) === 0,
      'name ' + JSON.stringify(name) + ' escaped to ' + dir);
  }
});

const avail = sb.isAvailable();
if (!avail.available) {
  // See suite-25: a top-level skip() throws past the harness and kills the run.
  test('MCPCHILD-4: live jailed stdio child (darwin-only)',
       () => skip('sandbox-exec unavailable: ' + (avail.error || '?')));
} else {
  test('MCPCHILD-4: a long-lived jailed child holds a stdio conversation but cannot read outside', async () => {
    const root   = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mcpjail-'));
    const jail   = path.join(root, 'bridge');
    const secret = path.join(root, 'secret.txt');
    fs.mkdirSync(jail, { recursive: true });
    fs.writeFileSync(secret, 'outside-the-walls');

    const jspec = sb.jailSpawnSpec({ cwd: jail, network: 'none' });
    assert.strictEqual(jspec.ok, true, 'jail spec built: ' + (jspec.error || ''));

    // The child is the bridge's shape: reads lines on stdin, answers on
    // stdout, stays alive between messages. On "read" it attempts the
    // outside file and reports what the kernel said. NB the \n in the
    // strings below are double-escaped: the CHILD's parser receives them.
    const childSrc = [
      'process.stdin.setEncoding("utf8");',
      'let buf = "";',
      'process.stdin.on("data", (d) => {',
      '  buf += d;',
      '  let i;',
      '  while ((i = buf.indexOf("\\n")) !== -1) {',
      '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
      '    if (line === "ping") process.stdout.write("pong\\n");',
      '    if (line === "read") {',
      '      try { require("fs").readFileSync(' + JSON.stringify(secret) + ', "utf8"); process.stdout.write("READ_OK\\n"); }',
      '      catch (e) { process.stdout.write("READ_DENIED:" + e.code + "\\n"); }',
      '    }',
      '    if (line === "quit") process.exit(0);',
      '  }',
      '});'
    ].join('\n');
    const proc = spawn(jspec.exec, jspec.args.concat([process.execPath, '-e', childSrc]),
                       { stdio: ['pipe', 'pipe', 'pipe'], env: jspec.env });
    let out = '';
    let errOut = '';
    proc.stderr.on('data', (d) => { errOut += d; });
    const gotLines = (n) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('child never answered; stderr: ' + errOut.slice(0, 300))), 15000);
      proc.stdout.on('data', (d) => {
        out += d;
        const lines = out.split('\n').filter(Boolean);
        if (lines.length >= n) { clearTimeout(t); resolve(lines); }
      });
    });

    proc.stdin.write('ping\n');
    proc.stdin.write('read\n');
    let lines;
    try {
      lines = await gotLines(2);
    } finally {
      try { proc.stdin.write('quit\n'); } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
    assert.strictEqual(lines[0], 'pong', 'stdio conversation works inside the jail');
    assert.ok(/^READ_DENIED:EPERM/.test(lines[1]), 'outside read refused, got: ' + lines[1]);
  });
}
};
