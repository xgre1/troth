// SPDX-License-Identifier: AGPL-3.0-only
// procedure-runner — true zero-LLM replay (substrate-side
// SSE event builder).
//
// Companion to procedure-matcher.js. The matcher decides WHAT procedure
// fits a prompt and builds a filled plan; this module turns the FIRST
// step of that plan into a sequence of Anthropic SSE events the proxy
// can write to the response without ever calling the LLM. The host
// (Claude Code) executes the tool, sends back the tool_result, and the
// next request resumes through the normal LLM path — substrate has
// already saved one LLM roundtrip on the matched workflow.
//
// What we DO:
//   1. buildToolUseId(procedure_id, step_index) — synthetic id with a
//      recognizable `gcr_` prefix so subsequent requests can detect
//      that the prior assistant tool_use came from substrate replay
//      (multi-turn continuation is a future ship; this id scheme
//      makes that ship trivial).
//   2. buildSseEvents({step, model, message_id, usage}) — pure
//      function returning an array of {event, data} objects in the
//      Anthropic streaming format: message_start → content_block_start
//      (tool_use) → content_block_delta (input_json_delta) →
//      content_block_stop → message_delta (stop_reason='tool_use') →
//      message_stop.
//   3. encodeSseEvents(events) — turns the array into the wire-format
//      string `event: <name>\ndata: <json>\n\n` ready for res.write.
//
// What we DO NOT do:
//   - Multi-turn replay. After the host returns the tool_result, the
//     next request falls through to the LLM normally. Future ship: a
//     stateless continuation that recognizes the prior gcr_ tool_use
//     and emits step+1 instead of bouncing to the LLM.
//   - Validate that the tool args are safe to run. The matcher's
//     buildReplayPlan is best-effort heuristic; the env-gated entry
//     point in the proxy intercept (TROTH_REPLAY_EXECUTE=1 plus
//     zero-missing-args precondition) is the only safety check.

const crypto = require('crypto');

const ID_PREFIX = 'gcr_';   // troth replay marker — used by future
                            // multi-turn continuation to detect that
                            // the prior assistant tool_use was ours.

function buildToolUseId(procedureId, stepIndex) {
  const sfx = String(procedureId || '').replace(/-/g, '').slice(-12) || 'noid';
  const rand = crypto.randomBytes(4).toString('hex');
  return ID_PREFIX + sfx + '_' + (stepIndex == null ? 0 : stepIndex) + '_' + rand;
}

function isReplayToolUseId(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

function parseReplayToolUseId(id) {
  if (!isReplayToolUseId(id)) return null;
  const m = /^gcr_([^_]+)_(\d+)_([0-9a-f]+)$/.exec(id);
  if (!m) return null;
  return {
    procedure_id_suffix: m[1],
    step_index: parseInt(m[2], 10),
    nonce: m[3]
  };
}

// Build the SSE event sequence for ONE synthetic tool_use turn.
// `step` matches the shape from procedure-matcher.buildReplayPlan:
//   { step_index, tool, args, source, missing? }
// Returns an array of {event, data} objects — ready for encodeSseEvents.
function buildSseEvents(opts) {
  opts = opts || {};
  const step = opts.step;
  const model = opts.model || 'claude-substrate-replay';
  const messageId = opts.message_id || ('msg_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'));
  const usage = opts.usage || { input_tokens: 0, output_tokens: 0 };
  const procedureId = opts.procedure_id || null;

  if (!step || !step.tool) {
    return null;
  }

  const toolUseId = opts.tool_use_id || buildToolUseId(procedureId, step.step_index);
  const inputObj = step.args || {};
  const inputJson = JSON.stringify(inputObj);

  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage
        }
      }
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: step.tool,
          input: {}
        }
      }
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson }
      }
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 }
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 }
      }
    },
    {
      event: 'message_stop',
      data: { type: 'message_stop' }
    }
  ];
}

// Wire-encode an event array to the Anthropic SSE format.
function encodeSseEvents(events) {
  if (!Array.isArray(events)) return '';
  return events.map(e => 'event: ' + e.event + '\ndata: ' + JSON.stringify(e.data) + '\n\n').join('');
}

module.exports = {
  ID_PREFIX,
  buildToolUseId,
  isReplayToolUseId,
  parseReplayToolUseId,
  buildSseEvents,
  encodeSseEvents
};
