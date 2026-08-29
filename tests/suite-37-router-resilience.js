// SPDX-License-Identifier: AGPL-3.0-only
// A memory that cannot start must not look like a memory that is empty.
//
// Field report: an operator asked about work discussed months
// earlier and explicitly told the agent to use the router. The agent tried,
// got a bare transport error, concluded the substrate held nothing, and spent
// ~100k tokens grepping uploaded files instead. The router.json on that
// machine was CORRECT — so the cause was downstream startup, and the only
// thing the model saw was "init timeout on troth-substrate".
//
// The cure is not one root cause (ABI mismatch, moved checkout, permissions —
// they all land here). It is that the failure must ANNOUNCE itself in words
// the model cannot mistake for absence, and carry the child's own stderr so a
// human can act on it.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');

console.log('\nRouter resilience (RTR):');

const ROUTER = path.join(ROOT, 'plugin', 'mcp-servers', 'troth-router', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-'));

// Ask the router for memory over a downstream that dies on startup, the way a
// native-module mismatch dies.
//
// spawn, not spawnSync: the suite shares one process with tests that measure
// wall-clock deadlines against their own child processes, and a synchronous
// spawn freezes the event loop for its whole duration — which made a
// neighbouring MCP test time out at 3s while this one waited on node startup.
// A test must not be able to fail its neighbour.
const askRouter = (routerCfg, toolCall) => new Promise((resolve) => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: toolCall })
  ].join('\n') + '\n';
  const child = spawn(process.execPath, [ROUTER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TROTH_ROUTER_CONFIG: routerCfg })
  });
  let stdout = '';
  let answered = false;
  const finish = (v) => { if (answered) return; answered = true; clearTimeout(timer); try { child.kill(); } catch (_) {} resolve(v); };
  const timer = setTimeout(() => finish(null), 60000);
  child.stdout.on('data', (d) => {
    stdout += d.toString();
    let idx;
    while ((idx = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, idx);
      stdout = stdout.slice(idx + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.id === 2) finish(m);
    }
  });
  child.stderr.resume();
  // spawnSync carried the request in `input`; an async spawn must write it.
  try { child.stdin.write(lines); child.stdin.end(); } catch (_) { finish(null); }
  child.on('error', () => finish(null));
  child.on('close', () => finish(null));
});

test('RTR-1: a downstream that dies on startup reports WHY, and forbids the file-grep fallback', async () => {
  const broken = path.join(TMP, 'broken.mjs');
  fs.writeFileSync(broken,
    'console.error("Error: The module \'/x/better_sqlite3.node\' was compiled against a different ' +
    'Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.");\n' +
    'process.exit(1);\n');
  const cfg = path.join(TMP, 'router-broken.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'troth-substrate': { command: process.execPath, args: [broken] } } }));

  const msg = await askRouter(cfg, { name: 'troth_recall', arguments: { query: 'what did we decide' } });
  assert.ok(msg && msg.error, 'the call reports an error rather than an empty result: ' + JSON.stringify(msg));
  const text = String(msg.error.message || '');
  assert.ok(/CONFIGURED but did not start/.test(text), 'it says configured-but-down, not missing: ' + text.slice(0, 160));
  assert.ok(/do not fall back to grepping files/i.test(text), 'it forbids the fallback that cost the field report: ' + text.slice(0, 160));
  assert.ok(/troth doctor/.test(text), 'it names the command a human should run');
  assert.ok(/rebuild better-sqlite3/.test(text), 'the native-module case gets its specific fix: ' + text.slice(0, 260));
  assert.ok(/exit code 1/.test(text), 'and the child\'s real exit is carried: ' + text.slice(-120));
});

test('RTR-2: an UNCONFIGURED substrate names what is configured and how to reprovision', async () => {
  const cfg = path.join(TMP, 'router-empty.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'something-else': { command: process.execPath, args: ['-e', '0'] } } }));
  const msg = await askRouter(cfg, { name: 'mcp_call', arguments: { server: 'troth-substrate', tool: 'troth_recall', args: { query: 'x' } } });
  assert.ok(msg && msg.error, 'errors rather than answering emptily');
  const text = String(msg.error.message || '');
  assert.ok(/unknown downstream server/.test(text), text.slice(0, 120));
  assert.ok(/something-else/.test(text), 'it lists what IS configured: ' + text.slice(0, 160));
  assert.ok(/install-plugin/.test(text), 'and names the reprovision path: ' + text.slice(0, 200));
});

test('RTR-3: a healthy downstream is unaffected', async () => {
  // A minimal well-behaved MCP child: answers initialize and tools/call.
  const good = path.join(TMP, 'good.mjs');
  fs.writeFileSync(good, [
    "let b='';process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;",
    "const m=JSON.parse(l);",
    "if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'x',version:'1'}}})+'\\n');",
    "else if(m.method==='tools/call')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'{\\\"items\\\":[]}'}]}})+'\\n');",
    "}});"
  ].join(''));
  const cfg = path.join(TMP, 'router-good.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'troth-substrate': { command: process.execPath, args: [good] } } }));
  const msg = await askRouter(cfg, { name: 'troth_recall', arguments: { query: 'x' } });
  assert.ok(msg && !msg.error, 'a working substrate still answers cleanly: ' + JSON.stringify(msg).slice(0, 200));
});
};
