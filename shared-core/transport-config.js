// SPDX-License-Identifier: AGPL-3.0-only
// Transport Config — single source of truth for transport endpoints.
//
// Goal: every place in the codebase that needs "the llama.cpp host" or
// "the Ollama model" reads from here, never from a string literal. UI
// and dashboard can later persist user overrides to ~/.troth/config.json
// without touching transport / orchestrator / demo code.
//
// Resolution priority for any field:
//   1. process.env.TROTH_<FIELD>
//   2. ~/.troth/config.json["<field>"] (if file exists)
//   3. built-in default (BUILT_IN_DEFAULTS below)
//
// Reads are cheap (config file parsed once, env consulted per call so a
// runtime env change is honored). The dashboard UI is expected to
// write the JSON file when the user edits a setting; no restart needed
// because subsequent reads always hit the disk on miss.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME = process.env.HOME || os.homedir();
const CONFIG_DIR  = process.env.TROTH_CONFIG_DIR  || path.join(HOME, '.troth');
const CONFIG_PATH = process.env.TROTH_CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

// One canonical defaults table. UI lists these as the "factory" values.
// Updating a default here propagates to every consumer.
const BUILT_IN_DEFAULTS = Object.freeze({
  llamacpp_host:  'http://127.0.0.1:11436',
  llamacpp_model: 'local',
  ollama_host:    'http://127.0.0.1:11434',
  ollama_model:   'qwen3:latest',
  embedding_host: null,        // null → falls back to llamacpp_host
  slot_save_path: '/tmp/llama-slots',
  // Property #3 + #6 (the entity design): periodic drift detection +
  // background deliberation. Default ON — Property #3 ("continuous
  // thinking") and Property #6 ("self-knowledge of degradation") are
  // entity-defining; they can't be opt-in if the dream is "ONE living
  // mind that thinks continuously". Cost is one engram-query and a
  // small write per session-start (~50ms). Set to `false` in
  // `~/.troth/config.json` if it ever proves expensive.
  deliberator_enabled: true,
  // Phase 1c — fast-model
  // override for voice quick_ack / brief_factual routes. When set, the
  // proxy rewrites request.model to this value before forwarding for
  // those routes only. deep_work / show_text are unaffected. Default
  // null = behavior unchanged (the heavy chain handles every route).
  // Examples: "claude-haiku-4-5", "gemma3:4b", "qwen3:1.7b". The user
  // is expected to ensure the chosen model is reachable via their
  // configured providers — no auto-discovery here.
  voice_fast_model: null,
  // The understanding passes (knowledge, self-facts, instance) may read with
  // the named llama.cpp host, not only one on this machine.
  understanding_named_host: false,
  // The knowledge pass may read with the proxy engine (the chat budget).
  knowledge_engine: false
});

// Maps a logical field name to the env var the user can set to override.
// Keep in sync with BUILT_IN_DEFAULTS keys.
const ENV_KEYS = Object.freeze({
  llamacpp_host:  'TROTH_LLAMACPP_HOST',
  llamacpp_model: 'TROTH_LLAMACPP_MODEL',
  ollama_host:    'TROTH_OLLAMA_HOST',
  ollama_model:   'TROTH_OLLAMA_MODEL',
  embedding_host: 'TROTH_EMBEDDING_HOST',
  slot_save_path: 'TROTH_SLOT_SAVE_PATH',
  understanding_named_host: 'TROTH_UNDERSTANDING_LOCAL_HOST',
  knowledge_engine: 'TROTH_KNOWLEDGE_ENGINE'
});

let _fileCache = null;
let _fileCacheMtime = 0;

function readConfigFile() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (_fileCache && stat.mtimeMs === _fileCacheMtime) return _fileCache;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    _fileCache = JSON.parse(raw) || {};
    _fileCacheMtime = stat.mtimeMs;
    return _fileCache;
  } catch (_) {
    _fileCache = {};
    _fileCacheMtime = 0;
    return _fileCache;
  }
}

// Generic reader. Honors the priority chain.
function get(field) {
  if (!Object.prototype.hasOwnProperty.call(BUILT_IN_DEFAULTS, field)) {
    throw new Error('transport-config: unknown field "' + field + '"');
  }
  const envKey = ENV_KEYS[field];
  if (envKey && process.env[envKey] != null && process.env[envKey] !== '') {
    return process.env[envKey];
  }
  const file = readConfigFile();
  if (file && file[field] != null && file[field] !== '') return file[field];
  return BUILT_IN_DEFAULTS[field];
}

// A yes/no field: config.json holds a boolean, an env var holds 1/true/yes.
function flag(field) {
  const v = get(field);
  return v === true || v === 1 || /^(?:1|true|yes|on)$/i.test(String(v));
}

// Per-field convenience accessors. Same resolution logic, just less
// risk of typos at call sites.
const llamacppHost  = () => get('llamacpp_host');
const llamacppModel = () => get('llamacpp_model');
const ollamaHost    = () => get('ollama_host');
const ollamaModel   = () => get('ollama_model');
const slotSavePath  = () => get('slot_save_path');

// Embedding host falls back to llamacpp host when not explicitly set —
// most users will run embeddings against the same llama-server they
// already have up. Keeps the config minimal for the default case.
function embeddingHost() {
  const explicit = get('embedding_host');
  if (explicit) return explicit;
  // NEVER fall back to the chat-model host. Memory embedding and chat are
  // unrelated concerns: the old fallback meant pointing the chat LLM at a
  // remote box silently killed write-time embeddings whenever that box
  // slept — in the field, every engram wrote embedded:false while
  // the self-installed LOCAL embed server ran healthy on this machine, and
  // recall went lexical-only, starving the memory-dispatch gate. The
  // self-installed embedder is the product's own always-local organ; it is
  // the only sane default, and it speaks the same /embedding shape.
  return 'http://127.0.0.1:' + (parseInt(process.env.TROTH_EMBED_PORT || '11437', 10));
}

// Snapshot for UI: returns the resolved current values + their source
// (env / file / default) for each field. Lets the dashboard render
// "Currently configured" with provenance.
function snapshot() {
  const out = {};
  for (const field of Object.keys(BUILT_IN_DEFAULTS)) {
    const envKey = ENV_KEYS[field];
    let source = 'default';
    let value  = BUILT_IN_DEFAULTS[field];
    if (envKey && process.env[envKey] != null && process.env[envKey] !== '') {
      source = 'env';
      value  = process.env[envKey];
    } else {
      const file = readConfigFile();
      if (file && file[field] != null && file[field] !== '') {
        source = 'file';
        value  = file[field];
      }
    }
    out[field] = { value, source, env_key: envKey, default: BUILT_IN_DEFAULTS[field] };
  }
  return out;
}

// UI / programmatic write: persist a partial config patch to disk. The
// dashboard calls this when the user updates a setting. Atomic write
// via temp file + rename so a crash mid-write can't corrupt the file.
function writePatch(patch) {
  if (!patch || typeof patch !== 'object') return false;
  try {
    // Single-writer path (config-file.js): strict fresh read + atomic
    // replace. The old lenient readConfigFile()||{} start meant a corrupt
    // or torn config.json got rewritten as JUST this patch, erasing every
    // other field. That case now refuses the write and returns false.
    const merged = require('./config-file.js').updateConfig((current) => {
      for (const k of Object.keys(patch)) {
        if (Object.prototype.hasOwnProperty.call(BUILT_IN_DEFAULTS, k)) {
          current[k] = patch[k];
        }
      }
      return current;
    });
    _fileCache = merged;
    try { _fileCacheMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch (_) {}
    return true;
  } catch (e) {
    console.error('[transport-config] config write refused: ' + (e && e.message));
    return false;
  }
}

// The understanding passes read only with an engine on this machine unless the
// operator opens the named host to them: a pass that ticks every ten minutes is
// sustained load on that host.
function isLoopbackHost(h) {
  const m = /^(?:https?:\/\/)?([^\/:\s]+|\[[^\]]+\])/i.exec(String(h || '').trim());
  const host = m ? m[1].toLowerCase() : '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
}
// The engine host the understanding passes may read with: the llama.cpp host
// when it is on this machine, or the named host once `understanding_named_host`
// opens it to them.
function understandingHost() {
  const h = llamacppHost();
  if (!h) return null;
  if (isLoopbackHost(h) || flag('understanding_named_host')) return h;
  return null;
}

module.exports = {
  get,
  llamacppHost,
  understandingHost,
  isLoopbackHost,
  flag,
  llamacppModel,
  ollamaHost,
  ollamaModel,
  embeddingHost,
  slotSavePath,
  snapshot,
  writePatch,
  BUILT_IN_DEFAULTS,
  ENV_KEYS,
  CONFIG_PATH
};
