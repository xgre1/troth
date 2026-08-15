// SPDX-License-Identifier: AGPL-3.0-only
// The memory question stops being optional on the proxy lane.
//
// Clients troth can hook get recall injected before the model ever answers.
// Foreign agents on the proxy lane have no hooks: a "do you remember / what
// did we decide" prompt reaches the model naked, and advice to call
// troth_recall is exactly that — advice (measured on the hook lane at
// roughly sixty corrections from hard enforcement per one from advice). The
// protocol itself has the hard version: tool_choice {type:"tool"} makes the
// next response BE the recall call. This module applies it when, and only
// when, the request is a fresh memory-shaped question and a recall tool is
// actually on the request's tool list.
//
// Where the force binds — traced per lane AND verified live, not assumed:
// the Anthropic lane forwards the body untouched, and the Responses lane
// passes every tool through and maps tool_choice, so both carry it. The
// OpenAI-compat chat lanes (hosted and local) strip MCP/troth tools at
// conversion AND emit no tool_choice, so there the force evaporates
// without error — consistent with those lanes not driving MCP tools at
// all. The Kimi Code lane is Anthropic-SHAPED but runs thinking on its own
// side and 400s on forced tool use (found by this module's first field
// test) — its transport deforces (drops tool_choice whole) for the same
// reason: a dropped force degrades to advice, a 400 kills the turn.
// Suite-60 pins every half of this map so a lane change reopens the
// question loudly.
//
// Guards, each one load-bearing:
//   - manual extended thinking is API-level incompatible with forced
//     tool_choice — skip or the upstream 400s. Adaptive thinking allows
//     forcing. The live pipeline strips `thinking` from the body before
//     this stage, so the call site passes the original type in
//     opts.thinkingType; the body check remains for standalone callers.
//   - an explicit client tool_choice (any/tool/none) is the client's own
//     decision; never overridden. 'auto' is the default and counts as absent.
//   - mid-loop requests (tail isn't a fresh user text turn) are skipped —
//     this is also what ends the cycle: the forced call's tool_result comes
//     back as part of the same turn, the guard sees it, the force lifts.
//   - a [troth/recall] block already in the latest user text means the hook
//     lane spoke first; the proxy stays silent. This scopes the module to
//     foreign agents structurally, with no client identification at all.
//
// The patterns are precision-first, both languages: a missed force still has
// the advisory road (initialize instructions, greeting, AGENTS.md), but a
// false force costs a wasted round-trip and — because tool_choice changes
// invalidate cached message blocks — a cache miss on that request. Only
// unambiguous memory questions match.
//
// isMemoryShaped() is exported on its own because it is the classifier the
// substrate-dispatch road needs: the same question shape that forces a
// recall call today is the one the substrate should answer pre-LLM tomorrow.

'use strict';

// The classifier lives in shared-core/memory-shaped.js — the decision
// engine's memory dispatch consumes the same shape, and two pattern lists
// drift. Re-exported below so this module's consumers keep one import.
const { isMemoryShaped } = require('../../shared-core/memory-shaped.js');

// The recall tool's name depends on the host's MCP prefixing —
// `troth_recall` wired direct, `mcp__<host-prefix>__troth_recall` behind a
// gateway. The suffix is the identity.
function findRecallTool(tools) {
  if (!Array.isArray(tools)) return null;
  for (const t of tools) {
    if (t && typeof t.name === 'string' && /(^|__)troth_recall$/.test(t.name)) return t.name;
  }
  return null;
}

// A fresh turn ends in a user message whose content is text — no
// tool_result blocks, no assistant prefill after it.
function freshUserText(data) {
  const msgs = data && Array.isArray(data.messages) ? data.messages : [];
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return null;
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const texts = [];
    for (const b of last.content) {
      if (!b) continue;
      if (b.type === 'tool_result') return null;   // mid-loop
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    return texts.length ? texts.join(' ') : null;
  }
  return null;
}

// Returns { body, forced, reason }. `body` is untouched unless forced.
// opts.thinkingType carries the request's ORIGINAL thinking type when the
// caller's pipeline has already stripped `thinking` from the body — without
// it the manual-thinking guard would inspect a field that is no longer there.
function apply(bodyStr, opts) {
  const out = { body: bodyStr, forced: false, reason: '' };
  try {
    const data = JSON.parse(bodyStr);

    const tc = data.tool_choice;
    if (tc && tc.type && tc.type !== 'auto') { out.reason = 'client-choice'; return out; }
    const thinkingType = (opts && opts.thinkingType) ||
      (data.thinking && data.thinking.type) || '';
    if (thinkingType === 'enabled') { out.reason = 'manual-thinking'; return out; }

    const toolName = findRecallTool(data.tools);
    if (!toolName) { out.reason = 'no-recall-tool'; return out; }

    const userText = freshUserText(data);
    if (userText === null) { out.reason = 'mid-loop'; return out; }
    if (userText.indexOf('[troth/recall]') !== -1) { out.reason = 'hook-already-spoke'; return out; }
    if (!isMemoryShaped(userText)) { out.reason = 'not-memory-shaped'; return out; }

    data.tool_choice = { type: 'tool', name: toolName };
    out.body = JSON.stringify(data);
    out.forced = true;
    out.reason = 'forced:' + toolName;
    return out;
  } catch (e) {
    out.reason = 'unparseable';
    return out;
  }
}

module.exports = { apply, isMemoryShaped, findRecallTool };
