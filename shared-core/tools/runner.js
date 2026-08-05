// SPDX-License-Identifier: AGPL-3.0-only
// runner — unified tool_runner that bridges shared-core/tools (worldly:
// Read / Write / Edit / Bash / Grep / Glob) and shared-core/substrate-tools
// (semantic: engram_search / engram_record / chameleon_query /
// dialogue_recent / chameleon_list_scopes) into a single callback for
// llm-orchestrator.composeAgentic.
//
// Why this layer exists:
//   composeAgentic accepts ONE `tool_runner(toolCall, ctx)` callback —
//   we want the model to see BOTH families of tools in its `tools` array
//   and we want one dispatcher to route by name. This module is the
//   unifier. Both source registries already follow the same {schema,
//   run} contract, so the union is mechanical.
//
// Wire-shape contract (from llm-orchestrator.js:247-256):
//   tool_runner(toolCall, ctx) → string
//   The returned string becomes the `content` of the corresponding
//     role:'tool' message appended to the conversation
//   Errors must be returned as structured payloads, NEVER thrown —
//     the orchestrator wraps a thrown error as `tool_runner_threw` but
//     loses the model-recoverable detail
//
// Usage:
//   const { makeRunner, unifiedToolsArray } = require('./tools/runner.js');
//   const runner = makeRunner({ agent_id, cwd, user_id, embedding_host });
//   const tools  = unifiedToolsArray();   // schemas for the LLM `tools` field
//   const result = await orch.composeAgentic(
//     { kind:'llm', prompt, options: { tools } },
//     { agent_id, cwd, user_id, embedding_host, tool_runner: runner }
//   );

const worldly   = require('./index.js');
const substrate = require('../substrate-tools.js');
const mcpClient = require('./mcp-client.js');
const preActionContext = require('./pre-action-context.js');

// Union of registries. Precedence (low → high): substrate, mcp-client,
// worldly. Worldly wins because callers expect canonical Claude tool
// names there; mcp-client comes second because mcp_* names are unlikely
// to collide; substrate last for anything else.
function unifiedRegistry() {
  return Object.assign(
    {},
    substrate.REGISTRY || {},
    mcpClient.REGISTRY || {},
    worldly.REGISTRY || {}
  );
}

// subsystem — audience-chain enforcement helpers, exported so unit tests
// can verify behavior without re-requiring the entire registry (which
// would cascade state.db opens during flushAsyncTests and push the MCP
// test suite past its 5s rpc-timeout).
//
// applyAudienceInheritance(name, args, ctx) — mutates args in place when
// ctx._l4_external_seen is true and name='engram_record' lacks an explicit
// non-partner_internal audience. Returns the (possibly modified) args.
// Operator-deliberate override: an explicit audience='model_visible' or
// 'external' on the call is respected; only the silent default
// (audience missing OR audience='partner_internal') gets upgraded.
function applyAudienceInheritance(name, args, ctx) {
  if (!ctx || !args || typeof args !== 'object') return args;
  if (name !== 'engram_record') return args;
  if (ctx._l4_external_seen !== true) return args;
  if (!args.audience || args.audience === 'partner_internal') {
    args.audience = 'external';
  }
  return args;
}

// recordExternalAudience(result, ctx) — sets the sticky flag on ctx when
// the tool's return envelope carries audience='external'. Idempotent;
// the flag does not decay within the agentic run.
function recordExternalAudience(result, ctx) {
  if (!ctx) return;
  if (result && typeof result === 'object' && result.audience === 'external') {
    ctx._l4_external_seen = true;
  }
}

// Combined OpenAI-compatible tools array. Pass a list of names to filter
// (intersects with what's actually available); omit for the full union.
function unifiedToolsArray(filterNames) {
  const reg = unifiedRegistry();
  const names = Array.isArray(filterNames) && filterNames.length
    ? filterNames
    : Object.keys(reg);
  // faculty workstream (S2): in faculty emit-mode the LLM holds no action/authority
  // tool — those are excised here too, mirroring substrate-tools.toolsArray.
  const emit = substrate.facultyEmitModeOn();
  const out = [];
  for (const n of names) {
    if (emit && substrate.FACULTY_EXCLUDED_TOOLS.has(n)) continue;
    const entry = reg[n];
    if (entry && entry.schema) out.push(entry.schema);
  }
  return out;
}

// Make a tool_runner closure bound to an agent context. The closure
// captures agent_id / cwd / user_id / embedding_host so the per-call
// ctx in the orchestrator doesn't have to repeat them on every invoke.
function makeRunner(baseCtx) {
  baseCtx = baseCtx || {};
  const reg = unifiedRegistry();
  return async function runner(toolCall, callerCtx) {
    const name = toolCall && toolCall.function && toolCall.function.name;
    const argsRaw = toolCall && toolCall.function && toolCall.function.arguments;
    let args = {};
    if (typeof argsRaw === 'string') {
      try { args = JSON.parse(argsRaw); } catch (_) { args = {}; }
    } else if (argsRaw && typeof argsRaw === 'object') {
      args = argsRaw;
    }
    const entry = reg[name];
    if (!entry) return JSON.stringify({ error: 'unknown_tool', name });

    // subsystem — audience-chain hard enforcement. The flag lives on
    // callerCtx (the orchestrator passes the SAME object across iterations)
    // so the chain survives across tool calls within one composeAgentic.
    const audienceBefore = args.audience;
    applyAudienceInheritance(name, args, callerCtx);
    if (args.audience !== audienceBefore) {
      // Rewrite toolCall.function.arguments so the substrate handler sees
      // the inherited audience.
      try { toolCall.function.arguments = JSON.stringify(args); } catch (_) {}
    }

    const ctx = Object.assign({}, baseCtx, callerCtx || {});

    // pre-action context retrieval.
    //
    // Before running interesting worldly tools (Read/Edit/Write/MultiEdit/
    // Grep/Glob), fetch related prior action_records and merge a short
    // substrate-derived context summary into the result. The LLM never
    // reaches for a tool blind — it gets "you've edited this file 4×
    // recently; decided to use Zod here 2 weeks ago" alongside the raw
    // tool output.
    //
    // Deterministic only (anticipator.js retired  for being
    // LLM-driven — production engrams = 0 in 7 days). FTS/queryActions/
    // listEngrams only. Skipped for substrate tools (they ARE recall,
    // no point recalling for them) and Bash (too noisy). See
    // pre-action-context.js isInteresting() for the gate.
    let priorContext = null;
    if (preActionContext.isInteresting(name)) {
      try {
        priorContext = preActionContext.gatherPriorContext({
          tool_name: name, args, cwd: ctx.cwd
        });
      } catch (_) { /* never block on context retrieval */ }
    }

    // MA-2 — generic remote-executor seam (Model A). When the embedder injects
    // ctx.remote_executor AND this is a WORLDLY tool (the "hands": Read/Write/
    // Edit/Bash/Grep/Glob/web_*), the ONE host mind dispatches the concrete
    // action INTO an execution sandbox (the L4 body) and awaits the observation,
    // instead of touching this host. SUBSTRATE/memory tools (engram_*,
    // dialogue_*, chameleon_*, mcp_*) are NEVER remoted — they are the mind
    // itself, and stay host-side. This seam is deliberately body-AGNOSTIC: the
    // closed app injects the actual signed body client as ctx.remote_executor;
    // open core knows only "a function that runs a worldly action elsewhere".
    // FAIL-CLOSED: a remote error is returned as-is — we NEVER silently fall
    // back to executing the action on the host.
    const remoteEligible =
      typeof ctx.remote_executor === 'function' &&
      Object.prototype.hasOwnProperty.call(worldly.REGISTRY || {}, name);

    let result;
    if (remoteEligible) {
      try { result = await ctx.remote_executor(name, args, ctx); }
      catch (e) {
        return JSON.stringify({ error: 'remote_exec_failed', name, detail: e && e.message || String(e) });
      }
    } else {
      try { result = await entry.run(args, ctx); }
      catch (e) {
        return JSON.stringify({ error: 'tool_exception', name, detail: e && e.message || String(e) });
      }
    }

    // subsystem — sticky external-content flag. Any tool whose result
    // envelope carries audience='external' (web_fetch is the canonical
    // emitter; future research adapters can also tag) marks the chain
    // as having seen external content.
    recordExternalAudience(result, callerCtx);

    // Worldly results may exceed the archive threshold — re-use the
    // existing archiver so big stdouts don't blow context. Substrate
    // results are already small by construction (engrams, dialogue
    // turns) but the wrap is harmless on small payloads.
    const archived = (typeof worldly.maybeArchive === 'function')
      ? worldly.maybeArchive(name, result)
      : result;

    // Phase G — merge prior context into the result envelope so the LLM
    // sees it as part of the tool message content. If archived is a
    // string (already serialized by the archiver), wrap it in an envelope
    // so we can add _prior_context cleanly.
    if (priorContext) {
      if (archived && typeof archived === 'object') {
        return JSON.stringify(Object.assign({}, archived, {
          _prior_context: priorContext.summary,
          _prior_context_refs: priorContext.refs
        }));
      }
      // Archived as string (worldly tool with big stdout) — prepend a
      // commented substrate block so the LLM still sees the context.
      const archivedStr = typeof archived === 'string' ? archived : JSON.stringify(archived);
      return '[troth/prior_context]\n' + priorContext.summary + '\n[/troth/prior_context]\n\n' + archivedStr;
    }
    return JSON.stringify(archived);
  };
}

module.exports = {
  makeRunner,
  unifiedToolsArray,
  unifiedRegistry,
  // subsystem — exported for tests + future re-use (e.g. claude-proxy
  // injector that needs the same audience-chain semantics).
  applyAudienceInheritance,
  recordExternalAudience
};
