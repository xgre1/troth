#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// task: one brief delegated to a child turn with its own conversation, a
// reduced tool set and no writes; the answer comes back as the tool result,
// the child's text never reaches the surface; a named engine routes the child.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');
const task = require('../shared-core/tools/task.js');
const permission = require('../shared-core/tools/permission.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// The transport both turns meet. A parent turn (the operator asks to
// delegate) calls task; the child turn (its user text is the brief) reads the
// workspace marker; every tool result is echoed back inside ECHO<...>.
const TRANSPORT_SRC = [
  "'use strict';",
  "module.exports = {",
  "  stream: async function* (req) {",
  "    const messages = Array.isArray(req && req.messages) ? req.messages : [];",
  "    const last = messages[messages.length - 1] || {};",
  "    if (last.role === 'tool') { yield { delta: 'ECHO<' + String(last.content || '') + '>' }; yield { done: true }; return; }",
  "    let userText = '';",
  "    for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m && m.role === 'user' && typeof m.content === 'string') { userText = m.content; break; } }",
  "    const ctxEnd = userText.lastIndexOf('</turn_context>');",
  "    const opText = ctxEnd >= 0 ? userText.slice(ctxEnd + '</turn_context>'.length) : userText;",
  "    const sys = messages.find((m) => m && m.role === 'system');",
  "    const sysText = (sys && typeof sys.content === 'string') ? sys.content : '';",
  "    const cwdMatch = sysText.match(/; cwd=([^\\s;]+)/);",
  "    const cwd = cwdMatch ? cwdMatch[1].replace(/\\.$/, '') : null;",
  "    const engineMatch = opText.match(/\\[engine:([a-z]+)\\]/);",
  "    if (/DELEGATE/.test(opText)) {",
  "      const args = { brief: 'BRIEF read marker.txt in the workspace and report its content', tools: 'read-only' };",
  "      if (engineMatch) args.engine = engineMatch[1];",
  "      yield { tool_calls: [{ id: 'task_1', function: { name: 'task', arguments: JSON.stringify(args) } }] };",
  "      yield { done: true }; return;",
  "    }",
  "    if (/^BRIEF/.test(opText.trim()) && cwd) {",
  "      yield { tool_calls: [{ id: 'child_read_1', function: { name: 'Read', arguments: JSON.stringify({ file_path: cwd + '/marker.txt' }) } }] };",
  "      yield { done: true }; return;",
  "    }",
  "    yield { delta: 'PLAIN ' + opText.slice(0, 60) };",
  "    yield { done: true };",
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
  console.log('task-tool');

  await t('the tool is registered as a read tool behind the door, with a schema', () => {
    const toolRunner = require('../shared-core/tools/runner.js');
    // Delegation is not an everyday tool: it stays out of the lean core set
    // and is loaded through tool_load, whose description names it.
    assert.ok(!toolRunner.CORE_TOOL_NAMES.has('task'), 'not in the core set');
    const all = toolRunner.unifiedToolsArray().map((s) => s.function && s.function.name);
    assert.ok(all.includes('task'), 'on the unified surface');
    const door = toolRunner.coreToolsArray().find((s) => s.function && s.function.name === 'tool_load');
    assert.ok(door && /\btask\b/.test(JSON.stringify(door)), 'the door names task');
    assert.strictEqual(permission.classify('task'), 'read');
    assert.deepStrictEqual(task.schema.function.parameters.required, ['brief']);
  });

  await t('without a runtime that can spawn a turn the tool says so; a delegate cannot delegate; the brief is required', async () => {
    const none = await task.run({ brief: 'x' }, {});
    assert.strictEqual(none.error, 'unavailable');
    const deep = await task.run({ brief: 'x' }, { spawn_turn: async () => ({ ok: true, text: 'no' }), task_depth: 1 });
    assert.strictEqual(deep.error, 'task_depth');
    const blank = await task.run({ brief: '   ' }, { spawn_turn: async () => ({ ok: true, text: 'no' }) });
    assert.strictEqual(blank.error, 'missing_brief');
  });

  await t('the request to the runtime carries the brief, the engine word, the tool set and the time box; the reply is shaped for the model', async () => {
    let seen = null;
    const spawn_turn = async (req) => { seen = req; return { ok: true, text: 'the answer', engine: req.engine, conversation_id: 'p:task:1' }; };
    const r = await task.run({ brief: '  find it  ', engine: ' Local ', tools: 'general', max_minutes: 3 }, { spawn_turn });
    assert.strictEqual(seen.brief, 'find it');
    assert.strictEqual(seen.engine, 'local');
    assert.strictEqual(seen.tools, 'general');
    assert.strictEqual(seen.tool_names, null, 'general leaves the tool list to the runtime');
    assert.strictEqual(seen.max_ms, 3 * 60000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'the answer');
    assert.strictEqual(r.engine, 'local');
    assert.strictEqual(r.conversation_id, 'p:task:1');
    const ro = await task.run({ brief: 'look', max_minutes: 99 }, { spawn_turn });
    assert.deepStrictEqual(seen.tool_names, task.READ_ONLY_TOOLS, 'read-only names the read tools');
    assert.strictEqual(seen.max_ms, task.MAX_MINUTES * 60000, 'the time box is capped');
    assert.strictEqual(ro.tools, 'read-only');
    const bad = await task.run({ brief: 'look' }, { spawn_turn: async () => { throw new Error('boom'); } });
    assert.strictEqual(bad.error, 'task_failed');
    const refused = await task.run({ brief: 'look' }, { spawn_turn: async () => ({ ok: false, error: 'busy', hint: 'wait' }) });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error, 'busy');
  });

  await t('over the wire: the child runs as its own conversation, reads the workspace, its text comes back through the parent; nothing of the child streams to the surface', async () => {
    const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-task-tx-'));
    const txPath = path.join(txDir, 'task-transport.js');
    fs.writeFileSync(txPath, TRANSPORT_SRC);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-task-ws-'));
    const token = 'MARKER_TOKEN_' + Math.random().toString(36).slice(2, 10);
    fs.writeFileSync(path.join(ws, 'marker.txt'), token);
    const A = 'task-wire-A';
    try {
      const { events, stderr } = await runDaemon([
        { type: 'user_input', input: { text: 'please DELEGATE the marker read' }, options: { conversation_id: A, workspace: ws } }
      ], 120000, { TROTH_ENTITY_LLM: txPath, TROTH_ENTITY_LLM_PIN: '1' });
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes('ready'), 'daemon ready; stderr tail: ' + stderr.slice(-300));
      const childId = A + ':task:1';
      const req = events.find((e) => e.kind === 'tool_request' && e.conversation_id === A && e.name === 'task');
      assert.ok(req, 'the parent asked for a task; kinds: ' + kinds.join(','));
      const childDispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === childId);
      assert.ok(childDispatch.length >= 1, 'the child dispatched under its own id; got ' + JSON.stringify(events.filter((e) => e.kind === 'dispatch')));
      const childRead = events.find((e) => e.kind === 'tool_request' && e.conversation_id === childId && e.name === 'Read');
      assert.ok(childRead, 'the child read the marker under its own id');
      assert.ok(!events.some((e) => e.kind === 'response' && e.conversation_id === childId), 'the child emits no response frame');
      assert.ok(!events.some((e) => e.kind === 'text_delta' && e.conversation_id === childId), 'the child streams nothing');
      assert.ok(!events.some((e) => e.kind === 'served' && e.conversation_id === childId), 'the child emits no served frame');
      const resp = events.find((e) => e.kind === 'response' && e.conversation_id === A);
      assert.ok(resp, 'the parent answered; kinds: ' + kinds.join(','));
      assert.strictEqual(resp.status, 'ok', 'parent status ok, got ' + resp.status + '/' + resp.reason);
      assert.ok(String(resp.text).includes(token), 'the marker came back through the parent; text: ' + String(resp.text).slice(0, 300));
      assert.ok(String(resp.text).includes('"ok":true'), 'the task result says ok; text: ' + String(resp.text).slice(0, 300));
      assert.ok(String(resp.text).includes(childId), 'the task result names the child conversation');
    } finally {
      for (const d of [txDir, ws]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    }
  });

  await t('over the wire: a named engine routes the child there and the parent hears the outcome', async () => {
    // Not pinned, so llamacpp is the auto-wired backstop with no server behind
    // it; the parent names its own transport as an explicit hint the way a
    // pinned pane does. The child dispatches to the backstop (the proof of
    // routing) and the parent hears whatever came of it.
    const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-task-tx-'));
    const txPath = path.join(txDir, 'task-transport.js');
    fs.writeFileSync(txPath, TRANSPORT_SRC);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-task-ws-'));
    fs.writeFileSync(path.join(ws, 'marker.txt'), 'x');
    const A = 'task-wire-B';
    try {
      const { events, stderr } = await runDaemon([
        { type: 'user_input', input: { text: 'please DELEGATE the marker read [engine:local]' }, options: { conversation_id: A, workspace: ws, transport_hint: txPath } }
      ], 120000, { TROTH_ENTITY_LLM: txPath });
      const childId = A + ':task:1';
      const childDispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === childId);
      assert.ok(childDispatch.some((e) => e.faculty === 'llamacpp' && e.engine_override === 'local'),
        'the child dispatched to llamacpp with engine_override local; got ' + JSON.stringify(childDispatch) + '; stderr tail: ' + stderr.slice(-200));
      const resp = events.find((e) => e.kind === 'response' && e.conversation_id === A);
      assert.ok(resp, 'the parent answered');
      assert.ok(String(resp.text).includes('"engine":"local"'), 'the task result names the engine; text: ' + String(resp.text).slice(0, 300));
      const parentDispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
      assert.ok(parentDispatch.every((e) => e.faculty !== 'llamacpp'), 'the parent stayed on its own engine');
    } finally {
      for (const d of [txDir, ws]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    }
  });

  console.log('\ntask-tool: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
