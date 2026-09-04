#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 troth-router — lightweight deferral MCP.
// A single MCP server that exposes THREE compact tools (`mcp_list`,
// `mcp_describe`, `mcp_call`) and proxies to an arbitrary set of real stdio
// MCPs on demand. The point: replace N heavy MCP schemas in the agent's locked
// prefix with one ~500-token schema for the router. Downstream servers are
// defined in ~/.troth/router.json (same shape as .claude/settings.json
// mcpServers). They're spawned lazily the first time the agent calls
// `mcp_list(server)` or `mcp_call(...)` and kept warm until the router process
// exits.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOME = homedir();
const _greet = createRequire(import.meta.url)(fileURLToPath(new URL('../../../shared-core/mcp-greeting.js', import.meta.url))).makeGreeter();
const ROUTER_CONFIG = process.env.TROTH_ROUTER_CONFIG || join(HOME, '.troth', 'router.json');
const DATA_DIR = join(HOME, '.troth');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// #42 — OSS fresh-install provisioning. Substrate + memory RECALL reach agents
// through THIS router's downstream (~/.troth/router.json). A freshly-installed
// open-source user has no router.json → loadDownstream() returns {} → recall is
// silently EMPTY. So if it's missing, write a default pointing at the plugin's
// OWN bundled servers (resolved from CLAUDE_PLUGIN_ROOT, else this file's
// location: <root>/mcp-servers/troth-router/server.mjs → <root>).
// NEVER overwrites an existing config — the operator's router.json always wins
// (the installers, shared-core/mcp-hosts.js + the app, heal OUR entries on
// every wire, so a stale default never freezes in).
// command = process.execPath, NOT bare 'node':
// hooks/servers can run under a GUI-minimal PATH with no node at all, and a
// PATH node can be a different major than the one that built better-sqlite3.
// The runtime executing THIS router is a working node by definition (bundled
// on app installs, the user's own on repo installs) and the downstream
// inherits the same ABI. Same pattern as troth-entity/server.mjs.
function provisionDefaultRouterConfig() {
  if (existsSync(ROUTER_CONFIG)) return healRouterConfig();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
    || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = (name, env) => {
    const spec = { command: process.execPath, args: [join(pluginRoot, 'mcp-servers', name, 'server.mjs')] };
    if (env) spec.env = env;
    return spec;
  };
  const def = { mcpServers: {
    // Action-capable tools (image generation over the operator's own ChatGPT
    // plan or Google key, MCP staging) live behind TROTH_MCP_ACTIONS. Spawning
    // the substrate without it meant the tools simply did not exist: an agent
    // asked to make an image answered "I don't have that" and was telling the
    // truth, even though the product page advertises the feature (operator
    // report). Staging stays inert by construction and image
    // generation uses the operator's own credentials, so default it ON.
    'troth-substrate': srv('troth-substrate', { TROTH_MCP_ACTIONS: '1' }),
    'troth-memory': srv('troth-memory'),
    'troth-entity': srv('troth-entity'),
  } };
  try { writeFileSync(ROUTER_CONFIG, JSON.stringify(def, null, 2)); }
  catch (_) { /* best-effort — loadDownstream() just returns {} if this failed */ }
}

// Existing installs get the SAME capabilities as new ones.
//
// The line above returns early when a config is already on disk, which is
// right for anything the operator may have edited (their own servers, their
// own commands) but wrong for a capability the product now ships by default:
// every user who had ever run troth kept a troth-substrate entry with no
// TROTH_MCP_ACTIONS, so image generation stayed missing for them forever while
// only brand-new installs got it — the SECOND time this feature was
// reported absent. Heal exactly that one field, additively:
// an entry that already sets the flag (to anything, including '0') is left
// alone, and nothing else in the file is touched.
function healRouterConfig() {
  try {
    const raw = readFileSync(ROUTER_CONFIG, 'utf8');
    const cfg = JSON.parse(raw);
    const sub = cfg && cfg.mcpServers && cfg.mcpServers['troth-substrate'];
    if (!sub || (sub.env && Object.prototype.hasOwnProperty.call(sub.env, 'TROTH_MCP_ACTIONS'))) return;
    sub.env = Object.assign({}, sub.env, { TROTH_MCP_ACTIONS: '1' });
    writeFileSync(ROUTER_CONFIG, JSON.stringify(cfg, null, 2));
  } catch (_) { /* best-effort: a malformed config is the user's to fix */ }
}
provisionDefaultRouterConfig();

function loadDownstream() {
  if (!existsSync(ROUTER_CONFIG)) return {};
  try {
    const cfg = JSON.parse(readFileSync(ROUTER_CONFIG, 'utf8'));
    return cfg.mcpServers || {};
  } catch (e) { return {}; }
}

// Warm-pool of spawned downstream servers. { name → { proc, nextId, pending } }
const pool = new Map();

function startDownstream(name, spec) {
  if (!spec.command) throw new Error('downstream ' + name + ' has no command');
  const env = Object.assign({}, process.env, spec.env || {});
  const proc = spawn(spec.command, spec.args || [], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const state = { proc, nextId: 1, pending: new Map(), buffer: '', ready: false };
  // Keep the child's own words. Without this a failed start could only report
  // "init timeout", which says nothing about WHY — and the why (a native
  // module built for another Node, a moved checkout, a permissions change) is
  // the entire diagnosis. Bounded so a chatty child cannot grow memory.
  state.stderr = '';
  try {
    proc.stderr.on('data', (c) => {
      if (state.stderr.length < 4000) state.stderr += c.toString('utf8');
    });
  } catch (_) { /* no stderr stream: nothing to capture */ }
  proc.on('error', (e) => { state.spawnError = (e && e.message) || String(e); });
  proc.on('exit', (code, sig) => { state.exited = 'exit code ' + code + (sig ? ' signal ' + sig : ''); });

  proc.stdout.on('data', (chunk) => {
    state.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && state.pending.has(msg.id)) {
          const { resolve, reject } = state.pending.get(msg.id);
          state.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) { /* ignore */ }
    }
  });
  proc.on('exit', () => pool.delete(name));
  proc.stderr.on('data', () => {}); // swallow — downstream logs aren't ours to surface

  // Initialize synchronously so the first tools/list call is fast.
  const initId = state.nextId++;
  return new Promise((resolve, reject) => {
    state.pending.set(initId, {
      resolve: () => { state.ready = true; pool.set(name, state); resolve(state); },
      reject
    });
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'troth-router', version: '1.0.0' }
      }
    }) + '\n');
    // Surface the child's real failure, not the symptom. An immediate crash
    // and a genuine hang both land here; the stderr tail tells them apart.
    setTimeout(() => reject(new Error('substrate did not answer initialize'
      + (state.spawnError ? ' (spawn failed: ' + state.spawnError + ')' : '')
      + (state.exited ? ' (process exited: ' + state.exited + ')' : '')
      + (state.stderr ? ' stderr: ' + state.stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 400) : ''))), 10000);
  });
}

// A downstream that will not start is the most expensive failure in the
// product, because it does not look like a failure. The model asks memory a
// question, gets a raw transport error, concludes the substrate is not
// available, and falls back to grepping files — a field report cost 100k
// tokens exactly this way, on an install whose router.json was correct. The
// cause varies (a native module built against another Node ABI, a moved
// checkout, a permissions change); the CURE is the same for all of them: say
// what happened and what fixes it, in words the model will not mistake for
// "there is no memory here".
function downstreamHelp(name, detail) {
  const d = String(detail || '').slice(0, 300);
  const abi = /NODE_MODULE_VERSION|was compiled against a different Node|invalid ELF|\.node/i.test(d)
    ? ' The native module was built for a different Node than the one running it — `npm rebuild better-sqlite3` in the troth checkout, using that same Node.'
    : '';
  return 'The troth substrate (' + name + ') is CONFIGURED but did not start, so memory is temporarily unreachable. '
       + 'This is NOT an empty memory and NOT a missing feature: do not fall back to grepping files or reading state.db. '
       + 'Tell the operator to run `troth doctor` in the troth checkout.' + abi
       + ' Underlying error: ' + d;
}

async function getDownstream(name) {
  if (pool.has(name)) return pool.get(name);
  const downstream = loadDownstream();
  if (!downstream[name]) {
    const known = Object.keys(downstream).join(', ') || '(none configured)';
    throw new Error('unknown downstream server: ' + name + '. Configured: ' + known
      + '. If the substrate is missing from ~/.troth/router.json, run `troth install-plugin` to reprovision it.');
  }
  try {
    return await startDownstream(name, downstream[name]);
  } catch (e) {
    throw new Error(downstreamHelp(name, e && e.message || e));
  }
}

// A flat 30s ceiling suits metadata calls and lies about generative ones.
// Image generation runs 60-120s on the plan endpoint, so the gateway rejected
// while the downstream was still working: the PNG landed in ~/.troth/images/
// and the agent was told "timeout", i.e. reported a failure that had actually
// succeeded. Slow-by-nature tools get a ceiling
// that matches what they really take.
const RPC_TIMEOUT_MS = 30000;
const SLOW_TOOL_TIMEOUT_MS = 300000;
const SLOW_TOOLS = /(^|_)(image_generate|intent_emit|browser)/;

function timeoutFor(method, params) {
  if (method !== 'tools/call') return RPC_TIMEOUT_MS;
  const name = (params && params.name) || '';
  return SLOW_TOOLS.test(name) ? SLOW_TOOL_TIMEOUT_MS : RPC_TIMEOUT_MS;
}

async function rpc(state, method, params) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error('downstream rpc timeout: ' + method));
      }
    }, timeoutFor(method, params));
  });
}

// ── MCP tool definitions we expose upstream ─────────────────────────────
const OUR_TOOLS = [
  {
    name: 'mcp_list',
    description: 'List the tools available on a downstream MCP server (names + one-line descriptions only).',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string', description: 'Name of a configured downstream server.' } },
      required: ['server']
    }
  },
  {
    name: 'mcp_describe',
    description: 'Return the full schema (inputSchema, description) of one downstream tool. Call this before mcp_call when you are unsure what arguments a tool takes — mcp_list gives you only a truncated one-liner.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Downstream server name as it appears in mcp_list, e.g. "troth-substrate" or "troth-memory"' },
        tool: { type: 'string', description: 'Exact tool name on that server, e.g. "troth_engram_record"' }
      },
      required: ['server', 'tool']
    }
  },
  {
    name: 'mcp_call',
    description: 'Invoke a tool on a downstream MCP server. This is the gateway: on router-only installs the substrate tools are NOT in your tool list, and this is how you reach them — e.g. mcp_call({server:"troth-substrate", tool:"troth_engram_record", args:{statement:"…"}}). Discover names with mcp_list, argument shapes with mcp_describe. A tool missing from your list does NOT mean the substrate is down.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Downstream server name, e.g. "troth-substrate" (engrams, recall, dialogue, slash) or "troth-memory" (ActionRecords, working set)' },
        tool: { type: 'string', description: 'Exact tool name on that server' },
        args: { type: 'object', description: 'Arguments object passed through verbatim, exactly as that tool\'s own schema defines them' }
      },
      required: ['server', 'tool']
    }
  },
  // First-class, NOT gateway-only. The image tool lived solely behind
  // mcp_call(troth-substrate, ...), so a pane's tools/list showed nothing
  // image-shaped and the model honestly answered "I have no image tool"
  // and hand-built prompts for the operator to paste into ChatGPT instead
  // the SECOND time this feature was reported missing after it was
  // "fixed". A capability
  // the model cannot see in tools/list does not exist; discoverability is
  // part of the feature. This entry only NAMES it upstream — the call is
  // delegated verbatim to troth-substrate, so governance and the plan-side
  // token load stay exactly where they were.
  {
    name: 'troth_image_generate',
    description: 'Generate an image from a text prompt using the operator\'s linked ChatGPT plan or their Google AI key, and save it as a PNG under ~/.troth/images/. Returns the saved file path. Use when the user asks to create, draw, render or edit an image. Slow (up to a few minutes) — tell the user it is running.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate. Be specific: subject, style, composition.' },
        source: { type: 'string', enum: ['chatgpt', 'google'], description: 'Optional. Omit to pick automatically (plan first, key as fallback).' }
      },
      required: ['prompt']
    }
  },
  // Same promotion as troth_image_generate above, for the same reported
  // failure: memory lived solely behind mcp_call(troth-substrate, …) whose
  // description never says the word memory, so panes answered "what did we
  // decide about X" by grepping files through troth-bash — or worse, by
  // opening state.db raw. A capability the model cannot see in tools/list
  // does not exist. This entry only NAMES it upstream; the call is
  // delegated verbatim to troth-substrate, so governance stays put.
  {
    name: 'troth_recall',
    description: 'USE INSTEAD OF grepping files or reading state.db for memory questions. Recall from the partner\'s persistent substrate memory: prior work, past decisions, operator preferences, lessons, anything "we did/said before". Class-routed (identity / episodic / semantic / procedural, default all) with cross-encoder rerank. Call it BEFORE claiming something is unknown or re-deriving prior work.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Natural-language query.' },
        class:  { type: 'string', enum: ['identity', 'episodic', 'semantic', 'procedural', 'all'], description: 'Memory class to route to; default "all".' },
        limit:  { type: 'integer', minimum: 1, maximum: 50, description: 'Max items (default 5).' },
        cwd:    { type: 'string' }
      },
      required: ['query']
    }
  }
];

// ── Handlers for our own tools ──────────────────────────────────────────
async function handleTool(name, args) {
  if (name === 'mcp_list') {
    const state = await getDownstream(args.server);
    const tools = await rpc(state, 'tools/list', {});
    return { content: [{ type: 'text', text: JSON.stringify((tools.tools || []).map(t => ({ name: t.name, description: (t.description || '').slice(0, 120) })), null, 2) }] };
  }
  if (name === 'mcp_describe') {
    const state = await getDownstream(args.server);
    const tools = await rpc(state, 'tools/list', {});
    const match = (tools.tools || []).find(t => t.name === args.tool);
    if (!match) throw new Error('tool ' + args.tool + ' not found on ' + args.server);
    return { content: [{ type: 'text', text: JSON.stringify(match, null, 2) }] };
  }
  if (name === 'mcp_call') {
    const state = await getDownstream(args.server);
    const result = await rpc(state, 'tools/call', { name: args.tool, arguments: args.args || {} });
    return result;
  }
  if (name === 'troth_image_generate') {
    // Delegate verbatim to the substrate's governed implementation; the
    // SLOW_TOOLS timeout already covers image_generate by name.
    const state = await getDownstream('troth-substrate');
    return await rpc(state, 'tools/call', { name: 'troth_image_generate', arguments: args || {} });
  }
  if (name === 'troth_recall') {
    // Delegate verbatim, like the image tool: promotion is discoverability,
    // not a second implementation.
    const state = await getDownstream('troth-substrate');
    return await rpc(state, 'tools/call', { name: 'troth_recall', arguments: args || {} });
  }
  throw new Error('unknown router tool: ' + name);
}

// ── Upstream MCP loop (stdin / stdout JSON-RPC) ─────────────────────────
let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  inputBuffer += chunk;
  let idx;
  while ((idx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, idx);
    inputBuffer = inputBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    await handleUpstream(msg);
  }
});

async function handleUpstream(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  };
  const replyError = (err) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: String(err && err.message || err) }
    }) + '\n');
  };

  try {
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'troth-router', version: '1.0.0' },
        // The protocol's own always-read: clients that honor the field put it
        // in front of the model without costing a file anywhere. Curated and
        // SHORT on purpose — a contract, not a manual; the tools document
        // themselves in the listing.
        instructions:
          'This machine runs troth: a persistent substrate that remembers ' +
          'decisions, preferences and prior work across sessions. For any ' +
          '"do you remember / what did we decide / have we built X" question, ' +
          'call troth_recall BEFORE reading or grepping CLAUDE.md, memory/*.md ' +
          'or project files — the substrate holds more than those files do, and ' +
          'blocks marked [troth/...] in your context are its ground truth. ' +
          'Tools not in your list are reachable via mcp_list / mcp_call.'
      });
    } else if (msg.method === 'tools/list') {
      reply({ tools: OUR_TOOLS });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      const result = await handleTool(name, args || {});
      reply(_greet(result));
    } else if (msg.method === 'ping') {
      reply({});
    } else {
      reply({});
    }
  } catch (e) { replyError(e); }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
