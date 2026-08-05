#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// PostToolUse hook for Bash — emits a `type='tool_call'` ActionRecord per
// invocation so the substrate carries the third type promised by the
// GMP v0.1 type registry. Without this the canonical store sees Edit,
// Read, Search, Decision but not the Bash actions every coding session
// generates dozens of, leaving Layer-1 coverage stuck around 60%.
//
// Kept tiny on purpose: the cache-populate hook handles bash output
// archival (large stdout into tool_output_archive); we record only the
// semantic action here. Errors come through errortax.mjs separately.

import { readStdinJson, allow, log, recordAction } from './_lib.mjs';

const payload  = await readStdinJson();
const tool     = payload.tool_name || '';
if (tool !== 'Bash') { allow(); }

const input    = payload.tool_input || {};
const response = payload.tool_response || {};
const session  = payload.session_id || null;
if (!session) { allow(); }

// Status from CC's tool_response shape:
//   - is_error / isError → 'error'
//   - exit_code present → 'ok' (0) or 'nonzero' (>0)
//   - else → 'ok'
const isError = response.is_error === true || response.isError === true;
const exitCode = typeof response.exit_code === 'number' ? response.exit_code
              : (typeof response.exitCode === 'number' ? response.exitCode : null);
const status =
  isError                       ? 'error'
  : exitCode !== null && exitCode !== 0 ? 'nonzero'
  : 'ok';

// Compute output bytes if available so consumers can spot heavy commands.
let bytes = null;
if (typeof response.content === 'string') bytes = Buffer.byteLength(response.content);
else if (typeof response.output === 'string') bytes = Buffer.byteLength(response.output);
else if (Array.isArray(response.content)) {
  bytes = response.content.reduce((n, c) =>
    n + Buffer.byteLength(typeof c === 'string' ? c : (c && (c.text || c.content) || '')), 0);
}

log('PostToolUse.markbash', {
  session_id: session, tool: 'Bash',
  metadata: { status, exit_code: exitCode, bytes }
});

recordAction({
  type: 'tool_call',
  session_id: session,
  cwd: payload.cwd,
  input: {
    tool_name: 'Bash',
    args: { command: typeof input.command === 'string' ? input.command.slice(0, 500) : null }
  },
  output: { status, exit_code: exitCode, bytes }
});

allow();
