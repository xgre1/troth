#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// /mode plan: one conversation reads and proposes while writes and commands
// refuse and name /mode build; other conversations keep building; the choice
// survives a reload; the CLI frames carry the mode.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const { DETERMINISTIC_HANDLERS: H } = require('../shared-core/slash/executor.js');
const parser = require('../shared-core/slash/parser.js');
const mo = require('../shared-core/mode-override.js');
const permission = require('../shared-core/tools/permission.js');
const ctxFor = (cid) => ({ agent_id: 'mode-test', cwd: null, user_id: 'op', conversation_id: cid });

// The transport a plan-mode turn meets: it asks for one Write into the turn's
// workspace, then echoes whatever the tool answered.
const TRANSPORT_SRC = [
  "'use strict';",
  "module.exports = {",
  "  stream: async function* (req) {",
  "    const messages = Array.isArray(req && req.messages) ? req.messages : [];",
  "    const last = messages[messages.length - 1] || {};",
  "    if (last.role === 'tool') { yield { delta: 'TOOL<' + String(last.content || '') + '>' }; yield { done: true }; return; }",
  "    const sys = messages.find((m) => m && m.role === 'system');",
  "    const sysText = (sys && typeof sys.content === 'string') ? sys.content : '';",
  "    const cwdMatch = sysText.match(/; cwd=([^\\s;]+)/);",
  "    const cwd = cwdMatch ? cwdMatch[1].replace(/\\.$/, '') : null;",
  "    if (!cwd) { yield { delta: 'NOCWD' }; yield { done: true }; return; }",
  "    yield { tool_calls: [{ id: 'mode_w1', function: { name: 'Write', arguments: JSON.stringify({ file_path: cwd + '/probe.txt', content: 'written' }) } }] };",
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
  console.log('mode-plan');
  mo._reset();

  await t('/mode is a registered deterministic handler with a bundled skill', () => {
    assert.strictEqual(typeof H.mode, 'function');
    const skill = require('../shared-core/slash/loader.js').loadAll({ cwd: os.tmpdir() }).get('mode');
    assert.ok(skill, 'bundled skill present');
    assert.strictEqual(skill.kind, 'deterministic');
  });

  await t('/mode plan sets one conversation; another conversation and a bare report see the truth', async () => {
    const on = await H.mode(parser.parse('/mode plan'), ctxFor('pane-A'));
    assert.strictEqual(on.ok, true);
    assert.ok(on.text.startsWith('✓ plan'), 'terse confirm: ' + on.text);
    assert.ok(on.text.includes('/mode build'), 'names the way back');
    assert.deepStrictEqual(on.side_effects.mode_override, { conversation_id: 'pane-A', mode: 'plan' });
    assert.strictEqual(mo.get('pane-A'), 'plan');
    assert.strictEqual(mo.get('pane-B'), null, 'another pane keeps building');
    const repA = await H.mode(parser.parse('/mode'), ctxFor('pane-A'));
    assert.ok(repA.text.startsWith('plan'), 'report names plan: ' + repA.text);
    assert.ok(repA.options.find((o) => o.value === '/mode plan').current === true);
    const repB = await H.mode(parser.parse('/mode'), ctxFor('pane-B'));
    assert.ok(repB.text.startsWith('build'), 'other pane reports build: ' + repB.text);
  });

  await t('/mode build clears it; an unknown word is refused; the untagged surface has its own bucket', async () => {
    const off = await H.mode(parser.parse('/mode build'), ctxFor('pane-A'));
    assert.strictEqual(off.ok, true);
    assert.ok(off.text.startsWith('✓ build'));
    assert.strictEqual(mo.get('pane-A'), null);
    const bad = await H.mode(parser.parse('/mode yolo'), ctxFor('pane-A'));
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'unknown_mode');
    const cli = await H.mode(parser.parse('/mode plan'), ctxFor(null));
    assert.ok(cli.text.includes('this terminal surface'), 'untagged scope wording: ' + cli.text);
    assert.strictEqual(mo.get(null), 'plan');
    assert.strictEqual(mo.get('pane-A'), null, 'a pane is not the terminal surface');
    mo.clear(null);
  });

  await t('the choice survives a reload from disk', () => {
    mo.set('pane-P', 'plan');
    mo._reload();
    assert.strictEqual(mo.get('pane-P'), 'plan');
    mo.clear('pane-P');
    mo._reload();
    assert.strictEqual(mo.get('pane-P'), null);
  });

  await t('the permission gate refuses a forbidden tool with the plan-mode reason and lets reads through', async () => {
    const inner = async () => 'ran';
    const gated = permission.wrapRunner(inner);
    const call = (name) => ({ function: { name, arguments: '{}' } });
    const ctx = { forbidden_tools: mo.PLAN_FORBIDDEN_TOOLS, forbidden_hint: mo.PLAN_FORBIDDEN_HINT, auto_write: false };
    const w = JSON.parse(await gated(call('Write'), ctx));
    assert.strictEqual(w.error, 'capability_scope_violation');
    assert.ok(w.hint.includes('/mode build'), 'the refusal names /mode build: ' + w.hint);
    const b = JSON.parse(await gated(call('Bash'), ctx));
    assert.strictEqual(b.error, 'capability_scope_violation');
    assert.strictEqual(await gated(call('Read'), ctx), 'ran', 'reads pass');
  });

  await t('over the wire: plan mode refuses the Write and names /mode build, another pane keeps writing, the mode survives a daemon restart, /mode build lets the Write land', async () => {
    // Deterministic commands apply the moment the daemon reads them, ahead of
    // the queued turns, so each phase is its own daemon run: exactly what an
    // operator does, one command, then the turns that follow it.
    const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-mode-tx-'));
    const txPath = path.join(txDir, 'mode-transport.js');
    fs.writeFileSync(txPath, TRANSPORT_SRC);
    const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'troth-mode-ws-'));
    const wsA = mk(), wsB = mk(), wsA2 = mk(), wsA3 = mk();
    const env = { TROTH_ENTITY_LLM: txPath, TROTH_ENTITY_LLM_PIN: '1', TROTH_ENTITY_AUTO_WRITE: '1' };
    const A = 'mode-wire-A', B = 'mode-wire-B';
    const turn = (cid, ws) => ({ type: 'user_input', input: { text: 'write the probe please' }, options: { conversation_id: cid, workspace: ws } });
    const cmd = (cid, text) => ({ type: 'user_input', input: { text }, options: { conversation_id: cid } });
    try {
      // Run 1: plan on for A; A is refused, B writes.
      const r1 = await runDaemon([cmd(A, '/mode plan'), turn(A, wsA), turn(B, wsB)], 90000, env);
      const k1 = r1.events.map((e) => e.kind);
      assert.ok(k1.includes('ready'), 'run 1 ready; stderr tail: ' + r1.stderr.slice(-300));
      const slash = r1.events.find((e) => e.kind === 'slash_resolved' && e.conversation_id === A);
      assert.ok(slash && slash.mode === 'plan', 'the slash frame carries plan: ' + JSON.stringify(slash));
      const dispA = r1.events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
      assert.ok(dispA.length >= 1 && dispA.every((e) => e.mode === 'plan'), 'A dispatch carries plan; got ' + JSON.stringify(dispA));
      const dispB = r1.events.filter((e) => e.kind === 'dispatch' && e.conversation_id === B);
      assert.ok(dispB.length >= 1 && dispB.every((e) => e.mode === undefined), 'B dispatch carries no mode; got ' + JSON.stringify(dispB));
      const respA = r1.events.find((e) => e.kind === 'response' && e.conversation_id === A && e.faculty !== 'deterministic');
      assert.ok(respA, 'A answered; kinds: ' + k1.join(','));
      assert.ok(/capability_scope_violation/.test(respA.text), 'plan turn: the Write was refused; text: ' + String(respA.text).slice(0, 300));
      assert.ok(/\/mode build/.test(respA.text), 'plan turn: the refusal names /mode build');
      assert.strictEqual(respA.status, 'ok', 'the turn still answers');
      assert.ok(!fs.existsSync(path.join(wsA, 'probe.txt')), 'plan turn: nothing was written');
      assert.ok(fs.existsSync(path.join(wsB, 'probe.txt')), 'pane B keeps building; stderr tail: ' + r1.stderr.slice(-300));
      // Run 2: a fresh daemon; A is still in plan mode from disk.
      const r2 = await runDaemon([turn(A, wsA2)], 90000, env);
      const d2 = r2.events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
      assert.ok(d2.length >= 1 && d2.every((e) => e.mode === 'plan'), 'after a restart A is still in plan; got ' + JSON.stringify(d2));
      assert.ok(!fs.existsSync(path.join(wsA2, 'probe.txt')), 'after a restart the Write is still refused');
      // Run 3: /mode build, then the Write lands.
      const r3 = await runDaemon([cmd(A, '/mode build'), turn(A, wsA3)], 90000, env);
      const s3 = r3.events.find((e) => e.kind === 'slash_resolved' && e.conversation_id === A);
      assert.ok(s3 && s3.mode === 'build', 'the slash frame carries build: ' + JSON.stringify(s3));
      const d3 = r3.events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
      assert.ok(d3.length >= 1 && d3.every((e) => e.mode === undefined), 'the build turn carries no mode; got ' + JSON.stringify(d3));
      assert.ok(fs.existsSync(path.join(wsA3, 'probe.txt')), 'after /mode build the Write lands; stderr tail: ' + r3.stderr.slice(-300));
    } finally {
      for (const d of [txDir, wsA, wsB, wsA2, wsA3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    }
  });

  mo._reset();
  console.log('\nmode-plan: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
