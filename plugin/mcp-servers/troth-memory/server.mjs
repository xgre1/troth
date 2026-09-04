#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-memory — reference implementation of GMP v0.1.
//
// The substrate endpoint. Any MCP-compatible tool (Claude Code, Cursor,
// OpenClaw, LangChain agents via MCP adapter, custom stdio clients)
// reads + writes ActionRecords here through a tiny, documented protocol.
//
// Protocol: the two stdio JSON-RPC surfaces described below are the contract.
// Storage: SQLite action_records table (see shared-core/state.js).
//
// Two interface surfaces, both over stdio JSON-RPC:
//
//   1. Native GMP methods: "troth/list_capabilities",
//      "troth/record_action", "troth/fetch_action",
//      "troth/query_actions", "troth/trace_causality",
//      "troth/count_actions" + optional search_actions.
//
//   2. MCP tools/list + tools/call wrappers so existing MCP clients
//      see the same operations without needing to speak GMP
//      natively. The tools are thin transliterations of the GMP
//      methods.
//
// This lets the same process serve three audiences: (a) a native
// GMP client speaking troth/* directly, (b) an MCP client
// calling the wrapper tools, (c) future HTTP/WebSocket clients
// once transports beyond stdio are added.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverDir = fileURLToPath(new URL('.', import.meta.url));
const state       = require(serverDir + '../../../shared-core/state.js');
const actionRec   = require(serverDir + '../../../shared-core/action-record.js');
const query       = require(serverDir + '../../../shared-core/query.js');
const causality   = require(serverDir + '../../../shared-core/causality.js');
const workingSet  = require(serverDir + '../../../shared-core/working-set.js');
const runtime     = require(serverDir + '../../../shared-core/runtime.js');
const atlas       = require(serverDir + '../../../shared-core/atlas.js');
const wireFormat  = require(serverDir + '../../../shared-core/wire-format.js');
const identity    = require(serverDir + '../../../shared-core/identity.js');
const mindState   = require(serverDir + '../../../shared-core/mind-state.js');
const claudeUsage = require(serverDir + '../../../shared-core/claude-usage-ingest.js');

// Claude Code writes its own per-message token usage next to the transcript;
// the proxy never sees that lane. Tail it into usage_ledger from here — this
// server lives exactly as long as a Claude session, which is exactly when new
// usage appears. Timers are unref'd: ingestion must never hold the process
// open. Stdout is the JSON-RPC channel — diagnostics go to stderr only.
if (process.env.TROTH_CLAUDE_USAGE_INGEST !== '0') {
  const runClaudeUsageIngest = () => {
    try {
      const s = claudeUsage.ingestOnce();
      if (s.messages > 0) process.stderr.write('[claude-usage] +' + s.messages + ' messages from ' + s.files_ingested + ' files\n');
    } catch (e) {
      process.stderr.write('[claude-usage] ingest failed: ' + ((e && e.message) || e) + '\n');
    }
  };
  setTimeout(runClaudeUsageIngest, 20 * 1000).unref();
  setInterval(runClaudeUsageIngest, 60 * 1000).unref();
}

const PROTOCOL_VERSION = '0.1';
const SERVER_NAME      = 'troth-memory';
const SERVER_VERSION   = '0.1.0';

// Feature flags advertised via list_capabilities. As Phase D/E land, flip
// sessions/snapshots/virtual_runtime/atlases on here.
const CAPABILITIES = {
  sessions:            true,   // Phase D working-set sessions
  snapshots:           true,   // Phase E KnowledgeAtlas export/import
  retention_policies:  false,
  encryption_info:     false,
  fts_search:          true,   // via state.searchActions (FTS5)
  semantic_search:     false,  // deferred to v0.2
  attestation:         false,  // deferred to v0.2
  custom_types:        false,  // mandatory types only for v0.1 conformance
  virtual_runtime:     true,   // Phase D: working-set, fetch_action, compact/reset hooks
  agent_market:        true,   // Phase E: competitive dispatch + winner analysis
  decision_graph:      true,   // typed-edge causality + recursive path queries
  compact_wire:        true    // TOON wire format for ActionRecord batches
};

// ── GMP method handlers ──────────────────────────────────────────────

const HANDLERS = {
  'troth/list_capabilities': (params) => ({
    protocol_version: PROTOCOL_VERSION,
    server_name:      SERVER_NAME,
    server_version:   SERVER_VERSION,
    features:         CAPABILITIES
  }),

  'troth/record_action': (params) => {
    if (!params || !params.action) return rpcError(-32602, 'missing action');
    const action = params.action;
    const validation = actionRec.validate(action);
    if (!validation.ok) return rpcError(-32101, 'schema validation failed', { errors: validation.errors });
    const id = state.recordAction(action, actionRec.toSearchText(action));
    if (!id) return rpcError(-32603, 'write failed');
    return { id };
  },

  'troth/fetch_action': (params) => {
    if (!params || !params.id) return rpcError(-32602, 'missing id');
    const row = state.getAction(params.id);
    if (!row) return rpcError(-32100, 'record not found', { id: params.id });
    return { action: actionRec.fromRow(row) };
  },

  // Page-fault entry point. The model sees `<troth:page:UUID>` markers (any
  // evicted action) or `<troth:intent:UUID>` markers (evicted intent records) in
  // its context and calls this tool with the marker as the `handle` argument. We
  // parse the UUID out and route to fetch_action, returning byte-equal record
  // content. Both prefixes resolve identically — the distinct prefix is purely a
  // hint to the model about what kind of record it's faulting on.
  'troth/fault_in': (params) => {
    if (!params || !params.handle) return rpcError(-32602, 'missing handle');
    // Mind added 'mind' prefix: <troth:mind:UUID> resolves identically
    // to page/intent — the substrate stores everything as action_records,
    // so fault-in is a uniform fetch_action regardless of which marker
    // type the agent saw in its context.
    const m = String(params.handle).match(/<troth:(page|intent|mind):([0-9a-fA-F-]{36})>/);
    if (!m) return rpcError(-32602, 'invalid handle format', {
      hint: 'expected <troth:page:UUID>, <troth:intent:UUID>, or <troth:mind:UUID> where UUID is a 36-char UUIDv7'
    });
    const id = m[2];
    const row = state.getAction(id);
    if (!row) return rpcError(-32100, 'page fault: id not found', { id });
    return { action: actionRec.fromRow(row), handle_resolved: params.handle, handle_kind: m[1] };
  },

  'troth/query_actions': (params) => {
    params = params || {};
    const filter = params.filter || {};
    const rows = state.queryActions({
      type:       filter.type,
      agent_id:   filter.agent_id,
      session_id: filter.session_id,
      cwd:        filter.cwd,
      parent_id:  filter.parent_id,
      since:      filter.since,
      until:      filter.until,
      limit:      params.limit,
      order:      params.order
    }) || [];
    // Opt-in compact wire format. When the client requests format='toon' AND we
    // advertise compact_wire, encode the batch as TOON; otherwise return the
    // parsed JSON action array. When an active wire_format_profile exists for the
    // computed domain signature, use its LLM-evolved aliases instead of
    // recomputing per-batch. Falls back to fresh dict on miss/error.
    if (params.format === 'toon' && CAPABILITIES.compact_wire) {
      let profileAliases = null;
      try {
        const reflector = require(serverDir + '../../../shared-core/schema-reflector.js');
        const parsed = rows.map(actionRec.fromRow);
        const sig = reflector.computeDomainSignature(parsed);
        const active = state.getActiveWireFormatProfile && state.getActiveWireFormatProfile(sig);
        if (active && active.header_json) {
          const h = JSON.parse(active.header_json);
          if (h && h.aliases && typeof h.aliases === 'object') profileAliases = h.aliases;
        }
      } catch (_) { /* fall through to default dict */ }
      return {
        format:  'toon',
        payload: wireFormat.encodeBatch(rows, { profile_aliases: profileAliases }),
        count:   rows.length,
        profile_used: profileAliases ? true : false
      };
    }
    return { actions: rows.map(actionRec.fromRow) };
  },

  'troth/count_actions': (params) => {
    params = params || {};
    const filter = params.filter || {};
    const count = state.countActions({
      type:       filter.type,
      agent_id:   filter.agent_id,
      session_id: filter.session_id,
      cwd:        filter.cwd,
      since:      filter.since
    });
    return { count };
  },

  'troth/trace_causality': (params) => {
    if (!params || !params.action_id) return rpcError(-32602, 'missing action_id');
    const chain = causality.traceCausalChain(state, params.action_id, {
      maxDepth: params.max_depth || 64
    });
    // TRON encoding for chain when client opts in.
    // Chain is a flat array of records; treated as a TOON batch (uniform
    // ActionRecord shape), not as path-rows.
    if (params.format === 'toon' && CAPABILITIES.compact_wire) {
      return {
        format:  'toon',
        payload: wireFormat.encodeBatch(chain),
        count:   chain.length
      };
    }
    return { chain };
  },

  // typed-edge DecisionGraph CRUD. Three new optional
  // methods gated on features.decision_graph (advertised in
  // list_capabilities). Storage delegated to shared-core/state.js
  // helpers; semantics match the GMP v0.2 spec sections in
  // the GMP spec (published separately).
  'troth/record_edge': (params) => {
    if (!CAPABILITIES.decision_graph) return rpcError(-32102, 'decision_graph not enabled');
    if (!params || !params.from_id || !params.to_id || !params.label) {
      return rpcError(-32602, 'missing from_id, to_id, or label');
    }
    if (!state.recordEdge) return rpcError(-32603, 'recordEdge not implemented');
    const id = state.recordEdge({
      from_id: params.from_id,
      to_id:   params.to_id,
      label:   params.label,
      weight:  typeof params.weight === 'number' ? params.weight : null
    });
    if (!id) {
      // recordEdge returns null on validation/FK failure. Distinguish
      // "unknown label" from "missing record" using state's allowlist
      // and a quick FK probe.
      const labelOk = state.CANONICAL_EDGE_LABELS.includes(params.label) ||
                      String(params.label).startsWith('ext:');
      if (!labelOk) return rpcError(-32101, 'invalid label', { label: params.label });
      // FK miss
      if (!state.getAction(params.from_id)) return rpcError(-32100, 'from_id not found', { id: params.from_id });
      if (!state.getAction(params.to_id))   return rpcError(-32100, 'to_id not found',   { id: params.to_id });
      return rpcError(-32603, 'recordEdge write failed');
    }
    return { edge_id: id };
  },

  'troth/query_edges': (params) => {
    if (!CAPABILITIES.decision_graph) return rpcError(-32102, 'decision_graph not enabled');
    params = params || {};
    if (!state.queryEdges) return rpcError(-32603, 'queryEdges not implemented');
    const edges = state.queryEdges({
      from_id: params.from_id,
      to_id:   params.to_id,
      label:   params.label,
      limit:   params.limit,
      order:   params.order
    }) || [];
    return { edges };
  },

  // typed-edge causal path query (recursive CTE over
  // action_record_edges). Returns array of { node_id, depth, path }.
  // When client opts into format='tron' AND we advertise compact_wire,
  // the result is encoded as TRON-path (53% reduction at 50 rows
  // measured). 'auto' mode picks tron for path-shape payloads.
  'troth/trace_causal_path': (params) => {
    if (!params || !params.start_id) return rpcError(-32602, 'missing start_id');
    if (!CAPABILITIES.decision_graph) return rpcError(-32102, 'decision_graph not enabled');
    const path = query.traceCausalPath(state, {
      start_id:    params.start_id,
      depth_limit: params.depth_limit,
      direction:   params.direction,
      label:       params.label
    }) || [];
    let format = params.format || 'json';
    if (format === 'auto') format = wireFormat.pickFormat(path);
    if ((format === 'tron' || format === 'toon') && CAPABILITIES.compact_wire) {
      return {
        format,
        payload: format === 'tron'
          ? wireFormat.encodeNested(path, { shape: 'path' })
          : wireFormat.encodeBatch(path),
        count: path.length
      };
    }
    return { path };
  },

  // Mind layer — persist a mind-state snapshot.
  // Append-only: each call writes a new mind_snapshot ActionRecord. Older
  // snapshots remain queryable. Latest snapshot for a user is "current
  // mind state."
  'troth/mind/persist': (params) => {
    if (!params || !params.mind_state) return rpcError(-32602, 'missing mind_state');
    const v = mindState.validate(params.mind_state);
    if (!v.ok) return rpcError(-32101, 'mind_state validation failed', { errors: v.errors });
    const id = require('crypto').randomUUID();
    // Fall back to a UUIDv4 here — substrate accepts any 36-char id; UUIDv7
    // is preferred for chronological ordering but action-record's recordAction
    // does its own ordering by timestamp column. Either works.
    const built = mindState.buildSnapshotRecord({
      id,
      timestamp: Date.now(),
      agent_id: params.agent_id || 'unknown',
      cwd: params.cwd || null,
      mind_state: params.mind_state,
      trigger: params.trigger,
      prev_snapshot_id: params.prev_snapshot_id
    });
    if (!built.ok) return rpcError(-32101, 'snapshot build failed', { errors: built.errors });
    const validation = actionRec.validate(built.record);
    if (!validation.ok) return rpcError(-32101, 'action_record validation failed', { errors: validation.errors });
    const writtenId = state.recordAction(built.record, actionRec.toSearchText(built.record));
    if (!writtenId) return rpcError(-32603, 'mind snapshot write failed');
    return { snapshot_id: writtenId };
  },

  // Mind layer — distill a project's recent decisions + intents into a
  // compact `distilled_summary` string via an external LLM driver. The driver
  // is built from env (TROTH_MIND_DISTILL_ENDPOINT). When no endpoint is
  // configured, returns { skipped: true, reason: 'no_endpoint' } — caller
  // should not treat this as an error. Cost-bounded by callers via rate
  // limiting; this method itself is unconditional.
  'troth/mind/distill_project': async (params) => {
    if (!params || !params.project_id) return rpcError(-32602, 'missing project_id');
    const projectId = params.project_id;
    const cwd = params.cwd || null;

    // Find the project from the latest snapshot.
    const snapRows = state.queryActions({
      type: 'mind_snapshot', cwd, limit: 1, order: 'desc'
    }) || [];
    if (snapRows.length === 0) {
      return { skipped: true, reason: 'no_snapshot' };
    }
    const snapRec = actionRec.fromRow(snapRows[0]);
    const ms = snapRec && snapRec.output && snapRec.output.mind_state;
    if (!ms) return rpcError(-32100, 'snapshot has no mind_state output', { id: snapRec.id });
    const project = (Array.isArray(ms.active_projects) ? ms.active_projects : [])
      .find((p) => p && p.id === projectId);
    if (!project) {
      return { skipped: true, reason: 'project_not_in_snapshot', project_id: projectId };
    }

    // Pull recent intents and mind_decisions for this project (and cwd if present).
    const sinceMs = params.since ? Number(params.since)
                  : Date.now() - (30 * 24 * 60 * 60 * 1000);
    const decisionRowsR = state.queryActions({
      type: 'decision', cwd, since: sinceMs, limit: 200, order: 'asc'
    }) || [];
    const decisionsForProject = decisionRowsR.map((r) => actionRec.fromRow(r))
      .filter((rec) => rec && rec.input && rec.input.kind === 'mind_decision'
                       && rec.input.signals && rec.input.signals.project_id === projectId);

    const intentRows = state.queryActions({
      type: 'intent', cwd, since: sinceMs, limit: 100, order: 'asc'
    }) || [];
    const intents = intentRows.map((r) => actionRec.fromRow(r)).filter(Boolean);

    // Build driver from env; skip if not configured.
    const driver = mindState.makeHttpDistillDriverFromEnv(process.env);
    if (!driver) {
      return { skipped: true, reason: 'no_endpoint', project_id: projectId };
    }

    // Run the distillation.
    const distillation = await mindState.distillProject({
      project,
      decisions: decisionsForProject.map((rec) => ({
        decision_id: rec.id,
        summary: rec.input.signals && rec.input.signals.summary,
        rationale: rec.input.signals && rec.input.signals.rationale
      })),
      intents: intents.map((rec) => ({ goal: rec.input && rec.input.goal })),
      driver
    });
    if (!distillation.ok) {
      return { skipped: true, reason: distillation.reason, detail: distillation.detail || null };
    }

    // Persist as mind_distillation event.
    const built = mindState.buildDistillationEventRecord({
      id: require('crypto').randomUUID(),
      timestamp: Date.now(),
      agent_id: params.agent_id || 'distill',
      cwd,
      project_id: projectId,
      summary: distillation.summary,
      used_decision_ids: distillation.used_decision_ids
    });
    if (!built.ok) return rpcError(-32101, 'distillation event build failed', { errors: built.errors });
    const v = actionRec.validate(built.record);
    if (!v.ok) return rpcError(-32101, 'distillation event invalid', { errors: v.errors });
    const writtenId = state.recordAction(built.record, actionRec.toSearchText(built.record));
    if (!writtenId) return rpcError(-32603, 'distillation write failed');
    return {
      ok: true,
      project_id: projectId,
      distillation_id: writtenId,
      summary: distillation.summary,
      used_decision_count: distillation.used_decision_ids.length,
      intent_count: intents.length
    };
  },

  // Mind layer — record a decision against a project (Q2 manual override arm).
  // Writes a `decision` ActionRecord with input.kind='mind_decision' and
  // signals carrying project_id/summary/rationale/supersedes. The next
  // recomputeFromSubstrate pass folds these into the project's
  // key_decisions list. This is the explicit-capture pathway alongside
  // the heuristic Q2 capture (intent-driven). Always returns the new
  // record id; the mind_snapshot itself is updated lazily on next persist.
  'troth/mind/record_decision': (params) => {
    if (!params) return rpcError(-32602, 'missing params');
    const project_id = params.project_id;
    const summary = params.summary;
    const rationale = params.rationale || '';
    const supersedes = Array.isArray(params.supersedes)
      ? params.supersedes
      : (params.supersedes ? [params.supersedes] : []);
    if (typeof project_id !== 'string' || !project_id) return rpcError(-32602, 'missing project_id');
    if (typeof summary !== 'string' || !summary)       return rpcError(-32602, 'missing summary');

    const id = require('crypto').randomUUID();
    const record = {
      id,
      timestamp: Date.now(),
      type: 'decision',
      agent_id: params.agent_id || 'unknown',
      cwd: params.cwd || null,
      input: {
        kind: 'mind_decision',
        signals: {
          project_id,
          summary: summary.slice(0, 400),
          rationale: rationale.slice(0, 800),
          supersedes
        }
      },
      output: {
        decision: 'recorded',
        reason: 'manual_capture'
      },
      verification: {},
      outcome: {}
    };
    const validation = actionRec.validate(record);
    if (!validation.ok) return rpcError(-32101, 'decision record validation failed', { errors: validation.errors });
    const writtenId = state.recordAction(record, actionRec.toSearchText(record));
    if (!writtenId) return rpcError(-32603, 'decision write failed');
    return { decision_id: writtenId, project_id };
  },

  // Mind layer — fault-in full project detail by id.
  // Companion to mind/surface: when surface returns projects with
  // `_cold: true`, the agent can call this to expand one (or more) by id
  // and get the full hot detail (key_decisions, open_questions,
  // constraints, collaborators) from the latest snapshot. Returns map of
  // project_id → full project object. Missing ids appear in `not_found`.
  'troth/mind/fault_project': (params) => {
    params = params || {};
    const ids = Array.isArray(params.project_ids)
      ? params.project_ids
      : (params.project_id ? [params.project_id] : []);
    if (ids.length === 0) return rpcError(-32602, 'missing project_id or project_ids');

    const rows = state.queryActions({
      type: 'mind_snapshot',
      cwd: params.cwd,
      agent_id: params.agent_id,
      limit: 1,
      order: 'desc'
    }) || [];
    if (rows.length === 0) {
      return { projects: {}, not_found: ids, snapshot_id: null, is_empty: true };
    }
    const rec = actionRec.fromRow(rows[0]);
    const ms = rec && rec.output && rec.output.mind_state;
    if (!ms || !Array.isArray(ms.active_projects)) {
      return { projects: {}, not_found: ids, snapshot_id: rec.id, is_empty: false };
    }
    const byId = new Map();
    for (const p of ms.active_projects) {
      if (p && typeof p === 'object' && p.id) byId.set(p.id, p);
    }
    const projects = {};
    const not_found = [];
    for (const id of ids) {
      if (byId.has(id)) projects[id] = byId.get(id);
      else not_found.push(id);
    }
    return {
      projects,
      not_found,
      snapshot_id: rec.id,
      is_empty: false,
      snapshot_at: ms.snapshot_at
    };
  },

  // Mind layer — task-aware mind shaping (Q3 hot/cold).
  // Loads the latest mind_snapshot, then reshapes active_projects so the
  // project matching task_signature.project_id stays HOT (full detail)
  // and the others go COLD (name + stage + current_focus only). When no
  // signature is supplied OR no project matches, all projects stay hot —
  // identical shape to load_orientation.
  // V0.2: also writes a `mind_retrieval` event recording which projects
  // got hot detail; recompute uses these counts to score decision salience.
  'troth/mind/surface': (params) => {
    params = params || {};
    const rows = state.queryActions({
      type: 'mind_snapshot',
      cwd: params.cwd,
      agent_id: params.agent_id,
      limit: 50,
      order: 'desc'
    }) || [];
    const archived = mindState.getArchivedSnapshotIds(state, params.cwd);
    const liveRow = rows.find((r) => !archived.has(r.id));
    if (!liveRow) {
      const empty = mindState.emptyMindState(params.user_id);
      const shaped = mindState.shapeForTask(empty, params.task_signature);
      return {
        mind_state: shaped.mind_state,
        shape_info: shaped.shape_info,
        snapshot_id: null,
        is_empty: true
      };
    }
    const rec = actionRec.fromRow(liveRow);
    const ms = rec && rec.output && rec.output.mind_state;
    if (!ms) return rpcError(-32100, 'snapshot has no mind_state output', { id: rec.id });
    const shaped = mindState.shapeForTask(ms, params.task_signature);

    // Record retrieval — only HOT project ids count as truly retrieved
    // (cold projects are listed as skeletons, not full detail).
    try {
      const hotIds = Array.isArray(shaped.mind_state.active_projects)
        ? shaped.mind_state.active_projects.filter((p) => p && !p._cold && p.id).map((p) => p.id)
        : [];
      if (hotIds.length > 0) {
        const ev = mindState.buildRetrievalEventRecord({
          agent_id: params.agent_id || 'unknown',
          cwd: params.cwd || null,
          snapshot_id: rec.id,
          project_ids: hotIds,
          reason: 'mind_surface'
        });
        const v = actionRec.validate(ev);
        if (v.ok) state.recordAction(ev, actionRec.toSearchText(ev));
      }
    } catch (_) { /* retrieval-event write is best-effort, never blocks */ }

    return {
      mind_state: shaped.mind_state,
      shape_info: shaped.shape_info,
      snapshot_id: rec.id,
      is_empty: false,
      snapshot_at: ms.snapshot_at
    };
  },

  // Mind layer — load orientation snapshot for a session start.
  // Returns the latest mind_snapshot for the given filters (user_id, cwd,
  // agent_id). If no snapshot exists, returns an empty mind state so the
  // caller has a valid shape to work with — first-run / cold-start safe.
  // Optional task_signature parameter is reserved for future hot/cold
  // shaping (Q3); v0.1 returns the full snapshot.
  'troth/mind/load_orientation': (params) => {
    params = params || {};
    const filter = {
      type: 'mind_snapshot',
      cwd: params.cwd,
      agent_id: params.agent_id
    };
    // Pull more than 1 so we can skip archived snapshots and still
    // pick the latest *active* one. 50 is a generous ceiling that
    // covers months of dedup-bounded growth.
    const rows = state.queryActions({
      type: filter.type,
      cwd: filter.cwd,
      agent_id: filter.agent_id,
      limit: 50,
      order: 'desc'
    }) || [];
    const archived = mindState.getArchivedSnapshotIds(state, filter.cwd);
    const liveRow = rows.find((r) => !archived.has(r.id));
    if (!liveRow) {
      return {
        mind_state: mindState.emptyMindState(params.user_id),
        snapshot_id: null,
        is_empty: true
      };
    }
    const rec = actionRec.fromRow(liveRow);
    const ms = rec.output && rec.output.mind_state;
    if (!ms) {
      return rpcError(-32100, 'snapshot has no mind_state output', { id: rec.id });
    }

    // V0.2 — Record retrieval. load_orientation surfaces ALL active
    // projects as full detail, so all of their ids count as retrieved.
    // Best-effort write; never blocks the response.
    try {
      const allIds = Array.isArray(ms.active_projects)
        ? ms.active_projects.filter((p) => p && p.id).map((p) => p.id)
        : [];
      if (allIds.length > 0) {
        const ev = mindState.buildRetrievalEventRecord({
          agent_id: params.agent_id || 'unknown',
          cwd: params.cwd || null,
          snapshot_id: rec.id,
          project_ids: allIds,
          reason: 'mind_load_orientation'
        });
        const v = actionRec.validate(ev);
        if (v.ok) state.recordAction(ev, actionRec.toSearchText(ev));
      }
    } catch (_) { /* best-effort */ }

    return {
      mind_state: ms,
      snapshot_id: rec.id,
      is_empty: false,
      snapshot_at: ms.snapshot_at
    };
  },

  // Persona layer — fetch persona directive from locally tuned model.
  // Always-available tool surface; if the local llama-server endpoint is
  // unset or unreachable, returns { available: false, reason } so the
  // model can interpret this as "no persona context, behave normally".
  // Layer B is never load-bearing for correctness.
  'troth/query_persona_context': async (params) => {
    params = params || {};
    const result = await identity.queryPersona({
      user_text:      params.user_text,
      recent_context: params.recent_context
    });
    if (!result.ok) {
      return { available: false, reason: result.reason || 'unknown' };
    }
    return { available: true, persona_directive: result.text };
  },

  // Optional — feature-flagged
  'troth/search_actions': (params) => {
    if (!CAPABILITIES.fts_search) return rpcError(-32102, 'fts_search not enabled');
    if (!params || !params.query) return rpcError(-32602, 'missing query');
    const hits = state.searchActions(params.query, { limit: params.limit }) || [];
    return { hits };
  },

  // Phase D — virtual runtime surface. Requires features.virtual_runtime.
  'troth/open_session': (params) => {
    if (!CAPABILITIES.virtual_runtime) return rpcError(-32102, 'virtual_runtime not enabled');
    if (!params || !params.session_id) return rpcError(-32602, 'missing session_id');
    const sess = workingSet.openSession(state, {
      session_id:    params.session_id,
      agent_id:      params.agent_id,
      cwd:           params.cwd,
      budget_tokens: params.budget_tokens,
      max_size:      params.max_size
    });
    return { session_id: sess.session_id, opened_at: sess.opened_at };
  },

  'troth/get_manifest': (params) => {
    if (!CAPABILITIES.virtual_runtime) return rpcError(-32102, 'virtual_runtime not enabled');
    if (!params || !params.session_id) return rpcError(-32602, 'missing session_id');
    const out = runtime.buildManifest(params.session_id);
    if (!out) return { manifest: null, text: '', tokens_used: 0 };
    return out;
  },

  'troth/fetch_page': (params) => {
    if (!CAPABILITIES.virtual_runtime) return rpcError(-32102, 'virtual_runtime not enabled');
    if (!params || !params.action_id) return rpcError(-32602, 'missing action_id');
    const result = runtime.handleFetch(state, params.session_id || 'anonymous', params.action_id);
    if (!result.ok) return rpcError(-32100, 'page_fault: ' + (result.fault || 'unknown'), result);
    return result;
  },

  'troth/swap_session': (params) => {
    if (!CAPABILITIES.virtual_runtime) return rpcError(-32102, 'virtual_runtime not enabled');
    if (!params || !params.session_id) return rpcError(-32602, 'missing session_id');
    const r = workingSet.swap(state, params.session_id, {
      add:     params.add || [],
      remove:  params.remove || [],
      trigger: params.trigger || 'explicit_swap'
    });
    if (!r || !r.ok) return rpcError(-32103, 'swap_rejected: ' + (r && r.reason || 'unknown'), r);
    return r;
  },

  'troth/before_compact': (params) => {
    if (!CAPABILITIES.virtual_runtime) return rpcError(-32102, 'virtual_runtime not enabled');
    if (!params || !params.session_id) return rpcError(-32602, 'missing session_id');
    return runtime.onBeforeCompact(state, params.session_id, {
      budget_tokens: params.budget_tokens
    });
  },

  // Phase E — KnowledgeAtlas snapshot ops
  'troth/export_snapshot': (params) => {
    if (!CAPABILITIES.snapshots) return rpcError(-32102, 'snapshots not enabled');
    params = params || {};
    const result = atlas.exportAtlas(state, {
      filter: params.filter || {},
      limit:  params.limit,
      source: params.source
    });
    return {
      snapshot_id: 'atlas-' + Date.now(),
      content:     result.content,
      count:       result.count,
      header:      result.header
    };
  },

  'troth/import_snapshot': (params) => {
    if (!CAPABILITIES.snapshots) return rpcError(-32102, 'snapshots not enabled');
    if (!params || !params.content) return rpcError(-32602, 'missing content');
    const result = atlas.importAtlas(state, params.content, {
      conflict: params.conflict || 'skip'
    });
    return result;
  },

  // Compat shims for the legacy troth-archive MCP server. Same tool
  // names the model saw before consolidation, routed through the
  // unified substrate. tool_output_archive table is still populated
  // by the output-sandbox hook; these methods keep the read surface
  // stable. See the substrate design notes for rationale.
  'troth/archive_search': (params) => {
    if (!params || !params.query) return rpcError(-32602, 'missing query');
    // FTS5 owns bare punctuation ('0.1.15' → syntax error near ".") — found
    // by the second blind trial searching a version string. Anything beyond
    // plain words is passed as a quoted phrase, which FTS reads as literal
    // text instead of syntax.
    let _q = String(params.query);
    if (/[^\w\s]/.test(_q)) _q = '"' + _q.replace(/"/g, '""') + '"';
    const rows = state.searchArchive(_q, {
      session_id: params.session_id,
      limit:      params.limit
    }) || [];
    return { hits: rows };
  },
  'troth/archive_excerpt': (params) => {
    // Coerced, not typeof-checked: a caller that follows the archiver's
    // own retrieval hint arrives with a STRING id, and a strict type check
    // would send it away with 'missing archive_id'. An id is an id in
    // either spelling.
    const _aid = params ? Number(params.archive_id) : NaN;
    if (!Number.isFinite(_aid)) return rpcError(-32602, 'missing archive_id');
    const excerpt = state.getArchiveExcerpt(_aid, params.start_line, params.end_line);
    if (!excerpt) return rpcError(-32100, 'archive not found', { archive_id: _aid });
    return excerpt;
  },
  'troth/archive_list': (params) => {
    params = params || {};
    const rows = state.listArchives({ session_id: params.session_id, limit: params.limit }) || [];
    return { archives: rows };
  }
};

// ── MCP tool wrappers so existing MCP clients see GMP operations ────

const TOOLS = [
  {
    name: 'troth_list_capabilities',
    description: 'GMP: discover protocol version + feature flags the server supports.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name:    { type: 'string' },
        client_version: { type: 'string' }
      }
    }
  },
  {
    name: 'troth_record_action',
    description: [
      'GMP: write an ActionRecord. Pass the full record object; the server',
      'validates against the v0.1 schema and returns the stored id.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'object', description: 'Complete ActionRecord per GMP v0.1 schema.' }
      },
      required: ['action']
    }
  },
  {
    name: 'troth_fetch_action',
    description: 'GMP: load one ActionRecord by uuidv7 id. Use this when you have a bare UUID; if the UUID came embedded in a `<troth:page:UUID>` page-handle marker (emitted after working-set eviction), prefer troth_fault_in.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'UUIDv7 id of the record.' } },
      required: ['id']
    }
  },
  {
    name: 'troth_fault_in',
    description: 'PAGE-FAULT entry point. When you see a `<troth:page:UUID>` marker (any evicted action) OR a `<troth:intent:UUID>` marker (evicted intent record, P16 Tier 2) in your context, call this with the FULL marker as `handle`. The substrate returns the byte-equal record content. This is how you read evicted pages without re-deriving from scratch — analogous to a virtual-memory page fault. Cheaper than re-running tools that originally produced the content.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The full <troth:page:UUID> or <troth:intent:UUID> marker as it appears in context.' }
      },
      required: ['handle']
    }
  },
  {
    name: 'troth_query_actions',
    description: [
      'GMP: deterministic query over ActionRecords. Filter by type, agent_id,',
      'session_id, cwd, parent_id, since, until. Returns up to `limit` records',
      '(default 100, max 1000).'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object' },
        limit:  { type: 'integer', minimum: 1, maximum: 1000 },
        order:  { type: 'string', enum: ['asc', 'desc'] }
      }
    }
  },
  {
    name: 'troth_count_actions',
    description: 'GMP: count records matching a filter without materializing.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'object' } }
    }
  },
  {
    name: 'troth_trace_causality',
    description: [
      'GMP: walk parent_id edges from this action back toward root. Returns the',
      'chain child → root. Cycle-safe, depth-limited.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action_id: { type: 'string' },
        max_depth: { type: 'integer', minimum: 1, maximum: 256 }
      },
      required: ['action_id']
    }
  },
  {
    name: 'troth_search_actions',
    description: [
      'LOW-LEVEL diagnostic surface — returns raw FTS5 hits across ALL action_records (every type, every audience, no class projection).',
      'Use ONLY for admin / debugging / "what is actually in the DB". For the model to find memory by topic, use troth_recall (substrate server) — it pre-filters by audience and routes per memory_class.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      },
      required: ['query']
    }
  },
  // style hidden internal tools — handlers stay live for hooks /
  // CLI / programmatic callers, but the MCP TOOLS list omits them so
  // the model doesn't see ~1.5K tokens of descriptions per turn:
  //   - troth_query_persona_context  (obsolete Layer B leftover)
  //   - troth_mind_persist           (written by hooks, not by agent)
  //   - troth_mind_load_orientation  (called by session-start hook)
  // Surface kept: surface, fault_project, record_decision, distill_project.
  // Token-economy rationale: model rarely benefits from seeing internal-
  // lifecycle tools; keeping the surface ~3 tools narrower saves the
  // tokens for actual output.
  {
    name: 'troth_mind_distill_project',
    description: [
      'Mind layer: distill a project\'s recent decisions + intents into a',
      'compact distilled_summary via an external LLM. Pulls from the latest',
      'mind_snapshot for cwd; uses TROTH_MIND_DISTILL_ENDPOINT if set, returns',
      '{skipped:true,reason:"no_endpoint"} otherwise. Output written as a',
      'mind_distillation event so the next recompute pass surfaces it as',
      'project.distilled_summary on session start. Cost-bounded by caller via',
      'time-since-last-distill rate limit.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'id of the active project to distill.' },
        cwd:        { type: 'string', description: 'Optional working-directory scope.' },
        since:      { type: 'integer', description: 'Optional ms-epoch lower bound; defaults to last 30 days.' },
        agent_id:   { type: 'string', description: 'Identifier of the requesting agent.' }
      },
      required: ['project_id']
    }
  },
  {
    name: 'troth_mind_record_decision',
    description: [
      'Mind layer: explicitly record a decision against a project (manual',
      'override arm of Q2 — companion to the heuristic intent-driven capture).',
      'Writes a decision ActionRecord with kind=mind_decision; the next mind',
      'snapshot recomputation folds it into the project\'s key_decisions list.',
      'Use when you (or the user) want to anchor an important "we decided X',
      'because Y" call so future agents see it on session start.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'id of the active project this decision applies to.' },
        summary:    { type: 'string', description: 'Short verbatim decision (≤400 chars).' },
        rationale:  { type: 'string', description: 'Why this decision over alternatives (≤800 chars).' },
        supersedes: { type: 'array',  description: 'Optional list of decision_ids this one supersedes.', items: { type: 'string' } },
        agent_id:   { type: 'string', description: 'Identifier of the writing agent.' },
        cwd:        { type: 'string', description: 'Optional working-directory scope.' }
      },
      required: ['project_id', 'summary']
    }
  },
  {
    name: 'troth_mind_fault_project',
    description: [
      'Mind layer: fault-in full hot detail for one or more project ids.',
      'Companion to troth_mind_surface — when surface returns projects with',
      '_cold:true skeletons, call this to expand them. Returns a map of',
      'project_id → full project object (key_decisions, open_questions,',
      'constraints, collaborators) from the latest snapshot. Missing ids are',
      'reported in not_found.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        project_id:  { type: 'string', description: 'Single project id (convenience).' },
        project_ids: { type: 'array',  description: 'Multiple project ids in one call.', items: { type: 'string' } },
        cwd:         { type: 'string', description: 'Optional working-directory filter.' },
        agent_id:    { type: 'string', description: 'Optional writing-agent filter.' }
      }
    }
  },
  {
    name: 'troth_mind_surface',
    description: [
      'Mind layer: load the latest mind-state and reshape it for a',
      'specific task. Project(s) matching task_signature.project_id stay HOT',
      '(full detail: decisions, open_questions, constraints, collaborators).',
      'Other projects collapse to COLD form (name + stage + current_focus only)',
      'with _cold:true marker so the agent knows it can fault-in detail by id',
      'if needed. When no task_signature is supplied OR no project matches,',
      'all projects remain hot — identical shape to load_orientation.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        user_id:        { type: 'string',  description: 'User identifier (used for empty-state default user_id).' },
        cwd:            { type: 'string',  description: 'Optional working-directory filter.' },
        agent_id:       { type: 'string',  description: 'Optional writing-agent filter.' },
        task_signature: {
          type: 'object',
          description: 'Task signature object: { domain, project_id, subgoal }. project_id drives hot match in v0.1.'
        }
      }
    }
  },
  // DecisionGraph typed-edge CRUD.
  // Optional under features.decision_graph.
  {
    name: 'troth_record_edge',
    description: 'GMP v0.2 (decision_graph): write a typed edge between two ActionRecords. Labels: refines_intent, contradicts_prior, supersedes, produces_edit, satisfies, rationalizes (or ext:* for custom). Returns edge_id.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: 'UUIDv7 of source ActionRecord' },
        to_id:   { type: 'string', description: 'UUIDv7 of target ActionRecord' },
        label:   { type: 'string', description: 'one of 6 canonical labels OR ext:*' },
        weight:  { type: 'number', description: 'optional confidence (0..1)' }
      },
      required: ['from_id', 'to_id', 'label']
    }
  },
  {
    name: 'troth_query_edges',
    description: 'GMP v0.2 (decision_graph): list edges by from_id / to_id / label. Returns raw edge rows (no JSON-parse cost). Use for one-hop lookups; for path queries use troth_trace_causal_path.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' },
        to_id:   { type: 'string' },
        label:   { type: 'string' },
        limit:   { type: 'integer', minimum: 1, maximum: 2000 },
        order:   { type: 'string', enum: ['asc', 'desc'] }
      }
    }
  },
  {
    name: 'troth_trace_causal_path',
    description: 'GMP v0.2 (decision_graph): walk typed edges from a starting record up to depth_limit hops via recursive CTE. Returns [{node_id, depth, path}]. format=auto picks tron for path-shape payloads, toon for flat, json for legacy clients.',
    inputSchema: {
      type: 'object',
      properties: {
        start_id:    { type: 'string', description: 'UUIDv7 of starting record' },
        depth_limit: { type: 'integer', minimum: 1, maximum: 25 },
        direction:   { type: 'string', enum: ['out', 'in'] },
        label:       { type: 'string', description: 'optional restrict to one edge label' },
        format:      { type: 'string', enum: ['auto', 'tron', 'toon', 'json'] }
      },
      required: ['start_id']
    }
  },
  // Virtual runtime (Phase D) — optional under features.virtual_runtime.
  {
    name: 'troth_open_session',
    description: 'Open a virtual-runtime session with its own working set (optional budget/max_size).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id:    { type: 'string' },
        agent_id:      { type: 'string' },
        cwd:           { type: 'string' },
        budget_tokens: { type: 'integer' },
        max_size:      { type: 'integer' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'troth_get_manifest',
    description: [
      'Return the working-set manifest (pointers + summaries + token budget) that the agent',
      'sees as its compact memory. Use this to build context without dumping full records.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id']
    }
  },
  {
    name: 'troth_fetch_page',
    description: [
      'Fetch full content for an ActionRecord id (page-fault). Auto-loads into the working set.',
      'Returns structured fault for unknown ids — never hallucinates content.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        action_id:  { type: 'string' }
      },
      required: ['action_id']
    }
  },
  // internal-only tools (swap_session, before_compact, export/
  // import_snapshot, archive_*) removed from the MCP TOOLS list. They
  // remain available as GMP native methods (troth/swap_session
  // etc.) for hooks, the runtime, and the CLI to use programmatically;
  // they're just not advertised to the model. The model rarely needs
  // these — atlases ship via CLI, working-set swaps are lifecycle,
  // archive compat shims are for legacy callers. Removing them from
  // the system-prompt-visible tool list cuts ~1,500 bytes per turn.
  // archive_* shims also dropped from MCP TOOLS — handlers stay for
  // back-compat callers but the model needs only troth_search_actions.
];

function rpcError(code, message, data) {
  return { __error: { code, message, data } };
}

async function handleMethod(method, params) {
  if (method in HANDLERS) return HANDLERS[method](params);
  // MCP pass-through: tools/<name> routes to the mirrored GMP handler.
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args     = (params && params.arguments) || {};
    const ampMethod = ({
      troth_list_capabilities:    'troth/list_capabilities',
      troth_record_action:        'troth/record_action',
      troth_fetch_action:         'troth/fetch_action',
      troth_fault_in:             'troth/fault_in',
      troth_query_actions:        'troth/query_actions',
      troth_count_actions:        'troth/count_actions',
      troth_trace_causality:      'troth/trace_causality',
      troth_search_actions:       'troth/search_actions',
      troth_record_edge:          'troth/record_edge',
      troth_query_edges:          'troth/query_edges',
      troth_trace_causal_path:    'troth/trace_causal_path',
      troth_open_session:         'troth/open_session',
      troth_get_manifest:         'troth/get_manifest',
      troth_fetch_page:           'troth/fetch_page',
      troth_swap_session:         'troth/swap_session',
      troth_before_compact:       'troth/before_compact',
      troth_export_snapshot:      'troth/export_snapshot',
      troth_import_snapshot:      'troth/import_snapshot',
      troth_query_persona_context:'troth/query_persona_context',
      troth_mind_persist:         'troth/mind/persist',
      troth_mind_load_orientation:'troth/mind/load_orientation',
      troth_mind_surface:         'troth/mind/surface',
      troth_mind_fault_project:   'troth/mind/fault_project',
      troth_mind_record_decision: 'troth/mind/record_decision',
      troth_mind_distill_project: 'troth/mind/distill_project',
      archive_search:               'troth/archive_search',
      archive_excerpt:              'troth/archive_excerpt',
      archive_list:                 'troth/archive_list'
    })[toolName];
    if (!ampMethod) return rpcError(-32601, 'unknown tool: ' + toolName);
    // Await: some handlers (e.g. troth/query_persona_context) are async.
    // Awaiting a sync return value is a no-op, so this is safe for all.
    const result = await HANDLERS[ampMethod](args);
    if (result && result.__error) return result;
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities:    { tools: {} },
      serverInfo:      { name: SERVER_NAME, version: SERVER_VERSION }
    };
  }
  if (method === 'ping') return {};
  return rpcError(-32601, 'method not found: ' + method);
}

// ── JSON-RPC stdio loop ───────────────────────────────────────────────────

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  inputBuffer += chunk;
  let idx;
  while ((idx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, idx);
    inputBuffer = inputBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    await respond(msg);
  }
});

async function respond(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const send = (payload) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }) + '\n');
  };
  try {
    const out = await handleMethod(msg.method, msg.params);
    if (out && out.__error) {
      send({ error: out.__error });
    } else {
      send({ result: out });
    }
  } catch (e) {
    send({ error: { code: -32603, message: String(e && e.message || e) } });
  }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
