#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The chat's composer on a real terminal, driven through tmux on a socket of
// its own: a pasted text taller than the screen is shown through a window
// with a marker row and never scrolls into the terminal's history; Ctrl-C
// clears the whole panel; a narrower window redraws one panel with the text
// still in it. Without tmux the run is reported as skipped by the runner.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..');

if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
  console.log('  ○ SKIP cli-screen (needs tmux for a real terminal)');
  process.exit(0);
}

const SOCK = 'troth-screen-' + process.pid;
const SES = 'chat';
const tmux = (args) => spawnSync('tmux', ['-L', SOCK].concat(args), { encoding: 'utf8', timeout: 20000 });
const screen = (history) => String(tmux(['capture-pane', '-p', '-t', SES].concat(history ? ['-S', '-300'] : [])).stdout || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('fs');
const http = require('http');

// A stand-in language faculty: the first call asks for one shell command (a
// long sleep carrying a marker), the call after the tool result answers in
// words. Nothing leaves the machine.
const MARK = 'orphan-probe-' + process.pid;
const FAKE_ENGINE = path.join(process.env.HOME, 'fake-engine.js');
fs.writeFileSync(FAKE_ENGINE, [
  "'use strict';",
  'module.exports = {',
  '  stream: async function* (req) {',
  '    const msgs = Array.isArray(req && req.messages) ? req.messages : [];',
  '    if (msgs.some((m) => m && m.role === "tool")) { yield { delta: "finished" }; yield { done: true }; return; }',
  '    const last = msgs.filter((m) => m && m.role === "user").pop(); const text = String(last && last.content || "");',
  '    if (/plan it/.test(text)) { yield { tool_calls: [{ id: "call_1", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ items: [{ text: "read the file", status: "doing" }, { text: "change the line", status: "pending" }, { text: "run the tests", status: "pending" }] }) } }] }; yield { done: true }; return; }',
  '    const cmd = /quick/.test(text) ? "echo trail-ok" : "sleep 30 && echo ' + MARK + '"; yield { tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: cmd }) } }] };',
  '    yield { done: true };',
  '  },',
  '  abort: () => {}',
  '};'
].join('\n'));
const ENGINE_ENV = 'TROTH_ENTITY_LLM=' + FAKE_ENGINE + ' TROTH_ENTITY_LLM_PIN=1';
// How many processes carry the marker on their command line: the shell that
// runs the sleep, and nothing else once it is gone.
const alive = () => String(spawnSync('pgrep', ['-f', MARK], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).length;
async function untilStarted() { let n = 0; for (let i = 0; i < 40 && !(n = alive()); i++) await sleep(500); return n; }

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

async function startChat(cols, rows, extraEnv) {
  tmux(['kill-server']);
  const env = 'HOME=' + process.env.HOME + ' TROTH_CONFIG_DIR=' + process.env.HOME + '/.troth STATE_DB_PATH=' + process.env.HOME + '/.troth/state.db' + (extraEnv ? ' ' + extraEnv : '');
  const r = tmux(['new-session', '-d', '-s', SES, '-x', String(cols), '-y', String(rows), 'cd ' + process.env.HOME + ' && env ' + env + ' node ' + path.join(REPO, 'bin', 'troth-chat.js') + ' 2>/dev/null']);
  assert.strictEqual(r.status, 0, 'tmux session: ' + (r.stderr || ''));
  for (let i = 0; i < 40; i++) { await sleep(500); if (/╭/.test(screen())) return; }
  throw new Error('the composer did not appear: ' + screen().slice(-300));
}
function pasteBracketed(text) {
  tmux(['set-buffer', '-b', 'pb', text]);
  tmux(['paste-buffer', '-p', '-b', 'pb', '-t', SES]);
}
const line = (i) => i + '. This is pasted point number ' + i + ' of an external list that is long enough to wrap around the composer width several times over.';

console.log('\n=== chat composer on a real terminal ===\n');

(async () => {
  try {
    await startChat(110, 30);

    await t('a paste taller than the screen is windowed with a marker and never scrolls into history', async () => {
      const text = Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n');
      pasteBracketed(text);
      await sleep(1500);
      const s = screen();
      assert.ok(/… \d+ more lines above/.test(s), 'the marker row: ' + s.slice(0, 200));
      const bars = (s.match(/│/g) || []).length / 2;
      assert.ok(bars <= 30, 'the panel fits the screen: ' + bars + ' rows');
      const history = screen(true);
      const scrolled = (history.match(/pasted point/g) || []).length - (s.match(/pasted point/g) || []).length;
      assert.strictEqual(scrolled, 0, 'rows that scrolled into history: ' + scrolled);
    });

    await t('Ctrl-C clears the whole panel and leaves nothing behind', async () => {
      tmux(['send-keys', '-t', SES, 'C-c']);
      await sleep(1500);
      const history = screen(true);
      assert.strictEqual((history.match(/pasted point/g) || []).length, 0, 'leftover rows: ' + history.slice(-300));
      assert.ok(/│\s+│/.test(screen()), 'an empty panel is drawn');
    });

    await t('a short paste then Ctrl-C leaves an empty panel', async () => {
      pasteBracketed('one line\nand another');
      await sleep(1000);
      assert.ok(/one line and another/.test(screen()), 'the paste is in the panel, newlines folded');
      tmux(['send-keys', '-t', SES, 'C-c']);
      await sleep(1000);
      assert.ok(!/one line and another/.test(screen(true)), 'cleared');
    });

    await t('a narrower window redraws one panel with the text still in it', async () => {
      tmux(['send-keys', '-t', SES, 'typed text that stays after a resize']);
      await sleep(800);
      tmux(['resize-window', '-t', SES, '-x', '70', '-y', '30']);
      await sleep(1500);
      const s = screen();
      assert.ok(/typed text that stays after a resize/.test(s), 'the text is still in the panel');
      assert.strictEqual((s.match(/╭/g) || []).length, 1, 'exactly one panel top: ' + (s.match(/╭/g) || []).length);
    });

    // A fake dashboard for the /mcps picker: one active server, a probe that
    // answers connected with two tools, and a log of what was asked.
    const asked = [];
    const proxy = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        asked.push(req.method + ' ' + req.url + ' ' + b);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url === '/api/mcp/servers') { res.end(JSON.stringify({ active: [{ name: 'supabase', transport: 'http', scope: 'general', note: 'the database' }], pending: [] })); return; }
        if (req.method === 'POST' && req.url === '/api/mcp/probe') { res.end(JSON.stringify({ state: 'connected', tools: [{ name: 'a' }, { name: 'b' }] })); return; }
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const PROXY_ENV = 'TROTH_PROXY_URL=http://127.0.0.1:' + proxy.address().port;
    await startChat(110, 30, ENGINE_ENV + ' ' + PROXY_ENV);

    await t('a slash typed during a turn is answered beside the work, and Escape still stops the work', async () => {
      tmux(['send-keys', '-t', SES, 'run it', 'Enter']);
      assert.ok(await untilStarted() > 0, 'the command started: ' + screen().slice(-400));
      tmux(['send-keys', '-t', SES, '/usage', 'Enter']);
      await sleep(3000);
      const s = screen(true);
      assert.ok(alive() > 0, 'the work kept running');
      assert.ok(!/running \/usage/.test(s), 'the working line was not taken over: ' + s.slice(-400));
      assert.ok(/\(\d+(\.\d)?s\)/.test(screen()), 'the working line is still up: ' + screen().slice(-400));
      tmux(['send-keys', '-t', SES, 'Escape']);
      for (let i = 0; i < 24 && alive(); i++) await sleep(250);
      assert.strictEqual(alive(), 0, 'Escape killed the command');
      assert.ok(/stopped/.test(screen(true)), 'the stop is named: ' + screen(true).slice(-400));
      // The stop hands the words back to the composer; clear them before the next case.
      tmux(['send-keys', '-t', SES, 'C-c']);
      await sleep(2000);
      assert.ok(/│\s+│/.test(screen()), 'the composer is empty again: ' + screen().slice(-400));
    });

    await t('plain text typed during a turn waits behind it, and a stop drops it by name', async () => {
      tmux(['send-keys', '-t', SES, 'run it', 'Enter']);
      assert.ok(await untilStarted() > 0, 'the command started: ' + screen().slice(-400));
      tmux(['send-keys', '-t', SES, 'and then this', 'Enter']);
      await sleep(1500);
      let s = screen(true);
      assert.ok(/queued · sends when the running turn ends/.test(s), 'the wait is named: ' + s.slice(-400));
      assert.ok(alive() > 0, 'the work kept running');
      tmux(['send-keys', '-t', SES, 'Escape']);
      for (let i = 0; i < 24 && alive(); i++) await sleep(250);
      s = screen(true);
      assert.ok(/dropped the queued message: and then this/.test(s), 'the drop is named: ' + s.slice(-400));
      tmux(['send-keys', '-t', SES, 'C-c']);
      await sleep(2000);
    });

    await t('/mcps opens a pick list of the servers; a pick offers the actions; Check asks the dashboard and prints the state', async () => {
      tmux(['send-keys', '-t', SES, '/mcps', 'Enter']);
      let s = '';
      for (let i = 0; i < 20 && !/▸ supabase/.test(s = screen()); i++) await sleep(500);
      assert.ok(/▸ supabase  general · http · the database/.test(s), 'the server row is offered: ' + s.slice(-400));
      tmux(['send-keys', '-t', SES, 'Enter']);
      for (let i = 0; i < 20 && !/▸ Check supabase/.test(s = screen()); i++) await sleep(500);
      assert.ok(/Check supabase/.test(s) && /Switch off supabase/.test(s) && /Remove supabase/.test(s), 'the actions: ' + s.slice(-400));
      tmux(['send-keys', '-t', SES, 'Enter']);
      for (let i = 0; i < 20 && !/connected · 2 tools/.test(s = screen(true)); i++) await sleep(500);
      assert.ok(/supabase · connected · 2 tools/.test(s), 'the check result: ' + s.slice(-400));
      assert.ok(asked.some((c) => /^POST \/api\/mcp\/probe .*"name":"supabase"/.test(c)), 'the probe was asked: ' + asked.join(' | '));
      tmux(['send-keys', '-t', SES, '/mcps', 'Enter']);
      for (let i = 0; i < 20 && !/▸ supabase/.test(s = screen()); i++) await sleep(500);
      tmux(['send-keys', '-t', SES, 'Escape']);
      await sleep(800);
      s = screen();
      assert.ok(!/▸ supabase/.test(s) && /╭/.test(s), 'Escape closes the list and the panel stays: ' + s.slice(-400));
    });

    await t('leaving the chat while a command runs leaves no orphan behind', async () => {
      tmux(['send-keys', '-t', SES, 'run it', 'Enter']);
      assert.ok(await untilStarted() > 0, 'the command started: ' + screen().slice(-400));
      tmux(['send-keys', '-t', SES, '/quit', 'Enter']);
      for (let i = 0; i < 32 && alive(); i++) await sleep(250);
      assert.strictEqual(alive(), 0, 'the command outlived the chat');
    });

    await t('a finished tool leaves a trail line, a long turn says so, and Ctrl-O turns details on', async () => {
      await startChat(110, 30, ENGINE_ENV + ' TROTH_TURN_PROGRESS_STEPS=1');
      tmux(['send-keys', '-t', SES, 'quick check please', 'Enter']);
      let s = '';
      for (let i = 0; i < 40 && !/finished/.test(s = screen(true)); i++) await sleep(500);
      assert.ok(/finished/.test(s), 'the reply came: ' + s.slice(-400));
      assert.ok(/◦ ran echo trail-ok · \d+(\.\d)?s/.test(s), 'the trail line names the command and its time: ' + s.slice(-500));
      assert.ok(/still working · \d+ min/.test(s), 'the progress note printed: ' + s.slice(-500));
      assert.ok(/◦ ran 1 command/.test(s), 'the turn summary stays: ' + s.slice(-300));
      tmux(['send-keys', '-t', SES, 'C-o']);
      await sleep(800);
      assert.ok(/details on/.test(screen(true)), 'Ctrl-O says details are on: ' + screen(true).slice(-300));
      tmux(['send-keys', '-t', SES, '/quit', 'Enter']);
      await sleep(1500);
    });

    await t('a step list from the turn shows under the trail, every step with details on', async () => {
      await startChat(110, 30, ENGINE_ENV);
      tmux(['send-keys', '-t', SES, 'plan it please', 'Enter']);
      let s = '';
      for (let i = 0; i < 40 && !/finished/.test(s = screen(true)); i++) await sleep(500);
      assert.ok(/finished/.test(s), 'the reply came: ' + s.slice(-400));
      assert.ok(/◦ 0\/3 steps · read the file/.test(s), 'the step line names the count and the step in hand: ' + s.slice(-500));
      assert.ok(!/▸ read the file/.test(s), 'details off: no step rows');
      tmux(['send-keys', '-t', SES, 'C-o']);
      await sleep(800);
      tmux(['send-keys', '-t', SES, 'plan it again', 'Enter']);
      for (let i = 0; i < 40 && !/finished[\s\S]*finished/.test(s = screen(true)); i++) await sleep(500);
      assert.ok(/▸ read the file/.test(s) && /· change the line/.test(s) && /· run the tests/.test(s), 'details on: every step with its mark: ' + s.slice(-600));
      tmux(['send-keys', '-t', SES, '/quit', 'Enter']);
      await sleep(1500);
    });

    await t('the composer and the echoed message wrap at spaces, never inside a word', async () => {
      await startChat(60, 24, ENGINE_ENV);
      const sentence = 'the composer must wrap this long sentence at the spaces between words and never cut a word in half when it reaches the edge of the box';
      const words = new Set(sentence.split(' '));
      const whole = (line) => line.trim().split(/\s+/).filter(Boolean).every((w) => words.has(w));
      tmux(['send-keys', '-t', SES, sentence]);
      await sleep(1200);
      const rows = screen().split('\n').filter((l) => /^\s*│ .*│\s*$/.test(l)).map((l) => l.replace(/^\s*│ /, '').replace(/\s*│\s*$/, ''));
      assert.ok(rows.length >= 3, 'the sentence spans rows: ' + JSON.stringify(rows));
      assert.ok(rows.every(whole), 'every composer row holds whole words: ' + JSON.stringify(rows));
      tmux(['send-keys', '-t', SES, 'Enter']);
      await sleep(1500);
      const echoed = screen(true).split('\n').filter((l) => /\b(composer|spaces|edge)\b/.test(l) && !/│/.test(l));
      assert.ok(echoed.length >= 2, 'the echo spans rows: ' + JSON.stringify(echoed));
      assert.ok(echoed.every(whole), 'every echoed row holds whole words: ' + JSON.stringify(echoed));
      tmux(['send-keys', '-t', SES, 'Escape']);
      await sleep(500);
      tmux(['send-keys', '-t', SES, '/quit', 'Enter']);
      await sleep(1500);
    });
    proxy.close();
  } catch (e) {
    console.log('  ✗ the chat came up: ' + e.message); fail++;
  } finally {
    tmux(['kill-server']);
  }
  console.log('\ncli-screen: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
