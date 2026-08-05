// SPDX-License-Identifier: AGPL-3.0-only
// slash/executor — render a SKILL.md body into the final user prompt the
// agent loop consumes, plus emit the troth-specific substrate side-effects
// that distinguish a slash invocation from a plain text turn.
//
// Substitutions (Anthropic-compatible):
//   $ARGUMENTS       → raw_args (verbatim tail after the slash)
//   $1.. $9         → positional args from the quote-aware split
//   !`<bash cmd>`    → spawn via shared-core/tools/bash.run, splice stdout
//                      (stderr if non-empty appended in a (stderr: …) tag)
//   @<path>          → fs.read via shared-core/tools/read.run, splice with
//                      a "## File: <path>" header
//
// troth extension — substrate hook on every invocation:
//   Before the resolved prompt is returned, we write a low-salience engram
//   recording WHO invoked WHICH command with WHICH args. This is the causal
//   trace that makes future /recall + /think able to reason about prior
//   tool use without the LLM having to re-derive it. Pure write — never
//   blocks or fails the invocation if the substrate write itself errors.
//
// Output:
//   { ok: true,
//     prompt:        string,         // the rendered markdown
//     allowed_tools: string[]|null,  // forwarded from frontmatter
//     model:         string|null,    // forwarded from frontmatter
//     skill_name:    string,
//     trace_engram_id: string|null   // id of the causal-trace engram
//   }
//   { ok: false, error, detail }

const readTool = require('../tools/read.js');
const bashTool = require('../tools/bash.js');
const engram   = require('../engram.js');
const state    = require('../state.js');
const lability = require('../lability-reconsolidation.js');
const agentRegistry = require('../agent-registry.js');

// ── /engine structured options ────────────────────────────────────────────
//
// buildModelOptions(engines) returns the additive options[] the /engine report
// frame carries for a UI selection surface. It lists ONLY what is ACTUALLY
// configured on this daemon - never a static menu. `engines` is the snapshot
// the entity threads from the dispatch site:
//   { available: string[], current: <faculty|'auto:<prefer>'>,
//     kimi: boolean, backbone: string|null }
//
// Faculty options are gated on `available` (what orchestrators exist). Router
// provider options are read fail-safe from ~/.troth/config.json: a provider is
// offered ONLY when it is enabled AND has a credential (apiKey in config, or the
// matching ENV_KEY_MAP env var, or - for openai_sub - a codex token file). Only
// provider WORDS the handler already maps (deepseek/openrouter/nvidia/deepinfra/
// alibaba) become options. `current:true` is stamped on the one option that
// matches engines.current.
//
// SECRETS NEVER APPEAR: we read booleans + the presence of a credential, never
// its value; no key fragments, no urls, no host names beyond the provider word.

// Env vars the router resolves provider credentials from (mirrors the proxy
// router's ENV_KEY_MAP). Presence of a non-empty value counts as a credential
// even when config.json omits the apiKey field (env-only setups).
const ROUTER_ENV_KEY = {
  deepseek:   'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia:     'NVIDIA_API_KEY',
  deepinfra:  'DEEPINFRA_API_KEY',
  alibaba:    'ALIBABA_API_KEY'
};

// Faculty -> the /engine option value that steers to it, so `current:true` can be
// stamped on the right option. Router faculty has no single option (many
// provider words map to it); auto:<prefer> is handled inline.
const FACULTY_TO_OPTION_VALUE = {
  claude_cli:  '/engine claude',
  codex_oauth: '/engine chatgpt',
  llamacpp:    '/engine local'
};

function readTrothConfigSafe() {
  try {
    const fs = require('fs');
    // Resolve the SAME path the blessed writer uses (config-file.configPath),
    // so this read honors TROTH_CONFIG_PATH / TROTH_CONFIG_DIR exactly like the
    // /engine model-write does - the read the option menu shows and the write it
    // persists can never point at different files. Falls back to the default
    // ~/.troth/config.json when the env vars are unset.
    const p = require('../config-file.js').configPath();
    const raw = fs.readFileSync(p, 'utf8');
    const cfg = JSON.parse(raw);
    return (cfg && typeof cfg === 'object') ? cfg : {};
  } catch (_) {
    // No file, unreadable, or bad JSON - fail safe to an empty config so the
    // options list simply omits router providers rather than throwing.
    return {};
  }
}

// pinKeyForResolved(res): translate a resolveEngine() result into the proxy
// provider key that config.routing.pin understands (the router matches these
// against its byok provider names + the special-cased "local"). Returns null
// when the engine has no pinnable provider (the bare 'router' auto-chain
// sentinel, or an unknown word). kimi (backbone OR the wired kimi_sub faculty)
// pins the Moonshot byok lane, the only Kimi path config.routing.pin expresses.
function pinKeyForResolved(res) {
  if (!res) return null;
  if (res.engine === 'kimi') return 'kimi_sub';
  if (res.kind === 'faculty') {
    if (res.router_provider) return res.engine === 'router' ? null : res.engine;
    if (res.faculty === 'claude_cli') return 'anthropic';
    if (res.faculty === 'codex_oauth') return 'openai_sub';
    if (res.faculty === 'llamacpp') return 'local';
  }
  return null;
}

// pinProviderUsable(pinKey): a running proxy fails CLOSED on a pin whose
// provider is not enabled (every proxied turn errors, no auto fallback - the
// operator said "always use this"). So refuse to write such a pin and say what
// to enable, rather than silently arming a broken global route.
function pinProviderUsable(pinKey) {
  let cfg = {};
  try { cfg = readTrothConfigSafe() || {}; } catch (_) {}
  // kimi_sub (Kimi Code membership) is enabled at proxy runtime from the
  // TROTH_KIMI_SUB_KEY env, not a config.json `enabled` flag - so usability is
  // "a Kimi Code key is reachable": the env, or a kimi key in config.json.
  if (pinKey === 'kimi_sub') {
    const hasEnv = !!String(process.env.TROTH_KIMI_SUB_KEY || '').trim();
    const kc = (cfg.providers && cfg.providers.kimi_sub) || {};
    const hasCfg = !!String(kc.apiKey || cfg.kimi_sub_key || '').trim();
    if (hasEnv || hasCfg) return { ok: true };
    return { ok: false, detail: 'Kimi Code membership is not wired for the CLI yet. Set your Kimi subscription in the app (Settings, Engine), or add a kimi key to ~/.troth/config.json, then run /engine pin kimi again.' };
  }
  const prov = (cfg.providers && cfg.providers[pinKey]) || null;
  if (prov && prov.enabled) return { ok: true };
  const LABEL = {
    moonshot: 'Moonshot (pay-per-token API key)',
    anthropic: 'Claude via a raw Anthropic API key',
    openai_sub: 'ChatGPT', local: 'the local model',
    deepseek: 'DeepSeek', openrouter: 'OpenRouter',
    nvidia: 'NVIDIA', deepinfra: 'DeepInfra', alibaba: 'Alibaba'
  };
  const label = LABEL[pinKey] || pinKey;
  let hint = 'Enable it (and add its API key) in Settings, then run /engine pin ' + pinKey + ' again.';
  if (pinKey === 'anthropic') hint = 'For Claude via your Claude Code sign-in, use /engine pin auto (clears the pin so the default chain reaches Claude).';
  return { ok: false, detail: label + ' is not enabled in your providers, so pinning it would make every proxied turn fail closed. ' + hint };
}

// Best-effort: nudge a running proxy to re-read config after a pin change so
// `/engine pin` flips the LIVE engine mid-session (classic mode) without a
// restart. Fire-and-forget (socket unref'd so it never keeps a caller alive);
// if the proxy is down the pin still lands for its next boot. Host/port from
// config (defaults 127.0.0.1:8000).
function pokeProxyReload() {
  try {
    const http = require('http');
    let host = '127.0.0.1', port = 8000;
    try {
      const c = readTrothConfigSafe() || {};
      if (typeof c.host === 'string' && c.host) host = c.host;
      if (typeof c.port === 'number') port = c.port;
    } catch (_) {}
    const rq = http.request({ host, port, path: '/api/routing/reload', method: 'POST', timeout: 1500 }, (r) => { r.resume(); });
    rq.on('socket', (s) => { try { s.unref(); } catch (_) {} });
    rq.on('error', () => {});
    rq.on('timeout', () => { try { rq.destroy(); } catch (_) {} });
    rq.end();
  } catch (_) {}
}

// providerHasCredential(name, p): true when this provider entry carries a usable
// credential WITHOUT ever reading the secret value. Follows the same shape the
// config validator + router use: local needs a host, custom_openai a base_url,
// openai_sub a codex token file, everything else an apiKey (config or env).
function providerHasCredential(name, p) {
  if (!p) return false;
  if (name === 'local')         return !!p.host;
  if (name === 'custom_openai') return !!p.base_url;
  if (name === 'openai_sub') {
    try { return !!require('../codex-token-store.js').load(); } catch (_) { return false; }
  }
  if (p.apiKey) return true;
  const envVar = ROUTER_ENV_KEY[name];
  return !!(envVar && String(process.env[envVar] || '').trim());
}

function buildModelOptions(engines) {
  const eng = engines || {};
  const available = Array.isArray(eng.available) ? eng.available : [];
  const has = (faculty) => available.includes(faculty);
  const current = eng.current || null;
  const options = [];
  const push = (value, label, note) => {
    const opt = { value, label };
    if (note) opt.note = note;
    // Stamp current on the faculty option matching engines.current (mapped
    // faculty->value), or on the auto option matching an active auto override.
    const curVal = (current && FACULTY_TO_OPTION_VALUE[current]) || null;
    if (curVal && curVal === value) opt.current = true;
    options.push(opt);
  };

  // Subscription / local faculties - only what is wired. claude also shows when
  // the backbone rides claude_cli (it is force-wired in that mode).
  if (has('claude_cli') || eng.backbone === 'claude_cli') {
    push('/engine claude', 'Claude (subscription)');
  }
  if (has('codex_oauth')) {
    push('/engine chatgpt', 'ChatGPT (subscription)');
  }
  // Kimi membership - ONLY when the env is present. Honest v1 note: it rides the
  // backbone engine setting, not a per-surface faculty.
  if (eng.kimi) {
    push('/engine kimi', 'Kimi membership', 'rides the backbone engine setting (global, not per-surface in v1)');
  }
  if (has('llamacpp')) {
    push('/engine local', 'Local (this Mac)');
  }

  // Auto dispatch modes - always offerable (they reorder the wired faculties).
  const autoLocalCurrent = current === 'auto:local';
  const autoBestCurrent  = current === 'auto:best';
  {
    const o = { value: '/engine auto local-first', label: 'Auto (local-first)' };
    if (autoLocalCurrent) o.current = true;
    options.push(o);
  }
  {
    const o = { value: '/engine auto best-first', label: 'Auto (best-first)' };
    if (autoBestCurrent) o.current = true;
    options.push(o);
  }

  // Router providers - fail-safe read of ~/.troth/config.json. One option per
  // enabled+credentialed provider whose word the handler already maps.
  const cfg = readTrothConfigSafe();
  const providers = (cfg && cfg.providers && typeof cfg.providers === 'object') ? cfg.providers : {};
  const eoMod = require('../engine-override.js');
  const routerWords = (eoMod.ROUTER_PROVIDERS || []).filter((w) => w !== 'router');
  for (const word of routerWords) {
    const p = providers[word];
    if (!p || !p.enabled) continue;
    if (!providerHasCredential(word, p)) continue;
    push('/engine ' + word, word.charAt(0).toUpperCase() + word.slice(1), 'via router');
  }

  return options;
}

// ── /engine <provider> <model-id> second-level model catalog ───────────────
//
// A router-provider word (deepseek/openrouter/nvidia/deepinfra/alibaba) selects
// the router faculty. v1 also lets the operator pin THAT provider's model, the
// same value the Settings dropdown writes (providers.<name>.model). To offer a
// submenu WITHOUT any network call, we derive the provider's known model ids
// from the ONE catalog core already carries offline: the proxy cost.js RATES
// table (pricing rows keyed by model id). We require it lazily + fail-safe: if
// cost.js is unavailable the submenu is simply omitted (never throws).
//
// The provider->id mapping is deliberately CONSERVATIVE. Each provider word maps
// to a small predicate that recognizes ONLY that provider's own id shapes among
// the RATES keys, so we never offer a model a provider can't actually serve:
//   deepseek   -> deepseek-* and deepseek-ai/* rows
//   alibaba    -> the Qwen/Alibaba-plan family (qwen*, plus the m2.5/glm plan rows
//                 that ride Alibaba's Model Studio flat plan, matching cost.js's
//                 "Alibaba (flat rate per plan)" grouping and the config default
//                 qwen3-max)
//   deepinfra  -> the deepseek-ai/* rows DeepInfra serves (its config default is
//                 deepseek-ai/DeepSeek-V3-0324, present in RATES)
//   nvidia     -> the deepseek-ai/* rows NIM serves (nvidia config default is a
//                 deepseek-ai id; the priced NIM row is deepseek-ai/deepseek-v3.2)
//   openrouter -> the minimax/*:free row OpenRouter exposes
// A provider with no recognized ids offers NO submenu (the reply then only names
// its current/default model, per the operator-approved v1 shape). moonshot/xai
// rows exist in RATES but are NOT router-provider words here, so they map to no
// menu on purpose (kimi rides the backbone, grok is not a router provider).
const PROVIDER_ID_PREDICATE = {
  deepseek:   (id) => /^deepseek(-|\/)/i.test(id),
  alibaba:    (id) => /^(qwen|minimax-|glm-)/i.test(id),
  deepinfra:  (id) => /^deepseek-ai\//i.test(id),
  nvidia:     (id) => /^deepseek-ai\//i.test(id),
  openrouter: (id) => /^minimax\//i.test(id),
};

// knownModelIdsFor(providerWord) -> string[] of model ids core knows for this
// provider, sorted, deduped. Sourced from cost.js RATES via the conservative
// predicate above. No network, no throw: an unavailable cost module or an
// unmapped provider yields [].
function knownModelIdsFor(providerWord) {
  const pred = PROVIDER_ID_PREDICATE[providerWord];
  if (!pred) return [];
  let RATES;
  try { RATES = require('../../proxy/modules/cost.js').RATES; }
  catch (_) { return []; } // cost module absent -> no submenu, never fail
  if (!RATES || typeof RATES !== 'object') return [];
  const ids = Object.keys(RATES).filter((id) => {
    try { return pred(id); } catch (_) { return false; }
  });
  ids.sort();
  return ids;
}

// providerCurrentModel(providerWord, cfg) -> the model id the config currently
// pins for this provider (providers.<word>.model), or null. Read-only, no secret
// (a model id is not a credential).
function providerCurrentModel(providerWord, cfg) {
  const providers = (cfg && cfg.providers && typeof cfg.providers === 'object') ? cfg.providers : {};
  const p = providers[providerWord];
  const m = p && typeof p.model === 'string' ? p.model.trim() : '';
  return m || null;
}

// buildProviderModelOptions(providerWord, cfg) -> the second-level options[] for
// a router provider: one option per known model id, value carrying BOTH args
// ("/engine <provider> <id>") so the parser/handler routes it to the config
// write, current:true stamped on the id equal to providers.<word>.model. Empty
// array when the provider has no known ids (caller then offers no submenu).
function buildProviderModelOptions(providerWord, cfg) {
  const ids = knownModelIdsFor(providerWord);
  if (!ids.length) return [];
  const cur = providerCurrentModel(providerWord, cfg);
  return ids.map((id) => {
    const opt = { value: '/engine ' + providerWord + ' ' + id, label: id };
    if (cur && id === cur) opt.current = true;
    return opt;
  });
}

// buildModelText(head, curText, cur, engines) -> the reality-based report/error
// body the CLI surfaces read. CLI has no options UI, so the TEXT must itself
// list ONLY what is actually available - never the old static catalog. It is
// sourced from buildModelOptions(engines) so the text and the structured
// options[] can NEVER drift: one enumeration, two renders. Layout:
//   <head>: <current human label> [current]
//   Options (only what is configured):
//     · /engine auto local-first
//     · /engine deepseek (via router)
// The current choice is dropped from the Options block (already named on the
// head line) so it is not listed twice. When no engines snapshot is threaded
// (pure-CLI callers), wired faculties can't be enumerated, so we pass an empty
// `available`: the auto modes + credentialed router providers still list (they
// don't depend on the faculty snapshot), and NOTHING unconfigured appears.
function buildModelText(head, curText, cur, engines) {
  // The value the current override maps to, so we can drop it from the choice
  // list (it is already the head line) and never double-print it.
  let curValue = null;
  if (cur && cur.faculty) {
    curValue = FACULTY_TO_OPTION_VALUE[cur.faculty] || null;
  } else if (cur && cur.prefer) {
    curValue = cur.prefer === 'local' ? '/engine auto local-first'
             : cur.prefer === 'best'  ? '/engine auto best-first' : null;
  }
  const opts = buildModelOptions(engines || { available: [], current: null });
  // Mark [current] explicitly only when an override/auto-override is actually
  // set; a bare surface on the global default has nothing to "mark".
  const marked = (cur && (cur.faculty || cur.prefer)) ? ' [current]' : '';
  const lines = [head + ': ' + curText + marked];
  const choices = opts.filter((o) => o.value !== curValue);
  if (choices.length) {
    lines.push('Options (only what is configured):');
    for (const o of choices) {
      const note = o.note ? ' (' + o.note + ')' : '';
      lines.push('  · ' + o.value + note);
    }
  } else {
    lines.push('Options: none other configured - wire an engine or a router provider to add choices.');
  }
  return lines.join('\n');
}

const BASH_RE = /!`([^`]+)`/g;
// File refs: word starting with `@` followed by non-whitespace path chars.
// We deliberately require an absolute or relative-with-slash path so we
// don't grab things like an email address or a model handle.
const FILE_RE = /(^|\s)@(\/[^\s]+|\.[^\s]*\/[^\s]+|~[^\s]*)/g;

async function substituteArgs(text, raw_args, args_array) {
  let out = text.replaceAll('$ARGUMENTS', raw_args || '');
  for (let i = 1; i <= 9; i++) {
    const v = args_array[i - 1] || '';
    out = out.replaceAll('$' + i, v);
  }
  return out;
}

async function substituteBash(text) {
  // Collect commands first, run them, then splice — avoids tripping over
  // adjacent matches and lets us short-circuit if the same command
  // appears twice (small cache by command string).
  const commands = [];
  text.replace(BASH_RE, (full, cmd) => { commands.push({ full, cmd }); return ''; });
  if (!commands.length) return text;
  const seen = new Map();
  for (const c of commands) {
    if (seen.has(c.cmd)) continue;
    let res;
    try { res = await bashTool.run({ command: c.cmd, timeout: 30000 }, {}); }
    catch (e) { res = { error: 'bash_exception', detail: e && e.message || String(e) }; }
    seen.set(c.cmd, res);
  }
  return text.replace(BASH_RE, (_full, cmd) => {
    const r = seen.get(cmd);
    if (!r || r.error) return '`' + cmd + '` failed: ' + JSON.stringify(r);
    let block = (r.stdout || '').trim();
    if (r.stderr && r.stderr.trim()) block += '\n(stderr: ' + r.stderr.trim() + ')';
    return '```\n$ ' + cmd + '\n' + block + '\n```';
  });
}

async function substituteFiles(text, cwd) {
  // Resolve home, relative, absolute. Stash matches first so concurrent
  // reads don't fight on shared cache.
  const matches = [];
  text.replace(FILE_RE, (full, prefix, refPath) => { matches.push({ full, prefix, refPath }); return ''; });
  if (!matches.length) return text;
  const resolved = new Map();
  const path = require('path');
  const os = require('os');
  for (const m of matches) {
    if (resolved.has(m.refPath)) continue;
    let abs = m.refPath;
    if (abs.startsWith('~')) abs = path.join(os.homedir(), abs.slice(1));
    if (!path.isAbsolute(abs)) abs = path.resolve(cwd || process.cwd(), abs);
    let res;
    try { res = await readTool.run({ file_path: abs, limit: 500 }, {}); }
    catch (e) { res = { error: 'read_exception', detail: e && e.message || String(e) }; }
    resolved.set(m.refPath, { abs, res });
  }
  return text.replace(FILE_RE, (_full, prefix, refPath) => {
    const got = resolved.get(refPath);
    if (!got) return prefix + '@' + refPath;
    if (got.res && got.res.error) {
      return prefix + '`' + refPath + '` (read failed: ' + got.res.error + ')';
    }
    if (got.res && got.res.type === 'text') {
      return prefix + '\n## File: ' + got.abs + '\n```\n' + got.res.file.content + '\n```\n';
    }
    return prefix + '@' + refPath;
  });
}

async function execute(skill, parsed, ctx) {
  if (!skill || typeof skill.body !== 'string') {
    return { ok: false, error: 'bad_skill', detail: 'skill record missing body' };
  }
  ctx = ctx || {};
  const raw_args = (parsed && parsed.raw_args) || '';
  const args_array = (parsed && parsed.args_array) || [];

  // 1) arg substitution → 2) file refs → 3) bash interp.
  // Order matters: if $1 expands to a `!`...`` literal, we DO want the
  // bash interp pass to see it. File refs run before bash so a `@path`
  // payload doesn't accidentally collide with a backtick run.
  let body = await substituteArgs(skill.body, raw_args, args_array);
  body = await substituteFiles(body, ctx.cwd);
  body = await substituteBash(body);

  // Substrate side-effect: write a low-salience causal-trace engram. Pure
  // write, never blocks or fails the invocation. Future /recall + /think
  // queries can walk the parent_id chain to see why the agent did what.
  let trace_engram_id = null;
  try {
    if (ctx.agent_id) {
      trace_engram_id = engram.recordEngram({
        agent_id: ctx.agent_id,
        cwd:      ctx.cwd || null,
        user_id:  ctx.user_id || 'default',
        statement: 'user invoked /' + skill.name + (raw_args ? ' ' + raw_args : ''),
        scope:     'command',
        salience:  0.5,
        source:    'slash:executor'
      });
    }
  } catch (_) { /* substrate write failures must never break the invocation */ }

  return {
    ok: true,
    prompt:          body,
    allowed_tools:   skill.allowed_tools,
    model:           skill.model,
    skill_name:      skill.name,
    trace_engram_id
  };
}

// ── Deterministic dispatch ───────────────────────────────────────────────
//
// For substrate-only commands (goal/remember/forget/context/usage), bypass
// the LLM entirely. Handler returns { ok, text, side_effects } and the
// caller (entity) emits it as a `kind:'response'` directly without
// invoking composeAgentic.
//
// Why this is the right shape for voice:
//   VoiceAgentRAG (arXiv 2603.02206) splits Fast Talker (cache) from
//   Slow Thinker (LLM). Substrate IS our cache. /goal "ship it" doesn't
//   need an LLM — write the engram, say "Goal pinned: ship it." Done in
//   ~30 ms instead of 2-5 s.

const DETERMINISTIC_HANDLERS = {
  goal: async (parsed, ctx) => {
    if (!parsed.raw_args) return { ok: false, error: 'missing_args', detail: '/goal needs a statement' };
    // SLICE-B.4 — classify goal text → bump goal_class_stats so the
    // confidence calibrator builds empirical track record across goals.
    // Classifier is regex-first (v1) — fast, deterministic, no LLM cost.
    // Best-effort: classification failure falls back to 'chat' default,
    // never blocks the goal write.
    let classification = null;
    try {
      const classifier  = require('../goal-class-classifier.js');
      const calibrator  = require('../confidence-calibrator.js');
      classification = classifier.classify(parsed.raw_args);
      calibrator.recordAttempt(classification.class, { success: false /* not yet attempted */ });
    } catch (_) { classification = null; }
    const id = engram.recordEngram({
      agent_id: ctx.agent_id, cwd: ctx.cwd || null, user_id: ctx.user_id || 'default',
      statement: parsed.raw_args, salience: 2, scope: 'goal',
      source: 'slash:deterministic:goal'
    });
    // Compose response surfacing the classified class + current confidence
    // so the operator immediately sees what the substrate thinks this
    // goal is. Confidence appears as a calibration breadcrumb — low
    // confidence (sparse history) is honestly reported, not hidden.
    let classText = '';
    if (classification && classification.class) {
      try {
        const calibrator = require('../confidence-calibrator.js');
        const stats = calibrator.getStats(classification.class);
        const matched = classification.matched && classification.matched.length
          ? ' (matched: ' + classification.matched.slice(0, 3).join(', ') + ')'
          : '';
        const conf = stats.attempt_count > 0
          ? 'confidence ' + (stats.confidence * 100).toFixed(0) + '% across ' + stats.attempt_count + ' prior attempts'
          : 'first attempt at this class — no calibration yet';
        classText = '\nClass: ' + classification.class + matched + '\n' + conf;
        if (classification.fallback_to_llm) {
          classText += '\n(classifier low-confidence — would route to LLM classifier in v2)';
        }
      } catch (_) { /* skip class breadcrumb on calibrator load failure */ }
    }
    return {
      ok: !!id,
      text: 'Goal pinned: ' + parsed.raw_args + '\n(engram ' + id + ', salience 2 — surfaces in identity envelope every turn.)' + classText,
      side_effects: {
        engrams: [id],
        goal_class: classification && classification.class
      }
    };
  },

  remember: async (parsed, ctx) => {
    if (!parsed.raw_args) return { ok: false, error: 'missing_args', detail: '/remember needs a statement' };
    const id = engram.recordEngram({
      agent_id: ctx.agent_id, cwd: ctx.cwd || null, user_id: ctx.user_id || 'default',
      statement: parsed.raw_args, salience: 1, scope: null,
      source: 'slash:deterministic:remember'
    });
    return {
      ok: !!id,
      text: 'Saved: ' + parsed.raw_args,
      side_effects: { engrams: [id] }
    };
  },

  // L4 design /refuse: register a hard substrate
  // refusal as an STVC invariant. Any future tool_call whose JSON-
  // stringified args contain the phrase is rejected pre-LLM by the
  // validation gate in state.recordAction. Cross-session, cross-surface,
  // structural — not a soft "the model usually says no" promise.
  refuse: async (parsed, ctx) => {
    if (!parsed.raw_args) {
      return { ok: false, error: 'missing_args', detail: '/refuse needs a phrase' };
    }
    const phrase = parsed.raw_args.trim();
    try {
      const sm = require('../state-machine.js');
      const id = 'refuse:' + Date.now() + '-' + phrase.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const reg = sm.registerInvariant({
        id,
        severity: 'error',
        predicate: { kind: 'tool_args_substring', phrases: [phrase] },
        description: 'User refusal registered via /refuse: "' + phrase + '"',
        created_by: ctx.agent_id || 'slash:refuse'
      });
      return {
        ok: true,
        text: 'Refusal registered. Substrate will block every tool_call whose args contain "' + phrase + '".\n(invariant ' + reg.id + ', severity=' + reg.severity + ', global scope)',
        side_effects: { invariants: [reg.id] }
      };
    } catch (e) {
      return { ok: false, error: 'invariant_write_failed', detail: String(e && e.message || e) };
    }
  },

  // L4 design /invariants list | remove <id>: manage the STVC
  // invariant set the substrate is enforcing. Operator-only escape hatch
  // for inspecting what's blocking writes + removing stale rules.
  invariants: async (parsed, ctx) => {
    const sm = require('../state-machine.js');
    const args = (parsed.args_array || []).slice();
    const cmd = (args.shift() || 'list').toLowerCase();
    if (cmd === 'list') {
      const all = sm.listInvariants({});
      if (!all.length) {
        return { ok: true, text: 'No invariants registered. (Seeds should populate at first migrate — try restarting troth if this is unexpected.)' };
      }
      const lines = ['Registered STVC invariants (' + all.length + '):'];
      // Sort: seeds first, then refuse:, then everything else; within each group, by id.
      all.sort((a, b) => {
        const ga = /^seed:/.test(a.id) ? 0 : /^refuse:/.test(a.id) ? 1 : 2;
        const gb = /^seed:/.test(b.id) ? 0 : /^refuse:/.test(b.id) ? 1 : 2;
        if (ga !== gb) return ga - gb;
        return a.id < b.id ? -1 : 1;
      });
      for (const inv of all) {
        const kind = (inv.predicate && inv.predicate.kind) || '?';
        const desc = inv.description ? ' — ' + inv.description.slice(0, 80) : '';
        lines.push('  [' + inv.severity + '] ' + inv.id + ' (' + kind + ')' + desc);
      }
      return { ok: true, text: lines.join('\n') };
    }
    if (cmd === 'remove') {
      const id = args.join(' ').trim();
      if (!id) return { ok: false, error: 'missing_args', detail: '/invariants remove <id>' };
      const removed = sm.deleteInvariant(id);
      if (!removed) {
        return { ok: true, text: 'No invariant matched id="' + id + '" (already gone or typo).' };
      }
      return {
        ok: true,
        text: 'Removed invariant: ' + id + (/^seed:/.test(id) ? '\n⚠ This was a SEEDED invariant — substrate safety floor weakened. Re-add via troth migrate, or substrate restart will re-seed.' : ''),
        side_effects: { invariants_removed: [id] }
      };
    }
    return { ok: false, error: 'unknown_subcommand', detail: 'usage: /invariants [list | remove <id>]' };
  },

  forget: async (parsed, ctx) => {
    if (!parsed.raw_args) return { ok: false, error: 'missing_args', detail: '/forget needs a query' };
    // Read across the whole partner brain — /forget should match an
    // engram regardless of which surface (cli/voice/claude-code/proxy)
    // wrote it. agent_id stays as write-time provenance only.
    // /forget operates on commitment-engrams only — you can't "forget"
    // a dialogue turn (immutable history) or an intent (goal record).
    // commitment_only:true keeps this on the legacy commitment+embedding
    // pipeline even now that retrieveRelevant defaults to cross-type.
    const matches = await engram.retrieveRelevant({
      cwd: ctx.cwd || null,
      query: parsed.raw_args, k: 1,
      commitment_only: true
    });
    if (!matches.length) {
      return { ok: true, text: 'Nothing in substrate matches "' + parsed.raw_args + '" — already forgotten.' };
    }
    const target = matches[0];
    // Need the RAW action_records row (retrieveRelevant returns a projection):
    // reconsolidate inherits the prior's audience + memory_class + scope, so the
    // superseder lands in the SAME recall pool as the original — the only place
    // buildSupersededIds can see the pointer.
    let raw = null;
    try { raw = state.getAction(target.id); } catch (_) { raw = null; }
    if (!raw) {
      return { ok: false, error: 'target_row_missing', detail: 'could not load the matched engram to retire it' };
    }
    let rawOut; try { rawOut = typeof raw.output === 'string' ? JSON.parse(raw.output) : (raw.output || {}); } catch (_) { rawOut = {}; }
    // Signed operator facts (operator_confirmed) are the crypto-anchored floor.
    // A casual /forget must NOT retire them — that needs a signed operation.
    // Say so honestly rather than pretend.
    if ((rawOut.source_authority || 'regex_extracted') === 'operator_confirmed') {
      return {
        ok: false,
        error: 'protected',
        text: 'That is a signed operator fact — /forget can not retire it (it needs a signed operation).',
        side_effects: { protected_id: target.id }
      };
    }
    // The REAL suppression mechanism. The old code wrote a "TOMBSTONE: …" engram
    // at scope 'system:tombstone', which NOTHING filters, so the original kept
    // surfacing (the SKILL's claim that listEngrams excluded it was false).
    // Retirement here is a supersession pointer, written via the blessed
    // reconsolidation primitive: it writes a successor pointing
    // lifetime.supersedes at the original (every recall path hides the
    // original) at tier='flagged' (the successor itself never surfaces), and
    // inherits the prior's audience/class/scope so both sit in the same recall
    // pool where the pointer is actually seen. The successor statement carries
    // the original text so an FTS-driven recall co-retrieves it (that is how
    // the pointer registers) — safe because tier='flagged' keeps it out of
    // every default read (recall + listEngrams both exclude flagged now).
    const forgotMarker = 'FORGOTTEN: ' + rawOut.statement;
    const id = lability.reconsolidate({
      state,
      prior_engram: raw,
      new_statement: forgotMarker,
      tier: 'flagged',
      reason: 'operator_forget',
      agent_id: ctx.agent_id || raw.agent_id || null,
      cwd: ctx.cwd || raw.cwd || null,
      user_id: ctx.user_id || raw.user_id || 'default',
      trigger_text: parsed.raw_args
    });
    return {
      ok: !!id,
      text: id
        ? 'Forgotten: ' + target.statement.slice(0, 100) + (target.statement.length > 100 ? '…' : '')
        : 'Could not forget that — the retire write was rejected (it may be a protected fact).',
      side_effects: { engrams: id ? [id] : [], forgot_id: target.id }
    };
  },

  context: async (_parsed, ctx) => {
    // /context surfaces the partner brain — goals + recent engrams +
    // recent turns from EVERY surface (cli/voice/claude-code/proxy
    // mirror), not just the surface that invoked /context. agent_id
    // is intentionally omitted; principal defaults to 'partner'.
    const goals = engram.listEngrams({
      cwd: ctx.cwd || null, scope: 'goal', limit: 5
    });
    const recent = engram.listEngrams({
      cwd: ctx.cwd || null, limit: 5
    });
    let dialogue = [];
    try {
      const dialogueMemory = require('../dialogue-memory.js');
      dialogue = dialogueMemory.recentTurns({ cwd: ctx.cwd || null, limit: 3 }) || [];
    } catch (_) { /* dialogue is optional */ }
    const lines = ['Substrate snapshot for ' + (ctx.agent_id || 'unknown') + ':'];
    if (goals.length) {
      lines.push('  GOALS (' + goals.length + '):');
      for (const g of goals) lines.push('    - ' + g.statement);
    } else {
      lines.push('  GOALS: none. Pin one with /goal <statement>.');
    }
    if (recent.length) {
      lines.push('  RECENT ENGRAMS (' + recent.length + '):');
      for (const r of recent) lines.push('    - [' + (r.scope || 'general') + '] ' + r.statement.slice(0, 90));
    }
    if (dialogue.length) {
      lines.push('  LAST TURNS:');
      for (const t of dialogue.slice(-3)) {
        lines.push('    user: ' + (t.user_text || '').slice(0, 80));
      }
    }
    return { ok: true, text: lines.join('\n') };
  },

  'dialogue-reset': async (_parsed, ctx) => {
    // Identity is in substrate — never destroyed by /dialogue-reset. We just count
    // what survives so the user sees what's preserved, then emit a
    // side_effect that the caller (chat REPL / voice) interprets as
    // "drop the live turn buffer." Substrate engrams remain untouched.
    // /dialogue-reset preserves identity = the partner brain. Count across
    // all surfaces, not just the one that issued it.
    const goals  = engram.listEngrams({ cwd: ctx.cwd || null, scope: 'goal', limit: 100 });
    const recent = engram.listEngrams({ cwd: ctx.cwd || null, limit: 100 });
    return {
      ok: true,
      text: 'Cleared. Identity preserved (' +
        goals.length + ' goal' + (goals.length === 1 ? '' : 's') + ', ' +
        recent.length + ' engram' + (recent.length === 1 ? '' : 's') + ' loaded for next turn).',
      side_effects: { dialogue_reset: true, identity_preserved: true,
                      goals_kept: goals.length, engrams_kept: recent.length }
    };
  },

  // /agent — single operator entry point for the entire sub-brain
  // workflow. Behavior is shaped by argument pattern:
  //   (empty)                       → list
  //   <name|prefix|number>          → switch (fuzzy)
  //   <name> + | <name> --new       → create + (optional --tag, --persona)
  //   <a>,<b>[,...] <task...>       → team dispatch (parallel sub-brain workers)
  //   stop [group_id]               → cancel team dispatch
  //   retire <name>                 → mark inactive
  // Resolution is fuzzy: exact id/name → numbered index → unique prefix.
  // Two matches return an ambiguous error; zero matches an unknown one.
  agent: async (parsed, ctx) => {
    const args = parsed.args_array || [];
    const raw  = parsed.raw_args || '';

    // Fuzzy resolver — exact > numeric index > unique prefix.
    function resolveTarget(target) {
      if (!target) return { row: null };
      const exact = agentRegistry.getAgent(target) || agentRegistry.getAgentByName(target);
      if (exact) return { row: exact };
      const all = agentRegistry.listAgents({}) || [];
      if (/^\d+$/.test(target)) {
        const idx = parseInt(target, 10) - 1;
        if (idx >= 0 && idx < all.length) return { row: all[idx] };
        return { row: null, error: 'index_out_of_range', max: all.length };
      }
      const lower = target.toLowerCase();
      const prefixHits = all.filter((r) =>
        (r.name || '').toLowerCase().startsWith(lower) ||
        (r.id   || '').toLowerCase().startsWith(lower)
      );
      if (prefixHits.length === 1) return { row: prefixHits[0] };
      if (prefixHits.length > 1)   return { row: null, ambiguous: prefixHits };
      return { row: null };
    }

    // Helper — render the registered sub-brain roster as a small "game
    // menu". Operator UX over CLI-syntax: show who exists, mark the
    // active one, list actions in natural language with the literal
    // command on the right, close with one sentence on why this exists
    // (why sub-brains beat one big brain).
    function listBrains() {
      const rows = agentRegistry.listAgents({}) || [];
      const out  = [];
      if (!rows.length) {
        out.push('No sub-brains yet.');
        out.push('');
        out.push('Make your first one:   /agent <name> +');
        out.push('  example: /agent cooking +');
        out.push('');
        out.push('Why: each sub-brain keeps its own memory slice, so a "cooking"');
        out.push('brain doesn\'t carry your refactor history into a recipe question.');
        return { ok: true, text: out.join('\n') };
      }
      out.push('Your sub-brains:');
      rows.forEach((r, i) => {
        const here = r.id === ctx.agent_id;
        const marker = here ? '  ▸ ' : '    ';
        const status = here ? '  ← you\'re here' : '';
        const tag    = r.tag ? ' (' + r.tag + ')' : '';
        out.push(marker + (i + 1) + '. ' + r.name + tag + status);
      });
      out.push('');
      out.push('What you can do:');
      out.push('  switch to one         /agent <name|number|prefix>');
      out.push('  make a new one        /agent <name> +');
      out.push('  ask several at once   /agent name1,name2,... <task>');
      out.push('  stop a running team   /agent stop');
      out.push('  retire one            /agent retire <name>');
      out.push('');
      out.push('Tip: prefix or number works — `/agent cook` or `/agent 2`.');
      out.push('');
      out.push('Why sub-brains: each keeps its own memory + persona. Switch to');
      out.push('a focused one for clean context, or team several for multi-angle work.');
      return { ok: true, text: out.join('\n') };
    }

    // Empty → list.
    if (!args.length) return listBrains();

    // /agent stop [group_id] — cancel team dispatch.
    if (args[0] === 'stop') {
      const givenGroup = args[1] || null;
      let runner;
      try { runner = require('../../bin/runner.js'); }
      catch (e) { return { ok: false, error: 'runner_unavailable', detail: e && e.message }; }
      const stateMod = require('../state.js');
      let spawns = [];
      try {
        spawns = stateMod.queryActions({
          type: 'decision', agent_id: 'orchestrator', limit: 200, order: 'desc'
        }) || [];
      } catch (e) { return { ok: false, error: 'state_query_failed', detail: e && e.message }; }
      let groupId = givenGroup;
      if (!groupId) {
        for (const row of spawns) {
          let inp; try { inp = JSON.parse(row.input); } catch (_) { continue; }
          if (inp && inp.kind === 'role_worker_spawned' && inp.group_id) {
            groupId = inp.group_id;
            break;
          }
        }
      }
      if (!groupId) {
        return { ok: true, text: 'Nothing to stop — no recent dispatch group found.' };
      }
      const killed = [];
      const seen = new Set();
      for (const row of spawns) {
        let inp; try { inp = JSON.parse(row.input); } catch (_) { continue; }
        let outp;try { outp = JSON.parse(row.output); } catch (_) { continue; }
        if (!inp || inp.kind !== 'role_worker_spawned' || inp.group_id !== groupId) continue;
        const runId = outp && outp.runId;
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        let ok = false;
        try { ok = !!runner.killWorker(runId); } catch (_) { ok = false; }
        if (ok) killed.push({ runId, role: inp.role });
      }
      return {
        ok: true,
        text: killed.length
          ? 'Stopped ' + killed.length + ' worker' + (killed.length === 1 ? '' : 's') + ' (group ' + groupId + ').'
          : 'No active workers in group ' + groupId + ' (already finished).',
        side_effects: { stopped_group: groupId, killed_count: killed.length }
      };
    }

    // /agent retire <name|prefix|number>
    if (args[0] === 'retire') {
      const target = args[1];
      if (!target) return { ok: false, error: 'missing_args', detail: '/agent retire <name>' };
      const r = resolveTarget(target);
      if (r.ambiguous) return { ok: false, error: 'ambiguous', detail: target + ' matches: ' + r.ambiguous.map((a) => a.name).join(', ') };
      if (!r.row) return { ok: false, error: 'unknown_agent', detail: 'no sub-brain matching ' + target };
      const ok = agentRegistry.retireAgent(r.row.id);
      return { ok: !!ok, text: ok ? 'Retired ' + r.row.name + ' (id=' + r.row.id + '). Audit trail kept.' : 'Failed to retire ' + r.row.name };
    }

    // Comma in first arg → team dispatch.
    if (args[0].includes(',')) {
      const names = args[0].split(',').map((s) => s.trim()).filter(Boolean);
      const task = args.slice(1).join(' ').trim();
      if (!task) {
        return { ok: false, error: 'missing_task', detail: 'Team dispatch needs a task after the agent list. Try: /agent cooking,nutrition plan a meal' };
      }
      const resolved = [];
      const missing = [];
      const ambiguous = [];
      for (const n of names) {
        const r = resolveTarget(n);
        if (r.ambiguous) ambiguous.push(n + ' → ' + r.ambiguous.map((a) => a.name).join('|'));
        else if (r.row)  resolved.push(r.row);
        else             missing.push(n);
      }
      if (ambiguous.length) {
        return { ok: false, error: 'ambiguous', detail: 'ambiguous prefixes: ' + ambiguous.join('; ') };
      }
      if (missing.length) {
        return { ok: false, error: 'unknown_agents', detail: 'unknown sub-brains: ' + missing.join(', ') };
      }
      let supervisor;
      try { supervisor = require('../agent-supervisor.js'); }
      catch (e) { return { ok: false, error: 'supervisor_missing', detail: e && e.message }; }
      const groupId = 'team-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const spawned = [];
      const failed  = [];
      for (const sb of resolved) {
        const roleLabel = sb.tag || sb.name || sb.id;
        const r = supervisor.spawnRoleWorker(roleLabel, task, {
          group_id: groupId, sub_brain_id: sb.id, cwd: ctx.cwd || null
        });
        if (r && r.ok) spawned.push({ sub_brain: sb.id, name: sb.name, runId: r.runId });
        else           failed.push({  sub_brain: sb.id, name: sb.name, error: r && r.error });
      }
      const lines = [
        'Team dispatched (group=' + groupId + '):',
        ...spawned.map((s) => '  ✓ ' + s.name + ' (run=' + s.runId + ')'),
        ...failed.map((f)  => '  ✗ ' + f.name + ' — ' + (f.error || 'unknown error'))
      ];
      if (spawned.length) {
        lines.push('');
        lines.push('Stop with /agent stop ' + groupId);
      }
      return {
        ok: spawned.length > 0,
        text: lines.join('\n'),
        side_effects: { team_group_id: groupId, spawned, failed }
      };
    }

    // /agent <name> + | --new → create.
    const wantsNew = args.includes('+') || args.includes('--new');
    if (wantsNew) {
      const rawName = args[0];
      let tag = null;
      let persona = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--tag' && args[i + 1])     { tag = args[++i]; continue; }
        if (args[i] === '--persona' && args[i + 1]) { persona = args[++i]; continue; }
      }
      const slug = String(rawName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      const id = slug || rawName;
      const row = agentRegistry.createAgent({
        id, name: rawName, tag, persona,
        parent_agent_id: ctx.agent_id || null
      });
      if (!row) return { ok: false, error: 'create_failed', detail: 'agent-registry rejected the row' };
      return {
        ok: true,
        text: 'Sub-brain created: ' + row.name + ' (id=' + row.id + ')' +
              (tag ? ', tag=' + tag : '') +
              (row.parent_agent_id ? ', under ' + row.parent_agent_id : ', top-level') +
              '. Switch with /agent ' + row.name + '.',
        side_effects: { agent_created: row.id }
      };
    }

    // /agent <name|prefix|number> → switch (fuzzy resolution).
    const target = args[0];
    const r = resolveTarget(target);
    if (r.ambiguous) {
      return { ok: false, error: 'ambiguous',
        detail: '"' + target + '" matches: ' + r.ambiguous.map((a) => a.name).join(', ') + '. Type more letters or pick by number.' };
    }
    if (!r.row) {
      const detail = r.error === 'index_out_of_range'
        ? 'no sub-brain at index ' + target + ' (only ' + r.max + ' registered)'
        : 'no sub-brain matching "' + target + '". Create with: /agent ' + target + ' +';
      return { ok: false, error: 'unknown_agent', detail };
    }
    const row = r.row;
    if (row.id === ctx.agent_id) {
      return { ok: true, text: 'Already on ' + row.name + ' (id=' + row.id + ').' };
    }
    return {
      ok: true,
      text: 'Switching to ' + row.name + ' (id=' + row.id + (row.tag ? ', tag=' + row.tag : '') + ').',
      side_effects: { switch_agent: row.id }
    };
  },


  // /mcps lists the partner's external MCP "hands": ACTIVE servers (resolved
  // from the global registry merged with the project.mcp.json) and PENDING
  // ones (staged via mcp_register_request, awaiting operator approval). Pure
  // read: NEVER spawns a server (tool counts would need a spawn, so we list
  // names + transport only from the registry file) and NEVER prints a secret.
  // Env values and $vault refs are masked, remote urls are elided. Read-only
  // by design, exactly like /context. Works on tagged panes and untagged
  // surfaces (the caller applies the conversation tag; this returns plain text).
  mcps: async (_parsed, ctx) => {
    let mcpClient;
    try { mcpClient = require('../tools/mcp-client.js'); }
    catch (e) { return { ok: false, error: 'mcp_client_unavailable', detail: e && e.message || String(e) }; }

    // ACTIVE: global ~/.troth/mcp-clients.json merged with <cwd>/.mcp.json
    // (project wins collisions). loadDownstream reads only those files (never
    // the inert pending file) and returns {name: config}. It never throws.
    let active = {};
    try { active = mcpClient.loadDownstream(null, (ctx && ctx.cwd) || null) || {}; }
    catch (_) { active = {}; }
    // Normalize each active entry's transport WITHOUT touching its secrets:
    // http/sse => 'http', anything with a command => 'stdio'. We read the
    // shape key only, never the url or env values.
    const activeRows = Object.keys(active).sort().map((name) => {
      const cfg = active[name] || {};
      const t = String(cfg.type || cfg.transport || '').toLowerCase();
      const transport = (t === 'http' || t === 'sse') ? 'http' : 'stdio';
      return { name, transport };
    });

    // PENDING: staged entries awaiting operator approval. listPendingServers
    // returns {name, transport, config, note, requested_at}; we surface only
    // name + note, never the config (which may carry $vault refs / a url).
    let pending = [];
    try { pending = mcpClient.listPendingServers() || []; }
    catch (_) { pending = []; }

    const lines = ['MCP servers (the partner\'s external hands):'];
    if (activeRows.length) {
      lines.push('');
      lines.push('ACTIVE (' + activeRows.length + '):');
      for (const r of activeRows) {
        lines.push('  - ' + r.name + '  [' + r.transport + ']');
      }
    } else {
      lines.push('');
      lines.push('ACTIVE: none configured.');
    }
    if (pending.length) {
      lines.push('');
      lines.push('PENDING (' + pending.length + '):');
      for (const p of pending) {
        const note = (typeof p.note === 'string' && p.note.length) ? ' - ' + p.note : '';
        lines.push('  - ' + p.name + '  (awaiting your approval)' + note);
      }
      lines.push('');
      lines.push('Approve or reject a pending server from the app popup, or with `troth mcp approve <name>` / `troth mcp reject <name>`.');
    } else {
      lines.push('');
      lines.push('PENDING: none awaiting approval.');
    }
    return { ok: true, text: lines.join('\n') };
  },

  usage: async (_parsed, _ctx) => {
    // Hit the local proxy via Bash — keeps the dependency surface small.
    const bashTool = require('../tools/bash.js');
    const r = await bashTool.run({ command: 'curl -s --max-time 2 http://localhost:8000/api/stats', timeout: 5000 }, {});
    if (r.error || !r.stdout) {
      return { ok: true, text: 'Proxy not reachable on localhost:8000 — start it with `troth` (no args) or check `troth status`.' };
    }
    let stats;
    try { stats = JSON.parse(r.stdout); } catch (_) {
      return { ok: true, text: 'Proxy reachable but returned non-JSON. Raw: ' + r.stdout.slice(0, 300) };
    }
    const lines = ['Usage snapshot:'];
    if (stats.tokens_in != null)  lines.push('  tokens in : ' + stats.tokens_in);
    if (stats.tokens_out != null) lines.push('  tokens out: ' + stats.tokens_out);
    if (stats.requests != null)   lines.push('  requests  : ' + stats.requests);
    if (stats.cost_estimate != null) lines.push('  cost est. : $' + stats.cost_estimate);
    if (lines.length === 1) lines.push('  (proxy returned no recognized stats fields)');
    return { ok: true, text: lines.join('\n') };
  },

  // /engine — per-conversation engine override (Claude-Code-style). In a
  // focused pane the operator types /engine <engine> to steer WHICH faculty
  // answers THAT conversation from now on, without touching the global engine
  // pin that governs every other pane. Deterministic, runtime-only: it writes
  // the daemon's in-memory conversation->override map (shared-core/engine-
  // override.js), never a durable substrate record, exactly like /mcps and
  // /context are read-only. The dispatch site consults that map BEFORE the
  // global pin fence, so an explicit /engine override beats the global pin
  // (operator explicitness wins) and stamps an engine_override annotation on
  // the dispatch frame. Needs the conversation_id: the feeder threads it into
  // ctx (a tagless surface - voice/CLI - has no pane to scope, so we say so).
  engine: async (parsed, ctx) => {
    const eo = require('../engine-override.js');
    // A tagged pane threads a real conversation_id; the troth CLI and voice
    // surfaces thread none (null/undefined). Both are steerable: a null id maps
    // to the shared untagged-surface bucket (see engine-override.bucketKey), so
    // /engine works everywhere. convId is the RAW inbound id (kept null for the
    // untagged surface so the store buckets it); scope wording keys off it.
    const convId = ctx && ctx.conversation_id != null ? ctx.conversation_id : null;
    const untagged = eo.isUntagged(convId);
    // Scope phrasing: honest about which surface the override lives on.
    const scopeThis = untagged ? 'this terminal surface' : 'this pane';
    const scopeOthers = untagged
      ? 'This terminal surface only; tagged conversations are unaffected.'
      : 'This pane only; other panes keep the global default.';
    const args = (parsed.args_array || []).slice();
    const word = args.shift();
    const modeTail = args.join(' ');

    // The choice enumeration is reality-based: the SAME source buildModelOptions
    // reads (wired faculties from ctx.engines + credentialed router providers +
    // the always-offerable auto modes). CLI surfaces have no options UI, so the
    // TEXT itself must carry it; NOTHING unconfigured may appear. When no engines
    // snapshot is threaded, wired faculties can't be enumerated, so we pass an
    // empty faculty snapshot: auto modes + credentialed router providers still
    // list, and no unwired faculty is invented.
    const realChoices = () =>
      buildModelOptions((ctx && ctx.engines) || { available: [], current: null })
        .map((o) => o.value)
        .join(' · ');

    // /engine pin <engine> - the terminal/CLI global engine lever. Distinct
    // from the per-surface override below: this writes config.routing.pin (the
    // proxy's "always use this provider"), so a PROXIED surface (troth classic,
    // or the Troth REPL) routes every turn to that engine. Gated to the untagged
    // terminal surface - a tagged pane must never silently repoint the whole
    // machine; there /engine <engine> is the right per-pane control.
    if (word === 'pin') {
      if (!untagged) {
        return { ok: false, error: 'pin_needs_terminal',
          detail: 'Pinning the global engine is a terminal/CLI action. In a pane, /engine <engine> sets a per-pane override instead.' };
      }
      const configFile = require('../config-file.js');
      const target = String(modeTail || '').trim();
      // Bare /engine pin -> report the current global pin, honestly.
      if (!target) {
        let curPin = '';
        try { curPin = ((readTrothConfigSafe().routing) || {}).pin || ''; } catch (_) {}
        return { ok: true, text: curPin
          ? 'Global engine pin: ' + curPin + '. Every proxied surface (troth classic / the Troth REPL) routes here.\nClear it with /engine pin auto.'
          : 'Global engine pin: none (auto - the router picks per tier).\nSet one with /engine pin <engine>, e.g. /engine pin chatgpt or /engine pin kimi.' };
      }
      const firstTok = target.split(/\s+/)[0];
      const pres = eo.resolveEngine(firstTok, '');
      // /engine pin auto|none|off|clear -> clear the pin (back to the tier chain).
      const clearing = (pres.kind === 'auto' && pres.prefer == null) ||
        ['none', 'off', 'clear'].indexOf(firstTok.toLowerCase()) !== -1;
      if (clearing) {
        try {
          configFile.updateConfig((c) => {
            if (!c.routing || typeof c.routing !== 'object') c.routing = {};
            c.routing.pin = '';
            return c;
          });
        } catch (e) { return { ok: false, error: 'config_write_failed', detail: String((e && e.message) || e) }; }
        pokeProxyReload();
        return { ok: true,
          text: '✓ auto (global)',
          side_effects: { routing_pin: { pin: '' } } };
      }
      const pinKey = pinKeyForResolved(pres);
      if (!pinKey) {
        return { ok: false, error: 'unknown_engine',
          detail: '"' + firstTok + '" is not a pinnable engine. Available: ' + realChoices() + ', or /engine pin auto to clear.' };
      }
      const usable = pinProviderUsable(pinKey);
      if (!usable.ok) { return { ok: false, error: 'provider_not_ready', detail: usable.detail }; }
      try {
        configFile.updateConfig((c) => {
          if (!c.routing || typeof c.routing !== 'object') c.routing = {};
          c.routing.pin = pinKey;
          return c;
        });
      } catch (e) { return { ok: false, error: 'config_write_failed', detail: String((e && e.message) || e) }; }
      pokeProxyReload();
      return { ok: true,
        text: '✓ ' + firstTok + ' (global)',
        side_effects: { routing_pin: { pin: pinKey, engine: firstTok } } };
    }

    const res = eo.resolveEngine(word, modeTail);

    // Bare /engine (or /engine with no engine word) -> report the surface's
    // current effective engine + ONLY the real choices, one per line, current
    // marked. The untagged CLI/voice surface reports its own shared bucket
    // honestly ("this terminal surface").
    if (res.kind === 'report') {
      const cur = eo.get(convId);
      let curText;
      if (cur && cur.faculty) {
        curText = cur.engine + ' (' + cur.faculty + ')' + (cur.prefer ? ', prefer=' + cur.prefer : '');
      } else if (cur && cur.prefer) {
        curText = 'global default, prefer=' + cur.prefer + '-first';
      } else {
        curText = 'global default (no override)';
      }
      const head = untagged ? 'This terminal surface' : 'This pane';
      // text is the complete standalone answer AND reality-based: it lists only
      // what is actually configured (same source as options[]), so the two can
      // never drift. options[] stays the ADDITIVE structured array for a UI
      // selection surface, built from the wired snapshot; when none is threaded
      // we omit it (the text already carries the auto modes + router providers).
      const options = ctx && ctx.engines ? buildModelOptions(ctx.engines) : null;
      const text = buildModelText(head, curText, cur, (ctx && ctx.engines) || null);
      const reply = { ok: true, text };
      if (options && options.length) reply.options = options;
      return reply;
    }

    if (res.kind === 'unknown') {
      return { ok: false, error: 'unknown_engine',
        detail: '"' + res.engine + '" is not a configured engine. Available: ' + realChoices() + '.' };
    }

    // kimi rides the global backbone env, not a per-surface faculty. Say so.
    if (res.kind === 'backbone') {
      return { ok: true, text: res.engine + ' rides the backbone engine setting, which is global, not per-surface in v1. Pin it in Settings and every surface on the backbone uses it.\n(' + scopeThis.charAt(0).toUpperCase() + scopeThis.slice(1) + ' keeps its current engine.)' };
    }

    // /engine auto <mode> and bare /engine auto.
    if (res.kind === 'auto') {
      if (res.prefer == null) {
        eo.clear(convId);
        return { ok: true, text: '✓ auto', side_effects: { engine_override: { conversation_id: convId, cleared: true } } };
      }
      eo.setPrefer(convId, res.prefer);
      return {
        ok: true,
        text: '✓ ' + res.prefer + '-first',
        side_effects: { engine_override: { conversation_id: convId, prefer: res.prefer } }
      };
    }

    // res.kind === 'faculty' -> a real per-surface engine override.
    // Router providers get a second level: /engine <provider> [<model-id>].
    // A bare /engine <provider> sets the pane override to the router faculty AND
    // offers that provider's known models as a submenu; /engine <provider> <id>
    // ALSO writes providers.<provider>.model globally (the Settings-dropdown value).
    if (res.router_provider) {
      const provider = res.engine;
      const modelArg = String(modeTail || '').trim();
      const cfg = readTrothConfigSafe();

      // Router config-reload reality (verified read-only against the proxy
      // router): proxy/modules/router.js calls loadProviders ONCE
      // at module load (router.js:2380) and caches the providers object in
      // process memory; there is no fs.watch on config.json and per-request
      // reads hit the cached object. So a running daemon does NOT hot-reload a
      // model change - it takes effect on the router's next respawn/restart.
      const respawnNote = 'A running daemon keeps its current model until it respawns (the router caches providers at boot); the change lands on its next restart.';

      // /engine <provider> <model-id> -> validate + persist the model globally.
      if (modelArg) {
        const known = knownModelIdsFor(provider);
        if (known.length && !known.includes(modelArg)) {
          // Refuse honestly, listing the ids core knows for this provider.
          return {
            ok: false, error: 'unknown_model',
            detail: '"' + modelArg + '" is not a known model for ' + provider +
                    '. Known: ' + known.join(', ') + '.'
          };
        }
        if (!known.length) {
          // No catalog for this provider: we cannot vouch for the id, so we do
          // not silently persist an unvalidated model. Say so.
          return {
            ok: false, error: 'no_model_catalog',
            detail: 'No model catalog is available for ' + provider +
                    ' core-side, so /engine ' + provider + ' <model-id> cannot be validated. ' +
                    'Set the model from Settings (the provider dropdown).'
          };
        }
        // Set the pane override to the router faculty (same as the bare word).
        eo.setFaculty(convId, res.engine, res.faculty, true);
        // Atomic read-modify-write of providers.<provider>.model via the ONE
        // blessed config writer (fresh read, temp+rename, dir 0700/file 0600,
        // preserves every other key). Never echoes a secret - a model id is not
        // a credential, and no other field is read or logged.
        let wrote = false;
        try {
          const configFile = require('../config-file.js');
          configFile.updateConfig((c) => {
            if (!c.providers || typeof c.providers !== 'object') c.providers = {};
            if (!c.providers[provider] || typeof c.providers[provider] !== 'object') c.providers[provider] = {};
            c.providers[provider].model = modelArg;
            return c;
          });
          wrote = true;
        } catch (e) {
          return { ok: false, error: 'config_write_failed', detail: String(e && e.message || e) };
        }
        return {
          ok: wrote,
          text: '✓ ' + res.engine + ' · model ' + modelArg,
          side_effects: {
            engine_override: { conversation_id: convId, engine: res.engine, faculty: res.faculty },
            provider_model: { provider, model: modelArg }
          }
        };
      }

      // Bare /engine <provider> -> set the router-faculty override + offer the
      // provider's models as a second-level submenu (empty when core has no
      // catalog for it; the text then just names its current/default model).
      eo.setFaculty(convId, res.engine, res.faculty, true);
      const models = buildProviderModelOptions(provider, cfg);
      const curModel = providerCurrentModel(provider, cfg);
      const modelLine = models.length
        ? '\nModels for ' + provider + ' (choose one to pin it globally):'
        : '\nModel: ' + (curModel || provider + ' default') + ' (no submenu - core has no model catalog for ' + provider + ').';
      const reply = {
        ok: true,
        text: '✓ ' + res.engine,
        side_effects: { engine_override: { conversation_id: convId, engine: res.engine, faculty: res.faculty } }
      };
      if (models.length) reply.options = models;
      return reply;
    }

    // Non-router faculty (claude/chatgpt/local): a plain per-surface override.
    eo.setFaculty(convId, res.engine, res.faculty, res.router_provider);
    return {
      ok: true,
      text: '✓ ' + res.engine,
      side_effects: { engine_override: { conversation_id: convId, engine: res.engine, faculty: res.faculty } }
    };
  },

  // /help - enumerate EVERY available command, one per line, compact. Uses the
  // SAME enumeration the Rust palette consumes (loader.skillSummaries: the
  // skills dirs + the deterministic-handler skills, since every deterministic
  // handler ships a SKILL.md). Driving both surfaces off one enumeration is why
  // the palette and /help can never drift - add a skill, both see it. Fail-safe:
  // an unreadable skills dir yields a shorter list, never an error card.
  // Deterministic (no LLM): pure metadata read, instant.
  help: async (_parsed, ctx) => {
    let rows = [];
    try {
      const loader = require('./loader.js');
      rows = loader.skillSummaries((ctx && ctx.cwd) || null) || [];
    } catch (_) {
      // Unreadable skill layers - degrade to an empty list rather than fail.
      rows = [];
    }
    const lines = ['Available commands (' + rows.length + '):'];
    for (const r of rows) {
      const name = '/' + r.name;
      // First line of the description as a one-line summary; argument hint when
      // the skill declares one; a small marker for deterministic (instant) ones.
      const summary = String(r.description || '').split('\n')[0].trim();
      const hint = r.argument_hint ? ' ' + r.argument_hint : '';
      const kind = r.deterministic ? ' [instant]' : '';
      lines.push('  ' + name + hint + kind + (summary ? ' - ' + summary : ''));
    }
    if (rows.length === 0) {
      lines.push('  (no skills discovered - check the skills directories)');
    }
    return { ok: true, text: lines.join('\n') };
  }
};

async function executeDeterministic(skill, parsed, ctx) {
  const handler = DETERMINISTIC_HANDLERS[skill.name];
  if (!handler) {
    return { ok: false, error: 'no_deterministic_handler', detail: 'skill ' + skill.name + ' marked deterministic but no handler registered' };
  }
  ctx = ctx || {};
  let trace_engram_id = null;
  try {
    if (ctx.agent_id) {
      trace_engram_id = engram.recordEngram({
        agent_id: ctx.agent_id, cwd: ctx.cwd || null, user_id: ctx.user_id || 'default',
        statement: 'user invoked /' + skill.name + (parsed.raw_args ? ' ' + parsed.raw_args : ''),
        scope: 'command', salience: 0.5,
        source: 'slash:executor:deterministic'
      });
    }
  } catch (_) {}
  let res;
  try { res = await handler(parsed, ctx); }
  catch (e) {
    return { ok: false, error: 'deterministic_handler_threw', detail: e && e.message || String(e) };
  }
  if (!res || res.ok === false) {
    return { ok: false, error: res && res.error || 'deterministic_failed', detail: res && res.detail };
  }
  return {
    ok: true,
    deterministic: true,
    skill_name:    skill.name,
    text:          res.text,
    // Structured options contract: a handler may return
    // options:[{value,label,note?,current?}] for a UI selection surface. Forward
    // it VERBATIM only when the handler emitted an array; `text` remains a
    // complete standalone answer (CLI parity). Handlers that return no options
    // get no field here, so the entity emits a frame without it.
    options:       Array.isArray(res.options) ? res.options : undefined,
    side_effects:  res.side_effects || null,
    trace_engram_id
  };
}

module.exports = {
  execute,
  executeDeterministic,
  DETERMINISTIC_HANDLERS,
  // Internals — exposed for tests.
  substituteArgs,
  substituteBash,
  substituteFiles,
  buildModelOptions,
  knownModelIdsFor,
  buildProviderModelOptions,
  providerCurrentModel
};
