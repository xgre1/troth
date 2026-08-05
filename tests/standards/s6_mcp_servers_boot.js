// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// S6 — every shipped MCP server must boot. A server.mjs that throws at
// require time (e.g. a top-level require of a module that was cut from the
// public tree) ships a plugin that crashes on host startup — the unit suite
// never catches it because suites import modules, not server entrypoints.
// This check spawns each plugin/mcp-servers/*/server.mjs, sends a JSON-RPC
// initialize over stdio, and requires a response.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVERS_DIR = path.join(__dirname, '..', '..', 'plugin', 'mcp-servers');
const INIT_MSG = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's6-boot', version: '0' } },
}) + '\n';

module.exports = {
  id: 'S6',
  title: 'all plugin MCP servers boot and answer initialize',
  expect: 'pass',
  run() {
    let entries;
    try {
      entries = fs.readdirSync(SERVERS_DIR).filter((d) =>
        fs.existsSync(path.join(SERVERS_DIR, d, 'server.mjs')));
    } catch (e) {
      return { pass: false, detail: 'cannot list plugin/mcp-servers: ' + e.message };
    }
    if (!entries.length) return { pass: false, detail: 'no server.mjs found under plugin/mcp-servers' };

    // Isolated HOME so a boot test never touches the operator's live substrate.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s6-'));
    const failures = [];
    for (const name of entries) {
      const server = path.join(SERVERS_DIR, name, 'server.mjs');
      const r = spawnSync(process.execPath, [server], {
        input: INIT_MSG,
        timeout: 10000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        env: { ...process.env, HOME: tmpHome },
      });
      const out = r.stdout || '';
      const answered = out.includes('"serverInfo"') || out.includes('"result"');
      if (!answered) {
        const err = (r.stderr || '').split('\n').find((l) => l.trim()) || (r.error && r.error.message) || 'no output';
        failures.push(`${name}: ${err.slice(0, 160)}`);
      }
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (failures.length) {
      return { pass: false, detail: `${failures.length}/${entries.length} server(s) failed to boot — ` + failures.join(' | ') };
    }
    return { pass: true, detail: `${entries.length}/${entries.length} MCP servers answered initialize` };
  },
};
