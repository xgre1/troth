// SPDX-License-Identifier: AGPL-3.0-only
// engine-tools.js — the tool set a non-Claude engine receives.
//
// The harness declares its whole surface on every call: Claude Code's own
// product tools, its deferred set (loaded on demand through a mechanism only
// the Anthropic endpoint carries) and every MCP tool. Anthropic's prompt
// cache makes that free for Claude; every other lane pays the full set on
// every call. So a non-Claude lane receives the tools the engine can act on —
// the coding tools and every MCP tool — in the order they arrived, so a
// prefix cache on the other side can still hit.
'use strict';

// Claude Code's own product surfaces and its session plumbing: nothing a
// proxied engine can act on, every one of them a schema paid for per call.
var HARNESS_ONLY = {
  Artifact: 1, ReportFindings: 1, SendFeedback: 1, Workflow: 1, ScheduleWakeup: 1,
  ListAgents: 1, DesignSync: 1, RemoteTrigger: 1, PushNotification: 1,
  EndConversation: 1, Monitor: 1, CronCreate: 1, CronDelete: 1, CronList: 1,
  TaskOutput: 1, TaskStop: 1, SendMessage: 1, EnterWorktree: 1, ExitWorktree: 1,
  EnterPlanMode: 1, ExitPlanMode: 1, ToolSearch: 1
};

function kb(n) { return (n / 1024).toFixed(1) + 'KB'; }

// tools: the Anthropic-shaped tools[] of a request. lane: the lane's name,
// for the log line. Returns the list to send and whether it differs.
function trimForEngine(tools, lane) {
  if (!Array.isArray(tools) || !tools.length) {
    return { tools: tools, changed: false, before: 0, after: 0 };
  }
  var out = [];
  for (var i = 0; i < tools.length; i++) {
    var t = tools[i];
    if (!t || !t.name) continue;
    if (t.defer_loading === true) continue;
    if (HARNESS_ONLY[t.name]) continue;
    if (Object.prototype.hasOwnProperty.call(t, 'defer_loading')) {
      t = Object.assign({}, t);
      delete t.defer_loading;
    }
    out.push(t);
  }
  var beforeBytes = Buffer.byteLength(JSON.stringify(tools));
  var afterBytes = Buffer.byteLength(JSON.stringify(out));
  var changed = out.length !== tools.length || afterBytes !== beforeBytes;
  if (changed) {
    console.log('[router] ' + (lane || 'engine') + ' tools: ' + tools.length + ' → ' + out.length +
      ' | ' + kb(beforeBytes) + ' → ' + kb(afterBytes));
  }
  return { tools: out, changed: changed, before: tools.length, after: out.length,
    before_bytes: beforeBytes, after_bytes: afterBytes };
}

module.exports = { trimForEngine: trimForEngine, HARNESS_ONLY: HARNESS_ONLY };
