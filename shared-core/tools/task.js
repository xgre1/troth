// SPDX-License-Identifier: AGPL-3.0-only
// task — delegate one brief to a child turn.
//
// The child is its own conversation (<parent>:task:<n>) with a reduced tool
// set, no writes, its own context and, when asked, another engine. The
// parent's turn waits for the answer and gets it back as this tool's result;
// the child's text never reaches the surface on its own. The runtime that
// can run a nested turn injects ctx.spawn_turn; without it the tool says so.
'use strict';

// What a delegate may touch. read-only: files, the web and memory reads.
// general: the core set, still without writes or commands (auto_write is
// off inside a delegate) and without task itself (depth one).
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'web_search', 'web_fetch', 'engram_search', 'dialogue_recent'];
const TOOL_SETS = ['read-only', 'general'];
const DEFAULT_MINUTES = 10;
const MAX_MINUTES = 30;

const schema = { type: 'function', function: {
  name: 'task',
  description: 'Delegate one self-contained brief to a child turn with its own context: research, a read-only survey of files, a second opinion from another engine. The child cannot write, run commands or delegate further; it answers with text that comes back here. Give it everything it needs in the brief; it sees none of this conversation.',
  parameters: { type: 'object', properties: {
    brief:       { type: 'string', description: 'The whole task, self-contained: what to find out or produce, where to look, what shape the answer takes' },
    engine:      { type: 'string', description: 'Optional engine word for the child (claude, chatgpt, local, anthropic, or a router provider such as openrouter, deepseek); omit for the default' },
    tools:       { type: 'string', enum: TOOL_SETS, description: 'read-only (default): files, web and memory reads. general: the core tools, still without writes or commands' },
    max_minutes: { type: 'integer', minimum: 1, maximum: MAX_MINUTES, description: 'Time box in minutes (default ' + DEFAULT_MINUTES + '); the child is stopped when it runs out' }
  }, required: ['brief'] }
} };

async function run(args, ctx) {
  const a = args || {};
  const c = ctx || {};
  if (typeof c.spawn_turn !== 'function') {
    return { error: 'unavailable', hint: 'this surface cannot run a delegate turn' };
  }
  if ((Number(c.task_depth) || 0) >= 1) {
    return { error: 'task_depth', hint: 'a delegate cannot delegate; do the work here and answer' };
  }
  const brief = typeof a.brief === 'string' ? a.brief.trim() : '';
  if (!brief) return { error: 'missing_brief', hint: 'brief must say the whole task' };
  const set = TOOL_SETS.indexOf(a.tools) >= 0 ? a.tools : 'read-only';
  const minutes = Number.isInteger(a.max_minutes) && a.max_minutes >= 1 ? Math.min(a.max_minutes, MAX_MINUTES) : DEFAULT_MINUTES;
  const t0 = Date.now();
  let r;
  try {
    r = await c.spawn_turn({
      brief,
      engine: typeof a.engine === 'string' && a.engine.trim() ? a.engine.trim().toLowerCase() : null,
      tools: set,
      tool_names: set === 'read-only' ? READ_ONLY_TOOLS.slice() : null,
      max_ms: minutes * 60000
    });
  } catch (e) {
    return { error: 'task_failed', detail: e && e.message || String(e), elapsed_ms: Date.now() - t0 };
  }
  const out = {
    ok: !!(r && r.ok),
    text: r && typeof r.text === 'string' ? r.text : '',
    engine: (r && r.engine) || null,
    tools: set,
    elapsed_ms: Date.now() - t0
  };
  if (r && r.conversation_id) out.conversation_id = r.conversation_id;
  if (r && r.error) out.error = r.error;
  if (r && r.detail) out.detail = r.detail;
  if (r && r.hint) out.hint = r.hint;
  if (r && r.reason && !out.ok) out.reason = r.reason;
  return out;
}

module.exports = { schema, run, READ_ONLY_TOOLS, TOOL_SETS, DEFAULT_MINUTES, MAX_MINUTES };
