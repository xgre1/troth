#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// PostToolUse — populate the troth semantic tool cache from real results.
//
// Fires after Read / Grep / Glob / Bash complete. We have two populate
// paths: (a) proxy-side history scan in proxy/server.js, (b) this hook.
// The hook is higher fidelity — it sees the tool_response at the moment
// of execution, can skip errors cleanly, and works for users running the
// plugin without the proxy.
//
// We do NOT cache Edit / Write / MultiEdit / NotebookEdit (stateful) nor
// side-effecting Bash. The cache module's isCacheable() enforces this.

import { createRequire } from 'node:module';
import { readStdinJson, allow, log } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let gc; // fail-open: bare marketplace clone has no node_modules
try { gc = require(pluginRoot + '/../proxy/modules/troth-cache.js'); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const tool     = payload.tool_name || '';
const input    = payload.tool_input || {};
const response = payload.tool_response;
const cwd      = payload.cwd || process.cwd();

if (!tool || !response) { allow(); }

// Skip if the tool is uncacheable by policy, or if response signalled error.
if (!gc.isCacheable(tool, input)) { allow(); }

// Claude Code shapes tool_response as either a string or an object with
// error/content fields depending on tool. Error signals we can see:
const isError =
  response === null ||
  (typeof response === 'object' && response !== null &&
    (response.is_error === true || response.error || response.errorMessage));
if (isError) { allow(); }

try {
  const cache = gc.getDefault();
  const paths = gc.referencedFiles(tool, input, cwd);
  const file_hashes = gc.hashReferencedFiles(paths);
  // If any referenced file is unreadable, skip: a null hash would poison
  // the cache key (we'd key against ghost content).
  if (file_hashes.some(h => h === null)) { allow(); }

  const key = gc.computeKey({ tool_name: tool, args: input, cwd, file_hashes });
  const ok = cache.store({ key, tool_name: tool, cwd, value: response });
  if (ok) {
    log('PostToolUse.cachePopulate', {
      session_id: payload.session_id || null,
      tool,
      metadata: { key_prefix: key.slice(0, 8), file_count: paths.length }
    });
  }
} catch (e) {
  // Cache failures must never break the tool's postcondition. Log to stderr
  // for forensics and let Claude Code proceed as if the hook didn't exist.
  process.stderr.write('[troth cache-populate] ' + (e.message || e) + '\n');
}

allow();
