// SPDX-License-Identifier: AGPL-3.0-only
// shared-core/tools — file/system tools surface for the language faculty.
//
// Companion to substrate-tools.js. That module exposes substrate primitives
// (engram_search, dialogue_recent, etc.) — semantic recall. This module
// exposes the worldly primitives (Read/Edit/Write/Grep/Glob/Bash) — the
// hands a coding agent needs to actually touch files and run commands.
//
// Same {schema, run} entry shape and same dispatch contract as
// substrate-tools.js so composeAgentic's tool_runner can union both
// registries and route by name without caring which family a tool
// belongs to.
//
// Each tool lives in its own file to keep each surface auditable and
// independently testable. Adding a new tool = create file + register
// here. Removing = delete file + unregister. No central monolith.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const readTool  = require('./read.js');
const writeTool = require('./write.js');
const editTool  = require('./edit.js');
const bashTool  = require('./bash.js');
const grepTool  = require('./grep.js');
const globTool  = require('./glob.js');
const webResearch = require('./web-research.js');
const imageGen  = require('./image-gen.js');
const vaultCapture = require('../vault-capture.js');

const REGISTRY = {
  Read:  readTool,
  Write: writeTool,
  Edit:  editTool,
  Bash:  bashTool,
  Grep:  grepTool,
  Glob:  globTool,
  // Provider-agnostic web research via the existing CDP browser (real Chrome,
  // sanitized extraction; no vendor API). Read-only — see permission.js. Lets
  // any native-tool-calling faculty (router/llamacpp/...) research the web;
  // claude_cli uses its own built-in WebSearch instead.
  web_search: webResearch.web_search,
  web_fetch:  webResearch.web_fetch,
  // Image generation via the operator's linked ChatGPT plan (same OAuth token +
  // codex Responses endpoint as chat, with tools:[{image_generation}]). WRITE —
  // saves a PNG under ~/.troth/images (see permission.js). No vendor API/key.
  image_generate: imageGen,
  // A credential the operator holds elsewhere moves into the vault by name.
  // WRITE — it stores a secret (see permission.js); the value never reaches
  // the model. In the proxy it captures in-process; elsewhere it reaches the
  // proxy over HTTP.
  vault_capture: vaultCapture
};

// ── Tool-result archiver ─────────────────────────────────────────────────
//
// Anthropic's "Effective Context Engineering" (Sep 2025) calls out that
// tool results are the #1 source of context bloat in long agent loops.
// Their own answer is "tool clearing" — keep N most recent, drop older
// detail. We do the same idea differently: when a single result is
// already so large that even ONE copy would dominate the context window,
// trim the inline payload BEFORE the model sees it, and persist the
// full version under ~/.troth/tool-archive/<id>.json so the agent can
// retrieve it on demand via Read({file_path: archive_path}).
//
// Composition wins: the archive is itself a file, so the existing Read
// tool is the retrieval API — no new tool, no new schema. The model
// learns "if I need the rest, I Read the archive_path."

const ARCHIVE_THRESHOLD = 8 * 1024;   // 8 KB stringified
const ARCHIVE_DIR       = path.join((process.env.HOME || os.homedir()), '.troth', 'tool-archive');
const PREVIEW_BYTES     = 2 * 1024;   // bytes kept inline as a preview

function ensureArchiveDir() {
  try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); }
  catch (_) { /* mkdir -p is idempotent; fall through if it already exists */ }
}

function archiveResult(toolName, result) {
  ensureArchiveDir();
  const id = Date.now().toString(36) + '-' +
             Math.random().toString(36).slice(2, 10);
  const archivePath = path.join(ARCHIVE_DIR, toolName + '-' + id + '.json');
  let serialized;
  try { serialized = JSON.stringify(result, null, 2); }
  catch (_) { serialized = String(result); }
  try { fs.writeFileSync(archivePath, serialized); }
  catch (_) { /* archive write is best-effort; never break the call */ }
  return { archive_path: archivePath, archive_size: serialized.length };
}

// Decide which fields of a result are the "fat" ones worth
// archiving. Bash → stdout/stderr; Grep/Read → content; everything
// else → the entire JSON. Trims those fields to a preview when the
// total payload exceeds ARCHIVE_THRESHOLD.
function maybeArchive(toolName, result) {
  if (!result || typeof result !== 'object') return result;
  let stringified;
  try { stringified = JSON.stringify(result); }
  catch (_) { return result; }
  if (stringified.length <= ARCHIVE_THRESHOLD) return result;

  const meta = archiveResult(toolName, result);
  const out = Object.assign({}, result);

  // Trim known-large string fields and mark the truncation. Other
  // fields stay as-is so the structured surface (mode, exitCode,
  // numFiles, etc.) is still usable.
  for (const k of ['stdout', 'stderr', 'content', 'originalFile']) {
    if (typeof out[k] === 'string' && out[k].length > PREVIEW_BYTES) {
      out[k] = out[k].slice(0, PREVIEW_BYTES) +
        '\n…(' + out[k].length + ' bytes total — full output archived)';
    }
  }
  // Read tool nests its content under file.content — handle the
  // canonical Claude shape too.
  if (out.file && typeof out.file === 'object' && typeof out.file.content === 'string'
      && out.file.content.length > PREVIEW_BYTES) {
    out.file = Object.assign({}, out.file, {
      content: out.file.content.slice(0, PREVIEW_BYTES) +
        '\n…(' + out.file.content.length + ' bytes total — full output archived)'
    });
  }
  out._archive = meta;
  out._archive_hint = 'Full output saved to disk. Read({file_path:"' + meta.archive_path + '"}) to fetch the rest.';
  return out;
}

// OpenAI-compatible tools array for the model's `tools` field. Pass a
// subset of names to filter; omit for the full set.
function toolsArray(filterNames) {
  const names = Array.isArray(filterNames) && filterNames.length
    ? filterNames
    : Object.keys(REGISTRY);
  const out = [];
  for (const n of names) {
    const entry = REGISTRY[n];
    if (entry && entry.schema) out.push(entry.schema);
  }
  return out;
}

// Dispatch a model-emitted tool_call. Returns the result as a JSON
// string ready to slot into a 'tool' role message. Errors come back
// as structured payloads (never thrown) so the model can recover.
// Large results are auto-archived to disk + summarized inline.
async function dispatchToolCall(toolCall, ctx) {
  const name = toolCall && toolCall.function && toolCall.function.name;
  const argsRaw = toolCall && toolCall.function && toolCall.function.arguments;
  let args = {};
  if (typeof argsRaw === 'string') {
    try { args = JSON.parse(argsRaw); } catch (_) { args = {}; }
  } else if (argsRaw && typeof argsRaw === 'object') {
    args = argsRaw;
  }
  const entry = REGISTRY[name];
  if (!entry) return JSON.stringify({ error: 'unknown_tool', name });
  try {
    const result = await entry.run(args, ctx || {});
    return JSON.stringify(maybeArchive(name, result));
  } catch (e) {
    return JSON.stringify({ error: 'tool_exception', name, detail: e && e.message || String(e) });
  }
}

module.exports = {
  REGISTRY,
  toolsArray,
  dispatchToolCall,
  // Exposed for tests and substrate integration.
  ARCHIVE_THRESHOLD,
  ARCHIVE_DIR,
  maybeArchive
};
