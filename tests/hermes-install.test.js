#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// `troth mcp install hermes` writes the four troth servers under mcp_servers
// and names troth as the memory provider in ~/.hermes/config.yaml, touching no
// other line, and places the provider files where Hermes loads plugins.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-hermes-'));
process.env.HOME = HOME;
const ROOT = path.join(__dirname, '..');
const hosts = require(path.join(ROOT, 'shared-core', 'mcp-hosts.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== troth mcp install hermes ===\n');

const hermes = hosts.hosts().find((h) => h.id === 'hermes');
const cfg = path.join(HOME, '.hermes', 'config.yaml');

t('the host is listed with a YAML config and a provider folder', () => {
  assert.ok(hermes, 'hermes host');
  assert.strictEqual(hermes.cfg, cfg);
  assert.strictEqual(hermes.format, 'yaml');
  assert.ok(hermes.provider.endsWith(path.join('.hermes', 'plugins', 'troth')));
  assert.strictEqual(hosts.hostStatus(hermes), 'no config yet');
});

t('a fresh install writes the servers, the provider line and the provider files', () => {
  const r = hosts.installInto(hermes, { coreRoot: ROOT });
  assert.ok(r.ok, JSON.stringify(r));
  const text = fs.readFileSync(cfg, 'utf8');
  assert.ok(/^mcp_servers:$/m.test(text), text);
  for (const n of hosts.SERVER_NAMES) assert.ok(new RegExp('^  ' + n + ':$', 'm').test(text), 'server ' + n);
  assert.ok(/^    command: ".*node[^"]*"$/m.test(text), 'absolute node: ' + text);
  assert.ok(/^memory:$/m.test(text) && /^  provider: troth$/m.test(text), text);
  for (const f of ['__init__.py', 'plugin.yaml', 'README.md']) assert.ok(fs.existsSync(path.join(hermes.provider, f)), f);
  assert.strictEqual(hosts.hostStatus(hermes), 'wired (' + hosts.SERVER_NAMES.length + ' servers, memory provider)');
});

t('an existing config keeps every foreign line and has its old troth entries replaced', () => {
  fs.writeFileSync(cfg, [
    'model: "anthropic/claude-opus-4"',
    '',
    'mcp_servers:',
    '  weather:',
    '    command: "npx"',
    '    args: ["-y", "weather-mcp"]',
    '  troth-router:',
    '    command: "/old/node"',
    '    args: ["/old/troth-router/server.mjs"]',
    '',
    'memory:',
    '  memory_enabled: true',
    '  provider: mem0',
    '  user_char_limit: 1375',
    '',
    'skills:',
    '  write_approval: false',
    ''
  ].join('\n'));
  const r = hosts.installInto(hermes, { coreRoot: ROOT });
  assert.ok(r.ok, JSON.stringify(r));
  const text = fs.readFileSync(cfg, 'utf8');
  assert.ok(/^model: "anthropic\/claude-opus-4"$/m.test(text), 'the model line stays');
  assert.ok(/^  weather:\n    command: "npx"\n    args: \["-y", "weather-mcp"\]$/m.test(text), 'the foreign server stays whole');
  assert.ok(!/\/old\//.test(text), 'the old troth entry is gone');
  assert.strictEqual((text.match(/^  troth-router:$/mg) || []).length, 1, 'one troth-router entry');
  assert.ok(/^  memory_enabled: true$/m.test(text) && /^  user_char_limit: 1375$/m.test(text), 'the memory block keeps its other keys');
  assert.ok(/^  provider: troth$/m.test(text) && !/mem0/.test(text), 'the provider is troth');
  assert.ok(/^skills:\n  write_approval: false$/m.test(text), 'the skills block stays');
  assert.ok(fs.existsSync(cfg + '.bak-troth'), 'a backup was taken');
});

t('an empty inline map becomes a block, and an inline map with content is refused untouched', () => {
  fs.writeFileSync(cfg, 'model: "x"\nmcp_servers: {}\nmemory: {}\n');
  const r = hosts.installInto(hermes, { coreRoot: ROOT });
  assert.ok(r.ok, JSON.stringify(r));
  const text = fs.readFileSync(cfg, 'utf8');
  assert.strictEqual((text.match(/^mcp_servers:/mg) || []).length, 1, 'one mcp_servers key: ' + text);
  assert.strictEqual((text.match(/^memory:/mg) || []).length, 1, 'one memory key');
  assert.ok(/^  troth-router:$/m.test(text) && /^  provider: troth$/m.test(text), text);
  const inline = 'mcp_servers: { weather: { command: "npx" } }\n';
  fs.writeFileSync(cfg, inline);
  const refused = hosts.installInto(hermes, { coreRoot: ROOT });
  assert.strictEqual(refused.ok, false, JSON.stringify(refused));
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), inline, 'the file is untouched');
  fs.writeFileSync(cfg, ['model: "anthropic/claude-opus-4"', 'mcp_servers:', '  weather:', '    command: "npx"', 'memory:', '  provider: mem0', ''].join('\n'));
  assert.ok(hosts.installInto(hermes, { coreRoot: ROOT }).ok);
});

t('a second install changes nothing', () => {
  const before = fs.readFileSync(cfg, 'utf8');
  const r = hosts.installInto(hermes, { coreRoot: ROOT });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), before);
});

t('HERMES_HOME moves the config and the provider folder', () => {
  process.env.HERMES_HOME = path.join(HOME, 'elsewhere');
  const h = hosts.hosts().find((x) => x.id === 'hermes');
  assert.strictEqual(h.cfg, path.join(HOME, 'elsewhere', 'config.yaml'));
  assert.strictEqual(h.provider, path.join(HOME, 'elsewhere', 'plugins', 'troth'));
  delete process.env.HERMES_HOME;
});

t('the CLI lists the host', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'cmd-mcp-install.js'), 'utf8');
  assert.ok(/mcpHosts\.hosts\(\)/.test(src), 'the CLI reads the shared host table');
});

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
console.log('\nhermes-install: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
