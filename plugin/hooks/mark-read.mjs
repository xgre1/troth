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
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
import { readStdinJson, allow, log, state, recordAction } from './_lib.mjs';

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const session = payload.session_id;
if (!session) { allow(); }

// WebFetch — a page the partner read. It has no path and no durable source, so
// the body itself is queued (the only kind for which that is true: re-fetching
// later gets different bytes, a paywall, or nothing).
//
// Marked 'external' downstream, never hidden: recall's audience filter is an
// exact match, so tagging a page as untrusted would delete it from every
// answer. It comes back, and it says where it came from.
//
// Measured 2026-08-11: WebFetch had 0 records in the entire substrate because
// no hook matched it. Five months of arXiv, DeepMind and Google Ads reading
// left nothing behind but a summary sentence, truncated at 8,000 chars.
if (tool === 'WebFetch') {
  try {
    const url = String(input.url || input.prompt_url || '').trim();
    const resp = payload.tool_response;
    let body = '';
    if (typeof resp === 'string') body = resp;
    else if (resp && typeof resp === 'object') {
      body = String(resp.result || resp.content || resp.text || '');
      if (!body && Array.isArray(resp.content)) {
        body = resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
      }
    }
    if (url && body.trim().length >= 400) {
      const { createHash } = await import('node:crypto');
      const sha = createHash('sha256').update(url + '\n' + body).digest('hex').slice(0, 32);
      state.spoolKnowledge({ kind: 'web', ref: url, sha, bytes: body.length, payload: body, why: null });
    }
  } catch (_) { /* a fetch must never fail because we wanted to keep it */ }
}

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

  // KNOWLEDGE SPOOL — the second entry point, and it exists because the first
  // one does not see this session.
  //
  // The proxy queues documents when it walks tool_results, which covers the
  // app, the CLI and voice. It does NOT cover Claude Code launched directly:
  // `bin/troth.js` sets ANTHROPIC_BASE_URL at the proxy only when it starts
  // Claude Code itself, and a session started with a bare `claude` talks to
  // Anthropic without ever passing through. Measured 2026-08-11: the proxy's
  // request counter sat unchanged at 1,088 across a whole working day in this
  // very session, so everything read here would have been invisible.
  //
  // No sixth hook: this one already runs on every Read and already has the
  // path. The five PostToolUse hooks on Read cost 488ms per call as it is.
  // Queue a pointer, never content — chunking and embedding belong to the
  // idle worker.
  for (const p of candidates) {
    try {
      const abs = resolve(p);
      const st = statSync(abs);
      if (!st.isFile() || st.size < 200 || st.size > 2 * 1024 * 1024) continue;
      // The predicate only — never the cache module, which drags a database
      // driver into a hook that runs on every read.
      const { isKnowledgeFile } = require(pluginRoot + '/../shared-core/knowledge-predicate.js');
      if (!isKnowledgeFile(abs)) continue;
      const sha = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 32);
      // No "have we ingested this already?" check here, deliberately. That
      // question costs 144ms — json_extract(input,'$.source') has no index, so
      // it is a full scan of 587,000 rows — and asking it on every Read added
      // more latency than the whole rest of this hook. The queue's UNIQUE
      // index on (kind, ref, sha) already refuses a duplicate row, and the
      // drain asks properly before doing the expensive part. The cheap guard
      // belongs where the work is, not on the operator's turn.
      state.spoolKnowledge({ kind: 'file', ref: abs, sha, bytes: st.size, why: null });
    } catch (_) { /* a read must never fail because we wanted to remember it */ }
  }
}
allow();
