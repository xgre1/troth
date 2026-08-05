#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// troth MCP server — v6.2
//
// Implements the Model Context Protocol over stdio so any MCP-aware
// AI chat client (Claude Code, Cline, Continue, ...) can manage
// troth autonomous runs as native tools without the user dropping
// to a shell.
//
// To wire it up in Claude Code, add to ~/.claude/mcp.json or the
// per-project .claude/mcp.json:
//
//   {
//     "mcpServers": {
//       "troth": {
//         "command": "troth",
//         "args": ["mcp"]
//       }
//     }
//   }
//
// After that, your interactive Claude Code session sees these tools
// alongside Read/Write/Edit/Bash/Glob/Grep/etc:
//
//   troth_run        — spawn a new autonomous worker
//   troth_list       — list all runs and their state
//   troth_status     — get one run's detailed status
//   troth_logs       — fetch a run's captured logs
//   troth_diff       — fetch the git diff a run produced
//   troth_kill       — stop a running container
//   troth_clean      — remove a run's worktree and container
//
// And the agent can naturally orchestrate them: "use troth_run to
// dispatch the Stripe checkout implementation in the background while
// I keep working on the UI here."
//
// Protocol notes:
//
// We hand-roll the MCP wire format instead of pulling in
// @modelcontextprotocol/sdk because (a) we only need ~6 tools and
// the protocol is small, (b) zero new dependencies = zero new supply
// chain risk, (c) minimizing dependencies is a core design goal.
//
// MCP transport is JSON-RPC 2.0 over stdio. Each line of stdin is
// one JSON message. We read line-by-line, dispatch on `method`,
// write the response (or error) as one JSON line to stdout. The
// minimum methods we need to satisfy are: `initialize`, `tools/list`,
// `tools/call`, plus we accept and ignore `notifications/initialized`.
//
// All log output goes to STDERR — never stdout — because stdout is
// the JSON-RPC transport and any stray writes there break the
// protocol handshake.

const readline = require('readline');
const path = require('path');

// Lazy-load the runner so a syntax error in runner.js doesn't kill
// the MCP server before we can report it cleanly.
let runner;
try {
  runner = require('./runner.js');
} catch (e) {
  process.stderr.write('[troth mcp] failed to load runner: ' + e.message + '\n');
  process.exit(1);
}

// Check if a remote host is configured. When set, dispatches go to
// the remote daemon (e.g. remote server) instead of spawning locally.
// This lets the laptop be a thin client while the heavy work runs
// on always-on hardware with Docker.
const fs = require('fs');
const http = require('http');
const HOME = process.env.HOME || require('os').homedir();
const CONFIG_FILE = path.join(HOME, '.troth', 'config.json');
// Where the proxy actually is. Every tool below reached http://127.0.0.1:8000
// literally, while the proxy follows its port when 8000 is busy (0.1.8), the
// app exports TROTH_PROXY_URL, and the operator can set host/port in the very
// config file this line above points at — so on any machine that had moved,
// each of these tools failed and blamed the proxy for being down.
function proxyBase() {
  const fromEnv = String(process.env.TROTH_PROXY_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  let host = '127.0.0.1', port = 8000;
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    if (typeof c.host === 'string' && c.host) host = c.host;
    if (c.port) port = parseInt(c.port, 10) || port;
  } catch (_) { /* defaults */ }
  return 'http://' + host + ':' + port;
}

function loadRemoteConfig() {
  try {
    var cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.remoteHost) return null;
    var parts = cfg.remoteHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
    var colonIdx = parts.lastIndexOf(':');
    var host = colonIdx === -1 ? parts : parts.slice(0, colonIdx);
    var port = colonIdx === -1 ? 8000 : parseInt(parts.slice(colonIdx + 1), 10) || 8000;
    return { host: host, port: port, token: cfg.remoteToken || '' };
  } catch (e) { return null; }
}

function remoteApiCall(method, urlPath, body, remote) {
  return new Promise(function(resolve, reject) {
    var payload = body ? JSON.stringify(body) : null;
    var headers = { 'Authorization': 'Bearer ' + remote.token };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    var req = http.request({
      hostname: remote.host, port: remote.port,
      path: urlPath, method: method,
      headers: headers, timeout: 60000,
    }, function(res) {
      var buf = '';
      res.on('data', function(c) { buf += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(buf)); }
        catch (e) { resolve({ ok: false, error: 'bad json from remote: ' + buf.slice(0, 200) }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: 'remote connection failed: ' + e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'remote timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

var REMOTE = loadRemoteConfig();
if (REMOTE) {
  process.stderr.write('[troth mcp] remote dispatch → ' + REMOTE.host + ':' + REMOTE.port + '\n');
}

const SERVER_NAME = 'troth';
const SERVER_VERSION = require('../package.json').version;
const PROTOCOL_VERSION = '2024-11-05';

// Tool definitions in the MCP schema shape. inputSchema is a
// JSON Schema fragment describing the tool's arguments.
const TOOLS = [
  {
    name: 'troth_run',
    description:
      'Spawn an autonomous troth worker that runs in its own context window, completely separate from this chat. Returns immediately with a run id.\n\n' +
      'Use this tool when the user explicitly asks to dispatch, OR when ALL of these are true:\n' +
      '- The task is self-contained (doesn\'t need clarification or back-and-forth)\n' +
      '- The task will take 10+ tool calls (large refactors, full test suites, implementing a whole feature)\n' +
      '- The task doesn\'t depend on context from the current conversation\n\n' +
      'Do NOT dispatch for: reading a few files, quick research, small edits, anything faster to do directly in this chat. ' +
      'A dispatch takes 2-5 minutes to complete — only use it when that time is justified.\n\n' +
      'The worker has its own filesystem (git worktree of current branch), its own Gemini routing, and reports back via logs and git diff. Your context stays clean.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A clear, self-contained natural-language description of the task. The dispatched worker has no knowledge of this chat\'s context, so the task must include everything it needs (file paths, success criteria, tests to run, output format).',
        },
        cwd: {
          type: 'string',
          description: 'Optional absolute path to a git repo. Defaults to the daemon\'s current working directory. Use this to dispatch a run against a specific project.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'troth_list',
    description:
      'List all troth runs (running, done, failed, killed) with their state and task. Use this to see what background workers exist before deciding what to check on.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'troth_status',
    description:
      'Get the detailed status of one troth run by id. Returns metadata (task, branch, started_at), current state (running/done/failed/killed), and a brief log summary (line count + last line). Use this to check whether a dispatched worker is still running or has finished.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run id returned by troth_run.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'troth_logs',
    description:
      'Fetch the captured stdout/stderr logs from a troth run. Use this when a run has finished (or is in progress) to read what the dispatched agent actually did. Pass tail_bytes to get only the most recent N bytes if the log is large.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run id.' },
        tail_bytes: { type: 'number', description: 'Optional: return only the last N bytes of the log. 0 or omitted = full log.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'troth_diff',
    description:
      'Fetch the git diff a troth run produced — the changes the dispatched worker made on top of the parent branch. Use this when a run is done to review what was actually changed before deciding whether to merge it. Returns the unified diff as text.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run id.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'troth_kill',
    description:
      'Stop a running troth worker container immediately. The worktree and run metadata are preserved so you can still inspect logs/diff afterwards. Use this when a run is stuck, taking too long, or going down the wrong path.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run id.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'troth_clean',
    description:
      'Permanently delete a troth run\'s worktree, container, and metadata directory. Use this after merging a run\'s changes (or deciding to throw them away) to free disk space and unclutter the run list. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run id to delete.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'troth_schedule_add',
    description:
      'Create a recurring scheduled troth run. The proxy checks every 60 seconds and auto-dispatches when it\'s time. Use this when the user wants something to run daily, hourly, or on a regular interval without having to manually dispatch each time.',
    inputSchema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: 'When to run. Supported: "daily HH:MM" (e.g. "daily 9:00"), "hourly", "every Nm" (e.g. "every 30m"), "every Nh" (e.g. "every 2h").' },
        task: { type: 'string', description: 'The task description the worker will receive.' },
        cwd: { type: 'string', description: 'Optional: absolute path to the git repo to run against.' },
      },
      required: ['cron', 'task'],
    },
  },
  {
    name: 'troth_schedule_list',
    description: 'List all scheduled troth runs with their cron expression, task, enabled state, and last run time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'troth_schedule_remove',
    description: 'Remove a scheduled troth run by id.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'The schedule id to remove.' },
      },
      required: ['schedule_id'],
    },
  },
  {
    name: 'troth_switch',
    description:
      'Switch the LLM backend mid-session. Available modes:\n' +
      '- "anthropic" — Anthropic API key\n' +
      '- "fallback" — provider chain (Alibaba/DeepInfra/NIM/OpenRouter)\n' +
      '- "local" — local model server (Gemma, Llama, etc.)\n' +
      '- "smart" — auto-routing based on task complexity\n' +
      '- "auto" — detect from request',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'One of: "anthropic", "fallback", "local", "smart", "auto"' },
      },
      required: ['mode'],
    },
  },
  // ── v8.2 scaffolding introspection tools ──
  {
    name: 'troth_stats',
    description: 'Get current troth module statistics: requests, tokens, quality scores, reflexion/trajectory counts, workflow state. Use when the user asks "how is troth doing" or wants to inspect proxy performance.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'troth_reflections',
    description: 'List recent reflexion lessons (verbal cues from past failures). These are persistent across sessions. Use when debugging recurring issues or auditing what troth has "learned".',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items to return (default 20)' } } },
  },
  {
    name: 'troth_workflow',
    description: 'Get current workflow state: active task, phase (planning/implementing/verifying), completed/pending steps. Use when the user asks "where am I" or "what was I working on".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'troth_clear_memory',
    description: 'Clear troth memory stores. Useful when switching projects or when accumulated lessons are stale/wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'One of: "reflexions" (lessons), "workflow" (current task), "all"' }
      },
      required: ['what'],
    },
  },
  {
    name: 'troth_cost',
    description: 'Get current session cost breakdown per model in USD. Shows requests, tokens, and cost for each provider used.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'troth_complexity',
    description: 'Score a task description for complexity (0-10) and recommend a model tier (cheap/mid/strong).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task description to score' }
      },
      required: ['task'],
    },
  },
  {
    name: 'troth_buildinfo',
    description: 'Get the current project build system info (test/build/start commands, deps, entry points). Useful before suggesting commands.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// JSON-RPC response helpers
function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id: id, result: result });
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}
function send(line) {
  process.stdout.write(line + '\n');
}

// Wrap a runner result into MCP's tools/call response shape. The
// content array carries one or more text blocks; isError is true on
// failure so the agent can react.
function toolResponse(text, isError) {
  return {
    content: [{ type: 'text', text: text || '' }],
    isError: !!isError,
  };
}

// Tool implementations. When REMOTE is configured, dispatch via HTTP
// to the remote daemon. Otherwise call runner.js's api* functions locally.
function callTool(name, args) {
  args = args || {};

  // Remote dispatch — all tools go through the remote /api/runs endpoints
  if (REMOTE) return callToolRemote(name, args);

  try {
    if (name === 'troth_run') {
      if (!args.task) return toolResponse('Error: task is required', true);
      var r = runner.apiCreateRun(args.task, { cwd: args.cwd });
      if (r.ok) {
        return toolResponse(
          'Started troth run' + (r.mode === 'subprocess' ? ' (subprocess mode, no Docker)' : '') + '.\n' +
          'run_id: ' + r.runId + '\n' +
          'task: ' + r.meta.task + '\n' +
          'branch: ' + r.meta.branch + ' (off ' + r.meta.parent_branch + ')\n' +
          'worktree: ' + r.meta.worktree + '\n' +
          'started_at: ' + r.meta.started_at + '\n\n' +
          'The worker is running in the background. Use troth_status with run_id="' + r.runId + '" to check progress, troth_logs to read its output, and troth_diff to see what it changed.'
        );
      }
      return toolResponse('Error: ' + r.error, true);
    }

    if (name === 'troth_list') {
      var runs = runner.apiListRuns();
      if (runs.length === 0) return toolResponse('No troth runs exist yet.');
      var lines = ['troth runs (' + runs.length + '):'];
      for (var i = 0; i < runs.length; i++) {
        lines.push('  [' + runs[i].state + '] ' + runs[i].id);
        lines.push('    ' + (runs[i].task || '').slice(0, 200));
        lines.push('    started: ' + runs[i].started_at);
      }
      return toolResponse(lines.join('\n'));
    }

    if (name === 'troth_status') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = runner.apiGetRun(args.run_id);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      var lines = [
        'run_id: ' + r.meta.id,
        'state: ' + r.state,
        'task: ' + r.meta.task,
        'branch: ' + r.meta.branch + ' (off ' + r.meta.parent_branch + ')',
        'worktree: ' + r.meta.worktree,
        'started_at: ' + r.meta.started_at,
      ];
      if (r.summary) {
        lines.push('log_lines: ' + r.summary.lines);
        if (r.summary.lastLine) lines.push('last_log_line: ' + r.summary.lastLine);
      }
      return toolResponse(lines.join('\n'));
    }

    if (name === 'troth_logs') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var tailBytes = typeof args.tail_bytes === 'number' ? args.tail_bytes : 0;
      var r = runner.apiGetRunLogs(args.run_id, tailBytes);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      var note = r.truncated ? '[truncated to last ' + tailBytes + ' bytes]\n' : '';
      return toolResponse(note + (r.logs || '(empty)'));
    }

    if (name === 'troth_diff') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = runner.apiGetRunDiff(args.run_id);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      if (!r.diff || r.diff.trim().length === 0) {
        return toolResponse('(no diff — the worker did not produce any commits)');
      }
      return toolResponse(r.diff);
    }

    if (name === 'troth_kill') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = runner.apiKillRun(args.run_id);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      return toolResponse('Killed run ' + args.run_id + '.');
    }

    if (name === 'troth_clean') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = runner.apiRemoveRun(args.run_id);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      return toolResponse('Cleaned run ' + args.run_id + '. Worktree and container removed.');
    }

    if (name === 'troth_schedule_add') {
      if (!args.cron || !args.task) return toolResponse('Error: cron and task are required', true);
      var sched = require('../proxy/modules/scheduler');
      var r = sched.addSchedule(args.cron, args.task, args.cwd);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      return toolResponse(
        'Schedule created.\n' +
        'id: ' + r.schedule.id + '\n' +
        'cron: ' + r.schedule.cron + '\n' +
        'task: ' + r.schedule.task + '\n' +
        'cwd: ' + r.schedule.cwd + '\n\n' +
        'The proxy checks every 60 seconds and will auto-dispatch a run when it\'s time.'
      );
    }

    if (name === 'troth_schedule_list') {
      var sched = require('../proxy/modules/scheduler');
      var scheds = sched.listSchedules();
      if (scheds.length === 0) return toolResponse('No scheduled runs yet.');
      var lines = ['Scheduled runs (' + scheds.length + '):'];
      for (var si = 0; si < scheds.length; si++) {
        var s = scheds[si];
        lines.push('  ' + (s.enabled ? '[on] ' : '[off]') + ' ' + s.id + '  ' + s.cron);
        lines.push('    task: ' + s.task);
        if (s.lastRun) lines.push('    last run: ' + s.lastRun);
      }
      return toolResponse(lines.join('\n'));
    }

    if (name === 'troth_schedule_remove') {
      if (!args.schedule_id) return toolResponse('Error: schedule_id is required', true);
      var sched = require('../proxy/modules/scheduler');
      var r = sched.removeSchedule(args.schedule_id);
      if (!r.ok) return toolResponse('Error: ' + r.error, true);
      return toolResponse('Removed schedule ' + args.schedule_id);
    }

    if (name === 'troth_switch') {
      if (!args.mode || !['anthropic', 'fallback', 'local', 'smart', 'auto'].includes(args.mode)) {
        return toolResponse('Error: mode must be "anthropic", "fallback", "local", "smart", or "auto"', true);
      }
      try {
        var switchResult = require('child_process').execFileSync('curl', [
          '-sf', '-X', 'POST', '-H', 'Content-Type: application/json',
          '-d', JSON.stringify({ mode: args.mode }),
          proxyBase() + '/api/routing',
        ], { stdio: 'pipe', timeout: 5000 }).toString();
        var parsed = JSON.parse(switchResult);
        if (parsed.ok) return toolResponse('Switched to ' + args.mode + ' mode.');
        return toolResponse('Error: ' + (parsed.error || 'unknown'), true);
      } catch (e) {
        return toolResponse('Error: could not reach proxy. Is it running?', true);
      }
    }

    if (name === 'troth_stats') {
      try {
        var statsResult = require('child_process').execFileSync('curl', [
          '-sf', proxyBase() + '/api/stats'
        ], { stdio: 'pipe', timeout: 5000 }).toString();
        var s = JSON.parse(statsResult);
        var summary = 'troth v' + (s.version || '?') + ' Stats:\n' +
          'Requests: ' + (s.requests || 0) + '\n' +
          'Errors: ' + (s.errors || 0) + '\n' +
          'Quality avg: ' + (s.critic && s.critic.qualityScoreAvg !== null ? s.critic.qualityScoreAvg + '/10' : 'no data') + '\n' +
          'Reflexions: ' + (s.reflexion && s.reflexion.totalStored || 0) + ' lessons stored\n' +
          'Trajectories: ' + (s.trajectory && s.trajectory.totalStored || 0) + ' patterns\n' +
          'Active workflow: ' + (s.workflow && s.workflow.task ? '"' + s.workflow.task.slice(0, 60) + '" (' + s.workflow.phase + ')' : 'none');
        return toolResponse(summary);
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    if (name === 'troth_reflections') {
      try {
        var limit = args.limit || 20;
        var reflResult = require('child_process').execFileSync('curl', [
          '-sf', proxyBase() + '/api/memory/reflexions'
        ], { stdio: 'pipe', timeout: 5000 }).toString();
        var data = JSON.parse(reflResult);
        var reflections = (data.reflections || []).slice(0, limit);
        if (!reflections.length) return toolResponse('No reflexions stored yet.');
        var text = 'Recent Reflexion Lessons:\n\n' + reflections.map(function(r) {
          return '[' + (r.tool || '?') + '] ' + r.reflection;
        }).join('\n');
        return toolResponse(text);
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    if (name === 'troth_workflow') {
      try {
        var wfResult = require('child_process').execFileSync('curl', [
          '-sf', proxyBase() + '/api/stats'
        ], { stdio: 'pipe', timeout: 5000 }).toString();
        var ws = JSON.parse(wfResult);
        var w = ws.workflow;
        if (!w || !w.task) return toolResponse('No active workflow. Workflow starts when Architect generates a plan.');
        var summary = 'Active Workflow:\nTask: ' + w.task + '\nPhase: ' + w.phase + '\n';
        if (w.completed_steps && w.completed_steps.length) {
          summary += '\nCompleted (' + w.completed_steps.length + '):\n' + w.completed_steps.map(function(s) { return '  [x] ' + s; }).join('\n');
        }
        if (w.pending_steps && w.pending_steps.length) {
          summary += '\nPending (' + w.pending_steps.length + '):\n' + w.pending_steps.map(function(s) { return '  [ ] ' + s; }).join('\n');
        }
        return toolResponse(summary);
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    if (name === 'troth_cost') {
      try {
        var costResult = require('child_process').execFileSync('curl', [
          '-sf', proxyBase() + '/api/stats'
        ], { stdio: 'pipe', timeout: 5000 }).toString();
        var s = JSON.parse(costResult);
        var c = s.cost || {};
        var pm = c.perModel || {};
        var keys = Object.keys(pm);
        if (!keys.length) return toolResponse('No usage tracked this session yet.');
        var lines = ['Session cost: $' + (c.grandTotalUSD || 0)];
        for (var k = 0; k < keys.length; k++) {
          var t = pm[keys[k]];
          lines.push('  ' + keys[k] + ': ' + t.requests + ' reqs, ' + t.input + ' in / ' + t.output + ' out, $' + t.cost);
        }
        return toolResponse(lines.join('\n'));
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    if (name === 'troth_complexity') {
      if (!args.task) return toolResponse('Error: task required', true);
      try {
        var routelm = require('../proxy/modules/routelm');
        var score = routelm.scoreTaskComplexity(args.task, 0);
        var tier = routelm.suggestTier(score);
        return toolResponse('Complexity: ' + score + '/10\nRecommended tier: ' + tier +
          '\n(cheap = fast/cheap model, mid = balanced, strong = best reasoning model)');
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    if (name === 'troth_buildinfo') {
      try {
        var bg = require('../proxy/modules/buildgraph');
        bg.init(process.cwd());
        var ctx = bg.getContext();
        if (!ctx) return toolResponse('No build system detected in current directory.');
        return toolResponse(ctx);
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    if (name === 'troth_clear_memory') {
      if (!args.what || !['reflexions', 'workflow', 'all'].includes(args.what)) {
        return toolResponse('Error: what must be "reflexions", "workflow", or "all"', true);
      }
      try {
        var cleared = [];
        if (args.what === 'workflow' || args.what === 'all') {
          require('child_process').execFileSync('curl', [
            '-sf', '-X', 'DELETE', proxyBase() + '/api/memory/workflow'
          ], { stdio: 'pipe', timeout: 5000 });
          cleared.push('workflow state');
        }
        if (args.what === 'reflexions' || args.what === 'all') {
          require('child_process').execFileSync('curl', [
            '-sf', '-X', 'DELETE', '-H', 'X-Confirm-Clear: yes',
            proxyBase() + '/api/memory/reflexions'
          ], { stdio: 'pipe', timeout: 5000 });
          cleared.push('reflexions');
        }
        return toolResponse('Cleared: ' + cleared.join(', '));
      } catch (e) { return toolResponse('Error: ' + e.message, true); }
    }

    return toolResponse('Unknown tool: ' + name, true);
  } catch (e) {
    return toolResponse('Tool threw: ' + (e.message || String(e)), true);
  }
}

// Remote tool dispatch — HTTP calls to the daemon's /api/runs endpoints.
// Returns a PROMISE (the MCP handler below awaits it).
async function callToolRemote(name, args) {
  try {
    if (name === 'troth_run') {
      if (!args.task) return toolResponse('Error: task is required', true);
      var r = await remoteApiCall('POST', '/api/runs', { task: args.task, options: { cwd: args.cwd } }, REMOTE);
      if (r.ok) {
        var m = r.meta || {};
        return toolResponse(
          'Started troth run on ' + REMOTE.host + '.\n' +
          'run_id: ' + (r.runId || m.id || '?') + '\n' +
          'task: ' + (m.task || args.task) + '\n' +
          (m.branch ? 'branch: ' + m.branch + '\n' : '') +
          'started_at: ' + (m.started_at || 'now') + '\n\n' +
          'Worker is running on the remote host. Use troth_status to check progress.'
        );
      }
      return toolResponse('Error: ' + (r.error || 'unknown remote error'), true);
    }

    if (name === 'troth_list') {
      var r = await remoteApiCall('GET', '/api/runs', null, REMOTE);
      if (!r.ok) return toolResponse('Error: ' + (r.error || 'failed'), true);
      var runs = r.runs || [];
      if (runs.length === 0) return toolResponse('No troth runs on ' + REMOTE.host + '.');
      var lines = ['troth runs on ' + REMOTE.host + ' (' + runs.length + '):'];
      for (var i = 0; i < runs.length; i++) {
        lines.push('  [' + runs[i].state + '] ' + runs[i].id);
        lines.push('    ' + (runs[i].task || '').slice(0, 200));
      }
      return toolResponse(lines.join('\n'));
    }

    if (name === 'troth_status') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = await remoteApiCall('GET', '/api/runs/' + encodeURIComponent(args.run_id), null, REMOTE);
      if (!r.ok) return toolResponse('Error: ' + (r.error || 'not found'), true);
      var m = r.meta || {};
      var lines = ['run_id: ' + m.id, 'state: ' + r.state, 'task: ' + m.task];
      if (m.branch) lines.push('branch: ' + m.branch);
      if (r.summary) {
        lines.push('log_lines: ' + r.summary.lines);
        if (r.summary.lastLine) lines.push('last: ' + r.summary.lastLine);
      }
      return toolResponse(lines.join('\n'));
    }

    if (name === 'troth_logs') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var tail = typeof args.tail_bytes === 'number' ? '?tail=' + args.tail_bytes : '';
      var r = await remoteApiCall('GET', '/api/runs/' + encodeURIComponent(args.run_id) + '/logs' + tail, null, REMOTE);
      if (!r.ok) return toolResponse('Error: ' + (r.error || 'failed'), true);
      return toolResponse(r.logs || '(empty)');
    }

    if (name === 'troth_diff') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = await remoteApiCall('GET', '/api/runs/' + encodeURIComponent(args.run_id) + '/diff', null, REMOTE);
      if (!r.ok) return toolResponse('Error: ' + (r.error || 'failed'), true);
      return toolResponse(r.diff || '(no changes)');
    }

    if (name === 'troth_kill') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = await remoteApiCall('POST', '/api/runs/' + encodeURIComponent(args.run_id) + '/kill', null, REMOTE);
      return toolResponse(r.ok ? 'Killed ' + args.run_id + ' on ' + REMOTE.host : 'Error: ' + (r.error || 'failed'), !r.ok);
    }

    if (name === 'troth_clean') {
      if (!args.run_id) return toolResponse('Error: run_id is required', true);
      var r = await remoteApiCall('DELETE', '/api/runs/' + encodeURIComponent(args.run_id), null, REMOTE);
      return toolResponse(r.ok ? 'Cleaned ' + args.run_id + ' on ' + REMOTE.host : 'Error: ' + (r.error || 'failed'), !r.ok);
    }

    return toolResponse('Unknown tool: ' + name, true);
  } catch (e) {
    return toolResponse('Remote error: ' + (e.message || String(e)), true);
  }
}

// JSON-RPC dispatch — handle incoming messages and respond.
function handleMessage(msg) {
  // Notifications have no id and don't require a response.
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'initialize') {
    send(rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }

  if (method === 'notifications/initialized') {
    // Notification — no response.
    return;
  }

  if (method === 'tools/list') {
    send(rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    const result = callTool(toolName, toolArgs);
    // callTool may return a promise (remote mode) or a plain object (local).
    if (result && typeof result.then === 'function') {
      result.then(function(r) { send(rpcResult(id, r)); })
            .catch(function(e) { send(rpcResult(id, toolResponse('Error: ' + e.message, true))); });
    } else {
      send(rpcResult(id, result));
    }
    return;
  }

  if (method === 'ping') {
    send(rpcResult(id, {}));
    return;
  }

  // Unknown method — respond with the standard error code if there's an id.
  if (id !== undefined) {
    send(rpcError(id, -32601, 'method not found: ' + method));
  }
}

// Read JSON-RPC messages from stdin, one per line.
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line || !line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stderr.write('[troth mcp] bad json from client: ' + line.slice(0, 200) + '\n');
    return;
  }
  try {
    handleMessage(msg);
  } catch (e) {
    process.stderr.write('[troth mcp] handler threw: ' + e.message + '\n');
    if (msg && msg.id !== undefined) {
      send(rpcError(msg.id, -32603, 'internal error: ' + e.message));
    }
  }
});

rl.on('close', () => {
  process.exit(0);
});

process.stderr.write('[troth mcp] server started — version ' + SERVER_VERSION + '\n');
