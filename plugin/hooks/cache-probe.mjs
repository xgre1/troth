#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// PreToolUse — soft-serve cached tool results via additionalContext.
//
// Claude Code's PreToolUse hook contract (verified against docs) does NOT
// allow supplying a synthetic tool_response that replaces actual tool
// execution. Available levers are allow/deny/ask/defer, updatedInput, and
// additionalContext.
//
// So this hook does the next best thing: if we have a cache entry that
// matches (same tool + args + cwd + current file-content hashes), we
// inject the cached content into Claude's context and allow the tool to
// proceed. In many cases — especially Read of a file the agent just read
// a turn ago — the model pulls from context and its response doesn't
// re-reference the tool output, so the full tool_result never needs to
// flow back to the backend.
//
// This is NOT a hard short-circuit. It's a latency/token-saving hint that
// works well for truly-idempotent retrievals and degrades to a no-op when
// the cache is cold.

import { createRequire } from 'node:module';
import { readStdinJson, allow, emit, log } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let gc; // fail-open: bare marketplace clone has no node_modules
try { gc = require(pluginRoot + '/../proxy/modules/troth-cache.js'); } catch (_) { console.log('{}'); process.exit(0); }
// Don't try to inline huge blobs — there's a point where sending them as
// context is more expensive than just running the tool. Tune by
// experiment; 8 KB covers most source files and Grep outputs.
const MAX_INLINE_BYTES = 8 * 1024;

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const cwd     = payload.cwd || process.cwd();

if (!tool || !gc.isCacheable(tool, input)) { allow(); }

// P0.4 — opt-in hint injection. The cache hint is only useful when CC
// permissions are enforcing (deny on Read/Grep/Glob → model has to use
// cached_*). In yolo mode (`--dangerously-skip-permissions`) the deny
// rule is bypassed, the model ignores the hint, and the hint becomes
// pure waste (~700 chars duplicated by the actual tool call). Default
// off; opt in via `TROTH_CACHE_PROBE_HINTS=1` for non-yolo workflows.
if (process.env.TROTH_CACHE_PROBE_HINTS !== '1') { allow(); }

try {
  const cache = gc.getDefault();
  const paths = gc.referencedFiles(tool, input, cwd);
  const file_hashes = gc.hashReferencedFiles(paths);
  if (file_hashes.some(h => h === null)) { allow(); }

  const r = cache.lookup({ tool_name: tool, args: input, cwd, file_hashes });
  if (!r.hit) { allow(); }

  // Serialise the cached value for the context block. Keep it compact.
  let payloadText = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
  const size = Buffer.byteLength(payloadText, 'utf8');
  if (size > MAX_INLINE_BYTES) { allow(); }

  log('PreToolUse.cacheProbe', {
    session_id: payload.session_id || null,
    tool,
    decision: 'soft_serve',
    metadata: { key_prefix: r.key.slice(0, 8), bytes: size }
  });

  const note =
    '[troth/cache] A verified-fresh cached result for this exact ' + tool +
    ' call is available (file hashes match current disk state). You can ' +
    'reference it directly instead of waiting for the tool to re-read.\n\n' +
    'Cached ' + tool + ' output:\n' + payloadText;

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: note,
    },
  });
} catch (e) {
  process.stderr.write('[troth cache-probe] ' + (e.message || e) + '\n');
  allow();
}
