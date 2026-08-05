// SPDX-License-Identifier: AGPL-3.0-only
// replay-intercept — true zero-LLM replay (proxy intercept).
//
// Sits between the proxy's preprocessing pipeline and the LLM call.
// Reads the latest user message from the request body, runs the
// substrate's procedure-matcher, and if the match is HIGH confidence
// AND the buildReplayPlan output has zero missing args, emits a
// synthetic Anthropic SSE response with the FIRST step's tool_use
// block — bypassing the LLM entirely for that turn.
//
// Hard preconditions (any miss = fall through to normal LLM path):
//   - TROTH_REPLAY_EXECUTE === '1' (callsite gates this; module
//     trusts the caller)
//   - Request body parses as JSON with stream === true
//   - Latest message role === 'user' with extractable text
//   - Matcher returns a match above min_confidence
//   - Plan has zero missing_args (no <command> / <pattern> placeholders)
//   - Plan has at least one step
//
// On any failure path returns { handled: false }; the proxy then
// runs the normal Anthropic / fallback chain. This module never
// writes to res unless ALL preconditions hold.
//
// What we DO NOT do here:
//   - Multi-turn continuation. The next request after the host
//     executes our tool_use returns through the normal LLM path.
//     procedure-runner.js's gcr_ id prefix exists so a future
//     continuation ship can detect "the last assistant tool_use was
//     ours" and emit step+1 instead of bouncing to the LLM.
//   - Sanity-check the tool args. The matcher fills file_path slots
//     from prompt heuristics; the operator opted in via env, so
//     mistyped paths produce real tool errors that the host surfaces
//     normally.

const path = require('path');

const SHARED_CORE = path.resolve(__dirname, '..', '..', 'shared-core');
const matcher = require(path.join(SHARED_CORE, 'procedure-matcher.js'));
const runner  = require(path.join(SHARED_CORE, 'procedure-runner.js'));

const DEFAULT_THRESHOLD = 0.50;

// Walk messages backward to find the most recent role:'user' content
// and extract a single textual prompt. Skips tool_result-only messages.
function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      // Skip messages that are pure tool_result (continuation turns)
      const textBlocks = m.content.filter(b => b && b.type === 'text' && typeof b.text === 'string');
      if (!textBlocks.length) {
        // Pure tool_result message — skip (this is a continuation turn,
        // not a fresh user prompt; we shouldn't try to match it)
        const isPureToolResult = m.content.every(b => b && (b.type === 'tool_result' || !b.type));
        if (isPureToolResult) return '';
        continue;
      }
      return textBlocks.map(b => b.text).join('\n').trim();
    }
  }
  return '';
}

// Detect whether the most recent assistant message contains a
// gcr_-prefixed tool_use — meaning we already emitted a synthetic
// step on a prior turn and the host is now sending back its result.
// Multi-turn replay would handle this; for now we fall through to LLM.
function hasPriorReplayToolUse(messages) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_use' && runner.isReplayToolUseId(b.id)) {
          return true;
        }
      }
    }
    return false; // only inspect the most recent assistant turn
  }
  return false;
}

async function tryIntercept(opts) {
  opts = opts || {};
  const body = opts.body;
  const res = opts.res;
  const requestedModel = opts.requestedModel || null;
  const cwd = opts.cwd || null;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;

  if (!body || !res) return { handled: false, reason: 'missing_body_or_res' };

  let parsed;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body; }
  catch (_) { return { handled: false, reason: 'body_parse_failed' }; }

  if (parsed.stream !== true) return { handled: false, reason: 'non_streaming_request' };

  const messages = parsed.messages || [];

  if (hasPriorReplayToolUse(messages)) {
    return { handled: false, reason: 'continuation_not_yet_supported' };
  }

  const promptText = extractLastUserText(messages);
  if (!promptText || promptText.length < 5) {
    return { handled: false, reason: 'no_user_text' };
  }

  const m = matcher.matchProcedure({
    prompt: promptText,
    cwd,
    min_confidence: threshold,
    state: opts.state  // optional override — tests use this to pin
                        // the matcher to the same state instance the
                        // test wrote into; production callers omit it
                        // and matcher uses its module-loaded default.
  });
  if (!m || !m.ok || !m.match) {
    return { handled: false, reason: (m && m.reason) || 'no_match' };
  }

  const plan = matcher.buildReplayPlan({ procedure: m.match.procedure, prompt: promptText });
  if (!plan || !plan.ok || !Array.isArray(plan.steps) || !plan.steps.length) {
    return { handled: false, reason: 'plan_empty' };
  }
  if (plan.missing_args > 0) {
    return { handled: false, reason: 'plan_has_missing_args', missing: plan.missing_args };
  }

  const firstStep = plan.steps[0];
  const events = runner.buildSseEvents({
    step: firstStep,
    model: requestedModel,
    procedure_id: m.match.procedure_id,
    usage: { input_tokens: 0, output_tokens: 1 }
  });
  if (!events) return { handled: false, reason: 'sse_build_failed' };

  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive'
    });
    res.write(runner.encodeSseEvents(events));
    res.end();
  } catch (e) {
    // res may already be in a bad state; nothing more to do here.
    return { handled: false, reason: 'res_write_failed', error: String(e && e.message || e) };
  }

  return {
    handled: true,
    procedure_id: m.match.procedure_id,
    step_index: firstStep.step_index,
    tool: firstStep.tool,
    score: m.match.score,
    plan_steps: plan.steps.length
  };
}

module.exports = {
  tryIntercept,
  extractLastUserText,
  hasPriorReplayToolUse,
  DEFAULT_THRESHOLD
};
