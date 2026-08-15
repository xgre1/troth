#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-substrate — MCP wrapper exposing the substrate-as-entity
// primitives (engram, chameleon, dialogue, dispatch, transport-config)
// to any MCP-aware host (Claude Code, Cursor, OpenClaw, etc).
//
// Why a separate server (not folded into troth-memory): memory's
// surface is L1 ActionRecord CRUD + GMP. Substrate primitives
// are higher-level operations on top of that L1. Keeping them in
// their own server lets clients enable / disable the substrate path
// independently and lets the documentation track each layer's tools
// separately.
//
// Protocol: stdio JSON-RPC, MCP tools/list + tools/call.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);
const serverDir = fileURLToPath(new URL('.', import.meta.url));

// The MODEL-facing edge of every statement this server returns.
//
// The data layer carries statements whole — a 600-char cap there amputated
// memories for every surface at once and was removed for it. But this edge
// spends the model's context, and it budgets like every other edge: measured
// over 52,833 recallable statements, p50 is 72 chars, p99 is 1,202, and one
// outlier reaches 10,555 — a limit-50 recall on a bad day would have dumped
// ~33k tokens of tail into the window. 2,000 clears the p99 with two-thirds
// headroom; the rare giant arrives clipped and SAYS SO, its id one
// troth_fetch_action away — the sin of the old cap was that it was silent,
// at the wrong layer, and left no road to the rest.
const STATEMENT_EDGE_CHARS = 2000;
function edgeStatement(s) {
  const t = String(s == null ? '' : s);
  if (t.length <= STATEMENT_EDGE_CHARS) return { statement: t };
  return { statement: t.slice(0, STATEMENT_EDGE_CHARS), truncated: true };
}
const engram         = require(serverDir + '../../../shared-core/engram.js');
const chameleon      = require(serverDir + '../../../shared-core/chameleon.js');
const chameleonRT    = require(serverDir + '../../../shared-core/chameleon-runtime.js');
const dialogueMemory = require(serverDir + '../../../shared-core/dialogue-memory.js');
const dispatchMod    = require(serverDir + '../../../shared-core/dispatch.js');
const transportCfg   = require(serverDir + '../../../shared-core/transport-config.js');
const serverLifecycle = require(serverDir + '../../../shared-core/server-lifecycle.js');
const identityVectors = require(serverDir + '../../../shared-core/identity-vectors.js');
const multiAgent     = require(serverDir + '../../../shared-core/multi-agent.js');
const supervisor     = require(serverDir + '../../../shared-core/agent-supervisor.js');
const { resolveAgentId } = require(serverDir + '../../../shared-core/agent-id.js');
const rolesMod       = require(serverDir + '../../../shared-core/roles.js');
const planner        = require(serverDir + '../../../shared-core/planner.js');
const triageMod      = require(serverDir + '../../../shared-core/orchestrate-triage.js');
const entityAxis     = require(serverDir + '../../../shared-core/entity-axis.js');
const intentRouter   = require(serverDir + '../../../shared-core/intent-router.js');
const identityExtract = require(serverDir + '../../../shared-core/identity-extract.js');
const procedureMatcher = require(serverDir + '../../../shared-core/procedure-matcher.js');
const slashParser    = require(serverDir + '../../../shared-core/slash/parser.js');
const slashLoader    = require(serverDir + '../../../shared-core/slash/loader.js');
const slashExecutor  = require(serverDir + '../../../shared-core/slash/executor.js');
const recallMod      = require(serverDir + '../../../shared-core/recall.js');
const lessonMod      = require(serverDir + '../../../shared-core/lesson.js');
const substrateTools = require(serverDir + '../../../shared-core/substrate-tools.js');
const mcpClient      = require(serverDir + '../../../shared-core/tools/mcp-client.js');
const worldlyTools   = require(serverDir + '../../../shared-core/tools/index.js');

const SERVER_NAME    = 'troth-substrate';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

// Default substrate context — every tool call uses these unless the
// caller passes overrides in the tool args. AGENT_ID can be set per
// host via env to keep different MCP clients in separate substrates.
// cwd defaults to NULL (not process.cwd()): the MCP server's working
// directory is arbitrary (wherever the daemon was spawned) and has no
// meaning to substrate isolation. Stamping it on every query silently
// filtered out engrams written from any other cwd. Operators who DO
// want per-project isolation set TROTH_ENTITY_CWD explicitly; callers
// who want it set per-call pass cwd in tool args.
const DEFAULT_CTX = {
  agent_id: process.env.TROTH_ENTITY_AGENT_ID || 'mcp-substrate',
  user_id:  process.env.TROTH_ENTITY_USER_ID  || 'default',
  cwd:      process.env.TROTH_ENTITY_CWD      || null
};

function ctxFromArgs(args) {
  args = args || {};
  return {
    agent_id: args.agent_id || DEFAULT_CTX.agent_id,
    user_id:  args.user_id  || DEFAULT_CTX.user_id,
    cwd:      args.cwd      || DEFAULT_CTX.cwd
  };
}

// ── Tool registry: each entry is {schema, run} ─────────────────────────────

const TOOLS = {
  troth_slash_invoke: {
    description: 'Execute a troth slash skill (`/goal`, `/remember`, `/recall`, `/context`, `/forget`, `/usage`, etc.) from any MCP host. Deterministic skills run in-process and return the final reply text + persisted engram ids; LLM-driven skills return the rendered prompt for the host model to consume. Discovers SKILL.md across plugin/skills, ~/.troth/skills, ~/.claude/skills, .claude/commands, and the project-local .claude/skills/. Same substrate semantics as the voice/chat path — every invocation writes a causal-trace engram (scope=command).',
    inputSchema: {
      type: 'object',
      properties: {
        slash:    { type: 'string', description: 'The full slash invocation, e.g. "/goal ship Mode B by Friday".' },
        agent_id: { type: 'string', description: 'Override substrate agent_id; defaults to env TROTH_ENTITY_AGENT_ID or "mcp-substrate".' },
        cwd:      { type: 'string', description: 'Override scope cwd; defaults to env TROTH_ENTITY_CWD or null (no cwd filter).' },
        user_id:  { type: 'string' }
      },
      required: ['slash']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const parsed = slashParser.parse(String(args.slash || ''));
      if (!parsed.is_slash) {
        return { ok: false, error: 'not_a_slash', detail: 'input must start with /<name>' };
      }
      const skill = slashLoader.load(parsed.name, { cwd: ctx.cwd || undefined });
      if (!skill) {
        return { ok: false, error: 'unknown_slash', name: parsed.name };
      }
      // Deterministic path — run in-process, return the canned reply +
      // any side-effect ids so the caller can audit + surface to the user.
      if (skill.kind === 'deterministic') {
        const t0 = Date.now();
        let res;
        try { res = await slashExecutor.executeDeterministic(skill, parsed, ctx); }
        catch (e) { return { ok: false, error: 'deterministic_threw', detail: e && e.message || String(e) }; }
        if (!res || res.ok === false) {
          return { ok: false, error: res && res.error || 'deterministic_failed', detail: res && res.detail };
        }
        return {
          ok: true,
          mode: 'deterministic',
          skill: skill.name,
          text: res.text,
          side_effects: res.side_effects || null,
          trace_engram_id: res.trace_engram_id,
          elapsed_ms: Date.now() - t0
        };
      }
      // LLM-driven path — render the prompt + return it. The host
      // (Claude Code et al) feeds the rendered text to its own model.
      // We still write the causal-trace engram via execute().
      let resolved;
      try { resolved = await slashExecutor.execute(skill, parsed, ctx); }
      catch (e) { return { ok: false, error: 'render_threw', detail: e && e.message || String(e) }; }
      if (!resolved || resolved.ok === false) {
        return { ok: false, error: resolved && resolved.error || 'render_failed' };
      }
      return {
        ok: true,
        mode: 'llm',
        skill: skill.name,
        rendered_prompt: resolved.prompt,
        allowed_tools:   resolved.allowed_tools,
        model_hint:      resolved.model,
        trace_engram_id: resolved.trace_engram_id,
        instruction_to_host: 'Feed `rendered_prompt` to your model. The skill body documents which substrate tools to call.'
      };
    }
  },

  troth_engram_record: {
    description: 'Commit a single salient fact to the substrate\'s long-term semantic memory. Use sparingly — only for stable, recallable information (user preferences, identity, commitments, facts the host should remember across sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The fact, one sentence' },
        scope:     { type: 'string', description: 'Optional corpus scope; omit for general user-fact engrams' },
        salience:  { type: 'number', description: 'Importance 0..2 (default 1)' },
        agent_id:  { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['statement']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      let embedding = null;
      try { embedding = await engram.embedRequest(transportCfg.embeddingHost(), args.statement); }
      catch (_) { embedding = null; }
      // TMMA write-time quality control on (env-gated, default ON for the
      // MCP path — substrate-as-MCP is the canonical write surface, so we
      // get the contradiction/duplicate scoring on every record without
      // touching legacy direct callers). Verifier is pure JS (engram-verify),
      // bounded cost. Outputs land on the persisted record as truth_score,
      // tier, contradiction_refs, duplicate_of so retrieval can promote /
      // demote based on pool-level integrity.
      const autoVerify = process.env.TROTH_ENGRAM_AUTO_VERIFY !== '0';
      const id = engram.recordEngram({
        ...ctx,
        statement: args.statement,
        source:    'mcp:engram_record',
        salience:  typeof args.salience === 'number' ? args.salience : 1.0,
        embedding,
        scope:     args.scope || null,
        auto_verify: autoVerify
      });
      return { ok: !!id, id, embedded: !!embedding };
    }
  },

  // A decision's reasoning SHAPE, recorded so a future session — possibly a
  // weaker model — can re-run the strategy instead of re-deriving it. Same
  // logic as rules-vs-engrams: asked differently, written differently. The
  // composer in shared-core/decision-record.js is the ONLY author of the
  // template so every record renders identically on every recall surface.
  troth_decision_record: {
    description: 'Record the reasoning shape of a significant decision: named strategy, when it applies, the step skeleton, the contrastive wrong turn (mistake→why→correct), one grounding example, and provenance. Use after real decisions whose reasoning would help a future session on a similar problem — not for routine choices. The statement is composed from a fixed template; do not pre-format.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy:  { type: 'string', description: 'Short name of the strategy (≤60 chars)' },
        trigger:   { type: 'string', description: 'The situation shape where this applies — this line is the retrieval key' },
        steps:     { type: 'array', items: { type: 'string' }, description: '2-7 moves of the skeleton; structure transfers, detail does not' },
        contrast:  { type: 'object', properties: { mistake: { type: 'string' }, why: { type: 'string' }, correct: { type: 'string' } }, description: 'The wrong turn: what tempts, why it fails, the correct move. Optional but the highest-value field.' },
        example:   { type: 'string', description: 'One concrete grounding instance (≤240 chars)' },
        provenance: { type: 'object', properties: { model: { type: 'string' }, verdict: { type: 'string', description: 'operator_confirmed | test_passed | critic_confirmed | unverified' } }, description: 'Who reasoned this and how it was verified — required; weak-source records poison stronger consumers' },
        salience:  { type: 'number' }, agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['strategy', 'trigger', 'steps', 'provenance']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const composer = require(serverDir + '../../../shared-core/decision-record.js');
      const composed = composer.compose(args);
      if (!composed.ok) return composed;
      let embedding = null;
      try { embedding = await engram.embedRequest(transportCfg.embeddingHost(), composed.statement); }
      catch (_) { embedding = null; }
      const autoVerify = process.env.TROTH_ENGRAM_AUTO_VERIFY !== '0';
      const id = engram.recordEngram({
        ...ctx,
        statement: composed.statement,
        source:    'mcp:decision_record',
        salience:  typeof args.salience === 'number' ? args.salience : 1.2,
        embedding,
        scope:     composed.scope,
        auto_verify: autoVerify,
        extra_output: { compact: composed.compact, provenance: args.provenance }
      });
      return { ok: !!id, id, scope: composed.scope, embedded: !!embedding };
    }
  },

  // A rule the OPERATOR gave about how to work, as opposed to a fact about
  // the world. Both are memory; they are asked for differently, so they are
  // written differently. Until this existed the substrate held 5,143 lessons
  // and not one of them came from a person.
  troth_rule_record: {
    description: 'Record a standing WORKING RULE the operator stated — how they want work done ("verify the cause before fixing", "never force push without asking"). NOT for facts about the world: those are engrams, use troth_engram_record. Be selective: a rule is something the operator would want followed again next month, not a one-off instruction for the current task. If the operator\'s wording is ambiguous or you are unsure whether they meant it as a standing rule, ASK THEM before recording it. Returns similar existing rules; if it returns similar_rules_exist, read them and either leave the existing one alone or re-send with confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        text:    { type: 'string', description: 'The rule, imperative and self-contained, in the operator\'s meaning' },
        why:     { type: 'string', description: 'Optional: what happened that made this a rule — a rule with a reason survives being questioned' },
        scope:   { type: 'string', enum: ['global', 'project'], description: 'global (default) applies everywhere; project applies only in this working directory' },
        confirm: { type: 'boolean', description: 'Set true to add a rule the substrate flagged as close to one it already holds' },
        agent_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['text']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      return await lessonMod.recordRule({
        text:    args.text,
        why:     args.why || null,
        scope:   args.scope === 'project' ? 'project' : 'global',
        cwd:     ctx.cwd || null,
        agent_id: ctx.agent_id,
        confirm: !!args.confirm,
        embedding_host: transportCfg.embeddingHost()
      });
    }
  },

  troth_rule_list: {
    description: 'The standing working rules the operator has given, newest first. Read-only — unlike the transient lesson pull, this never consumes what it returns. Use before recording a new rule, and when the operator asks what rules you are working under.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rules (default 20)' },
        cwd:   { type: 'string', description: 'When given, project-scoped rules from other projects are left out' }
      }
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const items = lessonMod.listRules({ limit: args.limit || 20, cwd: args.cwd || ctx.cwd || null });
      return { count: items.length, items };
    }
  },

  // The code graph the partner already keeps, finally askable.
  //
  // codelens indexes 8,303 entities and 31,248 CALLS edges for this repo and
  // reached the model one way only: the proxy injecting related code chunks.
  // Structural questions — who calls this, is it reachable, what breaks if I
  // change it — were answered with grep, badly: a grep that excluded tests/
  // reported "nothing calls action-outcome.js" when the truth was "only the
  // test suite does", which is the more useful answer and the one the graph
  // gives immediately.
  troth_code_who_calls: {
    description: 'Ask the code index who calls a function, class or method — and whether anything in PRODUCTION reaches it, or only the test suite. Use this INSTEAD of grepping for callers: it reads a real call graph, distinguishes test-only callers from live ones, and answers in one call. Also use it before changing or deleting something, to see what depends on it.',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Function / class / method name' },
        exact: { type: 'boolean', description: 'Only entities whose name matches exactly (default false)' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cwd:   { type: 'string', description: 'Project root; defaults to the session cwd' }
      },
      required: ['name']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      return require(serverDir + '../../../shared-core/code-graph.js')
        .whoCalls(args.name, { cwd: args.cwd || ctx.cwd || undefined, exact: !!args.exact, limit: args.limit });
    }
  },

  troth_code_calls: {
    description: 'Ask the code index what a function reaches — its outgoing calls — from the same real call graph as troth_code_who_calls. Use this INSTEAD of reading the body to trace dependencies: it answers in one call, and it is the blast radius you want BEFORE changing or deleting something. The mirror of troth_code_who_calls, which answers who reaches IN.',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Function / class / method name' },
        exact: { type: 'boolean', description: 'Only entities whose name matches exactly (default false)' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max callees to return (default 25)' },
        cwd:   { type: 'string', description: 'Project root; defaults to the session cwd' }
      },
      required: ['name']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      return require(serverDir + '../../../shared-core/code-graph.js')
        .whatItCalls(args.name, { cwd: args.cwd || ctx.cwd || undefined, exact: !!args.exact, limit: args.limit });
    }
  },

  troth_code_file_map: {
    description: 'Everything defined in one file, with how many things reach each — and which are reached by nothing at all. Answers "is any of this still alive" for a whole file at once.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path, absolute or relative to the project root' },
        cwd:  { type: 'string' }
      },
      required: ['file']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      return require(serverDir + '../../../shared-core/code-graph.js')
        .fileMap(args.file, { cwd: args.cwd || ctx.cwd || undefined });
    }
  },

  troth_recall: {
    description: 'Unified class-routed substrate recall. Pre-filters by audience (default model_visible — substrate-internal items never reach this surface), then routes per memory_class: identity (anchors / user-facts), semantic (research lessons), episodic (recent commitments), procedural (compiled procedures). Pass class="all" to merge with priority order; pass class explicitly to scope a single store. Replaces troth_engram_search for general use — that tool was structurally blind to lesson and dialogue pools.',
    inputSchema: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Natural-language query' },
        class:    { type: 'string', enum: ['identity','episodic','semantic','procedural','all'], description: 'Memory class to route to; default "all"' },
        audience: { type: 'string', enum: ['model_visible','substrate_internal','synthesis_of_external','all'], description: 'Audience filter; default "model_visible". synthesis_of_external = items derived from external/untrusted input (web fetches, third-party tool output) — separate tier per recall.js:27-32.' },
        limit:    { type: 'integer', minimum: 1, maximum: 50, description: 'Max items (default 5)' },
        cwd:      { type: 'string' },
        rerank:   { type: 'boolean', description: 'Cross-encoder precision rerank (bge-reranker) — surfaces conceptually-relevant memories the keyword/bi-encoder arm buried. Default TRUE on this deliberate lookup path; gracefully no-ops if the reranker model is absent. Set false to skip for speed.' }
      },
      required: ['query']
    },
    run: async (args) => {
      // Phase K: recall is async now (optional embedding rerank).
      const items = await recallMod.recall({
        query: args.query,
        class: args.class || 'all',
        audience: args.audience || 'model_visible',
        limit: args.limit || 5,
        cwd:   args.cwd || null,
        // Cross-encoder precision tier ON for deliberate /recall lookups (the
        // every-turn injector path stays OFF for latency). Graceful-degrades if
        // the reranker model isn't present (recall.js:857). Default on; opt out.
        rerank: args.rerank !== false
      });
      return {
        items: items.map((i) => Object.assign({}, i, edgeStatement(i.statement))),
        class_filter: args.class || 'all',
        audience_filter: args.audience || 'model_visible'
      };
    }
  },

  troth_engram_search: {
    description: 'LEGACY (use troth_recall instead for general lookup). Searches ONLY the commitment-engram pool — structurally blind to lessons / dialogue / procedural memory. Kept for callers that explicitly want the commitment-pool surface (per-agent isolation, scope filter, cosine ranking). For "find what is in my mind" without knowing the class, prefer troth_recall.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k:     { type: 'integer', minimum: 1, maximum: 20 },
        scope: { type: 'string', description: 'Optional scope filter; omit for all engrams' },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['query']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      // Intent-routed: chitchat / epistemic queries (greetings, date,
      // math, weather) return empty so the model answers from world
      // knowledge instead of dumping memory blocks for trivia.
      const { intent, weights } = intentRouter.route(args.query);
      if (weights === null) {
        return { items: [], intent, skipped: 'no-retrieval-for-' + intent };
      }
      // Substrate-as-mind: read across the unified partner brain by
      // default. agent_id only honored when the CALLER explicitly
      // passed it in args (operator audit views), not the ctx default.
      const items = await engram.retrieveRelevant({
        cwd:   ctx.cwd,
        agent_id: args.agent_id || undefined,
        query: args.query,
        k:     args.k || 5,
        scope: args.scope === undefined ? undefined : args.scope,
        embedding_host: transportCfg.embeddingHost()
      });
      const results = items.map(i => ({
        ...edgeStatement(i.statement),
        score:     Number(i.score && i.score.toFixed ? i.score.toFixed(3) : i.score),
        scope:     i.scope,
        ts:        i.ts
      }));
      // Diagnostic: empty result + caller used the default agent_id is the
      // canonical "wrong bucket" failure mode. Surface which agents DO have
      // data so the caller can re-route. Metadata only, no contents leaked.
      const out = { results, effective_agent_id: ctx.agent_id };
      if (results.length === 0) {
        out.hint = 'No matches under agent_id="' + ctx.agent_id + '". Try one from agents_with_engrams.';
        out.agents_with_engrams = engram.listAgentsWithEngrams({ limit: 10 });
      }
      return out;
    }
  },

  troth_chameleon_ingest: {
    description: 'WRITE path for bulk-ingesting a document into a named substrate corpus (scope). Chunked sentence-aware, embedded per chunk, stored as scoped engrams. The READ counterpart is troth_chameleon_query for scope-specific lookup OR troth_recall(class:"semantic") for the unified surface.',
    inputSchema: {
      type: 'object',
      properties: {
        scope:   { type: 'string', description: 'Corpus name, e.g., "docs:codebase"' },
        text:    { type: 'string', description: 'Document body' },
        title:   { type: 'string', description: 'Optional title prepended to chunks' },
        chunk_chars:   { type: 'integer' },
        chunk_overlap: { type: 'integer' },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['scope', 'text']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const r = await chameleon.ingestDocument({
        ...ctx,
        scope: args.scope,
        text:  args.text,
        title: args.title || null,
        chunk_chars:   args.chunk_chars,
        chunk_overlap: args.chunk_overlap,
        embedding_host: transportCfg.embeddingHost()
      });
      return r;
    }
  },

  troth_identity_bootstrap: {
    description: 'DEPRECATED. The regex auto-write path is retired — pattern matching on operator first-person statements is NOT operator cryptographic confirmation. dry_run still returns a preview of what regex WOULD have surfaced (useful for diagnostic review). Non-dry-run returns written:[] always. Use update_identity tool for capture (writes at honest llm_inferred tier); reflection-tick backfill is deferred.',
    inputSchema: {
      type: 'object',
      properties: {
        source_agent_id: { type: 'string', description: 'Where to read dialogue.turn entries from (defaults to env TROTH_ENTITY_AGENT_ID)' },
        limit:           { type: 'integer', minimum: 10, maximum: 2000, description: 'Max recent dialogue turns to scan (default 500)' },
        min_sessions:    { type: 'integer', minimum: 1, maximum: 10, description: 'Min distinct day-buckets a fact must appear in to qualify as stable (default 2)' },
        dry_run:         { type: 'boolean', description: 'When true, return preview without writing' },
        cwd:             { type: 'string' }, user_id: { type: 'string' }
      }
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const r = identityExtract.seedFromDialogue({
        source_agent_id: args.source_agent_id || resolveAgentId(),
        cwd:             args.cwd || ctx.cwd,
        user_id:         args.user_id || ctx.user_id,
        limit:           args.limit || 500,
        min_sessions:    args.min_sessions || 2,
        dry_run:         !!args.dry_run
      });
      // Dry-run preview includes the stable list with full statements
      // so the caller can decide whether to commit. Non-dry-run only
      // returns ids + counts (statements are already in the substrate).
      if (r.dry_run) {
        return {
          ok: r.ok,
          dry_run: true,
          turns_scanned: r.turns_scanned,
          stable_count: r.stable_count,
          preview: (r.stable || []).slice(0, 25).map(g => ({
            statement: g.statement,
            source_pattern: g.source_pattern,
            sessions: g.sessions ? g.sessions.size || g.sessions.length : 0
          }))
        };
      }
      return {
        ok: r.ok,
        turns_scanned: r.turns_scanned,
        stable_count: r.stable_count,
        written_count: (r.written && r.written.length) || 0,
        written: r.written || []
      };
    }
  },

  troth_match_procedure: {
    description: 'Substrate-side match of a user prompt against the compiled_procedure pool. Scores each procedure by trigger_keyword overlap + status (approved > detected, deprecated skipped) + occurrence count. Returns the best match above min_confidence (default 0.50) along with a best-effort filled replay plan: file paths extracted from the prompt fill Read/Edit/Write/MultiEdit slots; Grep/Glob/Bash declare missing_args for the LLM to finalize. Returns {ok, match, plan} on hit, {ok:true, match:null, reason} on miss. NOTE: this tool plans the replay; actual deterministic execution (proxy-side synthetic tool_use stream) is the next architectural ship — see HONEST-LIMITS.md.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:         { type: 'string', description: 'User-prompt text to match against compiled procedures' },
        min_confidence: { type: 'number', description: 'Minimum match score 0..1 (default 0.50)' },
        include_plan:   { type: 'boolean', description: 'Whether to also return buildReplayPlan output (default true)' },
        agent_id:       { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['prompt']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const r = procedureMatcher.matchProcedure({
        prompt: args.prompt,
        agent_id: ctx.agent_id,
        cwd: ctx.cwd,
        min_confidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined
      });
      if (!r.ok || !r.match) {
        return { ok: !!r.ok, match: null, reason: r.reason || 'unknown', best_score: r.best_score };
      }
      const matchSummary = {
        procedure_id: r.match.procedure_id,
        score: Number(r.match.score.toFixed(3)),
        hits: r.match.hits,
        triggers_matched: r.match.triggers_matched
      };
      const includePlan = args.include_plan !== false;
      let plan = null;
      if (includePlan) {
        plan = procedureMatcher.buildReplayPlan({
          procedure: r.match.procedure,
          prompt: args.prompt
        });
      }
      return { ok: true, match: matchSummary, plan };
    }
  },

  troth_multi_axis_query: {
    description: 'MAGMA-style 4-axis substrate query (Phase D). Extracts entities (file paths, function names, class names, tool/library vocabulary) from the prompt, then ranks records by fused score across SEMANTIC (FTS5 on full prompt), TEMPORAL (recency-weighted, 30-day decay), CAUSAL (parent_id chain hits get a boost), and ENTITY (records mentioning extracted entities) axes. Returns ranked rows with axis_hits attribution so the caller sees WHICH axis fired for each result. Default weights: entity 0.40, temporal 0.25, causal 0.20, semantic 0.15.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:   { type: 'string', description: 'Free-text query the substrate extracts entities from and scores against' },
        type:     { type: 'string', description: 'Optional ActionRecord type filter (edit / read / search / tool_call / decision / commitment / etc.)' },
        limit:    { type: 'integer', minimum: 1, maximum: 100 },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['prompt']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      // Intent-routed: chitchat / epistemic prompts skip retrieval
      // entirely. Episodic / entity / causal / semantic get
      // intent-specific axis weights per MAGMA §3.2 (the paper's
      // "hierarchical intent module selects relevant views").
      const { intent, weights } = intentRouter.route(args.prompt);
      if (weights === null) {
        return { results: [], entities: [], intent, skipped: 'no-retrieval-for-' + intent };
      }
      const ranked = entityAxis.multiAxisQuery({
        prompt: args.prompt,
        weights,
        agent_id: args.agent_id || undefined,
        cwd: ctx.cwd,
        type: args.type,
        limit: args.limit || 25
      });
      const entities = entityAxis.extractEntities(args.prompt);
      // Project to a compact result the caller can render. We omit the
      // full input/output blobs to keep the response small — caller can
      // troth_fetch_action({id}) for full content if they want it.
      const results = ranked.map(r => ({
        id: r.row.id,
        timestamp: r.row.timestamp,
        type: r.row.type,
        score: Number(r.score.toFixed(3)),
        axis_hits: r.axis_hits
      }));
      return {
        entities_extracted: entities,
        effective_agent_id: ctx.agent_id,
        result_count: results.length,
        results
      };
    }
  },

  troth_chameleon_query: {
    description: 'Scope-specific retrieval from ONE named substrate corpus (e.g., scope="docs:legal-2026"). Use only when you already know which corpus holds the answer. For general "find research about topic X" without knowing scope, use troth_recall(class:"semantic") — it searches all semantic-class engrams + lessons without requiring scope name.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Exact corpus name, e.g. "docs:seen:reports" or "docs:chats". These cannot be guessed — call troth_chameleon_list_scopes first, or use troth_recall when you do not know which corpus holds the answer.' },
        query: { type: 'string', description: 'Natural-language query, searched within that one corpus' },
        k:     { type: 'integer', description: 'How many passages to return (default 5)' },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['scope', 'query']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const r = await chameleon.queryScope({
        ...ctx,
        query: args.query,
        scope: args.scope,
        k:     args.k || 5,
        embedding_host: transportCfg.embeddingHost()
      });
      return {
        scope: r.scope,
        chunks: r.items.map(i => ({
          ...edgeStatement(i.statement),
          score:     Number(i.score && i.score.toFixed ? i.score.toFixed(3) : i.score),
          source:    i.source
        }))
      };
    }
  },

  troth_chameleon_list_scopes: {
    description: 'Enumerate the substrate\'s ingested corpora. Use first to discover what knowledge bases are queryable. Pass agent_id explicitly — substrate is per-agent-isolated; default is the active agent_id (env TROTH_ENTITY_AGENT_ID), which on a fresh install is usually empty until the watcher / dialogue mirror has captured turns.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      }
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const scopes = chameleon.listScopes(ctx);
      // Diagnostic: when the caller-effective agent_id has no engrams,
      // surface which agents DO have data so the caller can route the
      // next call correctly. Hides counts only, not engram content —
      // substrate isolation boundary stays intact.
      const out = { scopes, effective_agent_id: ctx.agent_id };
      if (!scopes || scopes.length === 0) {
        out.hint = 'No scopes under agent_id="' + ctx.agent_id + '". Pass an explicit agent_id from agents_with_engrams below.';
        out.agents_with_engrams = engram.listAgentsWithEngrams({ limit: 10 });
      }
      return out;
    }
  },

  // ── Chameleon Protocol — adapter-driven ingestion (v0.1) ─────────────────
  // The 3 tools below complete the loop: register an external adapter,
  // list registered adapters, drive one end-to-end via the runtime engine
  // (handshake → describe → read → ingest). Bypasses the legacy raw-text
  // path of `troth_chameleon_ingest` so the substrate can consume any
  // Chameleon-conformant adapter, not just hardcoded sources.

  troth_chameleon_register_adapter: {
    description: 'Register a Chameleon adapter under a name. Operator declares the spawn cmd + args; later calls to troth_chameleon_run reference the name. Upserts on existing name. Adapters are persisted to ~/.troth/adapters.json (chmod 600).',
    inputSchema: {
      type: 'object',
      properties: {
        name:          { type: 'string', description: 'Unique adapter name (e.g., "fs-docs").' },
        cmd:           { type: 'string', description: 'Executable to spawn (e.g., "node").' },
        args:          { type: 'array', items: { type: 'string' }, description: 'Command-line arguments.' },
        source_id:     { type: 'string', description: 'Optional Chameleon source_id passed to adapter.' },
        default_scope: { type: 'string', description: 'Optional default substrate scope for ingestion.' }
      },
      required: ['name', 'cmd']
    },
    run: async (args) => {
      const entry = chameleonRT.registerAdapter({
        name: args.name,
        cmd: args.cmd,
        args: args.args || [],
        source_id: args.source_id,
        default_scope: args.default_scope
      });
      return { registered: entry };
    }
  },

  troth_chameleon_list_adapters: {
    description: 'List all Chameleon adapters registered on this substrate (~/.troth/adapters.json). Returns name, cmd, args, source_id, default_scope per entry.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      return { adapters: chameleonRT.listAdapters() };
    }
  },

  troth_chameleon_run: {
    description: 'Drive a registered Chameleon adapter end-to-end: spawn → initialize handshake → describe → read → ingest each record into the substrate. Returns ingestion stats. Use this instead of raw-text troth_chameleon_ingest when an adapter exists for the source.',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Name of the registered adapter to run.' },
        scope: { type: 'string', description: 'Substrate scope for ingested chunks (overrides adapter default_scope).' },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['name']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const r = await chameleonRT.runRegisteredAdapter(args.name, {
        ...ctx,
        scope: args.scope,
        embedding_host: transportCfg.embeddingHost()
      });
      return r;
    }
  },

  troth_dialogue_recent: {
    description: 'Retrieve the substrate\'s most recent N conversation turns (chronological).',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 50 },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      }
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      // Recent turns surface from the unified partner brain — claude
      // code + cli + voice all write to the same dialogue stream, so
      // the LLM sees a continuous thread across surfaces.
      return {
        turns: dialogueMemory.recentTurns({
          agent_id: args.agent_id || undefined,
          cwd: ctx.cwd, limit: args.n || 5
        })
      };
    }
  },

  troth_dialogue_record_turn: {
    description: 'Persist a completed conversation turn (user input + assistant reply) into the substrate\'s working memory so the next session can surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        user_text:      { type: 'string' },
        assistant_text: { type: 'string' },
        faculty:        { type: 'string', description: 'Which faculty produced the reply (e.g., claude, gpt-4o, llamacpp)' },
        agent_id: { type: 'string' }, user_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['user_text', 'assistant_text']
    },
    run: async (args) => {
      const ctx = ctxFromArgs(args);
      const ok = dialogueMemory.recordTurn({
        ...ctx,
        user_text:      args.user_text,
        assistant_text: args.assistant_text,
        faculty:        args.faculty || 'unknown'
      });
      return { ok };
    }
  },

  troth_dispatch_pick: {
    description: 'Advisory: ask the substrate which language faculty it would route a given action through, given its current state. Useful for hosts that want to pre-route a request.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:    { type: 'string' },
        difficulty:{ type: 'string', enum: ['easy', 'medium', 'hard'] },
        intent:    { type: 'string', enum: ['analytical', 'creative', 'brainstorm', 'factual'] },
        available: { type: 'array', items: { type: 'string' }, description: 'Faculties this host has wired' }
      },
      required: ['available']
    },
    run: async (args) => {
      const dispatcher = dispatchMod.makeDispatcher({ available: args.available });
      const action = {
        kind: 'llm',
        prompt: args.prompt || '',
        options: {
          difficulty: args.difficulty,
          intent:     args.intent
        }
      };
      const choice = dispatcher.pick(action, { mind: { active_projects: [] } });
      return choice;
    }
  },

  troth_transport_config_snapshot: {
    description: 'Read the substrate\'s current transport-endpoint configuration with provenance (env / file / default for each field).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({
      snapshot: transportCfg.snapshot(),
      defaults: transportCfg.BUILT_IN_DEFAULTS,
      env_keys: transportCfg.ENV_KEYS,
      config_path: transportCfg.CONFIG_PATH
    })
  },

  troth_server_compose: {
    description: 'Emit the canonical llama-server command line for the substrate\'s current decode-time artefacts (control vectors, LoRA, slot-save dir, embeddings). Caller runs the returned command to apply substrate state to the model server.',
    inputSchema: {
      type: 'object',
      properties: {
        model_path: { type: 'string' },
        port: { type: 'integer' },
        ngl:  { type: 'integer' },
        control_vector_path:   { type: 'string' },
        control_vector_scale:  { type: 'number' },
        lora_path:             { type: 'string' },
        lora_scale:            { type: 'number' },
        bin: { type: 'string', description: 'llama-server binary path; defaults to "llama-server"' }
      },
      required: ['model_path']
    },
    run: async (args) => {
      const opts = { ...args };
      if (args.control_vector_path && args.control_vector_scale != null) {
        opts.control_vector_scaled = { path: args.control_vector_path, scale: args.control_vector_scale };
        delete opts.control_vector_path;
      }
      if (args.lora_path && args.lora_scale != null) {
        opts.lora_scaled = { path: args.lora_path, scale: args.lora_scale };
        delete opts.lora_path;
      }
      try { return serverLifecycle.composeCommand(opts); }
      catch (e) { return { error: String(e && e.message || e) }; }
    }
  },

  troth_identity_score: {
    description: 'Score arbitrary text against substrate\'s active commitment directions (anchor / refusal alignment). Use to detect drift in conversation, audit a draft against substrate identity.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        refusals: { type: 'array', items: { type: 'string' } },
        anchors:  { type: 'array', items: { type: 'string' } },
        agent_id: { type: 'string' }, cwd: { type: 'string' }
      },
      required: ['text']
    },
    run: async (args) => {
      const dirs = await identityVectors.computeIdentityDirections({
        refusals: args.refusals || [],
        anchors:  args.anchors  || [],
        host:     transportCfg.embeddingHost()
      });
      const scored = await identityVectors.scoreAgainstIdentity(args.text, dirs, {
        host: transportCfg.embeddingHost()
      });
      return { scored, direction_count: dirs.length };
    }
  },

  troth_transport_config_write: {
    description: 'Persist a partial override of substrate transport endpoints to disk. Subsequent transport calls pick up the new value without restart.',
    inputSchema: {
      type: 'object',
      properties: {
        llamacpp_host:  { type: 'string' },
        llamacpp_model: { type: 'string' },
        ollama_host:    { type: 'string' },
        ollama_model:   { type: 'string' },
        embedding_host: { type: 'string' },
        slot_save_path: { type: 'string' }
      }
    },
    run: async (args) => {
      const ok = transportCfg.writePatch(args || {});
      return { ok, snapshot: ok ? transportCfg.snapshot() : null };
    }
  },

  // Multi-agent (G5) — substrate-to-substrate negotiation. Two
  // agent_ids each pull their highest-salience commitment in `scope`, the
  // deterministic classifier returns agree/conflict/orthogonal, and BOTH
  // sides record the verdict (consensus / disagreement / merged) as a
  // first-class engram. Closes Property #8 of the entity design at the
  // MCP surface — any host (Claude Code, Cursor, custom) can drive a
  // negotiation between two substrate identities now.
  // orchestrator dispatch — main agent (the one the user
  // talks to) calls this to spin up a fleet of role-specialist workers
  // and read their results back via engram queries scoped per role.
  // Workers run in their own processes/containers; main stays in the
  // user's chat. Closes the "user talks to one main, others run in
  // background" pattern.
  // troth_orchestrate_triage — cheap pre-check the main
  // agent runs BEFORE deciding whether to call troth_orchestrate_run.
  // Pure deterministic heuristic, no LLM, no I/O. Returns a mode:
  //   - 'inline'           → handle directly, do NOT spawn sub-agents
  //   - 'ask_user'         → multi-domain detected; ASK the user before
  //                          spawning ("this looks like 3 roles — orchestrate?")
  //   - 'explicit_request' → user explicitly named roles or said "spawn
  //                          agents" — proceed with orchestrate_run directly
  // Default behavior is conservative: small / single-domain / question-shaped
  // prompts return 'inline' so the orchestrator does not fire by default.
  troth_orchestrate_triage: {
    description: 'Pre-check whether a user task warrants spawning role-specialist sub-agents. Returns one of: inline (handle directly), ask_user (multi-domain detected — ASK the user before spawning), explicit_request (user explicitly requested orchestration — proceed). Cheap deterministic heuristic. CALL THIS BEFORE troth_orchestrate_run on any non-trivial user prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        user_text: { type: 'string', description: 'The user\'s message text — the prompt you would otherwise act on directly' }
      },
      required: ['user_text']
    },
    run: async (args) => {
      return triageMod.triage(args.user_text || '');
    }
  },

  // troth_orchestrate_run — the high-value single-call
  // surface. The main agent (the one the user is talking to) calls this
  // ONCE with a high-level task and a list of roles. The substrate then:
  //   1. planner.plan() decomposes the task into role-specific subtasks
  //      with a dependency DAG
  //   2. agent-supervisor.runDAG() spawns workers respecting dependencies
  //      (frontend waits for backend's API contract, etc.)
  //   3. waits for completion sentinels OR timeout
  //   4. agent-supervisor.summarize() composes per-role outputs into a
  //      single user-facing reply
  // The main agent forwards that reply to the user. ONE TOOL CALL —
  // user gets a finished, multi-role result back.
  //
  // WHEN TO USE: user task spans multiple specialist domains
  // (backend + frontend + tests, API + DB + UI, design + copy + dev,
  // research + draft + review, etc.) AND the user prefers one
  // coordinated reply over chasing N background agents themselves.
  //
  // For independent / single-domain work, use the host's normal tool
  // calls — orchestration adds latency that small tasks don't earn.
  // troth_orchestrate_start — async dispatch. Returns
  // immediately with a group_id. Use this when the orchestration is
  // expected to take more than ~30s (most non-trivial tasks). Pair
  // with troth_orchestrate_status to poll, and troth_orchestrate_summary
  // when complete. Avoids holding the MCP transport open for many minutes.
  troth_orchestrate_start: {
    description: 'Asynchronously start a multi-role orchestration. Plans, then spawns first-tier workers, then RETURNS IMMEDIATELY with group_id. Use this for orchestrations expected to take >30s. Caller polls with troth_orchestrate_status; on completion, calls troth_orchestrate_summary for the final user-facing reply.',
    inputSchema: {
      type: 'object',
      properties: {
        task:        { type: 'string' },
        roles:       { type: 'array', items: { type: 'string' } },
        tenant:      { type: 'string' },
        cwd:         { type: 'string' },
        skip_planner:{ type: 'boolean' }
      },
      required: ['task', 'roles']
    },
    run: async (args) => {
      const groupId = 'orch-' + Date.now().toString(36) + '-' +
                      Math.random().toString(36).slice(2, 6);
      const planRes = args.skip_planner
        ? planner.planFallback(args.task, args.roles, { cwd: args.cwd })
        : await planner.plan(args.task, args.roles, {
            cwd:      args.cwd,
            group_id: groupId,
            agent_id: 'orchestrator-planner'
          });
      if (!planRes.ok) return { ok: false, group_id: groupId, error: planRes.error || 'plan failed' };

      // Fire-and-forget runDAG. The Stop-hook completion sentinel +
      // engram polling carry the actual coordination; we don't await.
      // setImmediate so the response goes out before the heavy work begins.
      setImmediate(() => {
        supervisor.runDAG({
          group_id:   groupId,
          plan:       planRes.plan,
          dag:        planRes.dag,
          tenant:     args.tenant,
          cwd:        args.cwd,
          timeout_ms: 30 * 60 * 1000
        }).catch(() => {});  // errors land as engrams via supervisor itself
      });

      return {
        ok: true,
        group_id: groupId,
        planner_used: planRes.planner_used,
        plan: planRes.plan,
        message: 'Orchestration started. Poll with troth_orchestrate_status({group_id}). Summarize with troth_orchestrate_summary({group_id}) when status reports done.'
      };
    }
  },

  troth_orchestrate_status: {
    description: 'Poll an in-progress orchestration. Returns per-role engram counts, latest progress engrams, and detected cross-role conflicts. Status field is "empty" | "in_progress" | "done" | "conflicts_detected".',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        cwd:      { type: 'string' }
      },
      required: ['group_id']
    },
    run: async (args) => {
      const merged = supervisor.mergeResults(args.group_id, { cwd: args.cwd });
      // Coarse done-detection: every requested role has a completion
      // engram. We surface this as a flag the caller can act on.
      const allComplete = merged.role_count > 0 && Object.keys(merged.by_role).every(function (r) {
        const list = merged.by_role[r];
        return list && list.engram_count > 0;
      });
      return Object.assign({}, merged, {
        all_roles_have_engrams: allComplete
      });
    }
  },

  troth_orchestrate_summary: {
    description: 'Compose the final user-facing summary of a completed orchestration. Reads every role engram and produces a single coherent reply. Forward this to the user verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        cwd:      { type: 'string' }
      },
      required: ['group_id']
    },
    run: async (args) => {
      return await supervisor.summarize(args.group_id, { cwd: args.cwd });
    }
  },

  // group-level cancel. The /agents skill could spawn workers
  // and have no clean abort path; the operator was reduced to looking
  // up runIds via `troth status` and killing each one. This tool
  // walks the spawn decision records for the group, calls killWorker
  // on each, and returns the per-runId outcome so the caller can
  // surface a clean status line to the operator.
  troth_orchestrate_kill: {
    description: 'Cancel a running orchestration group. Reads the spawn decision records for group_id, calls killWorker on every runId, and returns the per-worker outcome. Use when the operator wants to abort a /agents or /team dispatch that has gone long.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'The group_id returned by troth_orchestrate_start or /team' }
      },
      required: ['group_id']
    },
    run: async (args) => {
      const groupId = String(args.group_id || '').trim();
      if (!groupId) return { ok: false, error: 'group_id required' };
      let runner;
      try { runner = require('../../../bin/runner.js'); }
      catch (e) { return { ok: false, error: 'runner_unavailable', detail: e && e.message }; }
      const stateMod = require('../../../shared-core/state.js');
      let spawns = [];
      try {
        spawns = stateMod.queryActions({
          type: 'decision', agent_id: 'orchestrator', limit: 200, order: 'desc'
        }) || [];
      } catch (e) { return { ok: false, error: 'state_query_failed', detail: e && e.message }; }
      const killed = [];
      const skipped = [];
      const seen = new Set();
      for (const row of spawns) {
        let inp; try { inp = JSON.parse(row.input);  } catch (_) { continue; }
        let outp;try { outp = JSON.parse(row.output); } catch (_) { continue; }
        if (!inp || inp.kind !== 'role_worker_spawned' || inp.group_id !== groupId) continue;
        const runId = outp && outp.runId;
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        let ok = false;
        try { ok = !!runner.killWorker(runId); } catch (_) { ok = false; }
        (ok ? killed : skipped).push({ runId, role: inp.role, agent_id: outp.worker_agent_id || null });
      }
      return {
        ok: true,
        group_id: groupId,
        killed_count: killed.length,
        skipped_count: skipped.length,
        killed,
        skipped,
        message: killed.length
          ? 'Killed ' + killed.length + ' worker' + (killed.length === 1 ? '' : 's') + ' in group ' + groupId
          : 'No active workers found for group ' + groupId + ' (already finished or never spawned)'
      };
    }
  },

  troth_orchestrate_run: {
    description: 'BLOCKING single call: plan + DAG dispatch + WAIT for completion + summarize. Holds the MCP transport open for the entire orchestration (up to 10 min). Prefer troth_orchestrate_start for non-trivial tasks. Use this only for orchestrations expected to complete quickly.',
    inputSchema: {
      type: 'object',
      properties: {
        task:        { type: 'string', description: 'User\'s high-level intent. The planner decomposes this per role.' },
        roles:       { type: 'array', items: { type: 'string' }, description: 'Role names from the registry (e.g. ["backend","frontend","qa"]). Use troth_orchestrate_roles to discover available roles for the cwd.' },
        tenant:      { type: 'string', description: 'Optional tenant scope for substrate isolation' },
        cwd:         { type: 'string', description: 'Project root (where .troth/roles.json lives if any)' },
        timeout_ms:  { type: 'integer', description: 'Override the global 10-min orchestration timeout' },
        skip_planner:{ type: 'boolean', description: 'Skip the planner LLM call and use deterministic role-fallback decomposition. Faster but less coordinated.' }
      },
      required: ['task', 'roles']
    },
    run: async (args) => {
      const groupId = 'orch-' + Date.now().toString(36) + '-' +
                      Math.random().toString(36).slice(2, 6);
      // No callLlm injection in this MCP context (server is stdio-bound,
      // can't reach the proxy synchronously). Planner falls through to
      // its deterministic fallback. Hosts that want LLM-driven planning
      // can call planner.plan() directly with their own callLlm.
      const planRes = args.skip_planner
        ? planner.planFallback(args.task, args.roles, { cwd: args.cwd })
        : await planner.plan(args.task, args.roles, {
            cwd:      args.cwd,
            group_id: groupId,
            agent_id: 'orchestrator-planner'
          });
      if (!planRes.ok) return { ok: false, group_id: groupId, error: planRes.error || 'plan failed', stage: 'plan' };

      const dagRes = await supervisor.runDAG({
        group_id:   groupId,
        plan:       planRes.plan,
        dag:        planRes.dag,
        tenant:     args.tenant,
        cwd:        args.cwd,
        timeout_ms: args.timeout_ms || (10 * 60 * 1000)
      });

      const sumRes = await supervisor.summarize(groupId, { cwd: args.cwd });

      return {
        ok:           dagRes.ok,
        group_id:     groupId,
        planner_used: planRes.planner_used,
        plan:         planRes.plan,
        spawned:      Object.keys(dagRes.spawned || {}),
        failed:       dagRes.failed || {},
        elapsed_ms:   dagRes.elapsed_ms,
        summary:      sumRes.summary
      };
    }
  },

  troth_orchestrate_dispatch: {
    description: 'Dispatch a multi-role orchestration. Spawns one worker per role per the role registry (.troth/roles.json or ~/.troth/roles.json or built-in defaults). Each worker runs in its own process / git worktree, pinned to its role\'s LLM transport, scoped to a per-role engram namespace. Returns the group_id; poll results via troth_orchestrate_poll.',
    inputSchema: {
      type: 'object',
      properties: {
        task:    { type: 'string', description: 'High-level task description shared by all roles' },
        roles:   { type: 'array', items: { type: 'string' }, description: 'Role names from the registry (e.g. ["backend","frontend","qa"])' },
        tenant:  { type: 'string', description: 'Optional tenant name; pins workers to ~/.troth/tenants/<name>/state.db' },
        cwd:     { type: 'string', description: 'Project root (where .troth/roles.json lives)' }
      },
      required: ['task', 'roles']
    },
    run: async (args) => {
      const groupId = 'orch-' + Date.now().toString(36) + '-' +
                      Math.random().toString(36).slice(2, 6);
      const spawned = [];
      const failed = [];
      for (const roleName of args.roles) {
        const r = supervisor.spawnRoleWorker(roleName, args.task, {
          group_id: groupId,
          tenant:   args.tenant,
          cwd:      args.cwd
        });
        if (r.ok) spawned.push({ role: r.role, runId: r.runId, model: r.model, scope: r.scope });
        else      failed.push({ role: roleName, error: r.error });
      }
      return { ok: spawned.length > 0, group_id: groupId, spawned, failed };
    }
  },

  troth_orchestrate_poll: {
    description: 'Read the latest engrams written by every role worker in an orchestration group. Returns by-role summaries and any cross-role conflicts detected by multi-agent.classify. The main agent calls this periodically to know what specialists have produced.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        cwd:      { type: 'string' }
      },
      required: ['group_id']
    },
    run: async (args) => {
      return supervisor.mergeResults(args.group_id, { cwd: args.cwd });
    }
  },

  troth_orchestrate_roles: {
    description: 'List the role definitions available for this cwd. Combines built-in roles with ~/.troth/roles.json and project-local .troth/roles.json overrides.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string' } }
    },
    run: async (args) => {
      const all = rolesMod.loadRoles(args.cwd || process.cwd());
      const out = {};
      for (const k of Object.keys(all)) {
        out[k] = {
          transport_hint: all[k].transport_hint,
          model_pref:     all[k].model_pref,
          capabilities:   all[k].capabilities,
          system_prompt_preview: (all[k].system_prompt || '').slice(0, 120)
        };
      }
      return { roles: out };
    }
  },

  troth_negotiate: {
    description: 'Run a one-round substrate-to-substrate negotiation. Both agent_ids list their top commitments in `scope`; the substrate classifies them as agree / conflict / orthogonal; consensus or disagreement engrams land on both sides. Use to reconcile two substrate identities (e.g. team members, parallel workers) on a shared topic.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_a:  { type: 'string', description: 'First substrate agent_id' },
        agent_b:  { type: 'string', description: 'Second substrate agent_id' },
        scope:    { type: 'string', description: 'Engram scope to negotiate over' },
        rounds:   { type: 'integer', minimum: 1, maximum: 5, description: 'Default 1' },
        salience: { type: 'number', description: 'Salience for emitted engrams (default 1.0)' },
        cwd:      { type: 'string' }
      },
      required: ['agent_a', 'agent_b', 'scope']
    },
    run: async (args) => {
      const cwd = args.cwd || null;
      const A = multiAgent.fromEngram(engram, args.agent_a, { cwd });
      const B = multiAgent.fromEngram(engram, args.agent_b, { cwd });
      const result = multiAgent.negotiate(A, B, { scope: args.scope }, {
        rounds:   args.rounds   || 1,
        salience: typeof args.salience === 'number' ? args.salience : 1.0
      });
      return result;
    }
  },

  // ─────────────────────────────────────────────────────────────────────
  // design: substrate-as-subject MCP tools.
  //
  // These expose L4 entities (intents, observations, capabilities,
  // skills, lessons, sub-partners, voice profile, substrate-status) to
  // the partner-as-faculty (Claude Code / Cursor / any MCP client). The
  // language faculty USES these to query its own brain — recall what
  // intents fired, what skills compiled from past experience, what
  // walls (lessons) prevent repeat-failures, what authority scopes are
  // currently active. Without these tools, the LLM faculty is
  // structurally blind to its own substrate state.
  //
  // All read-only — no writes. Operator-tier writes happen via CLI
  // (troth confirm / pause / seal / cap / schedule / reactor /
  // project / vault) so the integration point signature path is honored.
  // ─────────────────────────────────────────────────────────────────────

  troth_l4_status: {
    description: 'Read current substrate posture: engram count, global-pause state, operator presence freshness, WAL backup status, encrypted-vault state. Use this BEFORE proposing autonomous action — confirms the substrate is healthy + operator is present.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const engM = require(serverDir + '../../../shared-core/engram.js');
      const allCount = (engM.listEngrams({ principal: null, audience: 'all', limit: 5000 }) || []).length;
      let pauseActive = false;
      try { pauseActive = require(serverDir + '../../../shared-core/global-pause.js').isPaused(); } catch (_) {}
      let presence = null;
      try { presence = require(serverDir + '../../../shared-core/presence.js').presenceFreshness(); } catch (_) {}
      let walStatus = null;
      try { walStatus = require(serverDir + '../../../shared-core/wal-replicate.js').status(); } catch (_) {}
      let vaultStatus = null;
      try { vaultStatus = require(serverDir + '../../../shared-core/vault.js').status(); } catch (_) {}
      return { engram_count: allCount, globally_paused: pauseActive, presence, wal: walStatus, vault_l4: vaultStatus };
    }
  },

  troth_l4_intents_recent: {
    description: 'List recent partner intents with their dispatch status (validated|dispatched|observed|failed). Use to understand "what have I been doing lately" or to find an intent you want to revisit.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
    run: async (args) => {
      const engM   = require(serverDir + '../../../shared-core/engram.js');
      const stateM = require(serverDir + '../../../shared-core/state.js');
      const limit = Math.max(1, Math.min(200, args.limit || 30));
      const pool = engM.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];
      const intents = pool.filter(e => typeof e.scope === 'string' && e.scope.indexOf('intent:') === 0).slice(0, limit);
      return {
        intents: intents.map(i => ({
          id: i.id, ts: i.ts, scope: i.scope, ...edgeStatement(i.statement),
          irreversibility_class: i.irreversibility_class,
          intent_state: stateM.getIntentState ? stateM.getIntentState(i.id) : null
        }))
      };
    }
  },

  troth_l4_observations_recent: {
    description: 'List recent observation engrams (results of dispatched intents). Use to understand outcomes of past actions or find data a previous action returned.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
    run: async (args) => {
      const engM = require(serverDir + '../../../shared-core/engram.js');
      const limit = Math.max(1, Math.min(200, args.limit || 30));
      const obs = engM.listEngrams({ principal: null, audience: 'all', scope: 'observation', limit }) || [];
      return { observations: obs.map(o => ({ id: o.id, ts: o.ts, observes_intent: o.observes_intent, statement: o.statement })) };
    }
  },

  troth_l4_capabilities_active: {
    description: 'List active operator-minted capabilities (the authority scopes the partner can act within). Use to know what you CAN do before emitting an intent.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const engM = require(serverDir + '../../../shared-core/engram.js');
      const pool = engM.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];
      const caps = pool.filter(e => typeof e.scope === 'string' && e.scope.indexOf('capability:') === 0);
      return { capabilities: caps.map(c => ({ id: c.id, ts: c.ts, scope: c.scope, max_irreversibility: c.max_irreversibility, expiry: c.expiry, revoked: c.revoked })) };
    }
  },

  troth_l4_skills: {
    description: 'List compiled skill engrams (procedures the substrate learned from past successful causal chains). Before reasoning from scratch on a new intent, query this to find a matching skill — recall + parameterize is cheaper than re-deriving.',
    inputSchema: { type: 'object', properties: { intent_scope: { type: 'string', description: 'Optional — filter to skills matching this intent scope' } } },
    run: async (args) => {
      let mod = null;
      try { mod = require(serverDir + '../../../shared-core/skill-compiler.js'); } catch (_) {}
      if (!mod) return { skills: [] };
      const skills = args.intent_scope
        ? mod.findSkillsForIntent(args.intent_scope)
        : (mod.listSkills({ limit: 200 }) || []);
      return { skills: skills.map(s => ({ id: s.id, ts: s.ts, scope: s.scope, statement: s.statement })) };
    }
  },

  troth_l4_lessons: {
    description: 'List active lesson:dont:* engrams (failure-walls the substrate built from past failed causal chains). STVC refuses intents matching these. Query before reasoning about a new action — if a lesson covers it, the action will be refused and you should plan differently.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const engM = require(serverDir + '../../../shared-core/engram.js');
      const pool = engM.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];
      const lessons = pool.filter(e => typeof e.scope === 'string' && e.scope.indexOf('lesson:dont:') === 0);
      return { lessons: lessons.map(l => ({ id: l.id, ts: l.ts, scope: l.scope, statement: l.statement })) };
    }
  },

  troth_l4_sub_partners: {
    description: 'List birth engrams for authorized parallel workers. Use to know who is delegated to what, and to read their subpartner_report results when they complete.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const engM = require(serverDir + '../../../shared-core/engram.js');
      const pool = engM.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];
      const subs = pool.filter(e => typeof e.scope === 'string' && e.scope.indexOf('sub_partner:') === 0);
      return { sub_partners: subs.map(s => ({ id: s.id, ts: s.ts, scope: s.scope, statement: s.statement })) };
    }
  },

  troth_l4_voice_profile: {
    description: 'Read the partner identity / voice profile (name, tone, verbosity, vocabulary preferences). Inject this into the system prompt for every tick — it is the operator-curated personality that carries across LLM faculty swaps.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      let vp = null;
      try { vp = require(serverDir + '../../../shared-core/voice-profile.js'); } catch (_) {}
      if (!vp) return { profile: null, rendered_for_tick: '' };
      return { profile: vp.getActiveVoiceProfile(), rendered_for_tick: vp.renderForTick() };
    }
  }
};

// Closed-extension tools (guarded optional require — absent in the open build).
try {
  const _ext = require(serverDir + '../../../shared-core/core-ext.js');
  if (_ext && typeof _ext.mcpTools === 'function') Object.assign(TOOLS, _ext.mcpTools() || {});
} catch (_) {}

// Governed action surface over MCP: opt-in, OFF by default ( scoping
// decision). When TROTH_MCP_ACTIONS=1, expose the substrate's governed
// intent surface so an MCP host can drive real-world actions. The ONE safe
// design: delegate to substrate-tools' REGISTRY.intent_emit.run, NEVER to
// dispatchers/browser-do.js directly and NEVER to the deprecated
// browser_session tool. Going through intent_emit inherits all four
// governance layers by construction (writeIntent's 7 inline STVC predicates,
// dispatcher.dispatchOne re-validation, the capability host-glob check, and
// recordAction state invariants). A direct dispatcher call would be the S2
// bypass class we are explicitly avoiding. Flag OFF means nothing changes and
// tools/list stays byte-identical to today.
if (process.env.TROTH_MCP_ACTIONS === '1' && substrateTools && substrateTools.REGISTRY && substrateTools.REGISTRY.intent_emit) {
  const _intentEmit = substrateTools.REGISTRY.intent_emit;
  // The OpenAI-style function `parameters` object IS a JSON Schema and maps
  // 1:1 to an MCP inputSchema, so reuse it verbatim so the two surfaces never
  // drift. Fall back to a permissive object schema if the registry shape
  // ever changes so tools/list still answers.
  const _intentEmitInputSchema =
    (_intentEmit.schema && _intentEmit.schema.function && _intentEmit.schema.function.parameters) ||
    { type: 'object', properties: {}, required: [] };
  const _intentEmitDescription =
    (_intentEmit.schema && _intentEmit.schema.function && _intentEmit.schema.function.description) ||
    'Express an intent to act in the world; the substrate STVC-gates, dispatches, and returns the observation.';

  TOOLS.troth_intent_emit = {
    description: _intentEmitDescription,
    inputSchema: _intentEmitInputSchema,
    // Delegate straight to the governed surface. ctxFromArgs supplies the
    // substrate context; the STVC wall runs inside writeIntent, so a missing
    // sealed capability fails closed here (ok:false, refused:true) rather than
    // acting. No governance is re-implemented in the MCP layer.
    run: async (args) => substrateTools.REGISTRY.intent_emit.run(args || {}, ctxFromArgs(args))
  };

  // Convenience wrapper for the browser scope. It is a thin shim over the
  // SAME intent_emit.run: it only forces scope:'intent:browser:do' and
  // documents the CDP steps[] contract; it adds NO privilege and takes NO
  // dispatch shortcut. Every governance layer is inherited because the call
  // still lands in intent_emit then writeIntent then dispatcher.
  TOOLS.troth_browser_do = {
    description: 'Governed browser action over MCP that drives the operator\'s REAL Chrome via CDP, carrying their existing logins and sessions. ALL browser work goes through this tool: browsing, operator accounts, logged-in sites, and testing the operator\'s own apps on localhost; NEVER write playwright/puppeteer/selenium scripts (they are not installed and bypass governance). Forces scope "intent:browser:do" and delegates to the SAME STVC-gated intent_emit (no bypass); payload.steps is a CDP step script (max 50 steps), each one of: navigate, fill, click, press, extract_text, extract_attr, screenshot, wait_ms, wait_for, eval, fill_from_vault, capture_to_vault, submit_and_observe, await_human. Fails closed (refused) unless the operator has sealed a capability covering intent:browser:do.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'CDP step script (max 50). Step kinds: navigate, fill, click, press, extract_text, extract_attr, screenshot, wait_ms, wait_for, eval, fill_from_vault, capture_to_vault, submit_and_observe, await_human.',
          items: { type: 'object' }
        },
        irreversibility_class: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'sealed_only'],
          description: 'Reversibility of the action (default low). See troth_intent_emit for the class semantics.'
        },
        capability_ref: { type: 'string', description: 'OPTIONAL: engram id of an operator-sealed capability covering intent:browser:do. Omit to let the substrate auto-resolve standing authorization.' },
        grounded_in:    { type: 'array', items: { type: 'string' }, description: 'OPTIONAL: sealed engram ids that justify the action. Omit to auto-cite standing grounding.' },
        seals:          { type: 'array', items: { type: 'string' }, description: 'For irreversibility_class >= high, operator seal engram ids.' },
        statement:      { type: 'string', description: 'One-line natural-language description of the browser task.' },
        agent_id: { type: 'string' },
        user_id:  { type: 'string' },
        cwd:      { type: 'string' }
      },
      required: ['steps']
    },
    run: async (args) => {
      args = args || {};
      // Force the browser scope; pass through everything intent_emit accepts.
      // Building the payload as {steps} here is the ONLY convenience; the
      // authority/STVC path is identical to a raw troth_intent_emit call.
      const emitArgs = {
        scope: 'intent:browser:do',
        payload: { steps: Array.isArray(args.steps) ? args.steps : [] },
        irreversibility_class: args.irreversibility_class || 'low',
        capability_ref: args.capability_ref,
        grounded_in: args.grounded_in,
        seals: args.seals,
        statement: args.statement || 'browser steps via troth_browser_do'
      };
      return substrateTools.REGISTRY.intent_emit.run(emitArgs, ctxFromArgs(args));
    }
  };

  // MCP hands over the backbone. Expose
  // the partner's external-MCP surface to the Claude Code backbone under the
  // SAME opt-in flag + same MA-1/MA-2 guarantees as the intent tools:
  //   flag OFF => these are ABSENT from tools/list (block never runs);
  //   flag ON  => present, delegating to the mcp-client REGISTRY.
  // mcp_call is now GOVERNED (routes through intent:mcp:call:<server> +
  // STVC), so exposing it here inherits the capability wall by construction,
  // exactly like troth_intent_emit - a missing sealed capability fails closed
  // (ok:false, refused:true) rather than contacting the downstream. mcp_list
  // and mcp_describe are read-only discovery. Schemas mirror the registry's
  // OpenAI `function.parameters` 1:1 so the two surfaces never drift.
  const _mcpTool = (regKey, fallbackDesc) => {
    const entry = mcpClient.REGISTRY[regKey];
    const fn = entry && entry.schema && entry.schema.function;
    return {
      description: (fn && fn.description) || fallbackDesc,
      inputSchema: (fn && fn.parameters) || { type: 'object', properties: {}, required: [] },
      // ctxFromArgs supplies agent_id/user_id/cwd; cwd threads through to the
      // layered project-.mcp.json resolution and (for mcp_call) into the
      // governed intent's workspace.
      run: async (args) => mcpClient.REGISTRY[regKey].run(args || {}, ctxFromArgs(args))
    };
  };
  TOOLS.troth_mcp_list     = _mcpTool('mcp_list', 'List the tools a configured external MCP server offers (read-only discovery).');
  TOOLS.troth_mcp_describe = _mcpTool('mcp_describe', 'Return the full schema of one tool on a downstream MCP server (read-only discovery).');
  TOOLS.troth_mcp_call     = _mcpTool('mcp_call', 'Invoke a tool on a configured external MCP server. GOVERNED via intent:mcp:call:<server> - fails closed without a sealed capability.');
  // Staging is part of the same surface: the
  // system prompt tells the partner to call mcp_register_request, but the
  // backbone tools/list never carried it — so on claude-cli panes, the
  // product's default, "paste a config in chat" was a dead call or a
  // narrated no-op). Staging is INERT by construction (writes the pending
  // file only; activation + capability seal stay operator-side), so exposing
  // it here grants no new authority.
  TOOLS.troth_mcp_register_request = _mcpTool('mcp_register_request', 'Stage a NEW external MCP server the operator pasted/described, for their approval (inert pending entry; the operator approves in Settings or via `troth mcp approve`). Never edit registry files directly.');

  // Image generation over the backbone. The worldly
  // REGISTRY carries image_generate (shared-core/tools/index.js), which native
  // panes get through the unified tool surface - but the backbone MCP gateway
  // never exposed it, so claude-cli panes (the product default, also the Kimi/
  // GPT engine carriers) could not generate images at all. Wire it here under
  // the SAME opt-in flag so flag OFF => absent, flag ON => present.
  //
  // The worldly REGISTRY uses the SAME {schema:{function:{...}}, run} entry
  // shape as the mcp-client REGISTRY above, so the adaptation is identical to
  // _mcpTool: read the OpenAI-style function.parameters as the MCP inputSchema
  // (the two are 1:1) and delegate to entry.run(args, ctxFromArgs(args)). We do
  // not re-declare the schema so the two surfaces never drift; a permissive
  // fallback keeps tools/list answering if the registry shape ever changes.
  const _imageGen   = worldlyTools.REGISTRY && worldlyTools.REGISTRY.image_generate;
  const _imageGenFn = _imageGen && _imageGen.schema && _imageGen.schema.function;
  if (_imageGen && typeof _imageGen.run === 'function') {
    TOOLS.troth_image_generate = {
      description: 'Generate an image from a text prompt using the operator\'s linked ChatGPT plan and save it as a PNG locally under ~/.troth/images/. Returns the saved file path. Use when the user asks to create/draw/render an image.',
      inputSchema: (_imageGenFn && _imageGenFn.parameters) || { type: 'object', properties: {}, required: [] },
      // ctxFromArgs supplies agent_id/user_id/cwd; the plan-side token load
      // and PNG write happen inside image_generate.run, which never throws
      // (returns a structured {ok:false,...} on every failure path).
      run: async (args) => worldlyTools.REGISTRY.image_generate.run(args || {}, ctxFromArgs(args))
    };
  }
}

//  unprefixed aliases for skill compatibility.
// The 9 SKILL.md files in plugin/skills/ reference tools as `engram_search`,
// `engram_record`, `dialogue_recent` (the names the substrate uses
// internally) — but the MCP layer exposes them under the troth_* prefix
// for namespace hygiene. Without aliases, every slash skill fails silently
// to invoke the tool. Aliases keep both call shapes valid; if we later
// decide on global consistency we can drop the alias map and rewrite the
// skill files. Idempotent (alias overrides original only if not already set,
// which never happens since names are distinct).
const _ALIASES = {
  engram_search:    'troth_engram_search',
  engram_record:    'troth_engram_record',
  dialogue_recent:  'troth_dialogue_recent',
  multi_axis_query: 'troth_multi_axis_query',
  chameleon_query:  'troth_chameleon_query',
  chameleon_ingest: 'troth_chameleon_ingest',
  recall:           'troth_recall'
};
for (const [aliasName, realName] of Object.entries(_ALIASES)) {
  if (TOOLS[realName] && !TOOLS[aliasName]) {
    // CLONED, not shared, so the alias can carry its own first sentence.
    //
    // Sharing the object meant tools/list showed seven pairs of tools with
    // byte-identical descriptions and no way to tell which was canonical — an
    // agent reading that surface has to guess, and a guess it gets right by
    // luck is a guess it gets wrong later. Now the alias says what it is and
    // points at the name to prefer; the skills that call the short name keep
    // working untouched.
    TOOLS[aliasName] = Object.assign({}, TOOLS[realName], {
      description: 'ALIAS of `' + realName + '` — identical behaviour, kept because the bundled slash '
        + 'skills call the unprefixed name. Prefer `' + realName + '` in new code. '
        + String(TOOLS[realName].description || '')
    });
  }
}

// ── MCP JSON-RPC plumbing ───────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function rpcResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function rpcError (id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data: data || null } });
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    });
  }

  if (method === 'notifications/initialized') {
    // No response for notifications.
    return;
  }

  if (method === 'tools/list') {
    const tools = Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
    return rpcResult(id, { tools });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS[name];
    if (!tool) return rpcError(id, -32601, 'unknown tool: ' + name);
    try {
      const result = await tool.run(args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      });
    } catch (e) {
      return rpcError(id, -32000, 'tool execution failed', { detail: String(e && e.message || e) });
    }
  }

  if (method && method.startsWith('notifications/')) return;
  return rpcError(id, -32601, 'method not found: ' + method);
}

// ── stdin loop: line-delimited JSON-RPC ─────────────────────────────────────

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    Promise.resolve(handle(msg)).catch((e) => {
      try { rpcError(msg && msg.id || null, -32603, 'internal error', { detail: String(e && e.message || e) }); }
      catch (_) {}
    });
  }
});
process.stdin.on('end', () => process.exit(0));

// First-message friendliness — some hosts wait for any output to confirm
// the server is alive before sending initialize. Quietly noop otherwise.
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
