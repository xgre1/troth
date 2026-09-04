#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// errortax — PostToolUse hook. When a tool call fails, extract the
// error text, classify it into a known bucket, and append a concrete
// recovery hint to the context so the model doesn't retry the same
// mistake verbatim.
//
// The PostToolUse payload carries tool_response; Claude Code marks
// tool failures either via a truthy `is_error` flag or by embedding
// "Error:" in the content. We handle both shapes.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readStdinJson, allow, addContext, log, state, recordAction } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const errortax = require(pluginRoot + '/../shared-core/errortax-hook.js');
// Precedent reads the delivery queue directly (below) — seven days of it
// survive the sweep, which is exactly the window "you failed this way
// recently" should mean.

function extractErrorText(payload) {
  const r = payload.tool_response;
  if (!r) return '';
  if (typeof r === 'string') {
    // A bare string carries no verdict. Only shell-shaped markers count;
    // prose that merely mentions an error is not an error report.
    return /^\s*(?:Error|error):|\bENOENT\b|\bEACCES\b|command not found/m.test(r) ? r : '';
  }
  if (r.is_error === true || r.isError === true) {
    if (typeof r.content === 'string') return r.content;
    if (typeof r.output === 'string') return r.output;
    if (Array.isArray(r.content)) return r.content.map(c => c && (c.text || c.content)).filter(Boolean).join('\n');
  }
  // A call that SUCCEEDED is not an error report, and its content is answer
  // text: a memory, a page, a file — material that may discuss errors without
  // being one. Classifying it would tell the model its own tool failed and
  // shelve that as precedent. On success only stderr is read, and only for
  // markers a shell actually emits.
  const err = typeof r.stderr === 'string' ? r.stderr : '';
  if (/\bENOENT\b|\bEACCES\b|command not found|permission denied|no such file or directory/i.test(err)) return err;
  return '';
}

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const session = payload.session_id || null;

const errText = extractErrorText(payload);
if (!errText) { allow(); }

const diag = errortax.diagnose(errText);
if (!diag) {
  log('PostToolUse.errortax', {
    session_id: session, tool, reason: 'no_classification',
    metadata: { bytes: errText.length }
  });
  allow();
}

log('PostToolUse.errortax', {
  session_id: session,
  tool,
  decision: 'allow_with_context',
  reason: diag.class,
  metadata: { recovery: diag.recovery.slice(0, 80) }
});

// One write, one policy. This would record every failure THREE times — a
// direct durable lesson, recordLesson's durable mirror, and the queue — so a
// single timeout minted two permanent rows. Measured: 283 durable errortax
// lessons, 238 of them infrastructure weather. Now recordLesson is the only
// writer, and errortax-hook's policy decides what deserves the shelf: a
// failure that reflects a CHOICE (edit-unread, overwrite, missing command)
// persists; weather is delivered in the moment and swept with the queue.
const fp = createHash('sha1').update('errortax|' + tool + '|' + diag.class).digest('hex').slice(0, 12);
try {
  state.recordLesson(
    session,
    payload.cwd || process.cwd(),
    'errortax',
    fp,
    'Previous ' + tool + ' call failed (' + diag.class + '). Recovery: ' + diag.recovery,
    { durable: errortax.durable(diag.class) }
  );
} catch (e) { /* never break the hook on telemetry */ }
recordAction({
  type: 'decision',
  session_id: session, cwd: payload.cwd,
  input: { kind: 'errortax', tool, error_class: diag.class },
  output: { decision: 'allow_with_context', reason: diag.class }
});

// Precedent: has this exact (tool × class) failed in OTHER recent sessions?
// Reads the delivery queue — seven days of it survive the sweep — rather than
// the permanent store, because most failure classes no longer persist there
// and last week's weather is precedent enough.
let precedentBlock = '';
try {
  const rows = state._dbForQuery().prepare(
    'SELECT COUNT(DISTINCT session_id) AS n FROM session_lessons ' +
    'WHERE fingerprint = ? AND session_id != ? AND ts >= ?'
  ).get(fp, session || '', Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (rows && rows.n > 0) {
    precedentBlock =
      '\n[troth/errortax] Precedent: this exact failure class (' + diag.class + ' on ' + tool +
      ') occurred in ' + rows.n + ' other session(s) this week. ' +
      'Don\'t re-derive from scratch.';
  }
} catch (_) { /* never break the hook on telemetry */ }

addContext(
  '[troth/errortax] The ' + tool + ' call failed (' + diag.class + ' — ' + diag.description + '). ' +
  'Recovery: ' + diag.recovery + precedentBlock
);
