// SPDX-License-Identifier: AGPL-3.0-only
// slash/loader — discover SKILL.md / .claude/commands files across standard
// locations, parse YAML frontmatter, return a name→record map.
//
// Search precedence (later wins on name collision so user/project overrides
// the bundled defaults — same as Claude Code's own resolution order):
//   1. <troth-install>/plugin/skills/<name>/SKILL.md   (bundled defaults)
//   2. ~/.troth/skills/<name>/SKILL.md                  (user-global)
//   3. ~/.claude/skills/<name>/SKILL.md                   (Claude-shared, user)
//   4. ~/.claude/commands/<name>.md                       (legacy user)
//   5. <cwd>/.claude/skills/<name>/SKILL.md               (project)
//   6. <cwd>/.claude/commands/<name>.md                   (legacy project)
//
// Frontmatter parser is hand-written (no js-yaml dep): only key:value lines
// inside `---` delimiters. Values are strings unless they look like a JSON
// list (`[a, b, c]`) or boolean. Matches what Anthropic's SKILL.md examples
// actually use — we don't pretend to be a full YAML implementation.
//
// Returned record shape:
//   {
//     name:                string,
//     description:         string,
//     allowed_tools:       string[] | null,
//     argument_hint:       string | null,
//     model:               string | null,
//     disable_model_invocation: boolean,
//     body:                string,
//     source_path:         string,
//     source_layer:        'bundled' | 'user_troth' | 'user_claude' | 'project'
//   }

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME = os.homedir();
const TROTH_INSTALL = path.resolve(__dirname, '..', '..');

function searchLayers(cwd) {
  const layers = [
    { dir: path.join(TROTH_INSTALL, 'plugin', 'skills'),       layer: 'bundled',       legacy: false },
    { dir: path.join(HOME, '.troth', 'skills'),                layer: 'user_troth',  legacy: false },
    { dir: path.join(HOME, '.claude', 'skills'),                 layer: 'user_claude',   legacy: false },
    { dir: path.join(HOME, '.claude', 'commands'),               layer: 'user_claude',   legacy: true  },
    { dir: path.join(cwd || process.cwd(), '.claude', 'skills'), layer: 'project',       legacy: false },
    { dir: path.join(cwd || process.cwd(), '.claude', 'commands'), layer: 'project',     legacy: true  }
  ];
  return layers;
}

function parseAutoPersist(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (!raw.scope) return null;
    return {
      scope:    String(raw.scope),
      salience: typeof raw.salience === 'number' ? raw.salience : 1
    };
  }
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      if (j && j.scope) return { scope: String(j.scope), salience: typeof j.salience === 'number' ? j.salience : 1 };
    } catch (_) {}
  }
  return null;
}

function parseFrontmatter(text) {
  // Only matches if file starts with `---\n...\n---`.
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const close = text.indexOf('\n---', 3);
  if (close < 0) return { meta: {}, body: text };
  const fmRaw = text.slice(3, close).trim();
  const body  = text.slice(close + 4).replace(/^\n+/, '');
  const meta = {};
  for (const line of fmRaw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sep = t.indexOf(':');
    if (sep < 0) continue;
    const key = t.slice(0, sep).trim();
    let val   = t.slice(sep + 1).trim();
    // Strip wrapping quotes.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith('\'') && val.endsWith('\''))) {
      val = val.slice(1, -1);
    }
    // Booleans.
    if (val === 'true')  meta[key] = true;
    else if (val === 'false') meta[key] = false;
    // JSON-shaped list (Claude uses these for allowed-tools).
    else if (val.startsWith('[') && val.endsWith(']')) {
      try { meta[key] = JSON.parse(val); }
      catch (_) {
        // Permissive comma-split fallback for "Bash(git *), Read".
        meta[key] = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    else meta[key] = val;
  }
  return { meta, body };
}

function buildRecord(absPath, meta, body, layer, fallbackName) {
  const name = (meta.name || fallbackName || '').toLowerCase();
  if (!name) return null;
  // Anthropic's allowed-tools lives under either "allowed-tools" (kebab) or
  // "allowed_tools" (snake). Honor both. Same for disable-model-invocation.
  const allowed = meta['allowed-tools'] || meta.allowed_tools || null;
  const allowedArr = Array.isArray(allowed)
    ? allowed
    : (typeof allowed === 'string'
        ? allowed.split(',').map((s) => s.trim()).filter(Boolean)
        : null);
  return {
    name,
    description: meta.description || '',
    allowed_tools: allowedArr,
    argument_hint: meta['argument-hint'] || meta.argument_hint || null,
    model: meta.model || null,
    disable_model_invocation: !!(meta['disable-model-invocation'] || meta.disable_model_invocation),
    // troth extension — when `kind: deterministic`, the executor runs the
    // skill via a hand-written handler (substrate write + canned reply)
    // instead of routing through the LLM. Cuts voice latency from ~2-5 s
    // to <100 ms for pure-substrate operations (VoiceAgentRAG arXiv
    // 2603.02206 — Fast Talker reads from sub-ms cache). Default is `llm`.
    kind: (meta.kind === 'deterministic') ? 'deterministic' : 'llm',
    // troth extension — declarative post-LLM substrate write. Format:
    //   auto-persist: { "scope": "reasoning", "salience": 1 }
    // After the LLM turn completes, the entity persists response.text as
    // an engram with that scope. Removes the dependency on model
    // compliance — the substrate write is guaranteed by the runtime, not
    // begged for in prose. /think + /init use this to keep their causal
    // contract even when a smaller GGUF model skips the documented
    // engram_record call.
    auto_persist: parseAutoPersist(meta['auto-persist'] || meta.auto_persist),
    body,
    source_path:  absPath,
    source_layer: layer
  };
}

// Walk one search layer, return [{path, layer, fallbackName}] for each
// SKILL.md / <name>.md file found. Skips non-existent dirs silently.
function listLayer(layer) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(layer.dir, { withFileTypes: true }); }
  catch (_) { return found; }
  for (const ent of entries) {
    if (layer.legacy) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const stem = ent.name.slice(0, -3);
      found.push({
        absPath: path.join(layer.dir, ent.name),
        layer:   layer.layer,
        fallbackName: stem
      });
    } else {
      if (!ent.isDirectory()) continue;
      const skillFile = path.join(layer.dir, ent.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        found.push({
          absPath: skillFile,
          layer:   layer.layer,
          fallbackName: ent.name
        });
      }
    }
  }
  return found;
}

// Public: return Map<name, record>. Callers re-invoke per cwd if they
// expect project-local skills to appear.
function loadAll(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const layers = searchLayers(cwd);
  const map = new Map();
  for (const layer of layers) {
    for (const candidate of listLayer(layer)) {
      let raw;
      try { raw = fs.readFileSync(candidate.absPath, 'utf8'); }
      catch (_) { continue; }
      const { meta, body } = parseFrontmatter(raw);
      const rec = buildRecord(candidate.absPath, meta, body, candidate.layer, candidate.fallbackName);
      if (rec) map.set(rec.name, rec);   // later layer wins (override)
    }
  }
  return map;
}

// Popup-ready listing for UI surfaces (proxy GET /api/slash/skills feeds
// the cockpit composer's "/" autocomplete). The grammar itself executes on
// the normal turn path (the entity intercepts leading-slash user_input);
// this is metadata only: name, one-liner, argument hint, deterministic flag.
function skillSummaries(cwd) {
  const out = [];
  for (const rec of loadAll({ cwd }).values()) {
    out.push({
      name: rec.name,
      description: rec.description || '',
      argument_hint: rec.argument_hint || null,
      deterministic: rec.kind === 'deterministic',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Alias map for muscle-memory continuity. When the consolidated /agent
// skill collapsed the old /create + /team + /brains + /agents (plural)
// surfaces into one entry point, operators kept typing the old names.
// Aliases route them to the same loaded skill rather than failing with
// 'unknown_slash'. Keep this list short — it's a transition aid, not a
// long-term API. Pure name-level redirect; the resolved skill stays
// the canonical one (so trace engrams record the canonical name).
const SLASH_ALIASES = {
  agents:  'agent',
  brains:  'agent',
  team:    'agent',
  create:  'agent',
  // also accept the singular plural typo confusions
  switch:  'agent'
};

function load(name, opts) {
  const key = String(name).toLowerCase();
  const map = loadAll(opts);
  let rec = map.get(key);
  if (!rec && SLASH_ALIASES[key]) rec = map.get(SLASH_ALIASES[key]);
  return rec || null;
}

module.exports = {
  loadAll,
  skillSummaries,
  load,
  parseFrontmatter,
  // Exposed for tests + tooling.
  searchLayers
};
