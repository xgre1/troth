// SPDX-License-Identifier: AGPL-3.0-only
// mcp-client — embed an MCP client INSIDE the entity, so the language
// faculty can call any MCP-conformant tool the user has configured.
//
// Why a client at this layer (not via troth-router):
//   troth-router IS an MCP server itself. To use it, you need an MCP
//   client. The voice-app stack is one such client. But the entity
//   running standalone (Mode A) is not behind another MCP — it IS the
//   agent. To reach external MCPs (context7, codebase-memory, fs,
//   bash sandboxes, etc.) the entity needs its own client.
//
// These are the partner's "extra hands." Surface exposed to the model
// (4 tools, <=500 token schema each):
//   mcp_list({server})              → tool inventory of a downstream
//   mcp_describe({server, tool})    → full schema of one downstream tool
//   mcp_call({server, tool, args})  → invoke a downstream tool (GOVERNED)
//   mcp_register_request({name, config, note?}) → STAGE a new server for
//     operator approval (writes only the inert pending file; see the
//     staged-registration section below)
//
// Same shape as troth-router. We deliberately do NOT lift each
// downstream tool into the model's tools[] — that explodes the prompt
// budget. The model uses mcp_list to discover, then mcp_call to invoke.
//
// GOVERNANCE. Before this change
// mcp_call executed UNGOVERNED - it spawned the downstream and ran
// tools/call outside the STVC intent system, so the partner could take
// arbitrary real-world action through any configured server with no
// capability wall, no observation engram, no kill-switch. mcp_call now
// routes through intent.writeIntent + dispatcher.dispatchOne under scope
// 'intent:mcp:call:<server>', exactly like intent_emit's HTTP path: the
// file DECLARES the server (registry), the operator-sealed capability
// AUTHORIZES it (capability:mcp:<server>). mcp_list / mcp_describe stay
// DIRECT - they are read-only discovery, no side effect, no round-trip.
//
// Config, layered (Claude Code-compatible):
//   GLOBAL  : ~/.troth/mcp-clients.json
//   PROJECT : <workspace>/.mcp.json   (workspace = ctx.cwd)
// Both use the mcpServers block shape:
//   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} }
//                     OR         { "type": "http"|"sse", "url": "..." } } }
// Project entries WIN name collisions (a repo pins the exact server it
// wants; the global config is the fallback). We only ever READ these
// files - this module never writes an ACTIVE registry file (a partner-
// written entry would be self-authorization; path-policy also blocks the
// path). The ONLY file this module writes is the inert PENDING file
// (staged registration, below), which loadDownstream never reads.
//
// Process management: spawn-on-first-use, kept warm in a pool until the
// node process exits. Identical pattern to plugin/mcp-servers/troth-router/server.mjs:36-88.

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_CONFIG_PATH = path.join((process.env.HOME || os.homedir()), '.troth', 'mcp-clients.json');
const PROJECT_CONFIG_BASENAME = '.mcp.json';
const RPC_TIMEOUT_MS   = 30 * 1000;
const INIT_TIMEOUT_MS  = 10 * 1000;

const pool = new Map();  // name → state { proc, nextId, pending, buffer }

// Read + parse one mcpServers file. Returns {} on absent/unreadable/malformed
// (never throws - a broken project file must not brick discovery of the
// global one). Reading ONLY, per the  audit: this module must
// never persist a registry file.
function _readServersFile(p) {
  if (!p || !fs.existsSync(p)) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object') ? cfg.mcpServers : {};
  } catch (_) { return {}; }
}

// Merge global ~/.troth/mcp-clients.json with the per-project
// <workspace>/.mcp.json. workspace is threaded from ctx.cwd. Project
// entries win name collisions (see header). Absent files are fine.
function loadDownstream(configPath, workspace) {
  const globalPath = configPath || process.env.TROTH_MCP_CLIENTS_CONFIG || DEFAULT_CONFIG_PATH;
  const globalServers = _readServersFile(globalPath);
  let projectServers = {};
  if (workspace && typeof workspace === 'string') {
    projectServers = _readServersFile(path.join(workspace, PROJECT_CONFIG_BASENAME));
  }
  // Project last so its keys overwrite global keys on collision.
  return Object.assign({}, globalServers, projectServers);
}

// ── Staged registration ─────────
//
// Product shape: the operator pastes an MCP config snippet in chat, the
// partner STAGES it via mcp_register_request, the operator approves ONCE
// (`troth mcp approve <name>`; the desktop app shells out to the same
// command headlessly). Approval moves the entry into the ACTIVE registry
// and seals capability:mcp:<name>. No Settings form, no JSON editing.
//
// SECURITY INVARIANT: the partner must never be able to ACTIVATE a
// server itself. The active registry (~/.troth/mcp-clients.json) stays
// partner-write-blocked (path-policy + bash-safety, pinned by suite-18).
// The PENDING file (~/.troth/mcp-pending.json) is INERT by construction:
// loadDownstream above reads ONLY the global + project files, never this
// one, so a staged entry can never resolve for mcp_list/mcp_call. That
// is why path-policy deliberately leaves the pending file (and its .tmp)
// partner-writable. Staging is a typed, validated parking lot; the
// operator approval is the security boundary. $vault env refs are stored
// VERBATIM here and resolve only at spawn time (after activation),
// never at stage time.
//
// File shape mirrors the registry ({"mcpServers":{...}}) so an approved
// entry moves over unchanged, plus a sibling "notes" map
// ({name: {note, requested_at}}) that never migrates into the active
// file. All writes are atomic (same-directory temp + rename) at 0600.

const DEFAULT_PENDING_PATH = path.join((process.env.HOME || os.homedir()), '.troth', 'mcp-pending.json');

function _pendingPath() {
  return process.env.TROTH_MCP_PENDING_CONFIG || DEFAULT_PENDING_PATH;
}

// The ACTIVE global registry path, resolved exactly the way loadDownstream
// resolves it (env override first) so approve writes where discovery reads.
function _activeGlobalPath() {
  return process.env.TROTH_MCP_CLIENTS_CONFIG || DEFAULT_CONFIG_PATH;
}

// Read a whole registry-shaped file (not just .mcpServers - the pending
// file carries a sibling "notes" map). {} on absent/unreadable/malformed.
function _readRegistryObject(p) {
  if (!p || !fs.existsSync(p)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (_) { return {}; }
}

// Atomic + private: temp file in the SAME directory (rename must not
// cross devices), mode 0600 (a config may carry plain env values),
// rename last so readers never see a torn file.
function _writeRegistryObjectAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

const PENDING_NAME_RE = /^[a-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Validate an env spec WITHOUT resolving anything. Values may be plain
// primitives, "$vault:KEY" strings, or {"$vault":"KEY"} objects; the
// refs stay verbatim until spawn time (post-activation, vault-gated by
// capability:mcp:<server> in _resolveEnvSpec). Returns null or an error.
function _validateEnvShape(env) {
  if (env === undefined) return null;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return 'env must be an object';
  for (const k of Object.keys(env)) {
    if (!ENV_KEY_RE.test(k)) return 'env key "' + k + '" is not a valid variable name';
    const v = env[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)
        && Object.keys(v).length === 1 && typeof v.$vault === 'string' && v.$vault.length) continue;
    return 'env.' + k + ' must be a string/number/boolean or {"$vault":"KEY"}';
  }
  return null;
}

// Strict validation + normalization into a CLEAN entry holding only the
// keys _toSpawnSpec understands - nothing else rides along into the
// registry. Accepts the two shapes _toSpawnSpec normalizes:
//   remote: {type|transport:"http"|"sse", url, env?}
//   stdio:  {command, args?, env?}
// Returns { config } on success or { error } with a paste-back-able
// reason (the partner relays it when the operator's snippet is off).
function _normalizeRegisterConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { error: 'config must be an object' };
  }
  const transport = String(config.type || config.transport || '').toLowerCase();
  if (transport === 'http' || transport === 'sse') {
    for (const k of Object.keys(config)) {
      if (k !== 'type' && k !== 'transport' && k !== 'url' && k !== 'env') {
        return { error: 'unsupported key "' + k + '" for an http/sse entry (allowed: type, url, env)' };
      }
    }
    if (typeof config.url !== 'string' || !/^https?:\/\/\S+$/.test(config.url)) {
      return { error: 'http/sse entry needs a valid http(s) url' };
    }
    const envErr = _validateEnvShape(config.env);
    if (envErr) return { error: envErr };
    const out = { type: transport, url: config.url };
    if (config.env !== undefined) out.env = Object.assign({}, config.env);
    return { config: out };
  }
  if (transport) {
    return { error: 'unsupported transport "' + transport + '" (use http, sse, or a stdio {command,...} entry)' };
  }
  for (const k of Object.keys(config)) {
    if (k !== 'command' && k !== 'args' && k !== 'env') {
      return { error: 'unsupported key "' + k + '" for a stdio entry (allowed: command, args, env)' };
    }
  }
  if (typeof config.command !== 'string' || !config.command.trim().length) {
    return { error: 'stdio entry needs a non-empty command string' };
  }
  if (config.args !== undefined
      && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string'))) {
    return { error: 'args must be an array of strings' };
  }
  const envErr = _validateEnvShape(config.env);
  if (envErr) return { error: envErr };
  const out = { command: config.command };
  if (config.args !== undefined) out.args = config.args.slice();
  if (config.env !== undefined) out.env = Object.assign({}, config.env);
  return { config: out };
}

// Merge one already-validated entry into the pending file. Duplicate
// pending name: overwrite, latest wins (the operator approves whatever
// is staged at approval time; a stale note must not survive the swap).
function stagePendingServer(name, config, note) {
  const p = _pendingPath();
  const obj = _readRegistryObject(p);
  if (!obj.mcpServers || typeof obj.mcpServers !== 'object') obj.mcpServers = {};
  obj.mcpServers[name] = config;
  if (note) {
    if (!obj.notes || typeof obj.notes !== 'object') obj.notes = {};
    obj.notes[name] = { note: String(note).slice(0, 500), requested_at: Date.now() };
  } else if (obj.notes) {
    delete obj.notes[name];
  }
  _writeRegistryObjectAtomic(p, obj);
  return { path: p };
}

// Flat view of the staged entries for the operator surfaces (CLI, app).
function listPendingServers() {
  const obj = _readRegistryObject(_pendingPath());
  const servers = (obj.mcpServers && typeof obj.mcpServers === 'object') ? obj.mcpServers : {};
  const notes = (obj.notes && typeof obj.notes === 'object') ? obj.notes : {};
  return Object.keys(servers).map((name) => ({
    name,
    transport: (servers[name] && (servers[name].type || servers[name].transport))
      ? String(servers[name].type || servers[name].transport) : 'stdio',
    config: servers[name],
    note: notes[name] ? notes[name].note : null,
    requested_at: notes[name] ? notes[name].requested_at : null
  }));
}

// Operator-side move pending → active. NOT reachable from any partner
// tool: only bin/cmd-mcp.js (operator CLI, signer-gated) calls this.
// Order: activate first, then un-stage; a crash in between leaves the
// entry in both files, which is safe (pending stays inert) and self-
// heals on the next approve/reject. Both writes are atomic.
function approvePendingServer(name) {
  const pendingPath = _pendingPath();
  const pending = _readRegistryObject(pendingPath);
  const entry = pending.mcpServers && pending.mcpServers[name];
  if (!entry) return { ok: false, reason: 'not_pending', name };
  const activePath = _activeGlobalPath();
  const active = _readRegistryObject(activePath);
  if (!active.mcpServers || typeof active.mcpServers !== 'object') active.mcpServers = {};
  active.mcpServers[name] = entry;
  _writeRegistryObjectAtomic(activePath, active);
  delete pending.mcpServers[name];
  if (pending.notes) delete pending.notes[name];
  _writeRegistryObjectAtomic(pendingPath, pending);
  return { ok: true, name, config: entry, active_path: activePath, pending_path: pendingPath };
}

// Operator-side discard of a staged entry.
function rejectPendingServer(name) {
  const pendingPath = _pendingPath();
  const pending = _readRegistryObject(pendingPath);
  if (!pending.mcpServers || !pending.mcpServers[name]) return { ok: false, reason: 'not_pending', name };
  delete pending.mcpServers[name];
  if (pending.notes) delete pending.notes[name];
  _writeRegistryObjectAtomic(pendingPath, pending);
  return { ok: true, name };
}

// Translate a downstream spec into a concrete stdio spawn spec:
// {command, args, env}. Two shapes are normalized here:
//   (1) HTTP/SSE transport ({type|transport:"http"|"sse", url}) - our
//       embedded client speaks stdio JSON-RPC only, so we bridge the
//       remote server through the community `mcp-remote` stdio<->http
//       proxy (npx -y mcp-remote <url>). This is the same bridge Claude
//       Code uses for http servers behind a stdio-only client.
//   (2) stdio ({command, args, env}) - passed through unchanged.
// $vault env references are resolved LATER (at spawn, in _resolveEnvSpec)
// so a locked vault degrades to a skipped var + warning rather than a
// resolve-time throw here.
function _toSpawnSpec(name, spec) {
  spec = spec || {};
  const transport = String(spec.type || spec.transport || '').toLowerCase();
  if ((transport === 'http' || transport === 'sse') && spec.url) {
    // WHY npx mcp-remote: our client is stdio-only today (startDownstream
    // writes JSON-RPC to child stdin). mcp-remote is the standard stdio
    // bridge to a remote http/sse MCP endpoint. env still flows through so
    // a bridged server can carry $vault-resolved auth.
    return { command: 'npx', args: ['-y', 'mcp-remote', String(spec.url)], env: spec.env || {} };
  }
  return { command: spec.command, args: spec.args || [], env: spec.env || {} };
}

// Resolve an env spec ({KEY: value|{"$vault":"NAME"}|"$vault:NAME"}) into
// a concrete {KEY: string} map. A $vault reference is looked up at spawn
// time via vault.getValueByKey, gated by a capability:mcp:<server> scope
// (the entry's capability_scope_glob must cover it). Returns
// {env, warnings}. HARD RULES:
//   - NEVER throw: a locked/missing vault SKIPS that var and records a
//     warning; the child simply spawns without it (fail-closed - better a
//     missing credential than a crash mid-dispatch).
//   - NEVER log the resolved value anywhere; only the KEY name + reason go
//     into the warning string.
// Pure + side-effect-free w.r.t. the vault (read-only), so it is exported
// for direct unit testing without spawning a process.
function _resolveEnvSpec(envSpec, serverName) {
  const out = {};
  const warnings = [];
  if (!envSpec || typeof envSpec !== 'object') return { env: out, warnings };
  let vault = null;
  try { vault = require('../vault.js'); } catch (_) { vault = null; }
  const capScope = 'capability:mcp:' + String(serverName || '');
  for (const key of Object.keys(envSpec)) {
    const raw = envSpec[key];
    let vaultKey = null;
    if (raw && typeof raw === 'object' && typeof raw.$vault === 'string') {
      vaultKey = raw.$vault;
    } else if (typeof raw === 'string' && raw.indexOf('$vault:') === 0) {
      vaultKey = raw.slice('$vault:'.length);
    }
    if (vaultKey === null) {
      // Plain env value - pass through as a string.
      if (raw !== undefined && raw !== null) out[key] = String(raw);
      continue;
    }
    // $vault reference - resolve at the substrate boundary. On any failure
    // (no vault module, locked, not found, scope mismatch) skip + warn.
    // We deliberately do NOT echo the resolved value into out via any log.
    if (!vault || typeof vault.getValueByKey !== 'function') {
      warnings.push('vault unavailable; skipped env ' + key + ' ($vault:' + vaultKey + ')');
      continue;
    }
    let hit = null;
    try { hit = vault.getValueByKey(vaultKey, capScope); } catch (_) { hit = null; }
    if (!hit || typeof hit.value !== 'string') {
      warnings.push('vault locked or key not authorized for ' + capScope + '; skipped env ' + key + ' ($vault:' + vaultKey + ')');
      continue;
    }
    out[key] = hit.value;   // value goes into the child env only - never logged.
  }
  return { env: out, warnings };
}

// The child's environment is BUILT, never inherited. The process hosting
// this client (proxy, plugin server, CLI) can carry API keys and tokens in
// its env; a downstream MCP server has no business reading any of them. It
// gets a working base — the parent's PATH (a lookup list, not a secret, and
// dropping it would break every operator whose server command lives in
// /opt/homebrew/bin), HOME/TMPDIR so caches and dotfiles work, locale — plus
// exactly what its registry entry DECLARED, with $vault refs resolved.
function _buildChildEnv(resolvedEnv) {
  const base = {
    PATH:   process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:' + path.dirname(process.execPath),
    HOME:   process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG:   process.env.LANG || 'en_US.UTF-8',
    TERM:   process.env.TERM || 'dumb'
  };
  return Object.assign(base, resolvedEnv || {});
}

// Where a jailed bridge lives: a stable per-server dir, so the bridge's own
// state (mcp-remote keeps OAuth tokens under HOME) survives restarts while
// staying invisible to every other server and to the rest of ~/.troth.
function _bridgeJailDir(name) {
  let safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  // Dots are legitimate INSIDE a name (api.example) but a name that IS
  // dots would make path.join walk out of the jail root.
  if (safe === '' || safe === '.' || safe === '..') safe = '_' + safe;
  return path.join((process.env.HOME || os.homedir()), '.troth', 'mcp-jail', safe);
}

function startDownstream(name, spec, sopts) {
  sopts = sopts || {};
  const initMs = (sopts.initTimeoutMs > 0) ? sopts.initTimeoutMs : INIT_TIMEOUT_MS;
  const spawnSpec = _toSpawnSpec(name, spec);
  if (!spawnSpec.command) throw new Error('downstream ' + name + ' has no command');
  // Resolve $vault env refs at spawn time. Warnings are attached to the
  // spawn-error path only (surfaced if the child dies), per the audit rule
  // that a locked vault must degrade, not throw, and never leak the value.
  const resolved = _resolveEnvSpec(spawnSpec.env, name);
  // The bridge (npx mcp-remote) is third-party code fetched at spawn time:
  // it runs jailed when the host has a jail. A jail failure falls through
  // to a plain spawn — the BUILT env below still applies either way, so
  // the parent's secrets never reach the child on any path.
  let proc = null;
  let jailed = false;
  if (spawnSpec.command === 'npx') {
    try {
      const seatbelt = require('./sandbox-seatbelt.js');
      const jailDir = _bridgeJailDir(name);
      fs.mkdirSync(jailDir, { recursive: true, mode: 0o700 });
      const jspec = seatbelt.jailSpawnSpec({ cwd: jailDir, network: 'full', loopbackListen: true, env: resolved.env });
      if (jspec.ok) {
        // cwd MUST be the jail. Without it the child keeps the proxy's
        // working directory, which is outside the walls, and npm/npx call
        // process.cwd() during bootstrap: getcwd() returns EPERM and every
        // remote server dies with "exited before init (code 7)".
        proc = spawn(jspec.exec, jspec.args.concat([spawnSpec.command]).concat(spawnSpec.args || []),
                     { stdio: ['pipe', 'pipe', 'pipe'], cwd: jspec.work, env: jspec.env });
        jailed = true;
      }
    } catch (_) { /* no adapter on this platform — plain spawn below */ }
  }
  if (!proc) {
    proc = spawn(spawnSpec.command, spawnSpec.args || [],
                 { stdio: ['pipe', 'pipe', 'pipe'], env: _buildChildEnv(resolved.env) });
  }
  const state = { proc, nextId: 1, pending: new Map(), buffer: '', ready: false, jailed, env_warnings: resolved.warnings, stderr: '', exited: null };
  if (typeof sopts.onState === 'function') { try { sopts.onState(state); } catch (_) {} }

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    state.buffer += chunk;
    let idx;
    while ((idx = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.id != null && state.pending.has(msg.id)) {
        const { resolve, reject } = state.pending.get(msg.id);
        state.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else           resolve(msg.result);
      }
    }
  });
  // Env-warning suffix: if a $vault env ref was skipped (locked vault /
  // unauthorized key), surface WHICH key was dropped on the spawn-error
  // path so a "server can't auth" failure is diagnosable. Never contains
  // the resolved secret value (see _resolveEnvSpec) - only key names.
  const warnSuffix = (state.env_warnings && state.env_warnings.length)
    ? ' [env warnings: ' + state.env_warnings.join('; ') + ']'
    : '';
  proc.on('exit', () => pool.delete(name));
  proc.on('error', () => {});  // resolved via the init reject below
  proc.stderr.on('data', (c) => { if (state.stderr.length < 8000) state.stderr += String(c); });
  proc.on('exit', (code, sig) => { state.exited = 'exit code ' + code + (sig ? ' signal ' + sig : ''); });

  const initId = state.nextId++;
  return new Promise((resolve, reject) => {
    let initTimer = setTimeout(() => {
      state.pending.delete(initId);
      reject(new Error('mcp-client init timeout on ' + name + warnSuffix));
    }, initMs);
    // A child that dies before it answers initialize rejects the promise
    // with the env warnings attached (common cause: missing $vault auth).
    proc.on('exit', (code) => {
      if (state.pending.has(initId)) {
        clearTimeout(initTimer);
        state.pending.delete(initId);
        reject(new Error('mcp-client ' + name + ' exited before init (code ' + code + ')' + warnSuffix));
      }
    });
    state.pending.set(initId, {
      resolve: () => {
        clearTimeout(initTimer);
        state.ready = true;
        pool.set(name, state);
        resolve(state);
      },
      reject: (e) => { clearTimeout(initTimer); reject(e); }
    });
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'troth-entity-mcp-client', version: '0.1.0' }
      }
    }) + '\n');
  });
}

// opts: string (legacy configPath) OR { configPath?, workspace? }.
// workspace is threaded from ctx.cwd so the per-project .mcp.json layers
// over the global registry (project wins collisions).
async function getDownstream(name, opts) {
  if (pool.has(name)) return pool.get(name);
  let configPath, workspace;
  if (typeof opts === 'string') { configPath = opts; }
  else if (opts && typeof opts === 'object') { configPath = opts.configPath; workspace = opts.workspace; }
  const downstream = loadDownstream(configPath, workspace);
  if (!downstream[name]) throw new Error('unknown downstream server: ' + name);
  return startDownstream(name, downstream[name]);
}

// The state a connector is really in. A server answers initialize and
// lists its tools, or a bridge asks for a sign-in and prints the address to
// visit, or nothing answers. A bridge waiting for a sign-in is left running
// so the sign-in can land; a server that answers nothing is stopped.
const PROBE_MS = 12 * 1000;
const SIGN_IN_INIT_MS = 5 * 60 * 1000;
// The address to visit: on the line that asks for it, or on one of the two
// lines after, or any address that names an authorization endpoint.
function _authUrl(stderr) {
  const lines = String(stderr || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cue = /visit|authoriz|browser|sign[- ]?in/i.test(lines[i]);
    for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
      const m = lines[j].match(/https?:\/\/[^\s"'<>]+/);
      if (m && (cue || /authorize|oauth|client_id=/i.test(m[0]))) return m[0].replace(/[.,;:)]+$/, '');
    }
  }
  return null;
}
async function probe(name, opts) {
  const t0 = Date.now();
  let configPath, workspace;
  if (typeof opts === 'string') { configPath = opts; }
  else if (opts && typeof opts === 'object') { configPath = opts.configPath; workspace = opts.workspace; }
  const done = (r) => Object.assign({ name, ms: Date.now() - t0 }, r);
  const listTools = async (state) => {
    const res = await rpc(state, 'tools/list', {});
    return (res && Array.isArray(res.tools) ? res.tools : []).map((t) => t && t.name).filter(Boolean);
  };
  if (pool.has(name)) {
    try { return done({ state: 'connected', tools: await listTools(pool.get(name)) }); }
    catch (e) { return done({ state: 'unreachable', error: e && e.message || String(e) }); }
  }
  const downstream = loadDownstream(configPath, workspace);
  if (!downstream[name]) return done({ state: 'unknown', error: 'not in the registry' });
  let live = null;
  const start = startDownstream(name, downstream[name], { initTimeoutMs: SIGN_IN_INIT_MS, onState: (s) => { live = s; } });
  start.catch(() => {});
  const until = Date.now() + PROBE_MS;
  while (Date.now() < until) {
    const settled = await Promise.race([start.then((s) => ({ ok: true, s }), (e) => ({ ok: false, e })), new Promise((r) => setTimeout(() => r(null), 250))]);
    if (settled && settled.ok) {
      try { return done({ state: 'connected', tools: await listTools(settled.s) }); }
      catch (e) { return done({ state: 'unreachable', error: e && e.message || String(e) }); }
    }
    if (settled && !settled.ok) {
      const tail = live && live.stderr ? ': ' + live.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300) : '';
      return done({ state: 'unreachable', error: (settled.e && settled.e.message || String(settled.e)) + tail });
    }
    const url = live ? _authUrl(live.stderr) : null;
    if (url) return done({ state: 'sign_in_needed', url });
    if (live && live.exited) return done({ state: 'unreachable', error: 'the server ' + live.exited + (live.stderr ? ': ' + live.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300) : '') });
  }
  if (live && live.proc) { try { live.proc.kill('SIGTERM'); } catch (_) {} }
  return done({ state: 'unreachable', error: 'no answer within ' + Math.round(PROBE_MS / 1000) + ' s' + (live && live.stderr ? ': ' + live.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300) : '') });
}

function rpc(state, method, params) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error('mcp-client rpc timeout: ' + method));
      }
    }, RPC_TIMEOUT_MS);
    state.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); }
    });
    state.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ── Tool schemas exposed to the model ──────────────────────────────────

const mcpList = {
  schema: {
    type: 'function',
    function: {
      name: 'mcp_list',
      description: 'Discover the partner\'s extra hands: list the tools a configured external MCP server offers. Returns an array of {name, description}. Read-only discovery (no governance round-trip). Servers come from the GLOBAL registry (~/.troth/mcp-clients.json) merged with the current project\'s .mcp.json (project wins collisions). Call this first, then mcp_call to invoke. If a hand you need is not listed, the MCP is not configured - ask the operator to add it.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Configured downstream MCP server name (global ~/.troth/mcp-clients.json OR project .mcp.json mcpServers entry).' } },
        required: ['server']
      }
    }
  },
  // Read-only discovery: stays DIRECT (no intent round-trip). Workspace
  // comes from ctx.cwd so the project .mcp.json layers over the global one.
  run: async (args, ctx) => {
    if (!args || typeof args.server !== 'string') return { error: 'bad_args', detail: 'server (string) is required' };
    const workspace = (ctx && ctx.cwd) || null;
    let state;
    try { state = await getDownstream(args.server, { workspace }); }
    catch (e) { return { error: 'spawn_failed', server: args.server, detail: e && e.message || String(e) }; }
    let res;
    try { res = await rpc(state, 'tools/list', {}); }
    catch (e) { return { error: 'rpc_failed', method: 'tools/list', server: args.server, detail: e && e.message || String(e) }; }
    return {
      server: args.server,
      tools: (res.tools || []).map((t) => ({ name: t.name, description: (t.description || '').slice(0, 200) }))
    };
  }
};

const mcpDescribe = {
  schema: {
    type: 'function',
    function: {
      name: 'mcp_describe',
      description: 'Return the full input schema and description of a specific tool on a downstream MCP server. Use after mcp_list when you need parameter details for a particular tool. Read-only discovery (no governance round-trip). Server resolution is workspace-aware: global ~/.troth/mcp-clients.json merged with project .mcp.json (project wins).',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          tool:   { type: 'string' }
        },
        required: ['server', 'tool']
      }
    }
  },
  // Read-only discovery: stays DIRECT. Workspace from ctx.cwd (project
  // .mcp.json layered over global registry).
  run: async (args, ctx) => {
    if (!args || typeof args.server !== 'string' || typeof args.tool !== 'string') {
      return { error: 'bad_args', detail: 'server + tool (strings) required' };
    }
    const workspace = (ctx && ctx.cwd) || null;
    let state;
    try { state = await getDownstream(args.server, { workspace }); }
    catch (e) { return { error: 'spawn_failed', server: args.server, detail: e && e.message || String(e) }; }
    let res;
    try { res = await rpc(state, 'tools/list', {}); }
    catch (e) { return { error: 'rpc_failed', method: 'tools/list', detail: e && e.message || String(e) }; }
    const match = (res.tools || []).find((t) => t.name === args.tool);
    if (!match) return { error: 'tool_not_found', server: args.server, tool: args.tool };
    return { server: args.server, tool: match };
  }
};

// Replicated, mcp-scoped standing-authorization lookup. substrate-tools'
// _autoResolveAuthorization is module-private (not exported), so per the
// operator design we replicate ONLY the piece mcp_call needs: find an
// operator-sealed capability that covers 'intent:mcp:call:<server>' and a
// sealed grounding engram, so a bare governed call works when the operator
// has already sealed authority. This does NOT weaken STVC - it only surfaces
// authority the operator already sealed; writeIntent's predicate wall still
// runs on the result (and refuses if nothing covers the scope). Returns
// { capability_ref, grounded_in } or null.
function _autoResolveMcpAuthorization(scope, irreversibilityClass) {
  if (typeof scope !== 'string' || scope.indexOf('intent:mcp:call:') !== 0) return null;
  let intentMod, eng;
  try { intentMod = require('../intent.js'); } catch (_) { return null; }
  try { eng = require('../engram.js'); }       catch (_) { return null; }
  const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
  const now = Date.now();
  const ranks = intentMod.IRREVERSIBILITY_RANK || {};
  const wantCls = irreversibilityClass || 'low';

  // 1. Covering capability. Uses the SAME mcp mapping the STVC wall uses
  //    (intent.mcpCapabilityCoversIntent) so auto-resolve never picks a cap
  //    the wall would then reject.
  let capRef = null;
  for (const cap of pool) {
    if (!cap || typeof cap.scope !== 'string' || cap.scope.indexOf('capability:') !== 0) continue;
    if (cap.revoked) continue;
    if (typeof cap.expiry === 'number' && cap.expiry > 0 && cap.expiry < now) continue;
    if (!intentMod.mcpCapabilityCoversIntent || !intentMod.mcpCapabilityCoversIntent(cap.scope, scope)) continue;
    const capMax = cap.max_irreversibility || 'low';
    if ((ranks[wantCls] || 99) > (ranks[capMax] || 0)) continue; // cap can't cover this class
    capRef = cap.id;
    break;
  }
  if (!capRef) return null; // no sealed authority - let STVC refuse with its hint

  // 2. Sealed grounding - any operator_confirmed|plr_evolved engram satisfies
  //    grounded_in_sealed. Fall back to the capability itself (it is
  //    operator_confirmed), mirroring substrate-tools' behavior.
  const sealed = e => {
    const a = (e && e.source_authority) || 'regex_extracted';
    return a === 'operator_confirmed' || a === 'plr_evolved';
  };
  const preferredScopes = new Set(['presence_proof', 'partner_charter', 'identity', 'partner_identity', 'recovery_directive']);
  const grounding = [];
  for (const e of pool) {
    if (grounding.length >= 3) break;
    if (!sealed(e) || typeof e.scope !== 'string') continue;
    if (preferredScopes.has(e.scope)) grounding.push(e.id);
  }
  if (!grounding.length) grounding.push(capRef);
  return { capability_ref: capRef, grounded_in: grounding };
}

const mcpCall = {
  schema: {
    type: 'function',
    function: {
      name: 'mcp_call',
      // GOVERNED: this call is NOT a raw passthrough. It emits an intent
      // (scope intent:mcp:call:<server>), the substrate STVC-gates it, and
      // only then runs the downstream tool + records an observation engram.
      // The registry file DECLARES the server; an operator-sealed capability
      // (capability:mcp:<server>, minted via `troth cap mint`) AUTHORIZES it.
      // With NO sealed capability the call fails closed with a structured
      // refusal (the substrate wall refuses; nothing is contacted). Server
      // resolution is workspace-aware (global mcp-clients.json + project
      // .mcp.json, project wins); env values shaped {"$vault":"KEY"} resolve
      // at the substrate boundary and never enter this context.
      description: 'Invoke a tool on a configured external MCP server (one of the partner\'s extra hands). GOVERNED via intent:mcp:call:<server>: requires an operator-sealed capability:mcp:<server> (or capability:mcp:*). Fails closed with a structured refusal if none is sealed. Returns the observation (downstream result) on success. Servers come from the global registry merged with the project .mcp.json; $vault env refs resolve substrate-side.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Configured downstream MCP server name (global ~/.troth/mcp-clients.json OR project .mcp.json).' },
          tool:   { type: 'string', description: 'Downstream tool name (discover via mcp_list / mcp_describe).' },
          args:   { type: 'object', description: 'Structured arguments for the downstream tool.' }
        },
        required: ['server', 'tool']
      }
    }
  },
  // GOVERNED path. Mirrors
  // substrate-tools intent_emit: lazy-bootstrap the adapters, auto-resolve
  // standing authorization, writeIntent (write-time STVC wall), then
  // dispatcher.dispatchOne (dispatch-time re-validation + observation). The
  // downstream MCP is reached ONLY inside mcp-do.dispatch, which only runs
  // after both STVC phases pass - so no sealed capability means the server
  // is never contacted. ctx._mcp_mock is threaded into the dispatch context
  // so tests exercise the governed path without a real spawn.
  run: async (args, ctx) => {
    if (!args || typeof args.server !== 'string' || typeof args.tool !== 'string') {
      return { ok: false, error: 'bad_args', detail: 'server + tool (strings) required' };
    }
    ctx = ctx || {};
    const intentMod  = require('../intent.js');
    const dispatcher = require('../dispatcher.js');
    // Lazy bootstrap of the universal executors (registers mcp-do among the
    // others). Idempotent via require cache + bootstrap's own guard.
    try { require('../dispatchers/bootstrap.js').bootstrap(); }
    catch (_) { /* an optional adapter missing is fine; mcp-do is core */ }

    const scope = 'intent:mcp:call:' + args.server;
    const payload = { server: args.server, tool: args.tool, args: args.args || {} };
    // Thread the workspace so mcp-do resolves the project .mcp.json; carried
    // in the payload so it survives into the observation + effect key.
    if (ctx.cwd) payload.workspace = ctx.cwd;
    const irreversibility_class = 'medium';   // matches mcp-do's default class

    // Auto-resolve operator-sealed authority (fail-closed if none). The
    // faculty is NOT asked to thread capability_ref/grounded_in - same
    // ergonomics as bare intent_emit.
    const auth = _autoResolveMcpAuthorization(scope, irreversibility_class);

    const write = intentMod.writeIntent({
      scope,
      payload,
      capability_ref:        auth ? auth.capability_ref : null,
      grounded_in:           auth ? auth.grounded_in : [],
      irreversibility_class: irreversibility_class,
      statement:             'mcp_call ' + args.server + '/' + args.tool,
      agent_id:              (ctx && ctx.agent_id) || 'partner',
      user_id:               (ctx && ctx.user_id)  || 'operator',
      cwd:                   (ctx && ctx.cwd) || null,
      source:                'partner via mcp_call'
    });
    if (!write.ok) {
      // STVC refused at write time - no sealed capability covers this server.
      // Structured, fail-closed refusal handed back to the model (the file
      // declares, the capability authorizes; nothing was contacted).
      return {
        ok: false,
        refused: true,
        stage: 'write',
        server: args.server,
        tool: args.tool,
        reason: write.error,
        detail: write.detail || null,
        auto_resolved: !!auth,
        hint: !auth
          ? 'no operator-sealed capability covers server "' + args.server + '". The operator must seal one first: `troth cap mint capability:mcp:' + args.server + ' --max medium` (or capability:mcp:* for any server). Then retry - the substrate fills capability_ref + grounded_in for you.'
          : null
      };
    }
    // Two-phase STVC: dispatcher re-validates, then mcp-do runs the tool.
    const result = await dispatcher.dispatchOne(write.id, {
      context: Object.assign({}, ctx, {
        // Test injection passes straight through to mcp-do.dispatch.
        _mcp_mock: ctx._mcp_mock
      })
    });
    if (!result.ok) {
      return {
        ok: false,
        refused: result.refusal_reason && result.refusal_reason.indexOf('adapter_error:') === 0 ? false : true,
        stage: 'dispatch',
        server: args.server,
        tool: args.tool,
        intent_id: write.id,
        status: result.status || 'failed',
        observation_id: result.observation_id || null,
        reason: result.refusal_reason
      };
    }
    return {
      ok: true,
      server: args.server,
      tool: args.tool,
      intent_id: write.id,
      status: result.status,
      observation_id: result.observation_id,
      auto_resolved: !!auth,
      capability_ref: auth ? auth.capability_ref : null,
      result: result.result
    };
  }
};

const mcpRegisterRequest = {
  schema: {
    type: 'function',
    function: {
      name: 'mcp_register_request',
      // STAGING ONLY. This tool cannot activate anything: it writes the
      // inert pending file, which the resolver never reads. The operator
      // approval (troth mcp approve <name>) is the security boundary -
      // it moves the entry into the active registry AND seals
      // capability:mcp:<name>, both operator-only actions.
      description: 'Stage a NEW external MCP server for operator approval. Use when the operator pastes an MCP server config snippet in chat (e.g. from a service\'s docs). Writes only the INERT pending file - the server stays unusable until the operator approves (`troth mcp approve <name>`, or the app\'s approval prompt), which activates it and seals capability:mcp:<name>. You can stage; only the operator can activate. config shapes: {type:"http"|"sse", url, env?} or {command, args?, env?}; env values may be {"$vault":"KEY"} references (stored verbatim, never resolved here).',
      parameters: {
        type: 'object',
        properties: {
          name:   { type: 'string', description: 'Server name, [a-z0-9_-], max 64 chars (e.g. "supabase").' },
          config: { type: 'object', description: 'The mcpServers entry: {type:"http"|"sse", url, env?} or {command, args?, env?}.' },
          note:   { type: 'string', description: 'Optional one-line reason shown to the operator at approval time.' }
        },
        required: ['name', 'config']
      }
    }
  },
  run: async (args, ctx) => {
    if (!args || typeof args.name !== 'string' || !args.config || typeof args.config !== 'object') {
      return { ok: false, error: 'bad_args', detail: 'name (string) + config (object) required' };
    }
    const name = args.name;
    if (!PENDING_NAME_RE.test(name)) {
      return { ok: false, error: 'bad_name', detail: 'name must match [a-z0-9_-]{1,64}' };
    }
    const norm = _normalizeRegisterConfig(args.config);
    if (norm.error) return { ok: false, error: 'bad_config', detail: norm.error };
    // Refuse a name that already RESOLVES as active (global registry or
    // the workspace .mcp.json). Re-staging it is at best a no-op and at
    // worst a silent config swap hiding behind an already-sealed
    // capability:mcp:<name>.
    const workspace = (ctx && ctx.cwd) || null;
    const active = loadDownstream(null, workspace);
    if (Object.prototype.hasOwnProperty.call(active, name)) {
      return {
        ok: false, reason: 'already_active', name,
        detail: 'server "' + name + '" is already in the active registry; use mcp_list/mcp_call directly'
      };
    }
    try {
      stagePendingServer(name, norm.config, typeof args.note === 'string' ? args.note : null);
    } catch (e) {
      return { ok: false, error: 'stage_failed', detail: e && e.message || String(e) };
    }
    return {
      ok: true, pending: true, name,
      hint: 'Registered for approval. Ask the operator to approve access to ' + name + '.'
    };
  }
};

// Best-effort cleanup on process exit so child MCPs don't outlive us.
function shutdownAll() {
  for (const [, state] of pool) {
    try { state.proc.kill(); } catch (_) {}
  }
  pool.clear();
}
process.on('exit', shutdownAll);

module.exports = {
  REGISTRY: {
    mcp_list:             mcpList,
    mcp_describe:         mcpDescribe,
    mcp_call:             mcpCall,
    mcp_register_request: mcpRegisterRequest
  },
  // Internals — exposed for tests + advanced wiring.
  loadDownstream,
  getDownstream,
  startDownstream,
  probe,
  rpc,
  shutdownAll,
  pool,
  // Staged registration (partner stages, operator approves via cmd-mcp.js).
  stagePendingServer,
  listPendingServers,
  approvePendingServer,
  rejectPendingServer,
  DEFAULT_PENDING_PATH,
  // Pure helpers - unit-testable without spawning a process.
  _toSpawnSpec,
  _resolveEnvSpec,
  _buildChildEnv,
  _bridgeJailDir,
  _autoResolveMcpAuthorization,
  _pendingPath,
  _activeGlobalPath,
  _normalizeRegisterConfig
};
