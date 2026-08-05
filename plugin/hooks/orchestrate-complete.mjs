#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// orchestrate-complete — Stop hook that auto-writes the orchestration
// completion sentinel when a role-specialist worker finishes.
//
// The orchestrator's runDAG() polls for engrams scoped
// `complete:role:<name>:group:<id>` to gate dependent roles. We can't
// trust the worker LLM to remember to write this engram at the end of
// its session — token-limit cutoffs, model amnesia, plain mistakes will
// strand the orchestration in indefinite wait.
//
// This hook fires on Stop. It checks for the env vars spawnRoleWorker
// sets (TROTH_AGENT_ID matching `role-<name>-<groupId>`) and, when
// present, writes the completion sentinel deterministically. The body
// of the engram summarizes the most recent dialogue turn so dependent
// roles can pick up handoff context without re-reading the full log.
//
// No-op (allow-only) when the worker is NOT an orchestration role.
// Plain interactive sessions don't trigger this hook's payload.

import { readStdinJson, allow, log } from './_lib.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();

const payload = await readStdinJson();
const session = payload.session_id || null;

const agentId = process.env.TROTH_AGENT_ID || '';
// Pattern set by shared-core/agent-supervisor.js spawnRoleWorker:
//   role-<name>-<groupId>
const m = /^role-([a-z0-9_-]+)-(orch-[a-z0-9-]+)$/i.exec(agentId);
if (!m) { allow(); }

const roleName = m[1];
const groupId  = m[2];
const completeScope = 'complete:role:' + roleName + ':group:' + groupId;

let summary = '';
try {
  // Best-effort: pull the last assistant turn from the transcript so the
  // sentinel carries something useful, not just "done".
  const txt = (payload.transcript || payload.last_message || payload.stop_reason || '').toString();
  summary = txt.replace(/\s+/g, ' ').slice(0, 400);
} catch (_) {}
if (!summary) summary = 'role ' + roleName + ' finished (no transcript captured)';

try {
  const engram = require(pluginRoot + '/../shared-core/engram.js');
  const id = engram.recordEngram({
    agent_id: agentId,
    statement: 'COMPLETE: ' + summary,
    source: 'orchestrate-complete-hook',
    scope: completeScope,
    salience: 1.5,
    source_module: 'orchestrate-complete.mjs'
  });
  log('Stop.orchestrate-complete', {
    session_id: session,
    metadata: { role: roleName, group_id: groupId, engram_id: id, scope: completeScope }
  });
} catch (e) {
  log('Stop.orchestrate-complete', {
    session_id: session,
    metadata: { role: roleName, group_id: groupId, error: String(e && e.message || e).slice(0, 200) }
  });
}

allow();
