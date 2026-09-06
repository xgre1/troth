#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// hashline_write: creates a file, refuses to replace one without the flag,
// validates the content before it touches disk, and refuses operator-only
// destinations. The validator asks the project's own TypeScript for a second
// opinion on TS/TSX that tree-sitter rejects.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-hashline', 'server.mjs');
const astValidate = require(path.join(__dirname, '..', 'shared-core', 'ast-validate.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

function client(env) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, env || {}) });
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
    const timer = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    pending.set(myId, (m) => { clearTimeout(timer); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const text = ((m.result && m.result.content) || []).filter((b) => b && b.text && !/^\[troth\] Substrate active/.test(b.text)).map((b) => b.text).join('\n');
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { text, json: j, isError: !!(m.result && m.result.isError) };
  };
  const init = () => rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const list = async () => { const m = await rpc('tools/list', {}); return (m.result && m.result.tools || []).map((x) => x.name); };
  return { call, init, list, kill: () => { try { proc.kill('SIGKILL'); } catch (_) {} } };
}

console.log('\n=== hashline_write ===\n');

(async () => {
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hlw-'));
  const c = client({});
  try {
    await c.init();
    await t('the server offers hashline_write beside read and edit', async () => {
      const names = await c.list();
      assert.deepStrictEqual(names.sort(), ['hashline_edit', 'hashline_read', 'hashline_write']);
    });
    await t('a new file lands, parsed, with its size and line count reported', async () => {
      const fp = path.join(work, 'lib', 'one.js');
      const r = await c.call('hashline_write', { file_path: fp, content: 'module.exports = { a: 1 };\n' });
      assert.ok(r.json && r.json.ok, r.text.slice(0, 200));
      assert.strictEqual(r.json.created, true);
      assert.strictEqual(r.json.lines, 2);
      assert.strictEqual(r.json.ast_ok, true);
      assert.strictEqual(fs.readFileSync(fp, 'utf8'), 'module.exports = { a: 1 };\n');
    });
    await t('an existing file is refused without overwrite, and replaced with it', async () => {
      const fp = path.join(work, 'lib', 'one.js');
      const refused = await c.call('hashline_write', { file_path: fp, content: 'module.exports = { a: 2 };\n' });
      assert.strictEqual(refused.json && refused.json.error, 'exists');
      assert.ok(/hashline_edit/.test(refused.json.hint), 'the refusal names the edit road');
      assert.strictEqual(fs.readFileSync(fp, 'utf8'), 'module.exports = { a: 1 };\n', 'nothing was written');
      const ok = await c.call('hashline_write', { file_path: fp, content: 'module.exports = { a: 2 };\n', overwrite: true });
      assert.ok(ok.json && ok.json.ok && ok.json.created === false, ok.text.slice(0, 200));
      assert.strictEqual(fs.readFileSync(fp, 'utf8'), 'module.exports = { a: 2 };\n');
    });
    await t('content that does not parse never touches disk', async () => {
      const fp = path.join(work, 'broken.js');
      const r = await c.call('hashline_write', { file_path: fp, content: 'function ( {\n' });
      assert.strictEqual(r.json && r.json.error, 'ast_parse_failed');
      assert.strictEqual(fs.existsSync(fp), false);
    });
    await t('a destination the policy keeps for the operator is refused', async () => {
      const fp = path.join(process.env.HOME, '.troth', 'config.json');
      const r = await c.call('hashline_write', { file_path: fp, content: '{}' });
      assert.strictEqual(r.json && r.json.error, 'blocked_destination', r.text.slice(0, 200));
    });
    await t('TS/TSX that tree-sitter rejects is accepted when the project\'s TypeScript parses it clean', async () => {
      const proj = path.join(work, 'tsproj');
      fs.mkdirSync(path.join(proj, 'node_modules', 'typescript'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '0.0.0-stub', main: 'index.js' }));
      fs.writeFileSync(path.join(proj, 'node_modules', 'typescript', 'index.js'),
        'module.exports = { ScriptTarget: { Latest: 99 }, ScriptKind: { TS: 3, TSX: 4 }, createSourceFile: (n, src) => ({ parseDiagnostics: /BROKEN/.test(src) ? [{}] : [] }) };\n');
      const tsx = path.join(proj, 'Card.tsx');
      const good = 'export function C() { return <h3 className="x">Privacy & Data</h3>; }\n';
      const r = await c.call('hashline_write', { file_path: tsx, content: good });
      assert.ok(r.json && r.json.ok, r.text.slice(0, 300));
      const direct = astValidate.validate(tsx, good);
      assert.strictEqual(direct.ok, true);
      assert.strictEqual(direct.via, 'typescript');
      const bad = astValidate.validate(tsx, 'export const x: import("./slash").T[] = BROKEN;\n');
      assert.strictEqual(bad.ok, false, 'a second opinion that also fails keeps the rejection');
    });
    await t('without a TypeScript in the project the tree-sitter verdict stands', async () => {
      const lone = path.join(work, 'lone', 'Card.tsx');
      fs.mkdirSync(path.dirname(lone), { recursive: true });
      const r = astValidate.validate(lone, 'export function C() { return <h3 className="x">Privacy & Data</h3>; }\n');
      assert.strictEqual(r.ok, false);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    });
  } finally { c.kill(); }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  console.log('\nhashline-write: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
