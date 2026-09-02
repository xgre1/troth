// SPDX-License-Identifier: AGPL-3.0-only
// permission — policy gate for the unified tool_runner.
//
// Mode A runs without a user-in-the-loop prompt (voice app, CI, headless
// workers). The model can call any tool the runner exposes — but
// arbitrary Bash and Write should NOT just fire silently in production.
// This module wraps an existing tool_runner with a policy classifier:
//
//   READ-ONLY tools (Read, Grep, Glob, mcp_list, mcp_describe,
//   substrate engram_search / dialogue_recent / chameleon_query):
//     → ALWAYS allowed
//
//   WRITE / EXECUTE tools (Write, Edit, Bash, mcp_call,
//   engram_record):
//     → allowed only when one of:
//       (a) env TROTH_ENTITY_AUTO_WRITE === '1' (operator opt-in,
//           e.g. trusted CI pipeline)
//       (b) ctx.auto_write === true (per-session opt-in from the
//           wrapper that knows the call context — voice with the
//           safety toggle on, etc.)
//     Otherwise → return a structured `requires_confirmation` payload
//     so the model surfaces the proposed action to the user / caller
//     instead of executing.
//
// This is deliberately COARSE — every tool is one of two buckets. A
// future revision can plug substrate's drift-detector / risk classifier
// in here for per-call risk scoring (block secrets in Write content,
// quarantine `rm -rf` in Bash, etc.). v1 keeps the surface small so
// the policy is auditable.

const READ_ONLY = new Set([
  // Worldly read-only.
  'Read', 'Grep', 'Glob',
  // Web research (CDP browser, GET-only, no side effects) — always allowed.
  'web_search', 'web_fetch',
  // MCP introspection (no side effects).
  'mcp_list', 'mcp_describe',
  // MCP staging. mcp_register_request
  // writes ONLY the inert pending file (~/.troth/mcp-pending.json); the resolver
  // never reads it, so a staged entry can never resolve for mcp_list/mcp_call.
  // The security boundary is the OPERATOR APPROVAL (troth mcp approve / the app
  // popup), which alone moves the entry into the active registry and seals
  // capability:mcp:<name>. Staging must therefore work in an ordinary chat turn
  // (the partner stages a config the operator just pasted) WITHOUT requiring the
  // operator to flip a global auto-write flag first; that would defeat the
  // whole conversational-registration UX. See shared-core/tools/mcp-client.js
  // (staged-registration header) + suite-18 MCPH-9..12 for the inertness proof.
  'mcp_register_request',
  // Substrate read-only (engram & dialogue queries don't mutate L1).
  'engram_search', 'dialogue_recent',
  'chameleon_query', 'chameleon_list_scopes'
]);

// Tools that need explicit auto-write to fire. Anything not in
// READ_ONLY and not in this set is treated as write-by-default for
// safety — a future tool added without classification still gates.
const WRITE_OR_EXEC = new Set([
  'Write', 'Edit', 'Bash', 'mcp_call', 'engram_record',
  // image_generate WRITES a PNG to ~/.troth/images and does network egress to
  // chatgpt.com — not read-only. Classified WRITE so it gates behind auto-write
  // like any other side-effecting tool (rather than riding the unknown default).
  'image_generate',
  // vault_capture stores a credential: a write, gated like any other.
  'vault_capture'
]);

function classify(toolName) {
  if (READ_ONLY.has(toolName))    return 'read';
  if (WRITE_OR_EXEC.has(toolName)) return 'write';
  return 'unknown';   // default-deny for unclassified tools
}

function wrapRunner(innerRunner, policyOpts) {
  policyOpts = policyOpts || {};
  const allowEnv = process.env.TROTH_ENTITY_AUTO_WRITE === '1';
  return async function gatedRunner(toolCall, ctx) {
    const name = toolCall && toolCall.function && toolCall.function.name;
    const kind = classify(name);

    // L4 Wall 2 — capability scope at the tool boundary.
    //
    // Step-engine spawns each step's worker with ctx.allowed_tools set
    // from step_definitions.allowed_tools (the operator-curated set per
    // class step — e.g. `understand` step gets [Read, Grep, Glob],
    // `verify` step gets [Read, Grep, Bash]). When the worker — under
    // prompt injection or model hallucination — proposes a tool outside
    // its scope, this gate rejects pre-execution. Without this layer
    // capability scope is hint-only; with it the worker structurally
    // cannot escape its role.
    //
    // ctx.allowed_tools:    array | null — when array, restrict; when
    //                       null/undefined, no allowlist (default).
    // ctx.forbidden_tools:  array | null — when array, deny these
    //                       regardless of allowlist (compose-friendly:
    //                       worker can inherit a broad allowlist + a
    //                       specific deny).
    //
    // Returned error is structured so the model surfaces the rejection
    // instead of failing silently.
    if (ctx) {
      if (Array.isArray(ctx.forbidden_tools) && ctx.forbidden_tools.indexOf(name) >= 0) {
        return JSON.stringify({
          error: 'capability_scope_violation',
          tool:  name,
          reason: 'tool_in_forbidden_set',
          forbidden_tools: ctx.forbidden_tools,
          hint:  'This tool is explicitly forbidden for the current worker scope. Pick a different approach.'
        });
      }
      if (Array.isArray(ctx.allowed_tools) && ctx.allowed_tools.indexOf(name) < 0) {
        return JSON.stringify({
          error: 'capability_scope_violation',
          tool:  name,
          reason: 'tool_outside_allowed_set',
          allowed_tools: ctx.allowed_tools,
          hint:  'Worker is capability-scoped — only tools in allowed_tools may fire. Pick one of the allowed tools or escalate the step boundary to the coordinator.'
        });
      }
    }

    // subsystem — Write/Edit destination policy. System-critical paths
    // (/etc/, /usr/, ~/.ssh/, ~/.troth/credentials.json, shell rc files,
    // launchd plists, etc.) are refused regardless of capability scope.
    // Audience-chain trip-wire also forbids any write once external
    // content is in the loop. The escape hatch is operator_request
    // {kind:approval} naming the exact write target.
    if (name === 'Write' || name === 'Edit') {
      let pathArgs = {};
      const pRaw = toolCall && toolCall.function && toolCall.function.arguments;
      if (typeof pRaw === 'string') { try { pathArgs = JSON.parse(pRaw); } catch (_) {} }
      else if (pRaw && typeof pRaw === 'object') { pathArgs = pRaw; }
      const targetPath = pathArgs.file_path || pathArgs.path || pathArgs.filePath;
      if (typeof targetPath === 'string' && targetPath.length) {
        try {
          const policy = require('./path-policy.js');
          const verdict = policy.isWritablePath(targetPath, ctx);
          if (!verdict.allowed) {
            // When the pane has NO real workspace (cwd is the operator's
            // HOME), a relative write like ".env.local" resolves to
            // ~/.env.local and trips the shell-init rule; the old hint said
            // "write inside the cwd", which IS home — a dead end the model
            // retried into a loop. Say the
            // actual fix: this pane needs a project workspace.
            const os0 = require('os');
            const cwdIsHome = !ctx || !ctx.cwd || require('path').resolve(String(ctx.cwd)) === os0.homedir();
            return JSON.stringify({
              error:   'path_policy_refusal',
              tool:    name,
              reason:  verdict.reason,
              pattern: verdict.pattern || null,
              path:    verdict.path || targetPath,
              detail:  verdict.detail || null,
              hint:    cwdIsHome
                ? 'This pane has no project workspace (cwd is the home directory), so relative paths land on protected home files. STOP retrying: tell the operator to open the project folder as this pane\'s workspace, then write there.'
                : 'Pivot to a write target inside the operator project cwd, or escalate via operator_request{kind:approval, detail:{plan:"write ' + name + ' to ' + targetPath + ' because Y"}}. Do not retry the same path.'
            });
          }
        } catch (e) {
          // A gate that disappears when it errors is not a gate. Whatever
          // went wrong (module missing, bad ctx, unreadable path), refusing
          // costs the model one retry; allowing costs the operator a file
          // they never agreed to.
          return JSON.stringify({
            error:  'path_policy_unavailable',
            tool:   name,
            reason: 'policy_evaluation_failed',
            detail: String(e && e.message || e),
            hint:   'The write-destination policy could not be evaluated, so the write was refused. Retry once; if it persists, tell the operator.'
          });
        }
      }
    }

    // Read-side wall for the DIRECT tools. The shell road was already
    // gated (bash-safety extracts paths from the command and consults
    // isReadablePath), but Read/Grep/Glob called AS TOOLS bypassed the
    // read policy entirely — the exact hole behind the field report of an
    // engine grepping the substrate DB raw. A raw read of the DB bypasses
    // every audience filter the substrate enforces; the sanctioned road to
    // memory is the substrate's own tools, and the wall says so.
    if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      let rArgs = {};
      const rRaw = toolCall && toolCall.function && toolCall.function.arguments;
      if (typeof rRaw === 'string') { try { rArgs = JSON.parse(rRaw); } catch (_) {} }
      else if (rRaw && typeof rRaw === 'object') { rArgs = rRaw; }
      const rTarget = rArgs.file_path || rArgs.path || null;
      if (typeof rTarget === 'string' && rTarget.length) {
        try {
          const policy = require('./path-policy.js');
          const os1 = require('os');
          const p1  = require('path');
          const _abs = p1.resolve(String(rTarget).replace(/^~(?=$|\/)/, os1.homedir()));
          const trothRoot = p1.join(os1.homedir(), '.troth');
          // Exact-target check first (resolves symlinks inside the policy);
          // then the ancestor case: pointing Grep/Glob AT ~/.troth (or any
          // directory inside it) sweeps the DB and credential stores into
          // the scan — refused as a unit, with the honest road named.
          const verdict = policy.isReadablePath(_abs, ctx);
          const insideTroth = _abs === trothRoot || _abs.indexOf(trothRoot + p1.sep) === 0;
          const dirSweep = insideTroth && name !== 'Read' && verdict.allowed;
          if (!verdict.allowed || dirSweep) {
            return JSON.stringify({
              error:   'path_policy_refusal',
              tool:    name,
              reason:  verdict.allowed ? 'blocked_secret_read' : verdict.reason,
              pattern: verdict.pattern || (dirSweep ? 'substrate_home' : null),
              path:    verdict.path || _abs,
              detail:  verdict.detail || (dirSweep ? 'the directory holds the substrate database and credential stores' : null),
              hint:    'The substrate\'s contents are served through its own tools (troth_recall, engram/dialogue surfaces) with audience filtering — raw file access bypasses every policy. Do not retry this path.'
            });
          }
        } catch (e) {
          // Same stance as the write gate: a gate that disappears when it
          // errors is not a gate.
          return JSON.stringify({
            error:  'path_policy_unavailable',
            tool:   name,
            reason: 'policy_evaluation_failed',
            detail: String(e && e.message || e),
            hint:   'The read-path policy could not be evaluated, so the read was refused. Retry once; if it persists, tell the operator.'
          });
        }
      }
    }

    // subsystem — Bash safety gate. Two layers:
    // (1) refuse dangerous shell shapes (rm -rf /, curl|sh, dd of=/dev/sdX,
    //     etc.) deterministically, BEFORE the command reaches the shell;
    // (2) refuse all Bash when external content was already seen this
    //     agentic turn (subsystem sticky flag _l4_external_seen). The model
    //     can pivot to Read/Grep/Glob or escalate via operator_request.
    if (name === 'Bash') {
      let bashArgs = {};
      const aRaw = toolCall && toolCall.function && toolCall.function.arguments;
      if (typeof aRaw === 'string') { try { bashArgs = JSON.parse(aRaw); } catch (_) {} }
      else if (aRaw && typeof aRaw === 'object') { bashArgs = aRaw; }
      try {
        const safety = require('./bash-safety.js');
        const verdict = safety.isCommandSafe(bashArgs.command, ctx);
        if (!verdict.allowed) {
          return JSON.stringify({
            error: 'bash_safety_refusal',
            tool:  'Bash',
            reason: verdict.reason,
            pattern: verdict.pattern || null,
            detail: verdict.detail || null,
            hint:  'Pivot to read-only inspection, or escalate via operator_request{kind:approval, detail:{plan:"..."}} if the operator should explicitly authorize this exact command.'
          });
        }
      } catch (e) {
        // Same rule as the write policy above: if the dangerous-shape check
        // cannot run, the command does not run either.
        return JSON.stringify({
          error:  'bash_safety_unavailable',
          tool:   'Bash',
          reason: 'safety_evaluation_failed',
          detail: String(e && e.message || e),
          hint:   'The command-safety check could not be evaluated, so the command was refused.'
        });
      }
    }

    // B1 — Wall 1 RPL refusal evaluator. the design work
    // (Wall 1 substrate-enforced refusals) + the design (Refusal Predicate
    // Language). v1 SHIPS pattern kind only; tool_class + semantic are
    // returned as unevaluated_kinds for audit (no silent pass). Combining
    // algorithm: deny-overrides (XACML 3.0). Fail-closed: evaluator load
    // failure → block (Wall 1 integrity > convenience, per
    // the fail-closed rule).
    //
    // ctx.active_refusals is populated by the coordinator per turn —
    // single substrate query loads commitment_type='refusal' rows once.
    // When ctx has no active_refusals, the gate is no-op (empty list).
    if (ctx && Array.isArray(ctx.active_refusals) && ctx.active_refusals.length) {
      let evaluator = null;
      try { evaluator = require('./refusal-evaluator.js'); }
      catch (e) {
        // Fail-closed: refusal evaluator absent but refusals exist =
        // structural Wall 1 failure. Refuse rather than silently bypass.
        return JSON.stringify({
          error: 'wall1_evaluator_missing',
          tool:  name,
          reason: 'refusal_evaluator_load_failed',
          detail: String(e && e.message || e),
          hint:  'Substrate Wall 1 cannot enforce refusals — refusing fail-closed. Restore shared-core/tools/refusal-evaluator.js.'
        });
      }
      const verdict = evaluator.evaluate(toolCall, ctx.active_refusals);
      if (verdict.decision !== 'proceed') {
        const matched = verdict.matched || {};
        const predicate = matched.predicate || {};
        const baseHint = 'Wall 1 substrate refusal matched. Pivot to a different approach or escalate via operator_request{kind:approval, detail:{plan:"...", reason:"' + (matched.reason || 'refusal') + '"}}.';
        const reviseHint = ' Revise: ' + (predicate.revise_hint || matched.reason || '');
        return JSON.stringify({
          error: 'refusal_predicate_match',
          tool:  name,
          action: verdict.decision,
          predicate_id:   matched.id,
          predicate_kind: predicate.kind,
          reason: matched.reason,
          unevaluated_kinds: verdict.unevaluated_kinds,
          hint:  verdict.decision === 'reject_and_revise' ? baseHint + reviseHint : baseHint
        });
      }
    }

    if (kind === 'read') return innerRunner(toolCall, ctx);

    // Write / unknown — require explicit auto-write.
    const allowCtx = !!(ctx && ctx.auto_write);
    if (allowEnv || allowCtx) return innerRunner(toolCall, ctx);

    // Block. Surface as a structured payload so the model can pivot.
    let argsParsed = {};
    const argsRaw = toolCall && toolCall.function && toolCall.function.arguments;
    if (typeof argsRaw === 'string') {
      try { argsParsed = JSON.parse(argsRaw); } catch (_) {}
    } else if (argsRaw && typeof argsRaw === 'object') {
      argsParsed = argsRaw;
    }
    return JSON.stringify({
      error: 'requires_confirmation',
      tool:  name,
      kind,
      args:  argsParsed,
      hint:  'Set ctx.auto_write=true (per-call) or env TROTH_ENTITY_AUTO_WRITE=1 (operator) to allow this class of tool. Until then, propose the action to the user instead of executing.'
    });
  };
}

module.exports = {
  classify,
  wrapRunner,
  READ_ONLY,
  WRITE_OR_EXEC
};
