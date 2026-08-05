#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// VerifyFirst — blocks Edit/Write/MultiEdit/NotebookEdit on a file the agent
// hasn't actually read in this session. Kills a whole class of speculative
// edits where the model guesses file contents and writes something wrong.
//
//   target doesn't exist on disk → allow (new file; nothing to verify)
//   target exists + was read     → allow
//   target exists + not read     → ask with reason
//
// Paired with mark-read.mjs which stamps reads into state.verifyfirst_reads.
// Research: AttnRoute (Building Efficient LLM Proxy Architectures §1.3).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readStdinJson, allow, ask, log, state, recordAction } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const query = require(pluginRoot + '/../shared-core/query.js');

const payload = await readStdinJson();
const session = payload.session_id || 'unknown';
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};

// Handle the various tool-input shapes uniformly.
const target = input.file_path || input.notebook_path || input.path || null;

if (!session || !target) { allow(); }

// Resolve against CWD so relative paths match the read log canonically.
const abs = resolve(target);

// New file (no existing content to verify) → let the write proceed.
if (!existsSync(abs)) {
  log('PreToolUse.verifyfirst', {
    session_id: session, tool, decision: 'allow', reason: 'new_file',
    metadata: { path: abs }
  });
  recordAction({
    type: 'decision',
    session_id: session, cwd: payload.cwd,
    input: { kind: 'verifyfirst', tool, path: abs },
    output: { decision: 'allow', reason: 'new_file' }
  });
  allow();
}

// Primary source of truth is the substrate (query.hasBeenRead).
// Legacy state.wasFileRead kept as fallback while hook_events + verifyfirst_reads
// continue to be populated in parallel. If substrate says yes, trust it.
// If substrate says no, check legacy one more time before blocking.
const readInSubstrate =
  query.hasBeenRead(state, { file_path: abs, session_id: session }) ||
  query.hasBeenRead(state, { file_path: target, session_id: session });
const readInLegacy = state.wasFileRead(session, abs) || state.wasFileRead(session, target);
const wasRead = readInSubstrate || readInLegacy;

if (wasRead) {
  log('PreToolUse.verifyfirst', {
    session_id: session, tool, decision: 'allow', reason: 'read_ok',
    metadata: { path: abs }
  });
  recordAction({
    type: 'decision',
    session_id: session, cwd: payload.cwd,
    input: {
      kind: 'verifyfirst', tool, path: abs,
      source: readInSubstrate ? 'substrate' : 'legacy'
    },
    output: { decision: 'allow', reason: 'read_ok' }
  });
  allow();
}

log('PreToolUse.verifyfirst', {
  session_id: session, tool, decision: 'ask', reason: 'unread_edit',
  metadata: { path: abs }
});
state.recordSavings('verifyfirst_blocked', 1, session, 'blocked ' + tool + ' on unread ' + abs);
recordAction({
  type: 'decision',
  session_id: session, cwd: payload.cwd,
  input: { kind: 'verifyfirst', tool, path: abs },
  output: { decision: 'ask', reason: 'unread_edit' }
});
ask(
  'File not read in this session: ' + abs + '\n' +
  'Read the file first so the ' + tool + ' call is grounded in its actual contents, ' +
  'not a guess. (Disable this guard by uninstalling the troth plugin if you prefer speculative edits.)'
);
