// SPDX-License-Identifier: Apache-2.0
// Shared hook helpers. Keeps each hook script ≤30 lines of logic.
//
// Reads the JSON payload Claude Code pipes in via stdin, exposes a helper
// to emit the correct hookSpecificOutput shape, and wires telemetry into
// the shared state.db. All hook scripts import from here.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

// Resolve shared-core/state.js relative to the plugin root that CC passes in.
// CLAUDE_PLUGIN_ROOT is set for us; we walk one level up to the repo root.
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();

// Stamp plugin version into the env *before* state.js's first markPluginActive
// call so plugin_presence.plugin_version is populated for telemetry. Reading
// the manifest each hook spawn is cheap (sync read of <1 KB), avoids a build
// step, and never breaks the hook on parse failure.
if (!process.env.TROTH_PLUGIN_VERSION) {
  try {
    const manifest = JSON.parse(readFileSync(pluginRoot + '/.claude-plugin/plugin.json', 'utf8'));
    if (manifest && manifest.version) process.env.TROTH_PLUGIN_VERSION = manifest.version;
  } catch { /* manifest absent — leave version unset */ }
}

// Force the plugin to share state.db with the proxy. CC sets
// CLAUDE_PLUGIN_DATA to its per-plugin sandbox (~/.claude/plugins/data/<id>)
// for hook spawns and state.js would honor that — splitting the substrate
// into two disjoint SQLite files. Unified substrate is the whole point.
// Override ONLY when the value looks like CC's sandbox path so test
// harnesses that set their own temp dir keep working.
const ccSandbox = process.env.CLAUDE_PLUGIN_DATA || '';
if (!ccSandbox || ccSandbox.includes('/.claude/plugins/data/')) {
  process.env.CLAUDE_PLUGIN_DATA = join(homedir(), '.troth');
}

// FAIL-OPEN when the native substrate cannot load. state.js pulls in
// better-sqlite3, a compiled dependency — and a plugin installed through the
// Claude Code marketplace is a bare git clone with NO node_modules, so this
// require threw at import time and took every hook in hooks.json down with it:
// 25+ registrations erroring on every tool call, which is the first thing an
// external developer would see. Capture and
// recall are features; the hooks' pass-through behavior (allow / addContext)
// is plumbing. Losing a feature must never break the plumbing — same fail-open
// stance features.js already gets a few lines down. `state` stays null and
// every caller below guards, so a missing build degrades to "no memory this
// session" instead of "every tool call complains".
let state = null, actionRecord = null, workingSet = null, _substrateLoadError = null;
try {
  const statePath = require.resolve(pluginRoot + '/../shared-core/state.js');
  state        = require(statePath);
  actionRecord = require(pluginRoot + '/../shared-core/action-record.js');
  workingSet   = require(pluginRoot + '/../shared-core/working-set.js');
} catch (e) {
  _substrateLoadError = e && e.message ? e.message : String(e);
  // One quiet line, once per process — not one error per tool call.
  process.stderr.write('[troth] substrate unavailable (run npm install in the plugin checkout to enable memory): ' + _substrateLoadError + '\n');
}

// Feature flags — single source of truth (shared-core/features.js):
// env override → ~/.troth/config.json "features" → built-in default (ships ON).
// Hooks gate on this so a fresh install (no shell .zshrc) still gets the
// partner's intelligence ON. Fail-OPEN to the built-in defaults if the module
// can't load, so a packaging glitch never silently re-disables capture.
const FEATURE_FALLBACK = { intent_decisions: true, capture_intent: true, dmn_push: true, topic_shift: true, negative_knowledge: true, decision_capture: false, how_rails: false, fidelity: false };
let _features = null;
try { _features = require(pluginRoot + '/../shared-core/features.js'); } catch { _features = null; }
export function featureEnabled(name) {
  try { if (_features && typeof _features.isEnabled === 'function') return _features.isEnabled(name); } catch { /* fall through */ }
  return !!FEATURE_FALLBACK[name];
}

// Step 4 — types that are meaningful to page via Layer 5.
// Reads, edits, and searches are content-bearing: the agent may want to
// refer back to them across many turns. Decisions are cheap and spammy
// (every hook writes several per turn) — excluding them keeps the
// working-set focused on what actually needs paging.
const PAGED_TYPES = new Set(['read', 'edit', 'search', 'tool_call']);

// Module-local stash so recordAction() can pick up tool_use_id from the
// hook's payload without every hook having to pass it explicitly. Set by
// readStdinJson(); cleared only if a hook deliberately overwrites.
let _lastPayload = null;
export function _currentPayload() { return _lastPayload; }

export async function readStdinJson() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  if (!data.trim()) { _lastPayload = {}; return {}; }
  try { _lastPayload = JSON.parse(data); return _lastPayload; }
  catch { _lastPayload = { _raw: data }; return _lastPayload; }
}

export function emit(output) {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

export function allow() { emit({}); }

export function block(reason) {
  // hookEventName MUST equal the dispatched event (e.g. 'PreToolUse'). The old
  // hardcoded 'Response' fails Claude Code's schema → "Hook JSON output
  // validation failed — (root): Invalid input", so the DENY is dropped and the
  // model keeps retrying the blocked write (this is exactly why memory-md-guard
  // appeared to "error" while the model kept trying to write Claude memory).
  // Mirror addContext(): read the live event from the stdin payload.
  emit({
    hookSpecificOutput: {
      hookEventName: (_lastPayload && _lastPayload.hook_event_name) || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  });
}

export function ask(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: (_lastPayload && _lastPayload.hook_event_name) || 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason
    }
  });
}

export function addContext(text) {
  // Auto-detect the active hook event from the stdin payload so the
  // response's `hookEventName` matches the event Claude Code dispatched.
  // Hardcoding 'UserPromptSubmit' breaks PostToolUse callers (e.g.
  // post-action-recall.mjs) — CC rejects with "expected 'PostToolUse'
  // but got 'UserPromptSubmit'" and drops the additionalContext.
  const eventName = (_lastPayload && _lastPayload.hook_event_name)
    || 'UserPromptSubmit';
  emit({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text
    }
  });
}

export function log(event, fields = {}) {
  if (!state) return; // substrate unavailable — telemetry is a feature, not plumbing
  try {
    state.recordHookEvent({ event, ...fields });
  } catch (e) {
    // Never let telemetry failure break the hook.
    process.stderr.write('[troth hook telemetry] ' + e.message + '\n');
  }
}

// Per-session chain tracker. Populates parent_id on
// ActionRecord writes so causality.traceCausalChain returns a real graph.
//
// Shape stored at $CLAUDE_PLUGIN_DATA/chains/<session_id>.json:
//   { turn_root_id: <action id>, tool_heads: { <tool_use_id>: <action id> } }
//
// Rules:
//   - injector.mjs writes with chain_role:'root' → resets turn_root_id,
//     clears tool_heads. Becomes the parent of every hook action until the
//     next root.
//   - PreToolUse hooks pass args.tool_use_id. First write for a given
//     tool_use_id takes turn_root_id as parent; subsequent writes for the
//     same tool_use_id take the previous head as parent (linear chain per
//     tool invocation).
//   - PostToolUse hooks (mark-read, mark-edit, errortax) also pass
//     tool_use_id. Parent = latest head for that id, which is whichever
//     PreToolUse hook ran last, or the root if none did.
//   - Stop.critic has no tool_use_id → inherits turn_root_id.
//
// Writes are atomic via write-then-rename. Hooks within one Claude Code
// turn run sequentially, so race conditions are not expected, but the
// atomic swap is cheap insurance.

function chainDir() {
  const root = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.troth');
  const dir = join(root, 'chains');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function chainPath(session_id) { return join(chainDir(), session_id + '.json'); }

export function readChain(session_id) {
  if (!session_id) return { turn_root_id: null, tool_heads: {} };
  try { return JSON.parse(readFileSync(chainPath(session_id), 'utf8')); }
  catch { return { turn_root_id: null, tool_heads: {} }; }
}

export function writeChain(session_id, obj) {
  if (!session_id) return;
  const p = chainPath(session_id);
  const tmp = p + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, p);
  } catch (e) {
    process.stderr.write('[troth chain] ' + e.message + '\n');
  }
}

// Write a structured ActionRecord to the substrate. Used by the hook
// migration; Step 2 adds automatic parent_id population via the chain
// tracker. Signature mirrors action-record.create() with three extras:
//   - agent_id defaults to 'claude-code'.
//   - tool_use_id: optional, scopes this write to a specific tool
//     invocation so PostToolUse links back to its PreToolUse chain.
//   - chain_role: 'root' marks the injector's write as the new turn root.
// Returns the id or null on failure; failures are logged but never thrown.
export function recordAction(args) {
  if (!state || !actionRecord) return null; // substrate unavailable — degrade quietly
  try {
    const sess = args.session_id || null;
    // Auto-derive tool_use_id from the current stdin payload so callers
    // don't have to thread it through every recordAction site.
    const toolUseId = args.tool_use_id
      || (_lastPayload && (_lastPayload.tool_use_id || null));
    let parent = args.parent_id || null;
    let chain = null;
    if (sess && !parent) {
      chain = readChain(sess);
      if (toolUseId && chain.tool_heads && chain.tool_heads[toolUseId]) {
        parent = chain.tool_heads[toolUseId];
      } else if (chain.turn_root_id) {
        parent = chain.turn_root_id;
      }
    }

    const rec = actionRecord.create({
      agent_id: args.agent_id || 'claude-code',
      session_id: sess,
      user_id: args.user_id || null,
      cwd: args.cwd || null,
      type: args.type,
      parent_id: parent,
      context_hash: args.context_hash || null,
      input: args.input || {},
      output: args.output || {},
      verification: args.verification || {},
      outcome: args.outcome || {}
    });
    const v = actionRecord.validate(rec);
    if (!v.ok) {
      process.stderr.write('[troth action invalid] ' + JSON.stringify(v.errors) + '\n');
      return null;
    }
    const id = state.recordAction(rec, actionRecord.toSearchText(rec));

    // Update the chain tracker so the NEXT hook in this turn can find its
    // parent. Only touch the file when we actually need to write.
    if (sess && id) {
      if (chain === null) chain = readChain(sess);
      let dirty = false;
      if (args.chain_role === 'root') {
        chain.turn_root_id = id;
        chain.tool_heads = {};
        dirty = true;
      }
      if (toolUseId) {
        if (!chain.tool_heads) chain.tool_heads = {};
        chain.tool_heads[toolUseId] = id;
        dirty = true;
      }
      if (dirty) writeChain(sess, chain);
    }

    // Step 4: load content-bearing records into the working-set so
    // PreCompact has a real manifest to page. Without this, the
    // working-set is always empty in production and Layer 5 is dead.
    if (sess && id && PAGED_TYPES.has(args.type)) {
      try {
        if (!workingSet.getSession(sess)) {
          workingSet.openSession(state, {
            session_id: sess,
            agent_id: args.agent_id || 'claude-code',
            cwd: args.cwd || null
          });
        }
        workingSet.load(state, sess, id);
      } catch (e) {
        // Never fail a hook on working-set trouble.
        process.stderr.write('[troth ws load] ' + e.message + '\n');
      }
    }
    return id;
  } catch (e) {
    process.stderr.write('[troth action telemetry] ' + e.message + '\n');
    return null;
  }
}

export { state, actionRecord };
