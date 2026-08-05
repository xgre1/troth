// SPDX-License-Identifier: AGPL-3.0-only
// Context-filtering — omit assistant's commentary text from older turns.
//
// Research: "Optimizing LLM Agent Context and Tools".
// ~39% of multi-turn prompts are self-contained; dropping assistant narration
// ("I'll read the file...", "Let me check...") from older turns cuts tokens
// without losing behavioral grounding — the tool_use blocks already record
// what the agent did, and tool_results record what it learned.
//
// Safety rules:
//  1. Never drop tool_use or tool_result blocks (API requires pair consistency).
//  2. Never drop thinking blocks here (preprocessor handles those).
//  3. Never touch the last N assistant messages (fresh reasoning is load-bearing).
//  4. Drop text blocks from older messages only when short (<SHORT_TEXT_LIMIT
//     chars) — long text blocks may contain strategic plans worth keeping.
//  5. If an assistant message ends up empty after filtering, drop the whole
//     message (API rejects empty content arrays).

var KEEP_RECENT_ASSISTANT = 2;  // always preserve the last N assistant msgs intact
// Empirical threshold from NousResearch April 2026 findings:
//  <150 chars = almost always "I'll do that" / "Looking at the file" narration,
//               safe to drop from older messages
//  >=150 chars (especially >300) = often contains reasoning steps or
//               self-corrections, dropping degrades the model's ability to
//               remember architectural choices made earlier in the session
// Phase 92 initially used 300 (safer default pre-evidence). Phase 99 drops to
// 150 based on verified research.
var SHORT_TEXT_LIMIT = 150;
var MIN_MESSAGES_TO_FILTER = 6; // don't bother on short conversations

function filterContext(bodyStr) {
  var result = { body: bodyStr, textBlocksRemoved: 0, messagesRemoved: 0, bytesSaved: 0 };
  try {
    var data = JSON.parse(bodyStr);
    if (!Array.isArray(data.messages) || data.messages.length < MIN_MESSAGES_TO_FILTER) {
      return result;
    }

    var beforeSize = bodyStr.length;

    // Find indices of assistant messages; mark the last KEEP_RECENT_ASSISTANT as protected.
    var assistantIndices = [];
    for (var i = 0; i < data.messages.length; i++) {
      if (data.messages[i] && data.messages[i].role === 'assistant') assistantIndices.push(i);
    }
    var protectedFrom = assistantIndices.length > KEEP_RECENT_ASSISTANT
      ? assistantIndices[assistantIndices.length - KEEP_RECENT_ASSISTANT]
      : 0;

    var out = [];
    for (var m = 0; m < data.messages.length; m++) {
      var msg = data.messages[m];
      if (!msg || msg.role !== 'assistant' || m >= protectedFrom || !Array.isArray(msg.content)) {
        out.push(msg);
        continue;
      }

      var filtered = [];
      for (var b = 0; b < msg.content.length; b++) {
        var blk = msg.content[b];
        if (!blk) continue;
        // Keep everything that isn't a short text block
        if (blk.type !== 'text') { filtered.push(blk); continue; }
        var txt = blk.text || '';
        if (txt.length >= SHORT_TEXT_LIMIT) { filtered.push(blk); continue; }
        result.textBlocksRemoved++;
      }

      if (filtered.length === 0) {
        // Message became empty — drop it entirely (API rejects empty content arrays).
        // But only safe to drop if it had no tool_use (tool_use must pair with tool_result).
        // Since we only remove text blocks, empty means the original was all text.
        result.messagesRemoved++;
        continue;
      }
      out.push(Object.assign({}, msg, { content: filtered }));
    }

    data.messages = out;
    var newBody = JSON.stringify(data);
    result.body = newBody;
    result.bytesSaved = beforeSize - newBody.length;
    // Emit to savings_ledger so the analytics overview can attribute
    // tokens saved to this surface. ~4 bytes/token rough conversion;
    // session_id unknown at proxy layer (no CC session header).
    if (result.bytesSaved > 0) {
      try {
        var s = require('../../shared-core/state.js');
        if (s && typeof s.recordSavings === 'function') {
          s.recordSavings(
            'context_filter',
            Math.ceil(result.bytesSaved / 4),
            null,
            'text_blocks=' + result.textBlocksRemoved + ' msgs=' + result.messagesRemoved
          );
        }
      } catch (_) { /* telemetry must never break the filter */ }
    }
    return result;
  } catch (e) {
    return result;
  }
}

function getStats() {
  return { module: 'contextfilter', enabled: true, keepRecent: KEEP_RECENT_ASSISTANT, shortTextLimit: SHORT_TEXT_LIMIT };
}

module.exports = { filterContext: filterContext, getStats: getStats, KEEP_RECENT_ASSISTANT: KEEP_RECENT_ASSISTANT, SHORT_TEXT_LIMIT: SHORT_TEXT_LIMIT };
