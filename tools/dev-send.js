#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// DEV-ONLY: send chat message(s) to the Troth entity AS IF a user typed them,
// over the SAME loopback socket + SAME "user_input" action the GUI's
// consumer_chat_send uses (the app control channel). Spawns a daemon entity (same
// core + same ~/.troth substrate) and captures the emitted event stream. Lets
// dev verify chat/team/autonomy flows end-to-end without manual GUI typing.
// Usage: node tools/dev-send.js "msg one ||| go"   (||| separates sequential turns)
const fs = require('fs'), net = require('net'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const CORE = path.resolve(__dirname, '..');
const ENTITY = path.join(CORE, 'bin', 'troth-entity.js');
const STATE = '/tmp/troth-dev-entity-state.json';
const WORKSPACE = process.env.DEV_SEND_CWD || '/tmp/troth-dev-ws';
const MSGS = (process.argv.slice(2).join(' ') || 'hello').split('|||').map(s => s.trim()).filter(Boolean);
function loadEnv() {
  const env = Object.assign({}, process.env);
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.troth', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return env;
}
const readPort = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).port; } catch (_) { return null; } };
(async function () {
  try { fs.mkdirSync(WORKSPACE, { recursive: true }); } catch (_) {}
  try { fs.unlinkSync(STATE); } catch (_) {}
  const env = loadEnv(); env.TROTH_ENTITY_DAEMON = '1'; env.TROTH_ENTITY_STATE_FILE = STATE;
  const child = spawn('node', [ENTITY], { cwd: WORKSPACE, env, stdio: ['ignore', 'ignore', 'inherit'] });
  let port = null;
  for (let i = 0; i < 40 && !port; i++) { await new Promise(r => setTimeout(r, 500)); port = readPort(); }
  if (!port) { console.error('FAIL: entity did not come up (no port)'); child.kill(); process.exit(2); }
  console.log('[dev-send] entity up 127.0.0.1:' + port + ' pid ' + child.pid + ' cwd ' + WORKSPACE + '\n');
  const sock = net.connect(port, '127.0.0.1'); sock.setEncoding('utf8');
  let buf = '', lastEvt = Date.now(), turnDone = false, qi = 0;
  const IDLE_MS = 75000;
  const sendNext = () => {
    if (qi >= MSGS.length) return;
    const text = MSGS[qi++]; turnDone = false;
    sock.write(JSON.stringify({ type: 'user_input', input: { text }, parent_id: null, options: { agentic: true, audio: false, auto_write: true } }) + '\n');
    console.log('\n>>> USER: ' + JSON.stringify(text));
  };
  sock.on('connect', sendNext);
  sock.on('data', d => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue; lastEvt = Date.now();
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      const k = e.kind || e.type;
      if (k === 'text_delta') process.stdout.write(e.content || '');
      else if (k === 'response') { console.log('\n[RESPONSE reason=' + (e.reason || '?') + ' done=' + e.done + '] ' + String(e.text || '').slice(0, 700)); turnDone = true; if (qi < MSGS.length) setTimeout(sendNext, 1500); }
      else if (k === 'worker_event') console.log('\n  [WORKER] ' + JSON.stringify(e).slice(0, 300));
      else if (k === 'escalation') { console.log('\n[ESCALATION/PLAN] ' + String(e.question || '').slice(0, 900)); turnDone = true; if (qi < MSGS.length) setTimeout(sendNext, 1500); }
      else if (k === 'dispatch' || k === 'error' || k === 'served') console.log('\n  [' + k + '] ' + JSON.stringify(e).slice(0, 220));
    }
  });
  const iv = setInterval(() => {
    if (qi >= MSGS.length && turnDone) { clearInterval(iv); console.log('\n[dev-send] all turns done.'); try { sock.end(); } catch (_) {} child.kill(); process.exit(0); }
    if (Date.now() - lastEvt > IDLE_MS) { clearInterval(iv); console.log('\n[dev-send] idle timeout.'); try { sock.end(); } catch (_) {} child.kill(); process.exit(0); }
  }, 1000);
})();
