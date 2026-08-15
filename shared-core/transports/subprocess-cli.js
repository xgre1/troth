// SPDX-License-Identifier: AGPL-3.0-only
// Subprocess-CLI transport for the Substrate-as-Entity orchestrator.
//
// ⚠ ADVANCED, NOT THE DEFAULT FACULTY PATH ⚠
//
// Substrate-as-subject thesis: faculty = one model, one inference call
// (rented language capability). Gemini-cli / Claude Code CLI / Codex
// are AGENTS — they have their own loops, tool systems, planning
// pipelines, and lifecycle. Using them as "faculty" is the exact
// agent-framework drift the thesis rejects: the substrate would no
// longer be the cognitive subject; it would be a thin shell around an
// external agent runtime.
//
// This transport stays in the codebase for operators who DELIBERATELY
// want agent-as-faculty (e.g. you want gemini-cli's tool-using loop
// to be the partner's reasoning engine because you trust it more than
// raw model API). That is a legitimate operator choice — but it is NOT
// the default path. Default is HTTP transports (anthropic, router,
// ollama, llamacpp) that bind one inference call at a time.
//
// To opt in, set at vessel boot:
//   TROTH_ENTITY_LLM=gemini_cli   (or claude_cli / local_cli)
// The dashboard's autonomous-tick-faculty dropdown intentionally does
// NOT list these — agent-faculty is shell-level operator commitment,
// not a click-flip toggle.
//
// Architecturally this is: substrate's heartbeat fires, instead of
// calling /v1/messages, we spawn `gemini --model X`, pipe substrate
// context as stdin, stream the agent's output back. The agent's
// internal reasoning loop is opaque to STVC; only its emitted output
// becomes an engram. Capability + STVC walls still gate any intent
// the agent's output triggers downstream.
//
// Contract matches transports/anthropic.js + transports/router.js so
// the orchestrator + dispatcher don't need special-casing:
//   stream({ system, user, options }) → AsyncIterable<{ delta?, done? }>
//   abort(handle) — best-effort SIGTERM
//
// Configuration:
//   binary      — path / name of CLI executable
//   args        — array of arg templates; substitution tokens:
//                   {{model}}   → resolved model name (from options or env)
//                   {{system}}  → system prompt (escaped)
//                   {{user}}    → user prompt (escaped)
//                 Tokens not present are dropped from the arg list.
//   pipe_stdin  — if true (default), write {system, user} as JSON to
//                 stdin. If false, prompt is passed via the arg
//                 template's {{user}} substitution.
//   parse       — 'lines' (default) = stdout chunks emitted as deltas;
//                 'json'  = expect single JSON blob on stdout, emit as
//                            one delta with the .text field.
//   env_passthrough — array of env var names forwarded to subprocess
//                     (default: all current env). Keep narrow in
//                     containerized vessels where the CLI auth lives in
//                     a specific env var.
//
// Built-in profiles (resolved by mode name in resolveTransport):
//   gemini_cli — `gemini --model {{model}}`, stdin pipe, line parse
//   claude_cli — `claude --model {{model}} --print` (-p flag), stdin pipe
//   local_cli  — `llama-cli -m {{model}} -p {{user}}`, line parse
//
// Tests use a stubbable spawn function (opts._spawn) so the integration
// path is exercised without a real CLI on disk.

const { spawn } = require('child_process');

// ── Per-conversation claude-CLI SESSION CONTINUITY (operator-latency fix I-3) ──
// The claude_cli faculty spawns a COLD `claude` subprocess per turn. Without
// continuity every turn re-uploads the full substrate system prompt (identity+
// memory via --append-system-prompt) AND the flattened conversation, with NO
// server-side reuse and a COLD prompt cache → first replies were 30-90s (operator
// FAIL). The `claude` CLI (2.x) persists each conversation as a transcript under
// $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl and can RESUME it:
//   turn 1  → --session-id <uuid>   (we mint the id, deterministic, no stdout parse)
//   turn 2+ → --resume <uuid>       (reuses the persisted transcript; Anthropic-side
//                                     prompt cache goes WARM → per-turn payload shrinks
//                                     to just the new user message; empirically ~3s /
//                                     cache_read_input_tokens dominant vs ~6s cold).
// The id is keyed by conversation_id (stable per chat/pane, see llm-orchestrator
// req.options.conversation_id). Store = in-memory Map (survives across turns because
// the transport factory is built ONCE at boot) + a best-effort JSON file so
// continuity survives a daemon restart. Opt out with TROTH_CLI_NO_RESUME=1.
const _CLI_SESSIONS = new Map(); // conversation_id -> { sessionId, createdAt }
let _cliSessionsLoaded = false;

function _cliSessionsFile() {
  const _os = require('os'); const _path = require('path');
  return _path.join(process.env.HOME || _os.homedir(), '.troth', 'claude-cli-sessions.json');
}

// Lazy-load the persisted map once (best-effort; a corrupt/missing file is fine —
// worst case we mint a fresh session, never a dead end).
function _loadCliSessions() {
  if (_cliSessionsLoaded) return;
  _cliSessionsLoaded = true;
  try {
    const _fs = require('fs');
    const raw = _fs.readFileSync(_cliSessionsFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v.sessionId === 'string') _CLI_SESSIONS.set(k, v);
      }
    }
  } catch (_) { /* no file yet / unreadable → start empty */ }
}

// Persist the map best-effort. Never throws (a write failure must not break a turn).
function _saveCliSessions() {
  try {
    const _fs = require('fs'); const _path = require('path');
    const file = _cliSessionsFile();
    _fs.mkdirSync(_path.dirname(file), { recursive: true });
    const obj = {};
    for (const [k, v] of _CLI_SESSIONS.entries()) obj[k] = v;
    _fs.writeFileSync(file, JSON.stringify(obj));
  } catch (_) { /* best-effort */ }
}

// Claude backbone browser directive. The
// spawned `claude` harness has its OWN Bash tool and, untold, defaults to
// writing a playwright/puppeteer script for any browser task (live find: an
// 18i pane ran `npx playwright` instead of the governed browser). Bind the
// governed-browser rule to the claude_cli profile so EVERY backbone turn
// carries it via --append-system-prompt, independent of whatever system prefix
// the caller assembled (the caller's system is the static frame only — the
// volatile memory rides the user message per the prefix-stability layout; it
// does not carry tool rules). troth_browser_do (troth-substrate MCP) drives the
// operator's real Chrome via CDP under STVC. No em-dash per repo authored-string rule.
const CLAUDE_BROWSER_RULE =
  'BROWSER AND WEB WORK: use web_search and web_fetch for reading. For anything that needs a real ' +
  'browser (logged-in sites, the operator\'s own accounts, or end-to-end testing the operator\'s own ' +
  'apps on localhost) use the troth_browser_do tool from the troth-substrate MCP server. NEVER write or ' +
  'run playwright, puppeteer, or selenium scripts, and never npm or npx install a browser driver: they are ' +
  'not installed, they bypass governance, and they are explicitly forbidden. If troth_browser_do returns ' +
  'refused, tell the operator to seal a browser capability. Do NOT fall back to a scripted browser.';

// Secrets discipline for the backbone (live find: a pane pasted a
// fresh secret into the chat and told the operator to place it manually).
// Mirrors the native-loop SECRETS rule in tools/system-prompt.js; keep the two
// in sync. No em-dash per repo authored-string rule.
const CLAUDE_SECRETS_RULE =
  'SECRETS: never print secret values (API keys, tokens, passwords, .env values, connection strings) ' +
  'in a reply, and never ask the operator to copy-paste one you could place yourself. When a task ' +
  'produces or needs a secret: store it in the operator vault and refer to it only by credential NAME, ' +
  'then place it where it belongs through the configured hands (troth-substrate mcp_call, browser steps ' +
  'with fill_from_vault / capture_to_vault). If the operator must know, name the destination and the ' +
  'credential NAME, never the value. If a tool result echoes a secret, do not repeat it.';

// Memory discoverability for the backbone (live find: memory questions
// funnelled into troth-bash file reads and a raw sqlite open of state.db,
// because troth_recall was reachable only behind mcp_call whose description
// never says the word memory). Bound to the claude_cli profile the same way
// the browser rule is, and pushed ONLY when the substrate MCP actually rides
// the spawn (TROTH_CLAUDE_MCP=1) - naming tools that are not mounted would
// be the same fiction the 41-tool advert was. No em-dash per repo
// authored-string rule.
const CLAUDE_MEMORY_RULE =
  'MEMORY: your persistent memory is the troth substrate, served by the troth-substrate MCP server ' +
  'in your tool list. For anything about prior work, past decisions, operator preferences, or things ' +
  'you are expected to remember, call mcp__troth-substrate__troth_recall FIRST - never grep files, ' +
  'never open ~/.troth/state.db, never answer \"I do not remember\" before recalling. To persist a ' +
  'durable fact the operator states, call mcp__troth-substrate__troth_engram_record.';

const PROFILES = Object.freeze({
  gemini_cli: {
    binary:     'gemini',
    args:       ['--model', '{{model}}'],
    pipe_stdin: true,
    parse:      'lines'
  },
  claude_cli: {
    binary:     'claude',
    // Anthropic SUBSCRIPTION path (legal per Anthropic's  notice:
    // "Agent SDK, claude -p, and third-party app usage continues to work with
    // your subscription"). We spawn the operator's OWN installed `claude` CLI on
    // their machine — no OAuth token extraction, no proxy, single-user. buildArgs
    // (not the {{}} template) so optional flags don't break: --model / --append-
    // system-prompt are only added when non-empty, and the substrate system
    // prompt (identity+memory) is preserved via --append-system-prompt.
    buildArgs:  (vars) => {
      // --dangerously-skip-permissions: the partner ALWAYS executes what the
      // operator asks (write/edit/bash) with NO per-action approval prompt — the
      // safety is the STVC walls + path/bash guards (and the sealed VM body for
      // autonomous), NOT a permission gate. Without this, `claude -p` cannot run
      // a single tool non-interactively → it "thinks" and DOES NOTHING (no files
      // created). This is the "bypass-permission Claude, but with our layers".
      // stream-json (+ --verbose, required with -p) so claude's OWN internal
      // tool loop is VISIBLE: we parse each NDJSON event and surface tool_use as
      // live chips + text as streaming deltas, instead of one opaque blob that
      // left the UI frozen on "Thinking". Falls back to raw text if the installed
      // CLI doesn't emit stream-json (see the close handler).
      const a = ['-p', String(vars.user || ''), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      // SESSION CONTINUITY (I-3): stream() resolves cliSessionId (a uuid keyed on
      // conversation_id) + cliResume (true once a session already exists). First
      // turn PINS the id with --session-id so we can resume it later WITHOUT
      // parsing stdout; every later turn RESUMES it so the server keeps the
      // history and the prompt cache stays warm → tiny per-turn payload. On a
      // resume FAILURE stream() transparently re-launches with cliResume=false
      // (fresh id), so this never dead-ends. Disabled entirely via
      // TROTH_CLI_NO_RESUME=1 (then cliSessionId is unset → old cold-start path).
      if (vars.cliSessionId) {
        if (vars.cliResume) { a.push('--resume', String(vars.cliSessionId)); }
        else { a.push('--session-id', String(vars.cliSessionId)); }
      }
      // BACKBONE ENGINE: TROTH_CLAUDE_ENGINE picks WHO answers
      // INSIDE the Claude Code harness. Unset/'claude' = the operator's
      // Anthropic subscription, direct (the else-branch below). Anything else
      // rides the troth proxy (_buildEnv sets ANTHROPIC_BASE_URL) so the
      // router serves the turn: 'gpt' = the ChatGPT-plan default model,
      // 'router' = the ambient/pinned model as-is, any other value = a literal
      // model id. Verified live: `claude -p --model gpt-5.6-sol`
      // through the proxy drove the Bash tool end-to-end (openai_sub served,
      // tool_use round-tripped through openai-translate).
      const engineOverride = (process.env.TROTH_CLAUDE_ENGINE || '').trim();
      if (engineOverride && !/^claude$/i.test(engineOverride)) {
        let m = engineOverride;
        if (/^gpt$/i.test(engineOverride)) {
          try { m = require('./codex-oauth.js').DEFAULT_MODEL; } catch (_) { m = 'gpt-5.5'; }
        } else if (/^router$/i.test(engineOverride)) {
          m = String(vars.model || '');
        } else if (/^kimi$/i.test(engineOverride)) {
          // Kimi membership (Code benefits) exposes an Anthropic-compatible
          // endpoint (base URL set in _buildEnv). No proxy translation hop:
          // the harness talks Kimi's API directly. Model rides
          // TROTH_KIMI_SUB_MODEL, defaulting to the always-available coding
          // model. Andante tier only serves this one; Moderato+ also offer
          // k3[1m] and kimi-for-coding-highspeed.
          m = (process.env.TROTH_KIMI_SUB_MODEL || '').trim() || 'kimi-for-coding';
        }
        if (m) { a.push('--model', m); }
      }
      // ONLY pass --model when it's actually a Claude model. `claude -p
      // --model <non-claude>` exits 1 with EMPTY stdout → the reply came back
      // blank and the UI showed a bare "Done." acknowledgement — so every
      // source below is
      // gated on the same /claude/ test, and passing nothing lets claude use
      // the operator's own subscription default, which works.
      else {
        // Source order: the operator's EXPLICIT pick outranks the dispatcher's
        // ambient guess. Settings → Claude → model is durably written to
        // providers.anthropic.model in ~/.troth/config.json (through the proxy
        // /api/config) — and until this read, NOTHING on the claude_cli chat
        // path ever loaded that key. The pick sat in storage while the spawn
        // used the subscription default: "Fable 5" selectable and silently
        // unserved, the badge honest about a choice that never took effect
        // (AUDIT-2026-08-09 item 15). Read at spawn time so a new pick takes
        // effect on the NEXT turn with no daemon respawn. TROTH_CLAUDE_MODEL
        // (env) wins over the config, mirroring TROTH_KIMI_SUB_MODEL above;
        // vars.model — the ambient default id, often a LOCAL model (e.g.
        // "Qwen3.6-35B-A3B") — stays the last resort it always was.
        let m = (process.env.TROTH_CLAUDE_MODEL || '').trim();
        if (!m) {
          try {
            const _fs = require('fs');
            const _cfgPath = require('../config-file.js').configPath();
            const _cfg = JSON.parse(_fs.readFileSync(_cfgPath, 'utf8'));
            m = String((((_cfg || {}).providers || {}).anthropic || {}).model || '').trim();
          } catch (_) { /* lenient read (per config-file.js header): no or broken config → subscription default */ }
        }
        if (!m) m = String(vars.model || '');
        if (m && /claude/i.test(m)) { a.push('--model', m); }
      }
      // ALWAYS carry the governed-browser directive (see CLAUDE_BROWSER_RULE),
      // combined with the caller's system prefix (identity+memory). Present even
      // when no prefix was passed, so the harness never defaults to a scripted
      // browser. Ordered prefix-first so the volatile identity block stays at the
      // top and the static rule trails it (byte-stable across turns).
      const _sysParts = [];
      if (vars.system && String(vars.system).trim()) { _sysParts.push(String(vars.system).trim()); }
      _sysParts.push(CLAUDE_BROWSER_RULE);
      _sysParts.push(CLAUDE_SECRETS_RULE);
      // Gated on the same flag that mounts the server below: the rule names
      // mcp__troth-substrate__* ids, which only exist when the MCP rides.
      if (process.env.TROTH_CLAUDE_MCP === '1') { _sysParts.push(CLAUDE_MEMORY_RULE); }
      a.push('--append-system-prompt', _sysParts.join('\n\n'));
      // Liveness during LONG generations: without partial messages, claude
      // emits its assistant event only when the WHOLE message is done - a big
      // synthesize step is minutes of total stdout silence, and the
      // orchestrator's idle timeout kills a perfectly healthy turn (burn-in
      // run #2 died exactly this way. Partial events prove the
      // stream is alive; the parser forwards them as keepalives only.
      // Kill-switch for older CLIs: TROTH_CLAUDE_PARTIAL=0.
      if (process.env.TROTH_CLAUDE_PARTIAL !== '0') { a.push('--include-partial-messages'); }
      // Substrate-as-MCP:
      // hand claude LIVE substrate tools (recall/record) instead of only the
      // passive memory snapshot riding --append-system-prompt. The server ships
      // in-tree (plugin/mcp-servers/troth-substrate) in both the repo checkout
      // and the app bundle's Resources/core, resolved relative to THIS file; the
      // entity's own node binary runs it. --strict-mcp-config keeps the
      // operator's personal MCP servers OUT of the faculty (recall-source
      // isolation, #41) — the organ gets the substrate and nothing else.
      // Tool permission rides the existing --dangerously-skip-permissions.
      if (process.env.TROTH_CLAUDE_MCP === '1') {
        try {
          const _p = require('path');
          const _f = require('fs');
          const srv = _p.resolve(__dirname, '..', '..', 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs');
          if (_f.existsSync(srv)) {
            // Governed ACTIONS over MCP
            // are opt-in: the flag must ride the server config EXPLICITLY,
            // because relying on implicit env inheritance through the claude
            // process is undocumented and was a silent gap (no path enabled
            // the tools even when the operator asked for them).
            const srvCfg = { command: process.execPath, args: [srv] };
            if (process.env.TROTH_MCP_ACTIONS === '1') { srvCfg.env = { TROTH_MCP_ACTIONS: '1' }; }
            a.push('--mcp-config',
                   JSON.stringify({ mcpServers: { 'troth-substrate': srvCfg } }),
                   '--strict-mcp-config');
          }
        } catch (_) { /* additive wiring — a resolve failure must not kill the spawn */ }
      }
      return a;
    },
    pipe_stdin: false,
    parse:      'claude_stream_json'
  },
  local_cli: {
    binary:     'llama-cli',
    args:       ['-m', '{{model}}', '-p', '{{user}}'],
    pipe_stdin: false,
    parse:      'lines'
  }
});

function _substitute(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => {
    return vars[k] != null ? String(vars[k]) : '';
  });
}

function _resolveArgs(args, vars) {
  const out = [];
  for (const tpl of args || []) {
    const filled = _substitute(tpl, vars);
    if (filled === '') continue;
    out.push(filled);
  }
  return out;
}

// Resolve a bare CLI name to an absolute path. Tauri-spawned daemons often have
// a minimal PATH that misses ~/.local/bin (where `claude` installs) and homebrew,
// so a bare spawn('claude') would ENOENT even though the CLI is present. If the
// name already contains a slash, trust it.
function _resolveBinary(bin) {
  if (!bin || bin.includes('/')) return bin;
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const home = process.env.HOME || os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    ...String(process.env.PATH || '').split(':').filter(Boolean),
  ];
  for (const d of dirs) {
    try { const p = path.join(d, bin); if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return bin; // fall back to PATH resolution by spawn
}

function makeSubprocessCliTransport(opts) {
  opts = opts || {};
  const profileName  = opts.profile || null;
  const profile      = profileName ? PROFILES[profileName] : null;
  if (profileName && !profile) {
    throw new Error('subprocess-cli transport: unknown profile ' + profileName);
  }
  const binaryRaw    = opts.binary || (profile && profile.binary);
  if (!binaryRaw) {
    throw new Error('subprocess-cli transport: opts.binary required (or pass opts.profile)');
  }
  const binary       = _resolveBinary(binaryRaw);
  // buildArgs(vars) → string[] takes precedence over the {{}} arg template; lets a
  // profile add optional flags conditionally (a literal flag whose templated value
  // resolves empty would otherwise swallow the next arg).
  const buildArgs    = opts.buildArgs || (profile && profile.buildArgs) || null;
  const argsTpl      = opts.args || (profile && profile.args) || [];
  const pipeStdin    = typeof opts.pipe_stdin === 'boolean'
                         ? opts.pipe_stdin
                         : (profile ? !!profile.pipe_stdin : true);
  const parseMode    = opts.parse || (profile && profile.parse) || 'lines';
  const modelDefault = opts.model || null;
  const spawnFn      = opts._spawn || spawn;
  const envWhitelist = Array.isArray(opts.env_passthrough) ? opts.env_passthrough : null;

  // Recall-source isolation (#41): the claude_cli faculty is a LANGUAGE ORGAN.
  // Its identity + memory come ONLY from the substrate — the entity already
  // injects them as <turn_context>/<memory_*> blocks at the TOP of the user
  // message (prefix-stability layout — llm-orchestrator resolvePrefix; the
  // --append-system-prompt carries only the static frame + tool rules). So we
  // point CLAUDE_CONFIG_DIR at a dedicated empty dir (and run in it) so `claude`
  // does NOT load the operator's personal ~/.claude/CLAUDE.md or file-based
  // memory — that would give Troth a SECOND identity/memory store, the core design
  // thesis violation (the organ must bring nothing of its own; the substrate is
  // the one mind). Auto-memory off as belt-and-suspenders.
  let claudeFacultyHome = null;
  if (profileName === 'claude_cli') {
    const _os = require('os'); const _path = require('path'); const _fs = require('fs');
    claudeFacultyHome = _path.join(process.env.HOME || _os.homedir(), '.troth', 'claude-faculty-home');
    try { _fs.mkdirSync(claudeFacultyHome, { recursive: true }); } catch (_) {}
    // WALLS for this isolated home. Isolation is the point (the organ brings
    // no second memory) — but it also means NONE of the operator's ~/.claude
    // wiring loads here: no troth-bash, no bash-steer hook, and with
    // --dangerously-skip-permissions the faculty's native Bash ran with no
    // wall at all. Both AUDIT-2026-08-09 incidents (`cut` on a .env, raw
    // sqlite3 against state.db) ran on exactly this surface. Provision the
    // faculty home's OWN settings.json with a PreToolUse hook that asks the
    // same bash-safety verdict the troth-bash server asks — one wall, two
    // doors. Idempotent + self-healing: recomputed each spawn so an app
    // move/update refreshes the absolute node/script paths; merge preserves
    // anything else the file holds; a stale gate entry is replaced in
    // place. Best-effort like the credential seeding below.
    try {
      const _gate = _path.resolve(__dirname, '..', '..', 'plugin', 'hooks', 'faculty-bash-gate.mjs');
      if (_fs.existsSync(_gate)) {
        const _sPath = _path.join(claudeFacultyHome, 'settings.json');
        let _s = null;
        try { _s = JSON.parse(_fs.readFileSync(_sPath, 'utf8')); } catch (_) { _s = null; }
        if (!_s || typeof _s !== 'object') _s = {};
        if (!_s.hooks || typeof _s.hooks !== 'object') _s.hooks = {};
        if (!Array.isArray(_s.hooks.PreToolUse)) _s.hooks.PreToolUse = [];
        const _entry = {
          matcher: 'Bash',
          hooks: [{ type: 'command',
                    command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(_gate),
                    timeout: 5 }]
        };
        const _i = _s.hooks.PreToolUse.findIndex((h) => JSON.stringify(h).indexOf('faculty-bash-gate.mjs') !== -1);
        const _before = JSON.stringify(_s);
        if (_i === -1) _s.hooks.PreToolUse.push(_entry); else _s.hooks.PreToolUse[_i] = _entry;
        if (JSON.stringify(_s) !== _before || !_fs.existsSync(_sPath)) {
          _fs.writeFileSync(_sPath, JSON.stringify(_s, null, 2) + '\n');
        }
      }
    } catch (_) { /* gate provisioning is best-effort; the spawn must not die */ }
    // Auth: CLAUDE_CONFIG_DIR (below) isolates MEMORY but also cut the operator's
    // login — modern claude keeps credentials in the macOS keychain (service
    // "Claude Code-credentials"), NOT this dir, so `claude -p` here returned
    // "Not logged in · Please run /login" and every routed turn failed. Seed the
    // credentials INTO the faculty home so auth works WHILE memory stays isolated.
    // Write only when absent/invalid, so a token claude later refreshes in-place
    // is not clobbered. Keychain first, then the legacy ~/.claude file.
    try {
      const _credPath = _path.join(claudeFacultyHome, '.credentials.json');
      let _have = false;
      try { const _e = _fs.readFileSync(_credPath, 'utf8'); if (_e && JSON.parse(_e)) _have = true; } catch (_) { _have = false; }
      if (!_have) {
        let _creds = '';
        try {
          _creds = require('child_process').execFileSync('security',
            ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            { encoding: 'utf8' });
        } catch (_) { _creds = ''; }
        if (!_creds || !_creds.trim()) {
          const _legacy = _path.join(process.env.HOME || _os.homedir(), '.claude', '.credentials.json');
          try { _creds = _fs.readFileSync(_legacy, 'utf8'); } catch (_) { _creds = ''; }
        }
        if (_creds && _creds.trim()) {
          try { _fs.writeFileSync(_credPath, _creds); _fs.chmodSync(_credPath, 0o600); } catch (_) {}
        }
      }
    } catch (_) {}
    // AUTH (the real fix): modern `claude` reads credentials from the macOS
    // KEYCHAIN keyed by config dir (service "Claude Code-credentials-<sha256(
    // CLAUDE_CONFIG_DIR)[:8]>"), NOT the .credentials.json file above (which it
    // ignores). Our isolated faculty dir gets its OWN slot whose token, never
    // refreshed by a non-interactive `claude -p`, goes stale -> 401 -> the turn
    // surfaces as "endpoint offline". So copy the operator's LIVE default creds
    // (auto-refreshed whenever they use claude) into the faculty's per-dir slot
    // on every spawn. Verified: sha256(faculty home) matches the keychain suffix
    // and `claude -p` then authenticates. Every `security` call is timeout-boxed
    // so a keychain prompt can NEVER hang the entity (it just proceeds).
    try {
      const _cp = require('child_process');
      const _crypto = require('crypto');
      const _slot = 'Claude Code-credentials-' +
        _crypto.createHash('sha256').update(claudeFacultyHome).digest('hex').slice(0, 8);
      let _live = '';
      try {
        _live = _cp.execFileSync('security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { encoding: 'utf8', timeout: 4000 });
      } catch (_) { _live = ''; }
      if (_live && _live.trim()) {
        const _acct = (_os.userInfo && _os.userInfo().username) || process.env.USER || 'user';
        try {
          _cp.execFileSync('security',
            ['add-generic-password', '-U', '-a', _acct, '-s', _slot, '-w', _live.trim()],
            { stdio: 'ignore', timeout: 4000 });
        } catch (_) { /* keychain write blocked/prompted -> skip; turn still tries */ }
      }
    } catch (_) {}
  }

  function _buildEnv() {
    // Clone so we never mutate the parent process.env.
    const out = {};
    if (envWhitelist) {
      for (const k of envWhitelist) { if (process.env[k] != null) out[k] = process.env[k]; }
    } else {
      Object.assign(out, process.env);
    }
    if (claudeFacultyHome) {
      out.CLAUDE_CONFIG_DIR = claudeFacultyHome;        // NOT the operator's ~/.claude
      out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      // BACKBONE ENGINE: a non-claude engine points the harness at the troth
      // proxy — the router fallback chain serves /v1/messages with the picked
      // model (openai_sub for gpt-*, gemini, local…). Loopback needs no bearer;
      // the dummy key only stops the CLI from hunting for another auth source.
      const engineOverride = (process.env.TROTH_CLAUDE_ENGINE || '').trim();
      if (/^kimi$/i.test(engineOverride)) {
        // Kimi membership (Code benefits) is Anthropic-compatible, so the
        // harness can talk to it two ways. PREFERRED: through the local troth
        // proxy — its kimi_sub lane is model-addressed (a k3/kimi-* model id
        // routes itself, no pin needed) and every request gets the proxy's
        // tool-block compression, caching and context filtering. Going DIRECT
        // skipped all of that: the operator measured 63-67% of a weekly Kimi
        // quota burning in minutes from app panes while the proxied CLI felt
        // free. The app sets TROTH_KIMI_VIA_PROXY=1 only when it
        // is actually running its proxy; without the flag (open-repo installs,
        // proxy down) the direct lane stays, because a dead loopback would
        // strand the pane entirely. Key handling: via proxy the key rides in
        // the PROXY's env (TROTH_KIMI_SUB_KEY enables its lane) and the
        // harness sends the loopback dummy; direct keeps key-in-env, never
        // argv, never logged.
        if ((process.env.TROTH_KIMI_VIA_PROXY || '').trim() === '1') {
          out.ANTHROPIC_BASE_URL = require('../dashboard-url.js').proxyBaseUrl();
          out.ANTHROPIC_API_KEY = 'troth-proxy';
        } else {
          out.ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/';
          const kk = (process.env.TROTH_KIMI_SUB_KEY || '').trim();
          if (kk) out.ANTHROPIC_API_KEY = kk;
        }
      } else if (engineOverride && !/^claude$/i.test(engineOverride)) {
        out.ANTHROPIC_BASE_URL = require('../dashboard-url.js').proxyBaseUrl();
        if (!out.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = 'troth-proxy';
      }
    }
    return out;
  }

  function stream(req) {
    const model = (req && req.options && req.options.model) || modelDefault
                  || process.env.TROTH_ENTITY_MODEL || '';
    let system = String(req && req.system || '');
    let user   = String(req && req.user   || '');

    // composeAgentic (the agentic tool loop) drives EVERY transport with a
    // `messages` array, NOT {system,user}. The SSE transports (router/llamacpp)
    // consume messages, but the CLI transports only read user/system — so
    // claude_cli got an EMPTY prompt (`claude -p ""`) → exit 1 / empty stdout →
    // a blank reply that surfaced as a bare "Done.". Flatten the messages into
    // a system block (system-role) + one user prompt so the CLI path works too.
    if (!user && Array.isArray(req && req.messages) && req.messages.length) {
      const toText = (c) => Array.isArray(c)
        ? c.map((b) => (b && (b.text || b.content)) || (typeof b === 'string' ? b : '')).join('')
        : String(c == null ? '' : c);
      const sys = [];
      const convo = [];
      for (const m of req.messages) {
        if (!m) continue;
        const txt = toText(m.content).trim();
        if (m.role === 'system') { if (txt) sys.push(txt); }
        else if (txt) {
          const tag = m.role === 'assistant' ? 'Assistant: ' : m.role === 'tool' ? 'Tool result: ' : 'User: ';
          convo.push(tag + txt);
        }
      }
      if (!system && sys.length) system = sys.join('\n\n');
      user = convo.join('\n\n');
    }

    // ── Resolve per-conversation claude-CLI session continuity (I-3). ──────────
    // Only for the claude_cli profile, only when NOT opted out, only when we have
    // a stable conversation_id to key on (autonomous/tick/job turns pass none →
    // fail closed to a fresh, non-continued turn; a shared null-key session would
    // cross-contaminate unrelated turns). resolvedSessionId is the uuid we mint
    // (first turn) or reuse (later turns); willResume=true means a session already
    // exists for this conversation so we pass --resume instead of --session-id.
    const convId = (req && req.options && req.options.conversation_id) || null;
    const sessionEnabled = profileName === 'claude_cli'
                           && process.env.TROTH_CLI_NO_RESUME !== '1'
                           && !!convId;
    let resolvedSessionId = null;
    let willResume        = false;
    if (sessionEnabled) {
      _loadCliSessions();
      const existing = _CLI_SESSIONS.get(convId);
      if (existing && existing.sessionId) {
        resolvedSessionId = existing.sessionId;
        willResume = true;
      } else {
        resolvedSessionId = require('crypto').randomUUID();
        willResume = false;
      }
    }

    // Queue + iterator pattern mirrors the SSE transports. Hoisted to stream()
    // scope (above launch()) so a transparent resume-failure re-launch reuses the
    // SAME queue/iterator — the caller never sees the internal retry.
    const queue   = [];
    let waiter    = null;
    let finished  = false;
    let child     = null;   // current child (updated on re-launch so abort() tracks it)
    let didRetry  = false;  // guard: only ever fall back once
    let sawRealDelta = false; // a real assistant delta was streamed this turn

    // Claude/Codex CLIs surface an AUTH failure as a normal assistant TEXT
    // message with a SUCCESS exit (not an error result) — e.g. "Failed to
    // authenticate. API Error: 401 Invalid authentication credentials". If we
    // stream that as the answer, _turnStreamedChars goes > 0 and the entity's
    // cross-faculty fallback is BLOCKED (anti-double-paint) — so a dead Claude
    // token kills every Auto turn while a working ChatGPT sub sits idle
    // Match the credential-failure shape to abort
    // cleanly and let the dispatcher fall through to the next faculty instead.
    const AUTH_ERR_RE = /failed to authenticate|invalid authentication credentials|api error:\s*401|oauth token (has )?expired|please run\b[^.]*\blogin|not authenticated|authentication_error|credit balance is too low|invalid_grant|usage limit reached|overloaded_error/i;
    // Tool chips count as real work for the empty-turn check below: a turn
    // that ran tools but returned no text is a weak answer, not a dead CLI.
    let sawToolActivity = false;

    function push(item) {
      if (item && typeof item.delta === 'string' && item.delta.trim()) sawRealDelta = true;
      if (waiter) { const w = waiter; waiter = null; w(item); }
      else queue.push(item);
    }

    // Spawn + wire ONE claude invocation. useResume decides --resume vs
    // --session-id (via the buildArgs vars). Per-launch parse state lives inside
    // so a re-launch starts clean. Returns nothing; drives the shared queue.
    function launch(useResume) {
      const vars = { model, system, user };
      if (sessionEnabled) {
        vars.cliSessionId = resolvedSessionId;
        vars.cliResume    = !!useResume;
      }
      const args = buildArgs ? buildArgs(vars) : _resolveArgs(argsTpl, vars);

      child = spawnFn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env:   _buildEnv(),
        // Run the claude_cli organ in its isolated home so there is no project
        // CLAUDE.md to walk up into — completes the recall-source isolation (#41).
        // (Also scopes where claude persists/looks-up the session transcript.)
        ...(claudeFacultyHome ? { cwd: claudeFacultyHome } : {})
      });

      let errored = null;

      if (pipeStdin) {
        try {
          const payload = JSON.stringify({ system, user, model }) + '\n';
          child.stdin.write(payload);
          child.stdin.end();
        } catch (e) { errored = e; }
      } else {
        try { child.stdin.end(); } catch (_) {}
      }

      let buffer = '';
      // claude_stream_json bookkeeping: rawBuf holds the unparsed stdout so we can
      // fall back to plain-text passthrough if the installed CLI doesn't actually
      // speak stream-json (older claude) — preserving the previous behavior exactly
      // instead of an empty reply. sawJsonEvent flips once we parse a real event,
      // which also suppresses the fallback.
      let rawBuf = '';
      let sawJsonEvent = false;
      let sentModel = false;
      let sawResultError = false; // an error result event → don't count as a good turn
      // Map ONE claude stream-json NDJSON event into transport chunks. claude runs
      // its OWN agentic loop internally, so its tool_use is surfaced as a
      // VISIBILITY-ONLY {tool_activity} chunk (a chip), NOT an executable
      // {tool_calls} — emitting tool_calls would make composeAgentic try to re-run
      // a tool claude already ran. Text blocks stream as deltas (live "writing").
      const handleClaudeEvent = (ev) => {
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          // Surface the REAL model claude used (e.g. "claude-opus-4-8") as
          // served_by so the UI's engine/"via" pill shows it. claude_cli is not
          // the router, so it never populated served_by before → no model shown.
          if (!sentModel && ev.message.model) {
            sentModel = true;
            push({ served_by: { provider: 'anthropic', model: String(ev.message.model) } });
          }
          for (const b of ev.message.content) {
            if (!b) continue;
            if (b.type === 'text' && b.text) {
              // Auth failure disguised as an assistant answer: abort WITHOUT
              // streaming (only while the turn has produced no real answer yet),
              // so the entity falls through to the next faculty (codex_oauth /
              // router) instead of surfacing "401" as the reply. See AUTH_ERR_RE.
              if (!sawRealDelta && AUTH_ERR_RE.test(b.text)) {
                push({ done: true, _abort_reason: 'cli_auth' });
                return;
              }
              // Structural secret wall (R17, mirrors llm-orchestrator): any
              // secret harvested from claude's own tool results below is
              // masked before the text reaches the surface. Assistant events
              // carry WHOLE text blocks, so there is no split-chunk gap here.
              let _txt = String(b.text);
              try { _txt = require('../secret-redactor.js').redact(_txt); } catch (_) {}
              push({ delta: _txt + '\n' });
            }
            else if (b.type === 'tool_use') { sawToolActivity = true; push({ tool_activity: { id: b.id || '', name: b.name || '', input: b.input || {} } }); }
          }
        } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
          // claude's INTERNAL tool results ride user-role events in stream-json.
          // Harvest secret-shaped literals so the assistant text above can be
          // redacted when the model echoes them (live find: a fresh
          // Supabase secret was pasted into the chat).
          for (const b of ev.message.content) {
            if (!b || b.type !== 'tool_result') continue;
            let raw = '';
            if (typeof b.content === 'string') raw = b.content;
            else { try { raw = JSON.stringify(b.content); } catch (_) { raw = ''; } }
            try { require('../secret-redactor.js').harvest(raw); } catch (_) {}
            // Completion signal for the visibility chip: the start rode the
            // tool_use block above as {tool_activity}; without this the app's
            // chips (and the sub-agent indicator) stayed "working" until the
            // first text delta wiped them, leaving sub-agents invisible.
            // id pairs with tool_activity.id.
            if (b.tool_use_id) {
              push({ tool_activity_done: { id: String(b.tool_use_id) } });
            }
          }
        } else if (ev.type === 'stream_event') {
          // Partial-message event (see --include-partial-messages above). Do NOT
          // forward partial text - the final 'assistant' event still carries the
          // full message exactly once, so forwarding deltas here would double
          // every reply. Its only job is liveness: any chunk resets the
          // orchestrator's idle clock.
          push({ keepalive: true });
        } else if (ev.type === 'result' && (ev.is_error || (ev.subtype && ev.subtype !== 'success'))) {
          // An ERROR result. A stale/GC'd --resume id surfaces here (and via a
          // non-zero exit) as subtype "error_during_execution" + "No conversation
          // found". If we can retry fresh (below), swallow it; the close handler
          // decides. Otherwise surface as abort. A SUCCESS result is left to the
          // close handler's single {done:true} (avoids a double-done chunk).
          sawResultError = true;
          if (!(useResume && !didRetry)) {
            push({ done: true, _abort_reason: 'cli_result_' + (ev.subtype || 'error') });
          }
        } else if (ev.type === 'result') {
          // The SUCCESS result frame. Its TEXT is left to the close handler's
          // single {done:true} (avoids a double-done chunk) — but its USAGE is
          // the only place the CLI states the turn's real token accounting,
          // and it was dropped on the floor: the claude_cli lane reported no
          // usage at all, so the app's context meter had nothing to show for
          // the one lane a subscription user actually runs. The prompt size
          // must include the cache columns — with a warm prompt cache
          // input_tokens alone is a few hundred while the real context is
          // hundreds of thousands. modelUsage (newer CLIs) also names the
          // model's context window, which beats any hardcoded table.
          const u = ev.usage;
          if (u && typeof u === 'object') {
            const n = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : 0; };
            const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
            const usage = { input_tokens: prompt, output_tokens: n(u.output_tokens), context_used: prompt };
            try {
              const mu = ev.modelUsage && Object.values(ev.modelUsage)[0];
              if (mu && n(mu.contextWindow)) usage.context_window = n(mu.contextWindow);
            } catch (_) { /* older CLI: no modelUsage — the meter shows tokens, not a percent */ }
            if (prompt > 0 || usage.output_tokens > 0) push({ usage });
          }
        }
      };
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (parseMode === 'lines') {
          buffer += text;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line) push({ delta: line + '\n' });
          }
        } else if (parseMode === 'claude_stream_json') {
          rawBuf += text;
          buffer += text;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch (_) { continue; }
            sawJsonEvent = true;
            handleClaudeEvent(ev);
          }
        } else if (parseMode === 'json') {
          buffer += text;
        } else {
          // Raw passthrough.
          push({ delta: text });
        }
      });

      child.stderr.on('data', (chunk) => {
        // stderr is informational; don't surface as deltas (would pollute
        // the model's apparent output). Operator sees it via daemon logs
        // if the daemon stdio inherits stderr. We DO buffer up to 4KB so
        // a non-zero exit can include the tail.
        try {
          errored = errored || { stderr_tail: '' };
          if (typeof errored !== 'object') errored = { stderr_tail: '' };
          errored.stderr_tail = (errored.stderr_tail || '');
          errored.stderr_tail = (errored.stderr_tail + chunk.toString('utf8')).slice(-4096);
        } catch (_) {}
      });

      child.on('error', (e) => {
        // ENOENT etc. — binary not installed. Must carry _abort_reason: the
        // orchestrator ignores a plain done.error, so without it a missing
        // binary ended the turn as a silent empty "ok" and the entity's
        // cross-faculty fallback never fired.
        finished = true;
        push({ done: true, _abort_reason: 'cli_spawn', error: 'subprocess_spawn_failed: ' + (e && e.message || String(e)) });
      });

      child.on('close', (code) => {
        // Flush remaining buffered output.
        if (parseMode === 'json' && buffer) {
          try {
            const obj  = JSON.parse(buffer);
            const text = (obj && (obj.text || obj.output || obj.response)) || '';
            if (text) push({ delta: String(text) });
          } catch (e) {
            // Malformed JSON — surface raw buffer as delta (better than dropping).
            push({ delta: buffer });
          }
          buffer = '';
        } else if (parseMode === 'lines' && buffer) {
          push({ delta: buffer });
          buffer = '';
        } else if (parseMode === 'claude_stream_json') {
          // Parse any trailing partial line.
          const tail = buffer.trim(); buffer = '';
          if (tail) { try { handleClaudeEvent(JSON.parse(tail)); sawJsonEvent = true; } catch (_) {} }
        }

        const failed = (code !== 0) || sawResultError;

        // ── Transparent resume-failure fallback (I-3). ────────────────────────
        // A resume that fails (stale/GC'd/rolled session id → non-zero exit or
        // error result, EMPTY of real output) must NEVER dead-end the turn. Drop
        // the dead session and RE-LAUNCH ONCE with a freshly minted id (no
        // --resume). Guarded so we only ever retry a resume, only once, and only
        // when the failed launch produced no usable assistant output (a genuine
        // mid-generation failure after real deltas is surfaced, not silently
        // re-run — that would double a partial answer).
        // ...and only when THIS attempt streamed no real text (its own
        // comment's promise, which the code did not enforce — eval M1).
        if (failed && useResume && !didRetry && sessionEnabled && !sawRealDelta) {
          didRetry = true;
          try { _CLI_SESSIONS.delete(convId); } catch (_) {}
          resolvedSessionId = require('crypto').randomUUID();
          willResume = false;
          launch(false); // fresh session, same queue/iterator; caller sees no gap
          return;
        }

        // Persist the session id on a SUCCESSFUL turn (first turn that minted it,
        // or a resume we confirmed still works) so the next turn of this
        // conversation resumes it. Only claude_stream_json actually carries a
        // session; other profiles never set sessionEnabled.
        if (!failed && sessionEnabled && resolvedSessionId) {
          const prev = _CLI_SESSIONS.get(convId);
          if (!prev || prev.sessionId !== resolvedSessionId) {
            _CLI_SESSIONS.set(convId, { sessionId: resolvedSessionId, createdAt: Date.now() });
            _saveCliSessions();
          }
        }

        // Fallback: the CLI never emitted parseable stream-json (older build, or
        // it printed a plain-text error) → surface raw stdout once so the reply
        // isn't empty. Preserves the pre-stream-json behavior exactly. (After the
        // retry decision so a to-be-retried failure doesn't leak its raw error.)
        if (parseMode === 'claude_stream_json' && !sawJsonEvent && rawBuf.trim()) {
          // The raw-passthrough path bypassed AUTH_ERR_RE entirely: an old CLI
          // printing a plain-text credential failure with exit 0 shipped the
          // error text as "the answer" and blocked cross-faculty fallback.
          // Same contract as handleClaudeEvent: auth text aborts, never streams.
          if (AUTH_ERR_RE.test(rawBuf)) {
            finished = true;
            push({ done: true, _abort_reason: 'cli_auth', error: 'subprocess_auth_error' });
            return;
          }
          push({ delta: rawBuf });
        }

        finished = true;
        if (failed) {
          const tail = (errored && errored.stderr_tail) || '';
          // Surface a non-zero CLI exit as an ABORT (not a silent done) so
          // composeAgentic emits a real error instead of an empty "Done." — a CLI
          // that exits non-zero produced no usable answer. _abort_reason is what
          // the orchestrator scans for (it ignores a plain done.error).
          const ac = (code !== 0) ? code : 'result_error';
          push({ done: true, _abort_reason: 'cli_exit_' + ac, error: 'subprocess_exit_' + ac + (tail ? ': ' + tail : '') });
        } else if (!sawRealDelta && !sawToolActivity) {
          // Exit 0 with NOTHING produced — no text, no tool activity, no raw
          // fallback. A plain {done:true} here became status:'ok' with empty
          // text upstream: the pane showed nothing and no other faculty was
          // tried. Abort so the entity walks to the next faculty instead.
          push({ done: true, _abort_reason: 'cli_empty', error: 'subprocess_empty_output' });
        } else {
          push({ done: true });
        }
      });
    }

    // Kick off the first launch (resume if a session already exists for convId).
    launch(willResume);

    const iter = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (queue.length) return { value: queue.shift(), done: false };
        if (finished) return { value: undefined, done: true };
        const item = await new Promise((resolve) => { waiter = resolve; });
        if (item && item.done && !item.delta) return { value: item, done: false };
        return { value: item, done: false };
      }
    };
    // Expose handle so abort() can SIGTERM the child. A getter tracks the CURRENT
    // child across a transparent re-launch (abort must hit whichever is live).
    Object.defineProperty(iter, 'handle', { get() { return child; }, enumerable: true });
    return iter;
  }

  function abort(handle) {
    try {
      const child = (handle && handle.handle) ? handle.handle : handle;
      if (child && typeof child.kill === 'function') child.kill('SIGTERM');
    } catch (_) {}
  }

  return { stream, abort };
}

module.exports = {
  makeSubprocessCliTransport,
  PROFILES,
  // Test hooks
  _substitute,
  _resolveArgs
};
