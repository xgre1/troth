#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Stamps a file as "read in this session" whenever Read/Grep/Glob succeeds.
// VerifyFirst reads this log to decide whether an Edit/Write is grounded.
//
// We record BOTH the raw path the agent supplied and the absolute-resolved
// form so VerifyFirst can look up either. That avoids a whole category of
// false positives where the read was logged as `src/foo.js` but the Write
// comes in as `/Users/.../src/foo.js`.

import { resolve } from 'node:path';
import { readStdinJson, allow, log, state, recordAction } from './_lib.mjs';

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const session = payload.session_id;
if (!session) { allow(); }

// Grep/Glob don't always carry file_path; fall back to pattern/path fields.
const candidates = new Set();
for (const field of ['file_path', 'notebook_path', 'path']) {
  if (input[field]) candidates.add(input[field]);
}
// Glob results travel in the tool_response → stamp whatever was actually read.
const response = payload.tool_response || {};
if (Array.isArray(response.files)) for (const f of response.files) candidates.add(f);

for (const p of candidates) {
  try {
    state.markFileRead(session, p);
    state.markFileRead(session, resolve(p));
  } catch {}
}

log('PostToolUse.markread', {
  session_id: session, tool,
  metadata: { paths: [...candidates] }
});

// Write an ActionRecord per observable action. The substrate
// becomes the canonical "has this been read/searched?" source.
//
// Branch by tool — until  this hook always wrote type='read'
// regardless of tool, leaving the substrate without `type='search'`
// records and breaking Layer-1 protocol coverage. Now Grep/Glob produce
// proper search records carrying the query string + result count, so
// any consumer (atlas export, GMP client, conformance test A) sees
// the full type vocabulary.
const isSearch = /^(Grep|Glob)$/.test(tool);
if (isSearch) {
  // Grep/Glob: a single semantic action even when matches span many files.
  recordAction({
    type: 'search',
    session_id: session,
    cwd: payload.cwd,
    input: {
      query: input.pattern || input.query || '',
      kind:  tool === 'Grep' ? 'grep' : 'glob',
      scope: input.path || input.glob || null
    },
    output: {
      result_count: Array.isArray(response.files) ? response.files.length
                    : (typeof response.numFiles === 'number' ? response.numFiles : 0),
      result_paths: Array.isArray(response.files) ? response.files.slice(0, 50) : undefined
    }
  });
} else {
  for (const p of candidates) {
    recordAction({
      type: 'read',
      session_id: session,
      cwd: payload.cwd,
      input: { file_path: p },
      output: {
        hash: 'unverified',                       // mark-read doesn't hash content; readers that need hash call hashline_read
        line_count: (response.line_count || null),
        bytes: (response.bytes || null)
      }
    });
  }
}
allow();
