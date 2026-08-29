#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Spawn census: the perimeter of process creation, frozen.
//
// Every file below is a REVIEWED legacy spawn site with its call count at
// the moment the spawn seam landed (shared-core/tools/spawn-purpose.js).
// The contract: counts may SHRINK (a lane migrated to the seam) and never
// GROW, and no file outside this registry may touch child_process at all.
// A new process launch either declares a purpose through the seam or turns
// this test red. Without this test, "execution is contained" is a hope;
// with it, an unrouted spawn is a build failure.
//
// To migrate a lane: route its calls through spawn-purpose, remove its
// child_process import, delete its line here. To add a NEW spawn: use the
// seam; only a reviewed exception may add a line here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY = {
  "shared-core/agent-supervisor.js": 2,
  "shared-core/background-worker.js": 1,
  "shared-core/chameleon-runtime.js": 1,
  "shared-core/claims.js": 1,
  "shared-core/claude-subscription.js": 1,
  "shared-core/codex-auth.js": 1,
  "shared-core/derive-config.js": 2,
  "shared-core/device-capabilities.js": 1,
  "shared-core/dispatchers/shell-do.js": 1,
  "shared-core/git-ok.js": 2,
  "shared-core/graduation.js": 2,
  "shared-core/host/hypervisor/docker.js": 1,
  "shared-core/host/keyhsm/secure-enclave.js": 4,
  "shared-core/local-embedder.js": 1,
  "shared-core/local-reranker.js": 1,
  "shared-core/local-server.js": 4,
  "shared-core/outcome-fold.js": 2,
  "shared-core/perception/chromium-daemon.js": 1,
  "shared-core/project-id.js": 1,
  "shared-core/server-lifecycle.js": 2,
  "shared-core/session-recorder.js": 2,
  "shared-core/situated-awareness.js": 1,
  "shared-core/system-load.js": 1,
  "shared-core/text-extract.js": 3,
  "shared-core/tools/bash.js": 1,
  "shared-core/tools/docker-sandbox.js": 2,
  "shared-core/tools/grep.js": 2,
  "shared-core/tools/mcp-client.js": 2,
  "shared-core/tools/sandbox-apple-container.js": 2,
  "shared-core/tools/sandbox-bare-exec.js": 1,
  "shared-core/tools/sandbox-seatbelt.js": 3,
  "shared-core/tools/spawn-purpose.js": 4,
  // Reviewed exception: wall-doctor APPLIES profiles to measure
  // them, so it must spawn from unwalled ground; the seam would wall it and
  // profiles do not nest. One shared callsite for every probe.
  "shared-core/tools/wall-doctor.js": 1,
  "shared-core/transports/subprocess-cli.js": 3,
  "proxy/modules/cochange.js": 2,
  "proxy/modules/commitmsg.js": 2,
  "proxy/modules/critic.js": 1,
  "proxy/modules/l4-entity-bridge.js": 1,
  "proxy/modules/mcp-routes.js": 2,
  "proxy/modules/router.js": 1,
  "proxy/modules/service.js": 13,
  "proxy/server.js": 21,
  "plugin/hooks/critic.mjs": 1,
  "plugin/hooks/pre-compact.mjs": 3,
  "plugin/hooks/session-start.mjs": 1,
  "plugin/mcp-servers/troth-bash/server.mjs": 2,
  "plugin/mcp-servers/troth-cache/server.mjs": 2,
  "plugin/mcp-servers/troth-entity/server.mjs": 1,
  "plugin/mcp-servers/troth-router/server.mjs": 1,
  "bin/cmd-partner.js": 5,
  "bin/ingest-openapi.js": 1,
  "bin/mcp-audit.js": 2,
  "bin/mcp-server.js": 7,
  "bin/reflect.js": 1,
  "bin/runner.js": 29,
  "bin/sweep-commitments.js": 1,
  "bin/troth-body.js": 3,
  "bin/troth-chat.js": 2,
  "bin/troth-pre-compact.js": 1,
  "bin/troth.js": 39
};

const CALL = /\b(spawn|spawnSync|exec|execFile|execFileSync|execSync|fork)\s*\(/g;
function measure() {
  const out = {};
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      if (!s.includes('child_process')) continue;
      let n = 0;
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) continue;
        const m = t.match(CALL);
        if (m) n += m.length;
      }
      if (n > 0) out[path.relative(ROOT, p)] = n;
    }
  }
  for (const d of ['shared-core', 'proxy', 'plugin', 'bin']) walk(path.join(ROOT, d));
  return out;
}

let passed = 0, shrunk = 0;
const live = measure();
const problems = [];
for (const [f, n] of Object.entries(live)) {
  const allowed = REGISTRY[f];
  if (allowed === undefined) {
    problems.push(f + ': unregistered spawn site (' + n + ' call(s)) - route it through shared-core/tools/spawn-purpose.js');
  } else if (n > allowed) {
    problems.push(f + ': spawn count grew ' + allowed + ' -> ' + n + ' - new launches go through the spawn seam');
  } else {
    passed++;
    if (n < allowed) { shrunk++; console.log('  info: ' + f + ' shrank ' + allowed + ' -> ' + n + ' (tighten the registry)'); }
  }
}
for (const f of Object.keys(REGISTRY)) {
  if (!(f in live)) console.log('  info: ' + f + ' no longer spawns - delete its registry line');
}
assert.ok(fs.existsSync(path.join(ROOT, 'shared-core', 'tools', 'spawn-purpose.js')), 'the spawn seam exists');
if (problems.length) {
  console.error('\nspawn-census FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nspawn-census: ' + passed + ' registered sites within bounds (' + shrunk + ' shrank)');
