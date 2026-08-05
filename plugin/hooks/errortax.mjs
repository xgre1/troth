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
// Read paths — pull precedent from substrate so classifier
// can reference "you've failed this way N times before; recovery that
// worked last time was X".
const query = require(pluginRoot + '/../shared-core/query.js');

function extractErrorText(payload) {
  const r = payload.tool_response;
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (r.is_error === true || r.isError === true) {
    if (typeof r.content === 'string') return r.content;
    if (typeof r.output === 'string') return r.output;
    if (Array.isArray(r.content)) return r.content.map(c => c && (c.text || c.content)).filter(Boolean).join('\n');
  }
  // Sometimes the tool succeeded but stderr contains a real error.
  // Heuristic: if content includes obvious error markers, still classify.
  const joined = [
    typeof r.output === 'string' ? r.output : '',
    typeof r.stderr === 'string' ? r.stderr : '',
    typeof r.content === 'string' ? r.content : '',
    Array.isArray(r.content) ? r.content.map(c => c && (c.text || c.content)).filter(Boolean).join('\n') : ''
  ].join('\n');
  if (/\b(Error:|error:|ENOENT|EACCES|not found)\b/i.test(joined)) return joined;
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

// Record both the lesson (learned pattern) and the causally-
// linked recovery decision. The lesson is the durable artifact; the
// decision is the action trail.
const lessonRec = recordAction({
  type: 'lesson',
  session_id: session, cwd: payload.cwd,
  input: {
    source: 'errortax',
    fingerprint: createHash('sha1').update('errortax|' + tool + '|' + diag.class).digest('hex').slice(0, 12),
    failing_tool: tool
  },
  output: {
    text: 'Previous ' + tool + ' call failed (' + diag.class + '). Recovery: ' + diag.recovery
  }
});
recordAction({
  type: 'decision',
  session_id: session, cwd: payload.cwd,
  parent_id: lessonRec,
  input: { kind: 'errortax', tool, error_class: diag.class },
  output: { decision: 'allow_with_context', reason: diag.class }
});

// record a reflexion lesson so the next injector turn re-surfaces
// the recovery hint if the agent keeps bouncing off the same error. Same
// pattern as critic → lesson → injector.
try {
  const fp = createHash('sha1').update('errortax|' + tool + '|' + diag.class).digest('hex').slice(0, 12);
  state.recordLesson(
    session,
    payload.cwd || process.cwd(),
    'errortax',
    fp,
    'Previous ' + tool + ' call failed (' + diag.class + '). Recovery: ' + diag.recovery
  );
} catch (e) { /* never break the hook on telemetry */ }

// Substrate READ: look up prior identical failures in this
// project. If we've classified the same (tool × error_class) before,
// tell the agent how many times and attach the most recent successful
// recovery so it doesn't re-try the same dead end.
let precedentBlock = '';
try {
  const fp = createHash('sha1').update('errortax|' + tool + '|' + diag.class).digest('hex').slice(0, 12);
  const priorLessons = query.getLessons(state, { cwd: payload.cwd, limit: 20 }) || [];
  const sameClass = priorLessons.filter(l =>
    l.input && l.input.fingerprint === fp && l.session_id !== session
  );
  if (sameClass.length > 0) {
    precedentBlock =
      '\n[troth/errortax] Precedent: this exact failure class (' + diag.class + ' on ' + tool +
      ') occurred in ' + sameClass.length + ' prior session(s) in this project. ' +
      'Don\'t re-derive from scratch.';
  }
} catch (_) { /* never break the hook on telemetry */ }

addContext(
  '[troth/errortax] The ' + tool + ' call failed (' + diag.class + ' — ' + diag.description + '). ' +
  'Recovery: ' + diag.recovery + precedentBlock
);
