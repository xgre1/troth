// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// suite-17: governed browser/action surface over MCP.
// The troth-substrate MCP server can expose the substrate's governed action
// surface (troth_intent_emit + troth_browser_do), but ONLY opt-in via
// TROTH_MCP_ACTIONS=1 and ONLY by delegating to REGISTRY.intent_emit.run,
// never to dispatchers/browser-do.js and never via the deprecated
// browser_session tool. These tests pin three things:
//   (1) flag OFF is a no-op: tools/list has neither action tool;
//   (2) flag ON registers both;
//   (3) governance is inherited by construction: troth_browser_do WITHOUT a
//       sealed capability fails closed with an STVC write-time refusal, not a
//       crash and not a success (the S2 bypass class we are avoiding).
// Hermetic: every server runs against a throwaway HOME so the real ~/.troth
// substrate is never touched (same discipline as tests/hermetic-db.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs');

// Drive the server over stdio with one initialize + one follow-up request and
// return the parsed JSON-RPC responses keyed by id. Mirrors the real MCP host
// transport and tests/standards/s6_mcp_servers_boot.js (no in-process import),
// so the env-gate is exercised exactly as a host would see it.
function rpc(requests, extraEnv) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s17-'));
  try {
    const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const r = spawnSync(process.execPath, [SERVER], {
      input,
      timeout: 15000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: tmpHome }, extraEnv || {}),
    });
    const byId = {};
    for (const line of (r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && typeof msg.id !== 'undefined') byId[msg.id] = msg;
    }
    return byId;
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } };

function toolNames(res, id) {
  const msg = res[id];
  assert(msg && msg.result && Array.isArray(msg.result.tools), 'tools/list answered with a tools array');
  return msg.result.tools.map((t) => t.name);
}

module.exports = function run({ test }) {
  console.log('\nMCP governed action surface (TROTH_MCP_ACTIONS):');

  test('MA-1: flag OFF (default) - tools/list has NO troth_intent_emit / troth_browser_do', () => {
    // No TROTH_MCP_ACTIONS in env, so the opt-in block must not fire.
    const env = { TROTH_MCP_ACTIONS: '' };
    const res = rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], env);
    const names = toolNames(res, 2);
    assert(!names.includes('troth_intent_emit'), 'troth_intent_emit absent when flag off');
    assert(!names.includes('troth_browser_do'), 'troth_browser_do absent when flag off');
    // The deprecated STVC-bypassing tool is never exposed on this server.
    assert(!names.includes('browser_session'), 'deprecated browser_session never exposed');
  });

  test('MA-2: flag ON - both troth_intent_emit and troth_browser_do are registered', () => {
    const res = rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { TROTH_MCP_ACTIONS: '1' });
    const names = toolNames(res, 2);
    assert(names.includes('troth_intent_emit'), 'troth_intent_emit present when flag on');
    assert(names.includes('troth_browser_do'), 'troth_browser_do present when flag on');
    // browser_do advertises the steps[] contract, not the stale {action,url,selector}.
    const bd = res[2].result.tools.find((t) => t.name === 'troth_browser_do');
    assert(bd.inputSchema && bd.inputSchema.properties && bd.inputSchema.properties.steps, 'browser_do takes steps[]');
    assert.strictEqual(bd.inputSchema.required[0], 'steps', 'steps is required');
    // The description must tell the model WHEN to reach for this: it drives the
    // operator's real Chrome, and playwright-class scripts are NEVER the answer
    // absolute, with no localhost E2E carve-out.
    assert(/real Chrome/i.test(bd.description || ''), 'description states it drives the operator real Chrome');
    assert(/NEVER/i.test(bd.description || '') && /playwright/i.test(bd.description || ''),
      'description states the absolute never-playwright rule');
  });

  test('governance inherited - troth_browser_do without a sealed capability fails closed (STVC refusal)', () => {
    // No operator-sealed capability exists in the throwaway HOME, so the
    // write-time STVC wall inside writeIntent must refuse. This proves the MCP
    // wrapper inherits governance through intent_emit rather than bypassing it.
    const call = {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'troth_browser_do', arguments: { steps: [{ navigate: 'https://example.com' }] } },
    };
    const res = rpc([INIT, call], { TROTH_MCP_ACTIONS: '1' });
    const msg = res[3];
    assert(msg && msg.result, 'tool call returned a result (not a crash / JSON-RPC error)');
    const out = msg.result.structuredContent;
    assert(out && typeof out === 'object', 'structured result present');
    // Fail-closed: not a success, explicitly refused at the STVC write stage.
    assert.strictEqual(out.ok, false, 'refused, not ok');
    assert.strictEqual(out.refused, true, 'flagged as a governance refusal');
    assert.strictEqual(out.stage, 'write', 'refused at the write-time STVC wall');
    assert.strictEqual(out.reason, 'intent_refused_at_write', 'refusal reason is the STVC write wall');
    // detail names the STVC predicate that fired. Predicates run in order
    // [grounded_in_sealed, capability_covers_intent, ...]; with neither a seal
    // nor a capability present, grounded_in_sealed fires first, but either is a
    // valid fail-closed STVC refusal for the "no sealed capability" case.
    assert(/grounded_in_sealed|capability_covers_intent/.test(String(out.detail || '')),
      'detail cites an STVC predicate (grounded_in_sealed / capability_covers_intent): ' + out.detail);
  });

  test('MA-4: backbone spawn forwards TROTH_MCP_ACTIONS into the substrate server config explicitly', () => {
    const { PROFILES } = require(path.join(__dirname, '..', 'shared-core', 'transports', 'subprocess-cli.js'));
    const prevMcp = process.env.TROTH_CLAUDE_MCP;
    const prevAct = process.env.TROTH_MCP_ACTIONS;
    try {
      process.env.TROTH_CLAUDE_MCP = '1';
      process.env.TROTH_MCP_ACTIONS = '1';
      const on = PROFILES.claude_cli.buildArgs({ user: 'hi', system: 's' });
      const cfg = JSON.parse(on[on.indexOf('--mcp-config') + 1]);
      assert.strictEqual(cfg.mcpServers['troth-substrate'].env.TROTH_MCP_ACTIONS, '1', 'flag rides the server config');
      delete process.env.TROTH_MCP_ACTIONS;
      const off = PROFILES.claude_cli.buildArgs({ user: 'hi', system: 's' });
      const cfgOff = JSON.parse(off[off.indexOf('--mcp-config') + 1]);
      assert.strictEqual(cfgOff.mcpServers['troth-substrate'].env, undefined, 'no flag, no env block');
    } finally {
      if (prevMcp === undefined) delete process.env.TROTH_CLAUDE_MCP; else process.env.TROTH_CLAUDE_MCP = prevMcp;
      if (prevAct === undefined) delete process.env.TROTH_MCP_ACTIONS; else process.env.TROTH_MCP_ACTIONS = prevAct;
    }
  });
};
