#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The one-road containment holds only if every spawn of the engine child
// carries BOTH halves: the walled hands mounted (troth-bash, troth-hashline
// over --mcp-config with --strict-mcp-config) AND the native mutating tools
// disallowed. Half of it is worse than none: mounted-but-not-disallowed lets
// a poisoned decision pick the bare hand; disallowed-but-not-mounted
// paralyzes the engine. This test pins the pair, the flag order, and the
// revert switch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { PROFILES } = require('../shared-core/transports/subprocess-cli.js');
const buildArgs = PROFILES.claude_cli.buildArgs;

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ok ' + name); }

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function mcpConfigOf(args) {
  const i = args.indexOf('--mcp-config');
  return i >= 0 ? JSON.parse(args[i + 1]) : null;
}
function sysPromptOf(args) {
  const i = args.indexOf('--append-system-prompt');
  return i >= 0 ? args[i + 1] : '';
}

try {
  // ── 1. Default: both halves present ──
  withEnv({ TROTH_ONE_ROAD: undefined, TROTH_CLAUDE_MCP: undefined }, () => {
    const a = buildArgs({ user: 'hello', model: '' });
    ok('core flags unchanged', a[0] === '-p' && a.includes('--dangerously-skip-permissions')
       && a.includes('--output-format') && a.includes('stream-json'));
    const cfg = mcpConfigOf(a);
    ok('execution servers mounted', !!cfg && !!cfg.mcpServers['troth-bash'] && !!cfg.mcpServers['troth-hashline']);
    ok('strict mcp config rides the mount', a.includes('--strict-mcp-config'));
    ok('mounted server files really exist on disk',
       fs.existsSync(cfg.mcpServers['troth-bash'].args[0])
       && fs.existsSync(cfg.mcpServers['troth-hashline'].args[0]));
    ok('substrate NOT mounted without its opt-in flag', !cfg.mcpServers['troth-substrate']);
    const di = a.indexOf('--disallowedTools');
    ok('native mutating tools disallowed', di >= 0);
    ok('disallow list exact and LAST (variadic safety)',
       JSON.stringify(a.slice(di)) === JSON.stringify(['--disallowedTools', 'Bash', 'Write', 'Edit', 'NotebookEdit']));
    ok('exec rule tells the engine where its hands are',
       sysPromptOf(a).includes('mcp__troth-bash__run') && sysPromptOf(a).includes('mcp__troth-hashline__hashline_edit'));
  });

  // ── 2. Substrate opt-in composes with the road ──
  withEnv({ TROTH_ONE_ROAD: undefined, TROTH_CLAUDE_MCP: '1' }, () => {
    const a = buildArgs({ user: 'hello', model: '' });
    const cfg = mcpConfigOf(a);
    ok('substrate joins the mount under its flag',
       !!cfg && !!cfg.mcpServers['troth-substrate'] && !!cfg.mcpServers['troth-bash']);
    ok('memory rule present alongside exec rule',
       sysPromptOf(a).includes('troth_recall') && sysPromptOf(a).includes('mcp__troth-bash__run'));
  });

  // ── 2b. Session ground rides into the engine shell ──
  withEnv({ TROTH_ONE_ROAD: undefined, TROTH_CLAUDE_MCP: undefined, GF_WATCH_DIR: process.cwd() }, () => {
    const cfg = mcpConfigOf(buildArgs({ user: "hello", model: "" }));
    ok("engine shell starts on the watched session ground",
       !!cfg.mcpServers["troth-bash"].env && cfg.mcpServers["troth-bash"].env.TROTH_BASH_CWD === process.cwd());
  });
  withEnv({ TROTH_ONE_ROAD: undefined, TROTH_CLAUDE_MCP: undefined, GF_WATCH_DIR: "/definitely/not/a/dir" }, () => {
    const cfg = mcpConfigOf(buildArgs({ user: "hello", model: "" }));
    ok("missing watch dir does not poison the shell env", !cfg.mcpServers["troth-bash"].env);
  });

  // ── 3. Revert switch restores pre-containment behavior entirely ──
  withEnv({ TROTH_ONE_ROAD: '0', TROTH_CLAUDE_MCP: undefined }, () => {
    const a = buildArgs({ user: 'hello', model: '' });
    ok('revert: no disallow', !a.includes('--disallowedTools'));
    ok('revert: no execution mounts', mcpConfigOf(a) === null);
    ok('revert: no exec rule', !sysPromptOf(a).includes('mcp__troth-bash__run'));
  });
  withEnv({ TROTH_ONE_ROAD: '0', TROTH_CLAUDE_MCP: '1' }, () => {
    const cfg = mcpConfigOf(buildArgs({ user: 'hello', model: '' }));
    ok('revert keeps substrate mount working as before',
       !!cfg && !!cfg.mcpServers['troth-substrate'] && !cfg.mcpServers['troth-bash']);
  });

  console.log('\none-road-engine: ' + passed + ' assertions passed');
} catch (e) {
  console.error('\none-road-engine FAILED: ' + (e && e.message));
  process.exitCode = 1;
}
