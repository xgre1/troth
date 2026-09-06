#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// todo_write: the turn's step list, validated, kept with the conversation,
// announced to the surface as a tagged todo_updated frame.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');
const todo = require('../shared-core/tools/todo.js');
const permission = require('../shared-core/tools/permission.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// The transport: names three steps, then reports the first done and the
// second doing, then answers.
const TRANSPORT_SRC = [
  "'use strict';",
  "module.exports = {",
  "  stream: async function* (req) {",
  "    const messages = Array.isArray(req && req.messages) ? req.messages : [];",
  "    const tools = messages.filter((m) => m && m.role === 'tool').length;",
  "    if (tools === 0) { yield { tool_calls: [{ id: 'todo_1', function: { name: 'todo_write', arguments: JSON.stringify({ items: [{ text: 'read the file', status: 'doing' }, { text: 'change the line', status: 'pending' }, { text: 'run the tests', status: 'pending' }] }) } }] }; yield { done: true }; return; }",
  "    if (tools === 1) { yield { tool_calls: [{ id: 'todo_2', function: { name: 'todo_write', arguments: JSON.stringify({ items: [{ text: 'read the file', status: 'done' }, { text: 'change the line', status: 'doing' }, { text: 'run the tests', status: 'pending' }] }) } }] }; yield { done: true }; return; }",
  "    yield { delta: 'DONE' }; yield { done: true };",
  "  },",
  "  abort: () => {}",
  "};",
  ""
].join('\n');

function runDaemon(lines, timeoutMs, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTITY], {
      cwd: process.cwd(),
      env: Object.assign({}, process.env, { TROTH_ENTITY_LLM: 'echo', TROTH_LLAMA_SERVER_BIN: '/nonexistent-no-fetch' }, extraEnv || {}),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const events = []; let out = ''; let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString(); let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim(); out = out.slice(nl + 1);
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('daemon timed out; stderr tail: ' + err.slice(-400))); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.trim();
      if (tail) { try { events.push(JSON.parse(tail)); } catch (_) {} }
      resolve({ events, stderr: err, code });
    });
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    child.stdin.end();
  });
}

(async () => {
  console.log('todo-tool');

  await t('registered as a read tool; the list is validated and summarised', async () => {
    assert.strictEqual(permission.classify('todo_write'), 'read');
    const none = await todo.run({ items: [{ text: 'x', status: 'doing' }] }, {});
    assert.strictEqual(none.error, 'unavailable');
    assert.strictEqual(todo.normalise('nope').error, 'items_not_array');
    assert.strictEqual(todo.normalise([{ text: '  ', status: 'doing' }]).error, 'empty_step');
    assert.strictEqual(todo.normalise(new Array(todo.MAX_ITEMS + 1).fill({ text: 'a', status: 'pending' })).error, 'too_many_items');
    const n = todo.normalise([{ text: '  read   it ', status: 'done' }, { text: 'change it', status: 'bogus' }, { text: 'x'.repeat(200), status: 'pending' }]);
    assert.deepStrictEqual(n.items[0], { text: 'read it', status: 'done' });
    assert.strictEqual(n.items[1].status, 'pending', 'an unknown status reads as pending');
    assert.strictEqual(n.items[2].text.length, todo.MAX_TEXT);
    const s = todo.summary([{ text: 'a', status: 'done' }, { text: 'b', status: 'doing' }, { text: 'c', status: 'pending' }]);
    assert.deepStrictEqual(s, { total: 3, done: 1, current: 'b', all_done: false });
    assert.strictEqual(todo.summary([{ text: 'a', status: 'done' }, { text: 'c', status: 'pending' }]).current, 'c', 'nothing doing: the next pending step is current');
    assert.strictEqual(todo.summary([{ text: 'a', status: 'done' }]).all_done, true);
    let got = null;
    const r = await todo.run({ items: [{ text: 'a', status: 'done' }, { text: 'b', status: 'doing' }] }, { todo_set: async (items, sum) => { got = { items, sum }; } });
    assert.deepStrictEqual(r, { ok: true, total: 2, done: 1, current: 'b', all_done: false });
    assert.strictEqual(got.items.length, 2);
  });

  await t('over the wire: each todo_write lands as a tagged todo_updated frame with the counts; the turn still answers', async () => {
    const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-todo-tx-'));
    const txPath = path.join(txDir, 'todo-transport.js');
    fs.writeFileSync(txPath, TRANSPORT_SRC);
    const A = 'todo-wire-A';
    try {
      const { events, stderr } = await runDaemon([
        { type: 'user_input', input: { text: 'plan it and do it' }, options: { conversation_id: A } }
      ], 90000, { TROTH_ENTITY_LLM: txPath, TROTH_ENTITY_LLM_PIN: '1' });
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes('ready'), 'daemon ready; stderr tail: ' + stderr.slice(-300));
      const ups = events.filter((e) => e.kind === 'todo_updated');
      assert.strictEqual(ups.length, 2, 'two updates; kinds: ' + kinds.join(','));
      assert.ok(ups.every((u) => u.conversation_id === A), 'tagged with the conversation');
      assert.deepStrictEqual({ total: ups[0].total, done: ups[0].done, current: ups[0].current }, { total: 3, done: 0, current: 'read the file' });
      assert.deepStrictEqual({ total: ups[1].total, done: ups[1].done, current: ups[1].current }, { total: 3, done: 1, current: 'change the line' });
      assert.strictEqual(ups[1].items.length, 3);
      assert.strictEqual(ups[1].items[0].status, 'done');
      const resp = events.find((e) => e.kind === 'response' && e.conversation_id === A);
      assert.ok(resp && resp.status === 'ok' && /DONE/.test(resp.text), 'the turn answered: ' + JSON.stringify(resp));
    } finally {
      try { fs.rmSync(txDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  console.log('\ntodo-tool: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
