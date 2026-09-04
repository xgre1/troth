#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-entity — MCP plug surface for the Substrate-as-Entity runtime.
//
// Two surfaces, by design:
//
//   1. DISCRETE SUBSTRATE TOOLS — read/write L1 directly, NEVER call an
//      LLM. These are what host LLMs (Claude Code's Claude, Cursor's
//      model, etc.) call to fold substrate state into their already-
//      running responses. The host owns the language faculty; the
//      substrate just provides cognitive scaffolding via these tools.
//
//   2. entity_submit (full cognitive loop) — spawns the entity daemon
//      and runs the full decision/orchestrator loop. Used in
//      STANDALONE / API-PROXY modes where the entity IS the agent (not
//      plug-in to a host with its own LLM). Calls a configured
//      transport (router by default — never directly Anthropic).
//
// This split fixes the framing where the entity would bring its own
// LLM provider stack into a Claude Code session — wrong: the host's
// LLM (Claude in that session) is the language faculty when the entity
// plugs in. The entity adds substrate intelligence via tools, not by
// running a parallel LLM call chain.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SHARED_CORE = resolvePath(__dirname, '../../../shared-core');
const ENTITY_BIN  = resolvePath(__dirname, '../../../bin/troth-entity.js');

const state      = require(SHARED_CORE + '/state.js');
const actionRec  = require(SHARED_CORE + '/action-record.js');
const mindState  = require(SHARED_CORE + '/mind-state.js');

const SERVER_NAME    = 'troth-entity';
const SERVER_VERSION = '0.2.0';

// ── Daemon manager (lazy, only for entity_submit) ─────────────────────────

let daemon = null;
const pending = [];

function startDaemon() {
  if (daemon && !daemon.killed) return daemon;
  daemon = spawn(process.execPath, [ENTITY_BIN], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env }
  });
  let buf = '';
  daemon.stdout.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.kind === 'ready') continue;          // status, not a reply
      const next = pending.shift();
      if (next) next(msg);
    }
  });
  daemon.on('exit', () => {
    daemon = null;
    while (pending.length) {
      const cb = pending.shift();
      try { cb({ kind: 'error', error: 'daemon_exited' }); } catch { /* ignore */ }
    }
  });
  return daemon;
}

function submitEvent(event) {
  return new Promise((resolveOk, rejectErr) => {
    const d = startDaemon();
    pending.push((msg) => resolveOk(msg));
    d.stdin.write(JSON.stringify(event) + '\n', (err) => { if (err) rejectErr(err); });
  });
}

// ── Discrete substrate operations (no LLM) ────────────────────────────────

function activeCommitments(args) {
  const scope = args.scope || null;
  const rows = state.queryActions({
    type: 'commitment',
    cwd: scope,
    limit: 1000,
    order: 'desc'
  }) || [];
  const live = [];
  const superseded = new Set();
  for (const row of rows) {
    const rec = actionRec.fromRow(row);
    if (!rec) continue;
    const sup = rec.output && rec.output.lifetime && rec.output.lifetime.supersedes;
    if (sup) superseded.add(sup);
    if (superseded.has(rec.id)) continue;
    live.push({
      id: rec.id,
      statement: rec.output && rec.output.statement,
      commitment_type: rec.output && rec.output.commitment_type,
      confidence: rec.output && rec.output.confidence,
      scope: rec.output && rec.output.scope,
      timestamp: rec.timestamp
    });
  }
  return { commitments: live.slice(0, 200), count: live.length };
}

function recordCommitment(args) {
  const id = actionRec.uuidv7();
  const rec = {
    id,
    timestamp: Date.now(),
    type: 'commitment',
    agent_id: args.agent_id || 'host_via_mcp',
    cwd: args.scope && args.scope.project_id ? args.scope.project_id : null,
    user_id: args.user_id || 'default',
    parent_id: args.parent_id || null,
    input: {
      source: args.source || 'host_mcp_call',
      trigger_text: args.trigger_text || ''
    },
    output: {
      statement: String(args.statement || ''),
      commitment_type: args.commitment_type || 'opinion',
      confidence: typeof args.confidence === 'number' ? args.confidence : 0.7,
      evidence_refs: Array.isArray(args.evidence_refs) ? args.evidence_refs : [],
      scope: args.scope || { universal: false },
      revision_policy: args.revision_policy || { revisable: true, protocol: 'evidence_only', min_evidence_strength: 0.5 },
      lifetime: { created_at: Date.now() }
    }
  };
  const v = actionRec.validate(rec);
  if (!v.ok) return { ok: false, errors: v.errors };
  const recordedId = state.recordAction(rec, actionRec.toSearchText(rec));
  return { ok: true, id: recordedId };
}

function recentDecisions(args) {
  const scope = args.scope || null;
  const limit = Math.max(1, Math.min(args.limit || 25, 200));
  const rows = state.queryActions({
    type: 'decision',
    cwd: scope,
    limit,
    order: 'desc'
  }) || [];
  return {
    decisions: rows.map((row) => {
      const rec = actionRec.fromRow(row);
      if (!rec) return null;
      return {
        id: rec.id,
        timestamp: rec.timestamp,
        kind: rec.input && rec.input.kind,
        decision: rec.output && rec.output.decision,
        rule: rec.input && rec.input.signals && rec.input.signals.rule
      };
    }).filter(Boolean)
  };
}

function checkDrift(args) {
  // Cheap deterministic check — compares draft text against active
  // refusal patterns. Returns conflicts; host LLM decides what to do.
  const draft = String(args.text || '');
  const scope = args.scope || null;
  const cs = activeCommitments({ scope }).commitments
    .filter((c) => c.commitment_type === 'refusal');
  const conflicts = [];
  for (const c of cs) {
    const stmt = String(c.statement || '').toLowerCase();
    if (!stmt) continue;
    // Heuristic: if draft contains any 4+ char content word from the
    // refusal statement, surface as potential conflict for host review.
    const tokens = stmt.split(/\W+/).filter((t) => t.length >= 4);
    let hits = 0;
    for (const t of tokens) {
      if (draft.toLowerCase().includes(t)) hits++;
      if (hits >= 2) break;
    }
    if (hits >= 2) conflicts.push({ commitment_id: c.id, statement: c.statement });
  }
  return { conflicts, checked_against: cs.length };
}

function entityState() {
  // Read-only: surface mind snapshot + commitment count + recent decision count
  const rows = state.queryActions({ type: 'mind_snapshot', limit: 1, order: 'desc' }) || [];
  let mind = mindState.emptyMindState('default');
  if (rows[0]) {
    const rec = actionRec.fromRow(rows[0]);
    if (rec && rec.output && rec.output.mind_state) mind = rec.output.mind_state;
  }
  const commitments = activeCommitments({}).count;
  const recent = state.queryActions({ limit: 10, order: 'desc' }) || [];
  return { mind, active_commitments: commitments, recent_action_count: recent.length };
}

// ── MCP method handlers ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'entity_active_commitments',
    description: 'Read active commitments for a scope. NO LLM call. Use to fold the entity\'s commitments into your own response so you respect refusals/anchors/working hypotheses.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: [] }
  },
  {
    name: 'entity_record_commitment',
    description: 'Write a new commitment to the substrate. NO LLM call. Use when the user explicitly wants a position/refusal/anchor remembered.',
    inputSchema: {
      type: 'object',
      properties: {
        statement:       { type: 'string' },
        commitment_type: { type: 'string', enum: ['anchor','refusal','opinion'], description: 'Narrowed advertised enum from 7 → 3. Dropped values (hard/methodology/hypothesis/factual) had ZERO production readers — six of nine sub-types were decorative per the audit. Schema layer still accepts the legacy values; the model is just no longer told to use them. anchor + refusal + opinion are the three that ship with active read paths today.' },
        confidence:      { type: 'number' },
        scope:           { type: 'object' },
        evidence_refs:   { type: 'array' }
      },
      required: ['statement']
    }
  },
  {
    name: 'entity_recent_decisions',
    description: 'Read recent substrate-recorded decisions. NO LLM call. Useful for grounding your response in what the entity recently did.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' }, limit: { type: 'number' } }, required: [] }
  },
  {
    name: 'entity_check_drift',
    description: 'Check a draft against active refusals. Returns potential conflicts. NO LLM call. Use BEFORE finalizing a response that touches sensitive territory.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, scope: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'entity_state',
    description: 'Snapshot of substrate mind + commitment count + recent activity. NO LLM call. Diagnostic / orientation.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'entity_submit',
    description: 'STANDALONE / proxy mode only — runs the full cognitive loop including its own LLM call (via configured TROTH_ENTITY_LLM transport, default router). DO NOT use this when you (the host LLM) are the language faculty; use the discrete tools above instead.',
    inputSchema: {
      type: 'object',
      properties: {
        type:  { type: 'string' },
        input: { type: 'object' },
        parent_id: { type: 'string' }
      },
      required: ['input']
    }
  }
];

const HANDLERS = {
  'initialize': () => ({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
  }),
  'tools/list': () => ({ tools: TOOLS }),
  'tools/call': async (params) => {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    let result;
    try {
      if (name === 'entity_active_commitments') result = activeCommitments(args);
      else if (name === 'entity_record_commitment') result = recordCommitment(args);
      else if (name === 'entity_recent_decisions') result = recentDecisions(args);
      else if (name === 'entity_check_drift')      result = checkDrift(args);
      else if (name === 'entity_state')            result = entityState();
      else if (name === 'entity_submit') {
        const event = {
          type:      args.type || 'user_input',
          input:     args.input || {},
          parent_id: args.parent_id || null
        };
        result = await submitEvent(event);
      } else {
        return { error: { code: -32601, message: 'unknown tool: ' + String(name) } };
      }
    } catch (e) {
      return { error: { code: -32603, message: e && e.message || String(e) } };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
};

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); }
  catch (e) { process.stderr.write('emit_error: ' + (e && e.message || e) + '\n'); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    const handler = HANDLERS[msg.method];
    if (!handler) {
      emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      continue;
    }
    try {
      const result = await handler(msg.params || {});
      if (result && result.error) emit({ jsonrpc: '2.0', id: msg.id, error: result.error });
      else emit({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e && e.message || String(e) } });
    }
  }
});

process.on('SIGTERM', () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM');
  process.exit(0);
});
