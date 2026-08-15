// SPDX-License-Identifier: AGPL-3.0-only
// The protocol's own always-read.
//
// MCP's initialize result carries an `instructions` field that compliant
// clients place in front of the model — presence with no file written
// anywhere and no per-turn rent. A fresh user's agent knows nothing about
// troth; on clients without our hooks this field and the tool listing are
// the only introduction it gets, and our servers shipped without it.
//
// Two disciplines pinned here: every wired server declares its contract, and
// every contract stays SHORT. The research this rides on is unambiguous —
// concise, curated instruction text helps agents; generated bulk measurably
// hurts them — so a ceiling is part of the contract, not a style preference.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nProtocol contract (PCON):');

const SERVERS = ['troth-router', 'troth-bash', 'troth-cache', 'troth-hashline'];
const CEILING = 700;   // chars — a contract, not a manual

test('PCON-1: every wired server declares short instructions at initialize', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pcon-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const env = Object.assign({}, process.env, {
    HOME, _TROTH_TEST_HOME: HOME,
    STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
  });
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'suite', version: '1' } } }) + '\n';
  for (const s of SERVERS) {
    const r = cp.spawnSync('node', [path.join(ROOT, 'plugin', 'mcp-servers', s, 'server.mjs')],
      { env, input: init, encoding: 'utf8', timeout: 20000 });
    const line = (r.stdout || '').split('\n').find(l => l.includes('"result"'));
    assert.ok(line, s + ' answered initialize');
    const res = JSON.parse(line).result;
    const ins = String(res.instructions || '');
    assert.ok(ins.length > 50, s + ' declares a contract: ' + ins.length + ' chars');
    assert.ok(ins.length <= CEILING,
      s + ' keeps it a contract, not a manual: ' + ins.length + ' > ' + CEILING);
  }
});

test('PCON-3: the first tool result of a session carries the greeting once, and only once', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pcon3-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcon3-docs-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello greeting probe\n');
  const env = Object.assign({}, process.env, {
    HOME, _TROTH_TEST_HOME: HOME,
    STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
  });
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'suite', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cached_read', arguments: { file_path: path.join(dir, 'a.txt') } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cached_read', arguments: { file_path: path.join(dir, 'a.txt') } } }
  ].map(JSON.stringify).join('\n') + '\n';
  // A private greeting key: sibling suites spawn servers from this same test
  // process, so the ppid-keyed marker would already exist. TROTH_GREET_KEY
  // exists exactly for this isolation.
  env.TROTH_GREET_KEY = 'pcon3-' + Date.now().toString(36);
  const r = cp.spawnSync('node', [path.join(ROOT, 'plugin', 'mcp-servers', 'troth-cache', 'server.mjs')],
    { env, input: msgs, encoding: 'utf8', timeout: 30000 });
  const replies = r.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const blocks = (id) => replies.find(x => x.id === id).result.content;
  const first = blocks(2), second = blocks(3);
  assert.ok(/^\[troth\] Substrate active/.test(first[0].text),
    'the session\'s first result leads with the greeting');
  assert.ok(first.length >= 2 && /cached|source/.test(first[first.length - 1].text),
    'and the real payload rides behind it, untouched');
  assert.ok(!/\[troth\] Substrate active/.test(second.map(b => b.text).join('')),
    'the second result is greeting-free — once per session means once');
});

test('PCON-2: the router\'s contract names the one behaviour that loses the product (source pin)', () => {
  // Whatever else changes, the router must keep telling a fresh agent the
  // single most valuable sentence: recall before file-grepping memory.
  const src = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-router', 'server.mjs'), 'utf8');
  assert.ok(/troth_recall BEFORE reading or grepping/.test(src),
    'the recall-first contract is stated at the protocol level');
});
};
