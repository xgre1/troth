// SPDX-License-Identifier: AGPL-3.0-only
// Substrate Tools — the surface the language faculty calls BACK into.
//
// Until now substrate state has only flowed FROM substrate TO model
// (via prefix injection, decode constraints, KV state). This module
// adds the reverse channel: the model can decide to query substrate
// state mid-generation by emitting a structured tool call. The
// orchestrator catches the call, dispatches to the named tool, and
// returns the result back into the model's context. The model then
// continues, having actively pulled the data it needed.
//
// This is the dream's "ONE process" property at the agentic level —
// substrate and faculty stop being request/response peers and start
// being one loop where each side reaches into the other on demand.
//
// Tool definitions follow the OpenAI-compatible function schema so
// they can flow straight through llama-server's `tools` field.
// Each tool exposes a small, deterministic substrate operation —
// no LLM reentry inside a tool, to keep latency bounded and to keep
// the substrate layer auditable.

const dialogueMemory = require('./dialogue-memory.js');
const engram         = require('./engram.js');
const chameleon      = require('./chameleon.js');
const intentRouter   = require('./intent-router.js');
const webFetch       = require('./tools/web-fetch.js');
const webAllowlist   = require('./tools/web-allowlist.js');
const credentialVault = require('./tools/credential-vault.js');


// Recovery hints returned by intent_emit when STVC refuses an intent
// at write time or dispatch time. The partner reads the hint and the
// reason, decides the next move (mint a capability, seal a high-
// irreversibility action, ground in a sealed engram, etc.) without
// human-readable parsing in the LLM. Keep concise — these flow into
// the partner's next turn as guidance.
function _writeStageHint(reason, args) {
  const r = String(reason || '');
  if (r === 'scope_must_be_intent_prefixed') return 'scope must start with "intent:" — examples: intent:http:do, intent:fs:do, intent:shell:do, intent:browser:do, intent:spawn:do, intent:skill:execute';
  if (r === 'bad_irreversibility_class')     return 'irreversibility_class must be one of: low, medium, high, sealed_only';
  if (r === 'intent_refused_at_write') {
    // intent.writeIntent's detail string is "<predicate>: <reason>" —
    // surface the predicate so the partner knows which wall refused.
    return 'STVC refused at write time. Common fixes: (a) add capability_ref pointing at a minted capability that covers this scope; (b) cite sealed engram IDs in grounded_in (operator decisions / charter / identity facts); (c) for irreversibility_class >= high, include operator-signed seal IDs in seals; (d) check global_pause is not active.';
  }
  if (r === 'intent_write_refused') return 'engram.recordEngram refused — check audience/scope discipline and substrate is initialized.';
  return null;
}

function _dispatchStageHint(reason) {
  const r = String(reason || '');
  if (r.indexOf('no_adapter_for_scope:') === 0) {
    const scope = r.replace('no_adapter_for_scope:', '').trim();
    return 'no universal executor registered for ' + scope + '. The 6 supported families are intent:http:do, intent:fs:do, intent:shell:do, intent:browser:do, intent:spawn:do, intent:skill:execute. If you used a per-service scope (e.g. intent:github:do) — that pattern is retired; use intent:http:do and pass the github URL in payload.url instead.';
  }
  if (r.indexOf('dispatch_revalidate_failed:') === 0) {
    return 'STVC re-validated at dispatch and refused. Likely cause: capability revoked, expired, or global_pause activated between write and dispatch. Re-check capability via engram_search scope=capability:.';
  }
  if (r === 'claim_lost_or_wrong_status') return 'another dispatcher already claimed this intent. Read the observation engram (observes_intent=this intent_id) for the result.';
  if (r.indexOf('adapter_error:') === 0) return 'executor ran but the action returned an error (e.g. HTTP 5xx, fs ENOENT, shell non-zero exit). The observation engram has the full result; read it for details.';
  return null;
}

// standing-authorization auto-resolution.
//
// THE ceremony that small faculties (Qwen3.6 etc.) fail: intent_emit
// REQUIRES capability_ref + grounded_in. To fill them, the model must
// engram_search for a capability, engram_search for sealed grounding,
// and thread both correctly-shaped arrays into the call. Small models
// drop one or both and fall back to chat text — so autonomous browsing
// never fires even though the operator already sealed the authority.
//
// This does NOT weaken STVC. It only looks up authority the operator
// ALREADY sealed, mirroring state-machine.js's capability_covers_intent
// (prefix-strip tail match + irreversibility rank) and grounded_in_sealed
// (>=1 operator_confirmed|plr_evolved ref) byte-for-byte. The faculty
// still cannot manufacture authority — if no sealed capability covers
// the scope, this returns null and the existing refusal+hint stands.
// High/sealed_only intents still need explicit operator seals (we never
// auto-fill `seals`), so destructive autonomy stays operator-gated.
function _autoResolveAuthorization(scope, irreversibilityClass) {
  if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
  let intentMod, eng;
  try { intentMod = require('./intent.js'); } catch (_) { return null; }
  try { eng = require('./engram.js'); }       catch (_) { return null; }
  const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
  const now = Date.now();
  const ranks = intentMod.IRREVERSIBILITY_RANK || {};
  const wantCls = irreversibilityClass || 'low';
  const intentTail = scope.slice('intent:'.length);

  // 1. Covering capability — same predicate logic as STVC.
  let capRef = null;
  for (const cap of pool) {
    if (!cap || typeof cap.scope !== 'string' || cap.scope.indexOf('capability:') !== 0) continue;
    if (cap.revoked) continue;
    if (typeof cap.expiry === 'number' && cap.expiry > 0 && cap.expiry < now) continue;
    const capTail = cap.scope.slice('capability:'.length);
    let scopeMatch = false;
    if (capTail === intentTail) scopeMatch = true;
    else if (capTail.endsWith('*') && intentTail.indexOf(capTail.slice(0, -1)) === 0) scopeMatch = true;
    // MCP hands family mapping - mirror the same branch
    // added to state-machine.capability_covers_intent so the bare-emit
    // auto-resolve fills a 'capability:mcp:<server>' cap for an
    // 'intent:mcp:call:<server>' scope. Byte-for-byte parity with the STVC
    // wall keeps auto-resolve from ever selecting a cap the wall would reject.
    else if (typeof intentMod.mcpCapabilityCoversIntent === 'function' &&
             intentMod.mcpCapabilityCoversIntent(cap.scope, scope)) scopeMatch = true;
    if (!scopeMatch) continue;
    const capMax = cap.max_irreversibility || 'low';
    if ((ranks[wantCls] || 99) > (ranks[capMax] || 0)) continue; // cap can't cover this class
    capRef = cap.id;
    break;
  }
  if (!capRef) return null; // no sealed authority — let STVC refuse with its hint

  // 2. Sealed grounding — prefer standing-authorization scopes, fall back
  //    to any operator_confirmed|plr_evolved engram (the capability itself
  //    qualifies as a last resort so grounded_in_sealed always passes).
  const sealed = e => {
    const a = (e && e.source_authority) || 'regex_extracted';
    return a === 'operator_confirmed' || a === 'plr_evolved';
  };
  const preferredScopes = new Set(['presence_proof', 'partner_charter', 'identity', 'partner_identity', 'recovery_directive']);
  const grounding = [];
  for (const e of pool) {
    if (grounding.length >= 3) break;
    if (!sealed(e) || typeof e.scope !== 'string') continue;
    if (preferredScopes.has(e.scope)) grounding.push(e.id);
  }
  if (!grounding.length) grounding.push(capRef); // capability is operator_confirmed → satisfies the wall

  return { capability_ref: capRef, grounded_in: grounding };
}

// Tool registry: each entry is { schema, run }. `schema` is the OpenAI
// function definition emitted to the model. `run(args, ctx)` is the
// substrate-side handler — receives the model-supplied arguments and
// substrate context (agent_id, cwd, user_id, embedding_host).
const REGISTRY = {
  jobs_status: {
    schema: {
      type: 'function',
      function: {
        name: 'jobs_status',
        description: 'Status of autonomous background runs (jobs). Without run_id: list recent runs (id, short task, state, started_at). With run_id: that run\'s state plus a real multi-line tail of its log. Operators may reference a run as @job:<run_id> in their message — pass that id here. Use whenever the operator asks how a background job / autonomous task is going, from ANY conversation.',
        parameters: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Optional run id for one run\'s detail' },
            tail_lines: { type: 'integer', description: 'With run_id: how many log lines to return (default 40)', minimum: 1, maximum: 200 }
          }
        }
      }
    },
    run: async (args) => {
      let runner;
      try { runner = require('../bin/runner.js'); }
      catch (e) { return { ok: false, error: 'runner_unavailable', detail: (e && e.message) || String(e) }; }
      try {
        if (args && args.run_id) {
          const id = String(args.run_id);
          const meta = runner.loadMeta(id);
          if (!meta) return { ok: false, error: 'run_not_found', run_id: id };
          const maxLines = Math.max(1, Math.min(200, parseInt(args.tail_lines, 10) || 40));
          return {
            ok: true,
            run: {
              id: meta.id,
              task: String(meta.task || '').slice(0, 200),
              state: runner.runState(meta.id),
              branch: meta.branch || null,
              started_at: meta.started_at || null,
              // Real multi-line tail (not a one-line digest): the operator
              // asks "how is X going" and the answer needs the actual log.
              log: typeof runner.logTail === 'function'
                ? runner.logTail(meta.id, { maxLines })
                : runner.logSummary(meta.id)
            }
          };
        }
        const runs = (runner.listRuns() || [])
          .map((id) => {
            const meta = runner.loadMeta(id) || {};
            return {
              id,
              task: String(meta.task || '').slice(0, 120),
              state: runner.runState(id),
              started_at: meta.started_at || null
            };
          })
          .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
          .slice(0, 20);
        return { ok: true, count: runs.length, runs };
      } catch (e) {
        return { ok: false, error: 'jobs_status_failed', detail: (e && e.message) || String(e) };
      }
    }
  },
  engram_search: {
    schema: {
      type: 'function',
      function: {
        name: 'engram_search',
        description: 'Retrieve substrate-stored memories most relevant to a query. Use when you need facts the substrate has previously committed (codewords, user preferences, past commitments, topical knowledge).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The information you are looking for' },
            k:     { type: 'integer', description: 'Maximum number of memories to return (default 5)', minimum: 1, maximum: 20 }
          },
          required: ['query']
        }
      }
    },
    run: async (args, ctx) => {
      // Intent-routed: chitchat / epistemic queries return empty —
      // substrate stays quiet on greetings and timeless trivia (date,
      // math, weather) so the model answers from world knowledge.
      const { intent, weights } = intentRouter.route(args.query);
      if (weights === null) {
        return { results: [], intent, skipped: 'no-retrieval-for-' + intent };
      }
      // engram_search reads across the whole partner brain — every
      // surface that wrote (cli/voice/proxy mirror/claude-code) is
      // visible. agent_id intentionally omitted; principal default
      // ('partner') applies. cwd kept as soft boost.
      const items = await engram.retrieveRelevant({
        cwd:             ctx.cwd,
        query:           args.query,
        k:               args.k || 5,
        embedding_host:  ctx.embedding_host
      });
      return {
        results: items.map(i => ({
          statement: i.statement,
          score:     Number(i.score && i.score.toFixed ? i.score.toFixed(3) : i.score),
          ts:        i.ts
        }))
      };
    }
  },

  // substrate-native identity update.
  // Partner calls this when operator says 'remember X about how we work'
  // or 'we don't ship Y'. Writes a high-authority identity engram so the
  // operator's words shape the substrate's always-on context directly.
  // No file convention, no separate scope category — identity IS the
  // thesis. Build 1's authority tier ranks these above regex-extracted
  // identity facts; <memory_identity> prefix block surfaces them every
  // turn. Same primitive used for what the user IS (preferences) AND
  // for what the project IS (thesis content) — one mind, scope tags
  // (project_id) optional.
  update_identity: {
    schema: {
      type: 'function',
      function: {
        name: 'update_identity',
        description: 'Save a stable identity fact about the operator, the project, or how-we-work. USE PROACTIVELY — do not wait for the operator to say "remember this". Call whenever the operator: (a) confirms a non-obvious approach worked, (b) corrects you ("no, do X instead"), (c) states a preference or constraint ("we always do X", "never ship Y"), (d) names what we are building / why / for whom, (e) names a person, tool, deadline that will recur. The operator should NOT have to ask. Auto-stamps highest authority (operator_confirmed) so it outranks regex-extracted facts. Skip only if: it is already in the identity prefix this turn, it is ephemeral task state, or it is obvious from code. Examples: "we are building a billing service for small clinics", "operator prefers terse code reviews", "we never touch the production database from a script", "deploys go out on Tuesdays, never Fridays".',
        parameters: {
          type: 'object',
          properties: {
            statement: { type: 'string', description: 'The identity fact to remember (single declarative sentence).' },
            project_scoped: { type: 'boolean', description: 'true = tag with current project_id so this fact only surfaces in this project context. false (default) = cross-project identity fact (e.g., universal user preference).' }
          },
          required: ['statement']
        }
      }
    },
    run: async (args, ctx) => {
      const statement = String(args.statement || '').slice(0, 600);
      // identity drift resolution.
      //
      // Without this: operator says "no I prefer X not Y", update_identity
      // writes a NEW operator_confirmed engram. The OLD "user prefers Y"
      // ALSO stays at operator_confirmed. Both surface in the identity
      // envelope; model sees contradiction; picks unpredictably. The
      // recall.js authority weighting can't disambiguate two same-tier
      // facts. Operator correction effectively never takes.
      //
      // Fix: pre-scan existing identity engrams for contradictions using
      // engram-verify's same-subject + polarity-flip detector. Any prior
      // operator-tier identity engram whose statement contradicts the new
      // one gets listed in output.lifetime.supersedes on the new write.
      // recall's buildSupersededIds (Phase B-aware now) hides them from
      // default reads. New operator correction wins; old wrong fact is
      // retired but still inspectable via opts.include_superseded.
      let supersedeIds = null;
      try {
        const verify = require('./engram-verify.js');
        const prior = engram.listEngrams({ scope: 'identity', limit: 300 }) || [];
        const v = verify.verifyStatement({ statement, existing: prior });
        if (v && Array.isArray(v.contradiction_refs) && v.contradiction_refs.length) {
          supersedeIds = v.contradiction_refs.slice(0, 8);
        }
      } catch (_) { /* drift detection is best-effort */ }

      // autonomous step — tier downgrade to 'llm_inferred'.
      //
      // integration point (cryptographic operator-write binding) requires an Ed25519
      // signature for operator_confirmed writes. update_identity is the
      // LLM-faculty proactive capture path — LLM is making a judgment
      // call ("this looks save-worthy") which IS llm_inferred quality by
      // definition, not operator's signed seal. Operator promotes to
      // operator_confirmed via the signed CLI (`troth confirm <id>`,
      // Phase 1.4) when reviewing identity facts.
      //
      // Tier-constrained supersedes (integration point) still protects real
      // operator_confirmed facts — llm_inferred writes here can't
      // override an operator-signed identity engram.
      const id = engram.recordEngram({
        agent_id: ctx.agent_id || 'operator',
        user_id:  ctx.user_id  || 'operator',
        cwd:      ctx.cwd,
        statement,
        scope:    'identity',
        salience: 1.5,
        source: 'llm-faculty proactive capture via update_identity tool',
        source_authority: 'llm_inferred',
        // Phase B: retire contradicting priors at the SAME tier.
        // Tier-constrained supersedes (integration point) blocks cross-tier
        // overrides automatically; this only retires other llm_inferred
        // identity facts the LLM is correcting.
        extra_output: supersedeIds ? { lifetime: { supersedes: supersedeIds, reason: 'llm_correction_via_update_identity' } } : undefined,
        auto_verify: false,
        tier: 'working',
        truth_score: 1.0
      });
      return {
        ok: !!id,
        id,
        scope: 'identity',
        source_authority: 'llm_inferred',
        superseded: supersedeIds || [],
        note: 'Operator can promote to operator_confirmed via signed CLI (Phase 1.4)'
      };
    }
  },

  engram_record: {
    schema: {
      type: 'function',
      function: {
        name: 'engram_record',
        description: 'Commit a new fact to substrate semantic memory for later recall. Use sparingly — only for stable, salient information the user has just provided or you have just confirmed. Set scope=\'handoff:YYYY-MM-DD-topic\' for agent-to-agent compacted handoff notes (auto-routes to substrate_internal). Set audience=\'synthesis_of_external\' for anything derived from web_fetch / untrusted source. Default audience is model_visible.',
        parameters: {
          type: 'object',
          properties: {
            statement: { type: 'string', description: 'The fact to remember (single sentence)' },
            salience:  { type: 'number', description: 'Importance weight 0..2 (default 1)', minimum: 0, maximum: 2 },
            scope:     { type: 'string', description: 'Optional scope/corpus tag. handoff:* and internal:* auto-derive substrate_internal+operational. identity stays in always-on envelope. docs:* and research:* land in semantic class. Omit for general episodic fact.' },
            audience:  { type: 'string', description: 'model_visible (default) | substrate_internal (handoff/operational) | synthesis_of_external (web_fetch-derived).', enum: ['model_visible', 'substrate_internal', 'synthesis_of_external'] }
          },
          required: ['statement']
        }
      }
    },
    run: async (args, ctx) => {
      let embedding = null;
      if (ctx.embedding_host) {
        try { embedding = await engram.embedRequest(ctx.embedding_host, args.statement); }
        catch (_) { embedding = null; }
      }
      const id = engram.recordEngram({
        agent_id: ctx.agent_id,
        user_id:  ctx.user_id,
        cwd:      ctx.cwd,
        statement: args.statement,
        source: 'language_faculty_tool_call',
        salience: typeof args.salience === 'number' ? args.salience : 1.0,
        scope:    typeof args.scope === 'string' ? args.scope : undefined,
        audience: typeof args.audience === 'string' ? args.audience : undefined,
        embedding
      });
      return { ok: !!id, id, embedded: !!embedding, scope: args.scope || null, audience: args.audience || 'model_visible' };
    }
  },

  // The operator's standing rules. Same road as the MCP surface calls — one
  // implementation in shared-core/lesson.js — so the two registries cannot
  // drift into disagreeing about what a rule is or when to ask first.
  rule_record: {
    schema: {
      type: 'function',
      function: {
        name: 'rule_record',
        description: 'Record a standing WORKING RULE the operator stated about how they want work done ("verify the cause before fixing", "never force push without asking"). NOT for facts about the world — those are engrams (engram_record). Be selective: a rule is something worth following again next month, not a one-off instruction. If the wording is ambiguous, ask the operator instead of guessing. On similar_rules_exist, read what came back and either leave the existing rule alone or re-send with confirm=true.',
        parameters: {
          type: 'object',
          properties: {
            text:    { type: 'string', description: 'The rule, imperative and self-contained' },
            why:     { type: 'string', description: 'What made this a rule — a rule with a reason survives being questioned' },
            scope:   { type: 'string', enum: ['global', 'project'], description: 'global (default) or project-only' },
            confirm: { type: 'boolean', description: 'Add it even though the substrate flagged a close existing rule' }
          },
          required: ['text']
        }
      }
    },
    run: async (args, ctx) => {
      const lessonMod = require('./lesson.js');
      return await lessonMod.recordRule({
        text:    args.text,
        why:     args.why || null,
        scope:   args.scope === 'project' ? 'project' : 'global',
        cwd:     ctx.cwd || null,
        agent_id: ctx.agent_id,
        confirm: !!args.confirm,
        embedding_host: ctx.embedding_host || null
      });
    }
  },

  // The code graph, askable. Same shared implementation the MCP surface uses
  // (shared-core/code-graph.js) so the two registries cannot drift into
  // disagreeing about what "nothing calls this" means.
  // The code graph, askable from here too. Same shared implementation the MCP
  // surface uses (shared-core/code-graph.js) so the two registries cannot
  // drift into disagreeing about what "nothing calls this" means.
  //
  // Every name here is also read into the daemon's system prompt, which
  // truncates past its cap. Measured 2026-08-11: these two cost 31 characters
  // in text mode (4,287 -> 4,318) and the cap was raised to keep the voice
  // variant — 172 chars longer for the brevity block — clear of the tail.
  code_who_calls: {
    schema: {
      type: 'function',
      function: {
        name: 'code_who_calls',
        description: 'Who calls this function or class, from the real code index — and whether anything in PRODUCTION reaches it or only the test suite. Use instead of grepping for callers, and before changing or deleting anything.',
        parameters: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'Function / class / method name' },
            exact: { type: 'boolean', description: 'Exact name matches only' }
          },
          required: ['name']
        }
      }
    },
    run: async (args, ctx) => {
      return require('./code-graph.js').whoCalls(args.name, { cwd: ctx.cwd || undefined, exact: !!args.exact });
    }
  },

  code_file_map: {
    schema: {
      type: 'function',
      function: {
        name: 'code_file_map',
        description: 'Everything defined in one file with how many things reach each, and which are reached by nothing. Answers "is any of this still alive" for a whole file.',
        parameters: {
          type: 'object',
          properties: { file: { type: 'string', description: 'Path, absolute or project-relative' } },
          required: ['file']
        }
      }
    },
    run: async (args, ctx) => {
      return require('./code-graph.js').fileMap(args.file, { cwd: ctx.cwd || undefined });
    }
  },

  rule_list: {
    schema: {
      type: 'function',
      function: {
        name: 'rule_list',
        description: 'The standing working rules the operator has given, newest first. Read-only and non-consuming. Use before recording a new rule, and when asked what rules you work under.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max rules (default 20)', minimum: 1, maximum: 100 }
          }
        }
      }
    },
    run: async (args, ctx) => {
      const lessonMod = require('./lesson.js');
      const items = lessonMod.listRules({ limit: args.limit || 20, cwd: ctx.cwd || null });
      return { count: items.length, items };
    }
  },

  chameleon_list_scopes: {
    schema: {
      type: 'function',
      function: {
        name: 'chameleon_list_scopes',
        description: 'List the named document corpora the substrate has ingested. Use this first to discover what knowledge bases are queryable before calling chameleon_query.',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async (_args, ctx) => {
      const scopes = chameleon.listScopes({ agent_id: ctx.agent_id, cwd: ctx.cwd });
      return { scopes };
    }
  },

  chameleon_query: {
    schema: {
      type: 'function',
      function: {
        name: 'chameleon_query',
        description: 'Retrieve top-K relevant chunks from a NAMED ingested corpus. Use when the user question touches a domain you know is loaded (call chameleon_list_scopes first if unsure).',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', description: 'The corpus name (e.g., docs:codebase-current)' },
            query: { type: 'string', description: 'The information you are looking for' },
            k:     { type: 'integer', description: 'Maximum chunks (default 5)', minimum: 1, maximum: 15 }
          },
          required: ['scope', 'query']
        }
      }
    },
    run: async (args, ctx) => {
      const r = await chameleon.queryScope({
        agent_id:       ctx.agent_id,
        cwd:            ctx.cwd,
        query:          args.query,
        scope:          args.scope,
        k:              args.k || 5,
        embedding_host: ctx.embedding_host
      });
      return {
        scope: r.scope,
        chunks: r.items.map(i => ({
          statement: i.statement,
          score:     Number(i.score && i.score.toFixed ? i.score.toFixed(3) : i.score),
          source:    i.source
        }))
      };
    }
  },

  web_fetch: {
    schema: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method:"GET", url, ...}, capability_ref, grounded_in, irreversibility_class:"low"}). Kept only for backward compatibility during migration. Original: fetch a single HTTPS page from the operator-approved allowlist and return its readable text. Returns external/untrusted content.',
        parameters: {
          type: 'object',
          properties: {
            url:        { type: 'string', description: 'Full https:// URL on the allowlist' },
            max_bytes:  { type: 'integer', description: 'Cap on response bytes (default 1048576)', minimum: 1024, maximum: 10485760 },
            timeout_ms: { type: 'integer', description: 'Network timeout (default 15000)', minimum: 1000, maximum: 60000 },
            auth_header_credential: { type: 'string', description: 'Vault credential NAME (uppercase). Substrate injects its value into "Authorization: Bearer <value>". Use credential_list first to see which credentials are scoped to your current goal class.' }
          },
          required: ['url']
        }
      }
    },
    run: async (args, ctx) => {
      // credential subsystem — credential injection. The partner names a vault entry;
      // substrate resolves the value (scope-checked against current goal
      // class) and passes it as a header. Value never enters LLM context.
      const fetchOpts = {
        max_bytes:  args.max_bytes,
        timeout_ms: args.timeout_ms
      };
      if (typeof args.auth_header_credential === 'string' && args.auth_header_credential.length) {
        const value = credentialVault.getCredentialValue(args.auth_header_credential, {
          class:   (ctx && ctx.goal_class) || null,
          goal_id: (ctx && ctx.goal_id) || null
        });
        if (!value) {
          return {
            ok: false, refused: true,
            reason: 'credential_unavailable',
            url: args.url,
            detail: 'Credential "' + args.auth_header_credential + '" not in vault OR not scoped to goal class "' + ((ctx && ctx.goal_class) || 'unknown') + '". Ask the operator via operator_request{kind:credential, detail:{service:"' + args.auth_header_credential + '", scope:"' + ((ctx && ctx.goal_class) || 'unknown') + '"}}.'
          };
        }
        fetchOpts.extra_headers = { 'Authorization': 'Bearer ' + value };
      }
      const r = await webFetch.fetchUrl(args.url, fetchOpts);
      // Cap returned text so a 1MB page doesn't blow the LLM context — the
      // fetcher already truncates at byte level, but plaintext after HTML
      // stripping can still be large. 32k char ceiling is generous for a
      // single fetched page.
      if (r && r.text && r.text.length > 32000) {
        r.text = r.text.slice(0, 32000);
        r.truncated = true;
      }
      // operator-request subsystem + audit subsystem — handle not_in_allowlist refusal per
      // the operator's web_allowlist.mode setting:
      //   strict    → emit operator_request{kind:allowlist_add} (default,
      //               unchanged from K).
      //   auto_grow → silently add the host to the allowlist + audit log,
      //               then re-fetch in the same call. Lets the partner
      //               keep moving without an inbox roundtrip.
      //   open      → audit log only; if we still got refused it's
      //               because the URL isn't https or bad shape — surface.
      if (r && r.refused && r.reason === 'not_in_allowlist') {
        let mode = 'strict';
        try {
          const l4cfg = (function(){try{return require('./l4-config.js')}catch(e){return {isEnabled:()=>false,DEFAULTS:{},getL4Config:()=>({enabled:false}),getBudgetForClass:()=>1000,getTransparencyForClass:()=>'show'}}}());
          const cfg = l4cfg.getL4Config();
          if (cfg && cfg.web_allowlist && typeof cfg.web_allowlist.mode === 'string') {
            mode = cfg.web_allowlist.mode;
          }
        } catch (_) {}
        let host = '';
        try { host = new (require('url').URL)(args.url).hostname; } catch (_) {}
        if (mode === 'auto_grow' && host) {
          // Partner-driven add + audit + iterative re-fetch. The fetcher
          // re-checks allowlist at every redirect hop (the default-deny rule) so a
          // 301 to a different subdomain hits the same wall. In auto-grow
          // we walk the redirect chain by adding each refused host until
          // we get a non-refusal OR hit a hop cap. Cap = 5 to bound the
          // attack surface; if a chain needs more, that's a sign and we
          // fall through to operator escalation.
          try {
            const state = require('./state.js');
            const _audit = (h, urlSample) => {
              try {
                webAllowlist.addDomain(h);
                if (state && typeof state.recordAllowlistAudit === 'function') {
                  state.recordAllowlistAudit({
                    host: h, sample_url: urlSample, mode,
                    goal_id:    (ctx && ctx.goal_id) || null,
                    goal_class: (ctx && ctx.goal_class) || null,
                    action:     'auto_added'
                  });
                }
              } catch (_) {}
            };
            _audit(host, args.url);
            let attempt = 0;
            let r2 = await webFetch.fetchUrl(args.url, fetchOpts);
            while (r2 && r2.refused && r2.reason === 'not_in_allowlist' && attempt < 5) {
              attempt++;
              // Pull the failing URL out of the result; the redirect chain
              // is preserved in r2.redirected_chain.
              const failingUrl = r2.url || args.url;
              let failHost = '';
              try { failHost = new (require('url').URL)(failingUrl).hostname; } catch (_) {}
              if (!failHost || failHost === host) break; // can't progress
              _audit(failHost, failingUrl);
              host = failHost;
              r2 = await webFetch.fetchUrl(args.url, fetchOpts);
            }
            if (r2 && r2.text && r2.text.length > 32000) {
              r2.text = r2.text.slice(0, 32000); r2.truncated = true;
            }
            // If still refused after walking, fall through to operator
            // escalation; don't silently lie about the outcome.
            if (!(r2 && r2.refused)) return r2;
          } catch (_) { /* fall through to inbox escalation */ }
        }
        // strict (or auto_grow that errored): emit operator_request as before.
        try {
          const state = require('./state.js');
          if (state && typeof state.recordOperatorRequest === 'function') {
            state.recordOperatorRequest({
              goal_id:    (ctx && ctx.goal_id) || null,
              goal_class: (ctx && ctx.goal_class) || null,
              kind:       'allowlist_add',
              urgency:    'normal',
              detail: {
                host,
                sample_url: args.url,
                why: 'web_fetch refused; pursuing ' + ((ctx && ctx.goal_class) || 'unknown') + ' goal'
              }
            });
          }
        } catch (_) { /* escalation is best-effort */ }
      }
      // Surface the audience marker so the caller (synthesizer step) knows
      // anything they engram_record off this content inherits 'external'.
      return r;
    }
  },

  // subsystem — partner-volitional follow-up goals (multi-class chains).
  //
  // The partner today runs one goal at a time. A real ambition like "find
  // how to make money with crypto, do the research, then build something
  // that runs" is naturally a research goal that hands off to a code goal
  // that hands off to a deploy/verify goal. Without this tool the partner
  // finishes step 1 and falls silent; the operator has to manually pin
  // each follow-up. With submit_goal, the synthesizer step at the end of
  // a class can queue the next class's goal and the idle-pursuit
  // heartbeat picks it up on the next tick.
  //
  // Scope discipline: this is NOT a way to spawn unlimited goals. Each
  // follow-up runs through the same transparency gate, budget tracker,
  // and capability scope as a manually pinned goal. Per-class budgets
  // cap cost, idle-pursuit refuses if the class is disabled, and the
  // operator can dismiss the goal from the dashboard.
  submit_goal: {
    schema: {
      type: 'function',
      function: {
        name: 'submit_goal',
        description: 'Queue a follow-up goal for the partner to pursue. NOTE: autonomous execution of queued goals ships with the app; in this build the call records the goal and returns unavailable rather than running it.',
        parameters: {
          type: 'object',
          properties: {
            text:       { type: 'string', description: 'Goal statement, one sentence. The classifier will route it; you may suggest a class hint via the class param.' },
            class_hint: { type: 'string', description: 'Suggested goal class (research|code|debug|writing|email|planning|learning|chat). Substrate may re-classify.' },
            why:        { type: 'string', description: 'One-line justification: what this follow-up unblocks or what it depends on from the current goal.' },
            regime:     { type: 'string', enum: ['host', 'sandbox'], description: 'sandbox regime step: where the goal works. host = operator cwd (default for code/edit in existing project). sandbox = isolated ~/.troth/sandbox/<goal_id>/workspace/ (auto-proposed for scaffold/create/new-project flavored goals with no cwd). Operator can override.' }
          },
          required: ['text']
        }
      }
    },
    run: async (args, ctx) => {
      try {
        const text = String(args.text || '').trim();
        if (!text || text.length < 6) return { ok: false, error: 'goal text too short' };
        if (text.length > 800)        return { ok: false, error: 'goal text too long (> 800 chars)' };
        // sandbox regime step regime decision: explicit param wins; otherwise
        // heuristic from sandbox-workspace.proposeRegime over (text, cwd).
        let sandboxWs = null;
        try { sandboxWs = require('./sandbox-workspace.js'); } catch (_) { /* closed overlay; absent on a public clone */ }
        if (!sandboxWs) return { ok: false, error: 'sandbox_workspace_unavailable',
          detail: 'Goal execution ships with the app. This build accepts goals through the substrate directly (engram_record with class "goal") instead.' };
        const cwd = (ctx && ctx.cwd) || null;
        let regime;
        if (args.regime === 'host' || args.regime === 'sandbox') {
          regime = args.regime;
        } else {
          regime = sandboxWs.proposeRegime(text, cwd);
        }
        // Record as engram scope='goal' so the existing idle-pursuit /
        // goal-status / dashboard surfaces all pick it up identically to
        // an operator-pinned goal. The class hint goes in the statement
        // body as a prefix tag the classifier can latch onto. Parent
        // linkage goes in the source field so the dashboard can render
        // chains without an extra schema change.
        const hint = (typeof args.class_hint === 'string' && args.class_hint.trim()) ? args.class_hint.trim() : null;
        const parentId = (ctx && ctx.goal_id) || null;
        const taggedStatement = hint ? ('[' + hint + '] ' + text) : text;
        const id = engram.recordEngram({
          agent_id: (ctx && ctx.agent_id) || 'l4-partner',
          user_id:  (ctx && ctx.user_id)  || null,
          cwd:      cwd,
          statement: taggedStatement,
          source:   parentId ? ('partner_self_submit:parent=' + parentId) : 'partner_self_submit',
          scope:    'goal',
          salience: 1.5,
          extra:    { regime },
          // Goals are operator-deliberate intentions, not factual claims
          // we want to compare for duplicate truth-content. Skip the
          // engram-verify pool comparison so a follow-up "build the
          // script" goal doesn't get suppressed because some other "build
          // the script" engram sits in the pool.
          auto_verify: false
        });
        // If sandbox regime, materialize the workspace directory now so
        // downstream tools have an actual path to mount/cd into.
        let sandbox_workspace = null;
        if (regime === 'sandbox' && id) {
          const ws = sandboxWs.resolveWorkspacePath('sandbox', id, null);
          if (ws.ok) sandbox_workspace = ws.path;
        }
        return {
          ok: !!id,
          goal_engram_id: id,
          parent_goal_id: (ctx && ctx.goal_id) || null,
          regime,
          sandbox_workspace,
          note: 'Goal queued. The idle-pursuit heartbeat will dispatch it on the next tick. Do not retry — pivot or end the current step.'
        };
      } catch (e) {
        return { ok: false, error: e && e.message || String(e) };
      }
    }
  },

  // operator-request subsystem+ — operator escalation tool. The LLM uses this when it
  // hits a ceiling it cannot transparently cross: a credential is
  // missing, money is needed for an external action, a plan needs
  // explicit operator sign-off, etc. The request lands in the dashboard
  // OPERATOR INBOX with kind-typed action buttons. Use sparingly — every
  // call wakes the operator's attention; only escalate when no substrate
  // path can cross the gap.
  operator_request: {
    schema: {
      type: 'function',
      function: {
        name: 'operator_request',
        description: 'Ask the operator for something the autonomous partner cannot do on its own (credential, money, approval, allowlist addition, or any blocking ask). Lands in the dashboard OPERATOR INBOX. Use sparingly; only when no substrate tool can cross the gap. Returns immediately — the partner does NOT wait for the operator inline; track the answer via subsequent inbox queries or by abandoning the goal until the operator resolves.',
        parameters: {
          type: 'object',
          properties: {
            kind:    { type: 'string', enum: ['allowlist_add', 'credential', 'money', 'approval', 'manual'], description: 'Kind of ask. Pick the most specific one.' },
            urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'low = "when you get to it", normal = default, high = blocks goal progress' },
            detail:  { type: 'object', description: 'Kind-specific payload. credential: {service, scope, why?}. money: {amount, currency, destination?, why?}. approval: {plan, transparency_promote?}. manual: {instruction}.' }
          },
          required: ['kind', 'detail']
        }
      }
    },
    run: async (args, ctx) => {
      try {
        const state = require('./state.js');
        const r = state.recordOperatorRequest({
          kind:    args.kind,
          urgency: args.urgency || 'normal',
          detail:  args.detail || {},
          goal_id:    (ctx && ctx.goal_id) || null,
          goal_class: (ctx && ctx.goal_class) || null
        });
        if (!r.ok) return { ok: false, error: r.error || 'operator_request_failed' };
        return {
          ok: true,
          id: r.id,
          dedup_suppressed: !!r.dedup_suppressed,
          note: r.dedup_suppressed
            ? 'A matching request is already pending — operator has not resolved it yet. Do not retry; pivot or pause this goal.'
            : 'Operator request filed. Do not wait inline — pivot or pause this goal until resolved.'
        };
      } catch (e) {
        return { ok: false, error: e && e.message || String(e) };
      }
    }
  },

  // subsystem — credential vault discovery.
  // Returns ONLY metadata (name, scope, description, ts) — NEVER values.
  // The value lives substrate-side; tool dispatchers (web_fetch
  // auth_header_credential, future api_call etc.) read it directly via
  // credentialVault.getCredentialValue. This separation is the wall: the
  // LLM may know X exists, may name X in a tool arg, but never sees X's
  // bytes in its own context.
  credential_list: {
    schema: {
      type: 'function',
      function: {
        name: 'credential_list',
        description: 'List vault credentials available to the current goal class. Returns metadata only — never values. Use BEFORE asking the operator via operator_request{kind:credential}: the credential may already be in the vault scoped for you. Pass the name to a tool that supports credential injection (e.g. web_fetch auth_header_credential).',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async (_args, ctx) => {
      const creds = credentialVault.listCredentials({
        class: (ctx && ctx.goal_class) || null
      });
      return {
        credentials: creds,
        note: creds.length === 0
          ? 'No credentials available for this goal class. Use operator_request{kind:credential} to ask the operator to add one.'
          : null
      };
    }
  },

  // ─── intent_emit ─────────────────────────────────────────────────────
  // The single substrate-first action surface, per the partner vision note
  // design note. Replaces per-tool function-call dispatch with
  // intent-engram emission → write-time STVC → dispatcher → universal
  // executor → observation engram → result returned to LLM.
  //
  // The partner expresses WHAT to do (full action spec in payload) and
  // WHY (grounded_in sealed engrams) and BY WHAT AUTHORITY
  // (capability_ref). Substrate enforces the 5 universal scope families:
  //   intent:http:do      — any HTTPS call (replaces api_call / web_fetch
  //                          / github_* / vercel_* / notion_* / supabase_*
  //                          / gmail email_*)
  //   intent:fs:do        — read/write under capability-scoped path
  //   intent:shell:do     — sandboxed shell (docker / firejail / refuse)
  //   intent:browser:do   — Playwright/Stagehand browser session
  //   intent:spawn:do     — spawn a scoped worker (closed tier)
  //   intent:skill:execute — run a compiled skill template
  //
  // Every emission gets STVC-gated at write time (capability covers
  // intent, irreversibility sealed, not globally paused, grounded in
  // sealed, no duplicate pending) AND re-validated at dispatch time
  // (TOCTOU defense). Failures land as observation engrams the partner
  // can reason about. Skill compiler watches successful intent chains
  // and packages repeating patterns into reusable templates.
  intent_emit: {
    schema: {
      type: 'function',
      function: {
        name: 'intent_emit',
        description: 'Express an intent to act in the world. The substrate validates against capability + STVC, dispatches via the universal executor for the scope, and returns the observation. Use this for ALL actions (HTTP, filesystem writes, shell, browser, spawning sub-partners, running compiled skills). Per L4 design: brain articulates intent; substrate decides whether and how to act; observation is the partner\'s memory of what happened. SIMPLEST FORM: emit just {scope, payload, irreversibility_class} — if the operator has sealed a capability covering the scope, the substrate AUTO-FILLS capability_ref + grounded_in for you from standing authorization, so you do NOT need to engram_search first. Supply capability_ref / grounded_in explicitly only to override that choice. If the result comes back ok:false with auto_resolved:false, no sealed capability covers the scope — emit operator_request{kind:capability}. irreversibility_class declares the action\'s class; STVC refuses if the capability\'s max_irreversibility is lower; high/sealed_only still require explicit operator seals.',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              description: 'Registered executor scopes: intent:http:do (any HTTPS), intent:fs:do (filesystem ops), intent:shell:do (sandboxed shell), intent:browser:do (CDP-driven browser, steps[] script), intent:spawn_subpartner (spawn sub-partner with attenuated scope), intent:skill:execute (run a compiled skill template).'
            },
            payload: {
              type: 'object',
              description: 'Full action specification — what the executor reads to dispatch. Shape depends on scope. intent:http:do → {method,url,headers?,body?,credential_name?}. intent:fs:do → {op:read|write|append|delete, path, content?, encoding?}. intent:shell:do → {command, stdin?, image?, network?, timeout_s?}. intent:browser:do → {steps:[...]} a CDP step script (max 50 steps), each step one of: navigate, fill, click, press, extract_text, extract_attr, screenshot, wait_ms, wait_for, eval, fill_from_vault, capture_to_vault, submit_and_observe, await_human. intent:spawn_subpartner → {role, scope_attenuation, max_turns}. intent:skill:execute → {skill_id, params}.'
            },
            capability_ref: {
              type: 'string',
              description: 'OPTIONAL — Engram ID of the capability authorizing this intent. Omit it and the substrate auto-selects an operator-sealed capability covering the scope. Supply explicitly only to override. If you want to find one yourself: engram_search scope=capability:<family>.'
            },
            grounded_in: {
              type: 'array',
              items: { type: 'string' },
              description: 'OPTIONAL — Array of sealed engram IDs (operator_confirmed or plr_evolved tier) that justify this action. Omit it and the substrate cites standing-authorization grounding (charter / presence_proof / identity) automatically. STVC still requires sealed grounding; the substrate fills it from what the operator already sealed.'
            },
            irreversibility_class: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'sealed_only'],
              description: 'Reversibility of the action. low=trivially undoable (reads, idempotent writes). medium=needs effort to undo (file create/edit, soft-delete). high=needs operator seal (publish, send email, deploy, pay). sealed_only=irrevocable (delete account, irreversible api). Default low.'
            },
            seals: {
              type: 'array',
              items: { type: 'string' },
              description: 'For irreversibility_class >= high, array of operator seal engram IDs. Obtain via operator_request{kind:approval} → operator signs a seal → resubmit intent with seals filled.'
            },
            expected_observation_shape: {
              type: 'object',
              description: 'Optional shape hint for the dispatcher contract (e.g. {status:"integer", body:"object"}). Logged for audit, not enforced.'
            },
            statement: {
              type: 'string',
              description: 'One-line natural-language description of what you intend (for substrate readability + future skill compilation).'
            }
          },
          required: ['scope', 'payload', 'irreversibility_class']
        }
      }
    },
    run: async (args, ctx) => {
      const intentMod = require('./intent.js');
      const dispatcher = require('./dispatcher.js');
      // Lazy bootstrap of the 6 universal executors. Idempotent via
      // require cache + dispatchers/bootstrap.js's own guard, so the
      // first intent_emit in a process registers them and subsequent
      // calls are no-ops. Production daemon also calls bootstrap() at
      // boot — this is the safety net for embedders that don't.
      try { require('./dispatchers/bootstrap.js').bootstrap(); }
      catch (e) { /* missing optional executor (e.g. playwright) is fine */ }

      // auto-resolve standing authorization when the
      // faculty emits a bare intent (scope+payload only). Small models
      // can't reliably thread capability_ref + grounded_in arrays; the
      // substrate looks them up from operator-sealed engrams instead.
      // Only fires when the model OMITTED them — an explicit ref the
      // model supplied is always honored as-is. No weakening of STVC:
      // _autoResolveAuthorization only returns operator-sealed authority,
      // and writeIntent's predicate wall still runs on the result.
      let autoResolved = false;
      let capRef     = args.capability_ref;
      let groundedIn = args.grounded_in;
      const needsCap    = !capRef;
      const needsGround = !Array.isArray(groundedIn) || !groundedIn.length;
      if (needsCap || needsGround) {
        const auth = _autoResolveAuthorization(args.scope, args.irreversibility_class || 'low');
        if (auth) {
          if (needsCap)    capRef     = auth.capability_ref;
          if (needsGround) groundedIn = auth.grounded_in;
          autoResolved = true;
        }
      }

      const write = intentMod.writeIntent({
        scope:                 args.scope,
        payload:               args.payload,
        capability_ref:        capRef,
        grounded_in:           groundedIn,
        irreversibility_class: args.irreversibility_class || 'low',
        seals:                 args.seals || [],
        expected_observation_shape: args.expected_observation_shape || null,
        statement:             args.statement || ('intent ' + args.scope),
        agent_id:              (ctx && ctx.agent_id) || 'partner',
        user_id:               (ctx && ctx.user_id)  || 'operator',
        cwd:                   (ctx && ctx.cwd) || null,
        source:                'partner via intent_emit'
      });
      if (!write.ok) {
        // STVC refused at write time — surface the predicate that
        // refused + a hint so the partner can self-correct (mint missing
        // cap, seal high-irreversibility, ground in operator decision).
        return {
          ok: false,
          refused: true,
          stage: 'write',
          reason: write.error,
          detail: write.detail || null,
          auto_resolved: autoResolved,
          hint: (!autoResolved && (needsCap || needsGround))
            ? 'no operator-sealed capability covers ' + args.scope + '. The operator must seal one first (control:seal_engram scope=capability:' + args.scope.slice('intent:'.length) + ') OR you emit operator_request{kind:capability}. Once sealed, you can emit a bare intent_emit{scope,payload,irreversibility_class} and the substrate fills capability_ref + grounded_in for you.'
            : _writeStageHint(write.error, args)
        };
      }
      // Two-phase STVC: dispatcher re-validates at dispatch time.
      const result = await dispatcher.dispatchOne(write.id, { context: ctx || {} });
      if (!result.ok) {
        return {
          ok: false,
          refused: result.refusal_reason && result.refusal_reason.startsWith('adapter_error:') ? false : true,
          stage: 'dispatch',
          intent_id: write.id,
          status: result.status || 'failed',
          observation_id: result.observation_id || null,
          reason: result.refusal_reason,
          hint: _dispatchStageHint(result.refusal_reason || '')
        };
      }
      return {
        ok: true,
        intent_id: write.id,
        status: result.status,
        observation_id: result.observation_id,
        auto_resolved: autoResolved,
        capability_ref: capRef,
        result: result.result
      };
    }
  },

  // design: generic API client. Replaces "use web_fetch with
  // hand-rolled bodies" for structured-JSON services. Credential value
  // never crosses LLM boundary (R17); substrate resolves from vault and
  // injects per service auth shape (Bearer / x-api-key / basic / etc.).
  //
  // DEPRECATED for partner use. Drifts from substrate-as-subject (no
  // intent engram, no STVC, no observation memory). intent_emit is the
  // replacement. Kept temporarily for backward-compat during migration;
  // will be removed once the partner's prompt is retrained to emit
  // intents. See design.
  api_call: {
    schema: {
      type: 'function',
      function: {
        name: 'api_call',
        description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method, url, body?, credential_name?, ...}, capability_ref, grounded_in, irreversibility_class}). Kept only for backward compatibility during migration. Original: authenticated HTTP API call to a known service. Returns parsed JSON + status.',
        parameters: {
          type: 'object',
          properties: {
            service:         { type: 'string', description: 'Service registry key. See api_services_list. Pass null to use base_url directly.' },
            base_url:        { type: 'string', description: 'Override the registry base URL. REQUIRED for supabase (e.g. https://<project>.supabase.co) and any unregistered service.' },
            method:          { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE'] },
            path:            { type: 'string', description: 'Path relative to base_url, e.g. /repos/owner/repo' },
            body:            { type: 'object', description: 'Request body (will be JSON-serialized). Use string for non-JSON.' },
            query:           { type: 'object', description: 'URL query params as {key: value}.' },
            credential_name: { type: 'string', description: 'Vault credential NAME (uppercase). Substrate injects its value into the right auth header without exposing it.' },
            timeout_ms:      { type: 'integer', description: 'Network timeout (default 30000)', minimum: 1000, maximum: 60000 },
            extra_headers:   { type: 'object', description: 'Additional non-auth headers.' }
          },
          required: ['method', 'path', 'credential_name']
        }
      }
    },
    run: async (args, ctx) => {
      const apiCall = require('./tools/api-call.js');
      return apiCall.apiCall(args, ctx);
    }
  },

  api_services_list: {
    schema: {
      type: 'function',
      function: {
        name: 'api_services_list',
        description: 'List service names known to api_call. Use before api_call when uncertain.',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async () => {
      const apiCall = require('./tools/api-call.js');
      return { services: apiCall.listServices() };
    }
  },

  // design: Browser session (backend-agnostic). Substrate
  // provides mutex + TTL + concurrent-cap + audit; operator wires the
  // actual driver (Stagehand on Playwright, Browserbase cloud, etc.).
  // Until a driver is injected at the call site, returns
  // driver_required — extended tools module installs the backend separately.
  browser_session: {
    schema: { type: 'function', function: {
      name: 'browser_session',
      description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:browser:do", payload:{action, url?, selector?, ...}, capability_ref, grounded_in, irreversibility_class}). Original: drive a browser session for flows with no API path. One session per credential.',
      parameters: { type: 'object', required: ['action', 'credential_name'], properties: {
        action:          { type: 'string', enum: ['open','goto','act','extract','observe','screenshot','close'] },
        credential_name: { type: 'string' },
        args:            { type: 'object' }
      }}
    }},
    run: async (args, ctx) => {
      const bs = require('./tools/browser-session.js');
      if (args.action === 'open') {
        // The substrate cannot conjure a driver. extended tools module
        // must inject one via ctx.browser_driver_factory(credential_name).
        const factory = ctx && ctx.browser_driver_factory;
        const driver = (typeof factory === 'function')
          ? await factory(args.credential_name, args.args || {})
          : null;
        return bs.open({ credential_name: args.credential_name, driver, ttl_ms: args.args && args.args.ttl_ms });
      }
      return bs.exec({ credential_name: args.credential_name, action: args.action, args: args.args });
    }
  },


  // design: per-service named wrappers (high-frequency ops).
  // Each delegates to api_call under the hood. Long-tail operations
  // come from OpenAPI docs via chameleon (implementation step) — don't expand
  // this set without evidence the op is frequent enough to justify
  // the system-prompt schema cost.
  github_get_repo: {
    schema: { type: 'function', function: {
      name: 'github_get_repo',
      description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method:"GET", url:"https://api.github.com/repos/"+owner+"/"+repo, credential_name:"GITHUB_TOKEN"}, ...}). Original: fetch GitHub repo metadata.',
      parameters: { type: 'object', required: ['owner', 'repo'], properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        credential_name: { type: 'string' }, timeout_ms: { type: 'integer' }
      }}
    }},
    run: async (args, ctx) => require('./tools/api-wrappers.js').github_get_repo(args, ctx)
  },
  github_create_issue: {
    schema: { type: 'function', function: {
      name: 'github_create_issue',
      description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method:"POST", url:"https://api.github.com/repos/"+owner+"/"+repo+"/issues", body:{title,body,labels,assignees}, credential_name:"GITHUB_TOKEN"}, irreversibility_class:"medium", ...}). Original: open GitHub issue.',
      parameters: { type: 'object', required: ['owner', 'repo', 'title'], properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        title: { type: 'string' }, body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } },
        credential_name: { type: 'string' }, timeout_ms: { type: 'integer' }
      }}
    }},
    run: async (args, ctx) => require('./tools/api-wrappers.js').github_create_issue(args, ctx)
  },
  vercel_list_projects: {
    schema: { type: 'function', function: {
      name: 'vercel_list_projects',
      description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method:"GET", url:"https://api.vercel.com/v9/projects", credential_name:"VERCEL_TOKEN"}, ...}). Original: list Vercel projects.',
      parameters: { type: 'object', properties: {
        limit: { type: 'integer' }, team_id: { type: 'string' },
        credential_name: { type: 'string' }, timeout_ms: { type: 'integer' }
      }}
    }},
    run: async (args, ctx) => require('./tools/api-wrappers.js').vercel_list_projects(args, ctx)
  },
  notion_search: {
    schema: { type: 'function', function: {
      name: 'notion_search',
      description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method:"POST", url:"https://api.notion.com/v1/search", body:{query,page_size,filter,sort}, credential_name:"NOTION_TOKEN"}, ...}). Original: search Notion pages/databases.',
      parameters: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' }, page_size: { type: 'integer' },
        filter: { type: 'object' }, sort: { type: 'object' },
        credential_name: { type: 'string' }, timeout_ms: { type: 'integer' }
      }}
    }},
    run: async (args, ctx) => require('./tools/api-wrappers.js').notion_search(args, ctx)
  },
  supabase_run_sql: {
    schema: { type: 'function', function: {
      name: 'supabase_run_sql',
      description: 'DEPRECATED — bypasses substrate STVC + observation engram. PREFER intent_emit({scope:"intent:http:do", payload:{method:"POST", url:base_url+"/rest/v1/rpc/"+rpc_function, body:params, credential_name:"SUPABASE_SERVICE_KEY"}, irreversibility_class:"medium", ...}). Original: call Supabase PostgREST RPC function.',
      parameters: { type: 'object', required: ['base_url', 'rpc_function'], properties: {
        base_url: { type: 'string' },
        rpc_function: { type: 'string' },
        params: { type: 'object' },
        credential_name: { type: 'string' }, timeout_ms: { type: 'integer' }
      }}
    }},
    run: async (args, ctx) => require('./tools/api-wrappers.js').supabase_run_sql(args, ctx)
  },

  web_allowlist_list: {
    schema: {
      type: 'function',
      function: {
        name: 'web_allowlist_list',
        description: 'List the domains the operator has approved for web_fetch. Call this before web_fetch if uncertain whether a URL is fetchable.',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async () => {
      return { domains: webAllowlist.listAllowed() };
    }
  },

  dialogue_recent: {
    schema: {
      type: 'function',
      function: {
        name: 'dialogue_recent',
        description: 'Retrieve the most recent N conversation turns the substrate has on record (chronological), scoped to the CURRENT project. Default 20 for "what did we just discuss" questions; bump up to 200 for "summarize today". Set all_projects=true ONLY when the user explicitly asks across projects.',
        parameters: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'Number of recent turns (default 20)', minimum: 1, maximum: 200 },
            all_projects: { type: 'boolean', description: 'Cross-project read. Default false: dialogue is session state and stays inside the current project unless the user explicitly asks otherwise.' }
          }
        }
      }
    },
    run: async (args, ctx) => {
      // Scoped BY DEFAULT. recentTurns only honors cwd when same_cwd is set,
      // and this tool never set it, so /save and every skill that summarizes
      // "recent dialogue" read turns from whatever project wrote last
      // (operator hit this inside /troth:save,: engrams were about
      // to be minted from another project's conversation). Engrams and
      // identity stay one-mind global; the dialogue WINDOW is attention, and
      // attention does not cross projects uninvited.
      const turns = dialogueMemory.recentTurns({
        cwd:      ctx.cwd,
        same_cwd: !args.all_projects,
        limit:    args.n || 20
      });
      return {
        turns: turns.map(t => ({
          ts: t.ts,
          user: t.user_text,
          assistant: t.assistant_text
        }))
      };
    }
  },

  // recall subsystem — time-range + FTS dialogue search. dialogue_recent
  // is recency-only with no time-window; for "what did we work on
  // yesterday / last 2 days" the partner needs a tool that filters by
  // timestamp + optionally matches text. Backed by state.searchDialogueTurns
  // which JOINs action_records_fts with action_records and filters to
  // dialogue.turn rows.
  dialogue_search: {
    schema: {
      type: 'function',
      function: {
        name: 'dialogue_search',
        description: 'Search past conversation turns by text and/or time-range. Use for "what did we discuss yesterday / 3 days ago / about topic X" questions. Returns chronological turns from the unified partner brain (all surfaces: chat, voice, CLI).',
        parameters: {
          type: 'object',
          properties: {
            query:      { type: 'string', description: 'Optional FTS text to match within user_text or assistant_text. Omit for time-range-only.' },
            since_days: { type: 'number', description: 'Limit to turns within the last N days. Default 7. Pass 2 for "last 2 days", 30 for "last month".', minimum: 0.04, maximum: 365 },
            limit:      { type: 'integer', description: 'Max turns to return (default 50, max 500). Use larger for summarization queries.', minimum: 1, maximum: 500 }
          }
        }
      }
    },
    run: async (args, _ctx) => {
      try {
        const state = require('./state.js');
        if (!state || typeof state.searchDialogueTurns !== 'function') {
          return { turns: [], error: 'searchDialogueTurns_unavailable' };
        }
        const sinceDays = typeof args.since_days === 'number' && args.since_days > 0 ? args.since_days : 7;
        const turns = state.searchDialogueTurns({
          query:    args.query || '',
          since_ms: sinceDays * 24 * 60 * 60 * 1000,
          limit:    args.limit || 50
        });
        return {
          turns: turns.map(t => ({
            ts: t.ts,
            day: new Date(t.ts).toISOString().slice(0, 10),
            user: t.user_text,
            assistant: t.assistant_text,
            agent_id: t.agent_id
          })),
          count: turns.length,
          since_days: sinceDays
        };
      } catch (e) {
        return { turns: [], error: 'dialogue_search_failed', detail: e && e.message || String(e) };
      }
    }
  }
};

// Optional tool packs merge in when present. The open registry is complete
// without them and no open test depends on one.
try { Object.assign(REGISTRY, require('./tools/optional/index.js').REGISTRY); } catch (_) {}

// Closed-extension tools (guarded optional require — absent in the open build).
try { const _extTools = require('./core-ext.js'); Object.assign(REGISTRY, _extTools.substrateTools || {}); } catch (_) {}

// Return the OpenAI-compatible tools array to attach to a chat request.
// Caller may filter to a subset by name; default exports the full set.
// faculty workstream — "intents, not tools" (standard S2). When faculty emit-mode is
// on, the LLM holds NO action/authority-committing tool: it emits <intent>
// tokens in free text and the substrate parses them through writeIntent's STVC
// wall (see llm-orchestrator.composeAgentic + faculty.commitParsedIntents).
// These names are excised from the advertised tool array in that mode. Default
// OFF — the native tool-call path stays working until a live wake proves the
// emit path, at which point the flag becomes default and S1/S2 flip to enforced.
const FACULTY_EXCLUDED_TOOLS = new Set([
  'intent_emit',     // commits any action via the universal executor
  'api_call',        // DEPRECATED — bypasses STVC + observation engram
  'browser_session', // DEPRECATED — bypasses STVC
  'email_search',    // DEPRECATED — external read with credential
  'email_open',      // DEPRECATED — external read with credential
]);

function facultyEmitModeOn() {
  return /^(1|on|true|yes)$/i.test(String(process.env.TROTH_FACULTY_EMIT_MODE || ''));
}

function toolsArray(filterNames) {
  const names = Array.isArray(filterNames) && filterNames.length
    ? filterNames
    : Object.keys(REGISTRY);
  const emit = facultyEmitModeOn();
  const out = [];
  for (const n of names) {
    if (emit && FACULTY_EXCLUDED_TOOLS.has(n)) continue;
    const entry = REGISTRY[n];
    if (entry) out.push(entry.schema);
  }
  return out;
}

// Dispatch a single tool_call object as emitted by the model. Returns
// the result payload as a string (so it can be slotted into a 'tool'
// role message back to the model). Unknown tools return an error
// payload rather than throwing — the model sees the error and can
// recover.
async function dispatchToolCall(toolCall, ctx) {
  const name = toolCall && toolCall.function && toolCall.function.name;
  const argsRaw = toolCall && toolCall.function && toolCall.function.arguments;
  let args = {};
  if (typeof argsRaw === 'string') {
    try { args = JSON.parse(argsRaw); } catch (_) { args = {}; }
  } else if (argsRaw && typeof argsRaw === 'object') {
    args = argsRaw;
  }
  const entry = REGISTRY[name];
  if (!entry) return JSON.stringify({ error: 'unknown_tool', name });
  try {
    const result = await entry.run(args, ctx || {});
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: 'tool_exception', name, detail: e && e.message || String(e) });
  }
}

module.exports = {
  REGISTRY,
  toolsArray,
  dispatchToolCall,
  facultyEmitModeOn,
  FACULTY_EXCLUDED_TOOLS
};
