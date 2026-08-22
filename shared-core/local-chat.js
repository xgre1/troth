// SPDX-License-Identifier: AGPL-3.0-only
// local-chat — in-process CHAT faculty for the substrate.
//
// The mind's LANGUAGE faculty when run fully local: turns a prompt into a
// reply, in-process, via node-llama-cpp — the SAME runtime that already powers
// the local embedder (recall faculty). No external llama-server, no `brew
// install`, no Ollama: the engine ships in the app and the model GGUF downloads
// on demand (same "loads when ready" UX as the embedder + voice). This is what
// makes the "Automatic" local option true plug-and-play.
//
// Custom/remote (a home server, a remote box, etc.) stays a separate path — the
// proxy's HTTP local provider. This module is ONLY the bundled in-process path.
//
// Tool calling: node-llama-cpp's session.prompt() takes a `functions` map and
// will emit structured calls; the router translates the substrate's tool
// schemas into that map and the calls back, so a local partner EXECUTES actions
// (no "talks but never acts"). See router wiring.
//
// Degradation: if node-llama-cpp is absent, every call returns null and the
// caller falls back to the HTTP local provider / another faculty — degraded,
// never broken (same contract as local-embedder).

const os   = require('os');
const fs   = require('fs');
const path = require('path');

// Is the chosen model already a COMPLETE .gguf on disk (not a .ipull/.part
// partial)? The download state is in-memory per process, so after a proxy
// restart we'd otherwise report 0% for a model that's actually downloaded.
// Loose-match the model URI's alphanumeric tokens against the filenames.
function modelPresentOnDisk(uri) {
  try {
    const want = String(uri || '').toLowerCase()
      .split(/[^a-z0-9]+/).filter((t) => t && t !== 'hf' && t !== 'gguf');
    const files = fs.readdirSync(MODELS_DIR);
    for (const f of files) {
      const lc = f.toLowerCase();
      if (!lc.endsWith('.gguf')) continue; // .ipull/.part = incomplete → skip
      const n = lc.replace(/[^a-z0-9]/g, '');
      if (want.length && want.every((t) => n.includes(t))) return true;
    }
  } catch (_) {}
  return false;
}

// ── Config (env-overridable; the UI passes the user's chosen model URI) ──────

// A chat GGUF consumable by node-llama-cpp's resolveModelFile. Default is a
// small, broadly-capable multilingual instruct model that fits a 16GB Mac; the
// "Automatic" UI overrides this with the RAM-recommended pick. Kept tiny by
// default so a fresh run is a reasonable one-time download, not 20GB.
// "Automatic" = the DEVICE picks the model. Bigger RAM → bigger model, with
// zero user input. This runs in BOTH the entity and the proxy (both load
// local-chat), and both read the same physical RAM via os.totalmem(), so they
// agree on the model WITHOUT any cross-process config plumbing — the single
// source of truth lives here. Current-generation Qwen3.5/3.6 GGUFs (unsloth
// repos; existence + exact filenames live-verified against the HF API,
//). Explicit file-path URIs instead of:quant tags so resolution
// can never mis-pick: the 35B file is named UD-Q4_K_M (a tag lookup for
// Q4_K_M is ambiguous there) and the 122B Q4_K_M is a 3-part split that
// node-llama-cpp 3.18 downloads whole when given the first part. The serving
// runtime is the bundled llama-server, which already runs Qwen3.6-35B-A3B in
// production; 9B/4B are the same architecture family. Conservative tiers
// leave OS + browser + the substrate headroom (the 35B is ~20GB of weights,
// so its floor is 32GB: on a 24GB Mac it would page-thrash next to the 16K
// KV cache, verifier find). TROTH_CHAT_MODEL overrides
// (the Custom / BYO-model path).
function pickModelForRam() {
  let gb = 16;
  try { gb = require('os').totalmem() / (1024 ** 3); } catch (_) {}
  // Top tiers need the b9957+ vendored llama-server (GLM-5.2: b9736 loader
  // fix; DeepSeek V4: the #24162 CSA+HCA merge). Files live-verified on the
  // HF API: GLM-5.2 UD-Q3_K_XL 9-part ~320GB+, DSV4-Flash
  // UD-IQ3_XXS 4-part ~96-103GB. Research round: strongest open weights that
  // fit each tier with KV + OS headroom.
  if (gb >= 448) return { uri: 'hf:unsloth/GLM-5.2-GGUF/UD-Q3_K_XL/GLM-5.2-UD-Q3_K_XL-00001-of-00009.gguf', id: 'glm-5.2' };
  if (gb >= 128) return { uri: 'hf:unsloth/DeepSeek-V4-Flash-GGUF/UD-IQ3_XXS/DeepSeek-V4-Flash-UD-IQ3_XXS-00001-of-00004.gguf', id: 'deepseek-v4-flash' };
  if (gb >= 96) return { uri: 'hf:unsloth/Qwen3.5-122B-A10B-GGUF/Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf', id: 'qwen3.5-122b-a10b' };
  if (gb >= 32) return { uri: 'hf:unsloth/Qwen3.6-35B-A3B-MTP-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', id: 'qwen3.6-35b-a3b' };
  // 24GB Macs still get the current-gen 35B MoE, one quant tier down: the
  // UD-IQ3_S single file is 14.3GB,
  // which fits 24GB with KV + OS headroom where the 22GB Q4 would thrash.
  if (gb >= 24) return { uri: 'hf:unsloth/Qwen3.6-35B-A3B-MTP-GGUF/Qwen3.6-35B-A3B-UD-IQ3_S.gguf', id: 'qwen3.6-35b-a3b' };
  if (gb >= 16) return { uri: 'hf:unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf', id: 'qwen3.5-9b' };
  return                { uri: 'hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf', id: 'qwen3.5-4b' };
}
const _autoModel = pickModelForRam();
const MODEL_URI = process.env.TROTH_CHAT_MODEL    || _autoModel.uri;
const MODEL_ID  = process.env.TROTH_CHAT_MODEL_ID || _autoModel.id;
// 16384, not 8192: the troth entity hands the language faculty its FULL tool
// set — ~37 tools ≈ 8.6K tokens of schemas — plus a ~1K-token identity
// envelope. At 8192 that overflowed the window BEFORE the first reply token,
// so node-llama-cpp's context-shift threw and the partner returned EMPTY ("no
// response") on every local turn. 16384 fits tools+envelope+history+reply with
// headroom; the Qwen3.5/3.6 picks support 32768+ natively, and the KV cache at 16K
// is ~1-2GB — comfortable on a 16GB+ Mac. Override via TROTH_CHAT_CTX.
//
// Unset, this is resolved per model once the file is known: a constant is
// wrong for every model except the one it was picked for. Held mutable
// because the model can be switched at runtime.
const CTX_OVERRIDE = parseInt(process.env.TROTH_CHAT_CTX || '0', 10) || 0;
let _ctxSize = CTX_OVERRIDE || 16384;
const MODELS_DIR = process.env.TROTH_CHAT_DIR
  || path.join(process.env.HOME || os.homedir(), '.troth', 'models');
// Chat is the foreground task — let it use most cores (the embedder already
// caps itself to half, so a backfill won't fight a live reply).
const MAX_THREADS = Math.max(1, os.cpus().length - 1);

// ── Lazy singleton state (mirrors local-embedder) ────────────────────────────

let _initPromise = null;   // in-flight or completed init
let _model = null;         // LlamaModel
let _ctx = null;           // LlamaContext
let _unavailable = false;  // node-llama-cpp missing / init failed
let _modelUri = MODEL_URI; // the currently-loaded model URI
let _dlPromise = null;
let _dlProgress = 0;
let _dlDone = false;
let _dl = null;          // active ModelDownloader (for cancel)
let _dlTotal = 0;        // bytes
let _dlGot = 0;          // bytes
let _dlCancelled = false;

// Warm-session KV reuse. The entity hands the SAME static prefix
// (identity envelope + ~37 tool schemas ≈ 9.6K tokens) every turn. Re-prefilling
// it per call cost ~47s, and a fresh getSequence() per call leaked sequences so
// the 2ND turn failed outright ("no response"). We keep ONE warm session+seq:
// a clean continuation reuses it (instant, like LM Studio's prompt cache); any
// divergence rebuilds on a disposed+refreshed sequence (never exhausts).
let _chatSession = null;  // warm LlamaChatSession
let _chatSeq = null;      // its context sequence (reused, not re-got every call)
let _chatKey = null;      // systemPrompt + tool-signature the warm session holds
let _seenConvo = null;    // [{role,text}] conversation currently in the warm KV

function _disposeWarm() {
  try { _chatSession && _chatSession.dispose && _chatSession.dispose(); } catch (_) {}
  try { _chatSeq && _chatSeq.dispose && _chatSeq.dispose(); } catch (_) {}
  _chatSession = null; _chatSeq = null; _chatKey = null; _seenConvo = null;
}

// Resolve once. Returns the LlamaContext, or null if unavailable. A different
// modelUri than the loaded one forces a reload (model switch from the UI).
async function ensureContext(modelUri) {
  const want = modelUri || _modelUri;
  if (_ctx && want === _modelUri) return _ctx;
  if (_ctx && want !== _modelUri) {
    // Model switch: drop the old context/model so the new one loads clean.
    _disposeWarm(); // the warm session belongs to the old context — drop it too
    try { await _ctx.dispose?.(); } catch (_) {}
    try { await _model?.dispose?.(); } catch (_) {}
    _ctx = null; _model = null; _initPromise = null; _unavailable = false;
  }
  if (_unavailable) return null;
  if (_initPromise) return _initPromise;
  _modelUri = want;
  _initPromise = (async () => {
    let nlc;
    try {
      nlc = await import('node-llama-cpp');
    } catch (_) {
      _unavailable = true;
      return null;
    }
    try {
      const { getLlama, resolveModelFile } = nlc;
      const modelPath = await resolveModelFile(_modelUri, MODELS_DIR);
      try {
        const chosen = require('./model-context.js').chooseContextSize(modelPath, { explicit: CTX_OVERRIDE });
        _ctxSize = chosen.size;
        console.error('[local-chat] context ' + chosen.size + ' (' + chosen.source +
          (chosen.trained ? ', model trained for ' + chosen.trained : '') + ')');
      } catch (_) { /* keep the standing size */ }
      const llama = await getLlama();
      _model = await llama.loadModel({ modelPath });
      _ctx = await _model.createContext({
        contextSize: _ctxSize,
        threads: MAX_THREADS
      });
      return _ctx;
    } catch (e) {
      _unavailable = true;
      return null;
    }
  })();
  return _initPromise;
}

// prepareModel(modelUri?, onProgress?) — pre-download the chat GGUF with
// PROGRESS for the "Automatic → Install" UX. Idempotent. Falls back silently if
// node-llama-cpp is missing.
async function prepareModel(modelUri, onProgress) {
  const uri = modelUri || _modelUri;
  if (_dlDone && uri === _modelUri) { if (onProgress) onProgress(1); return true; }
  if (_dlPromise) return _dlPromise;
  _modelUri = uri;
  _dlProgress = 0; _dlDone = false;
  _dlCancelled = false;
  _dlPromise = (async () => {
    let nlc;
    try { nlc = await import('node-llama-cpp'); }
    catch (_) { _unavailable = true; return false; }
    try {
      const { createModelDownloader } = nlc;
      const downloader = await createModelDownloader({
        modelUri: uri,
        dirPath: MODELS_DIR,
        deleteTempFileOnCancel: true,
        onProgress: (p) => {
          const total = p && (p.totalSize || p.totalBytes);
          const got   = p && (p.downloadedSize || p.downloadedBytes);
          if (total) {
            _dlTotal = total; _dlGot = got;
            _dlProgress = Math.min(1, got / total);
            if (onProgress) onProgress(_dlProgress);
          }
        }
      });
      _dl = downloader;
      // Cancel may have arrived WHILE createModelDownloader was resolving (the
      // window where _dl was still null, so cancelDownload couldn't abort it).
      // Honor it now before kicking off the actual transfer — otherwise the
      // download ran to completion despite the user pressing ✕.
      if (_dlCancelled) {
        try { await downloader.cancel({ deleteTempFile: true }); } catch (_) {}
        _dl = null; _dlPromise = null;
        return false;
      }
      await downloader.download();
      _dl = null;
      // A late cancel during the transfer leaves _dlCancelled set — don't flip
      // to "done" in that case (the file is being deleted).
      if (_dlCancelled) { _dlPromise = null; return false; }
      _dlProgress = 1; _dlDone = true;
      if (onProgress) onProgress(1);
      return true;
    } catch (e) {
      _dl = null; _dlPromise = null;
      return false;
    }
  })();
  return _dlPromise;
}

// Cancel an in-flight download (the "x" in the Automatic setup UI). Deletes the
// partial temp file and resets state so a later prepare starts clean.
async function cancelDownload() {
  _dlCancelled = true;
  const d = _dl;
  _dl = null; _dlPromise = null; _dlProgress = 0; _dlDone = false; _dlTotal = 0; _dlGot = 0;
  if (d) { try { await d.cancel({ deleteTempFile: true }); } catch (_) {} }
  return true;
}

// complete({ system, messages, tools, onToken, modelUri }) → Promise<{ text, toolCalls, model_id }|null>
//   messages: [{role:'user'|'assistant', text}] — FULL turn history (the
//             substrate owns history; we replay it into a fresh session each
//             call). The last user message is the new prompt.
//   tools: optional [{name, description, input_schema}] (Anthropic-shape). When
//          the model wants one we STOP and return it as a toolCall for the
//          ENTITY's gated tool_runner to execute — we never auto-run it here
//          (node-llama-cpp's prompt() would auto-execute handlers, bypassing
//          the STVC/permission gate; promptWithMeta + an aborting trampoline
//          handler lets the gate stay in charge).
//   onToken: optional streaming callback (partial text chunks).
// Returns null when the engine is unavailable (caller falls back). Never throws.
async function complete(opts) {
  opts = opts || {};
  const ctx = await ensureContext(opts.modelUri);
  if (!ctx) return null;
  let nlc;
  try { nlc = await import('node-llama-cpp'); }
  catch (_) { return null; }
  try {
    const { LlamaChatSession, defineChatSessionFunction } = nlc;

    // Separate system-role messages from the conversation. The entity sends its
    // identity envelope as a role:'system' message INSIDE the messages array;
    // node-llama-cpp wants that text as the session systemPrompt (and a
    // {type:'system'} history item) — NOT folded into a user turn. The old code
    // pushed every non-assistant message (system included) as a {type:'user'}
    // history entry, producing malformed two-user-in-a-row history that
    // setChatHistory/promptWithMeta rejected → caught → null → the transport
    // yielded empty → the partner went SILENT on every turn carrying an
    // identity envelope (i.e. every real entity turn).  fix.
    const rawMsgs = Array.isArray(opts.messages) ? opts.messages.slice() : [];
    let sysFromMsgs = '';
    const msgs = [];
    for (const m of rawMsgs) {
      if (!m) continue;
      if (m.role === 'system') {
        sysFromMsgs += (sysFromMsgs ? '\n\n' : '') + String(m.text || m.content || '');
      } else {
        msgs.push(m);
      }
    }
    const systemPrompt = [opts.system, sysFromMsgs].filter(Boolean).join('\n\n') || undefined;

    // Take the trailing user/tool message as the prompt; the rest is history.
    let last = null;
    while (msgs.length && (!last || last.role === 'assistant')) last = msgs.pop();
    // ^ take the last non-assistant (user/tool) message as the prompt.
    const prompt = last ? String(last.text || last.content || '') : '';
    if (!prompt) return null;

    // Fit-guard: keep system + tools + prompt + (trimmed) history under the
    // window so a long conversation can never re-trigger the context-shift
    // throw that silenced the partner. We can't shrink the system or tools
    // (the entity owns those), so we drop the OLDEST history turns until the
    // budget fits, reserving room for the reply. Rough char/3.5 token proxy —
    // deliberately conservative (over-counts) so we trim early rather than
    // overflow. If system+tools alone already blow the budget, we log and let
    // node-llama-cpp try (it may still shift) instead of pretending all is well.
    {
      const estTok = (s) => Math.ceil(String(s || '').length / 3.5);
      const RESERVE = 1024; // headroom for the generated reply
      const toolTok = Array.isArray(opts.tools) ? estTok(JSON.stringify(opts.tools)) : 0;
      const fixed = estTok(systemPrompt) + toolTok + estTok(prompt);
      let budget = _ctxSize - RESERVE - fixed;
      if (budget < 0) {
        try { console.error(`[local-chat] system+tools (~${fixed} tok) exceed ctx ${_ctxSize} − reserve; reply may be truncated`); } catch (_) {}
      } else {
        let used = 0, keepFrom = msgs.length;
        for (let i = msgs.length - 1; i >= 0; i--) {
          used += estTok(msgs[i].text || msgs[i].content || '');
          if (used > budget) break;
          keepFrom = i;
        }
        if (keepFrom > 0) msgs.splice(0, keepFrom); // drop oldest, keep recent
      }
    }

    // Warm-session decision. key = the static prefix (system + tool names). The
    // conversation already in KV is _seenConvo; if the incoming history matches
    // it exactly (same system+tools, same prior turns), this turn is a clean
    // continuation → reuse the warm session and prompt ONLY the new message
    // (KV stays hot — no 9.6K-token re-prefill). Otherwise rebuild.
    const toolSig = (Array.isArray(opts.tools) ? opts.tools : [])
      .map((t) => (t && t.name) || '').join(',');
    const key = (systemPrompt || '') + '\0' + toolSig;
    const historyConvo = msgs
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user',
                     text: String(m.text || m.content || '') }))
      .filter((m) => m.text);
    const convoMatches = _seenConvo && _seenConvo.length === historyConvo.length &&
      _seenConvo.every((s, i) => s.role === historyConvo[i].role && s.text === historyConvo[i].text);
    const canReuse = !!(_chatSession && _chatKey === key && convoMatches);

    // Persistent warm session — keep ONE session+sequence and let node-llama-cpp
    // reuse the common KV prefix (adaptStateToTokens): the stable front (tool
    // schemas + identity) is NOT re-prefilled, only the changed tail + new
    // prompt is evaluated. Per the local-agentic-optimization research
    // (persistent loaded model + prompt cache = a warm remote server's ~3s). The old code
    // built a FRESH session every turn → empty KV → full 9.6K-token re-prefill
    // (~47s). Disposed ONLY on model switch (ensureContext → _disposeWarm).
    if (!_chatSession) {
      _chatSeq = ctx.getSequence();
      _chatSession = new LlamaChatSession({ contextSequence: _chatSeq });
    }
    const session = _chatSession;
    {
      const history = [];
      if (systemPrompt) history.push({ type: 'system', text: String(systemPrompt) });
      for (const m of historyConvo) {
        if (m.role === 'assistant') history.push({ type: 'model', response: [m.text] });
        else history.push({ type: 'user', text: m.text });
      }
      // setChatHistory diffs against the live KV → matching prefix reused.
      try { session.setChatHistory(history); } catch (_) {}
    }

    // Trampoline tool handlers: capture the call + abort generation so the
    // ENTITY executes it through its permission/STVC gate. We never run the
    // real tool here.
    const captured = [];
    const ac = new AbortController();
    let functions;
    const tools = Array.isArray(opts.tools) ? opts.tools : [];
    if (tools.length) {
      functions = {};
      for (const t of tools) {
        if (!t || !t.name) continue;
        functions[t.name] = defineChatSessionFunction({
          description: t.description || '',
          params: t.input_schema || t.parameters || { type: 'object', properties: {} },
          handler: (params) => {
            captured.push({ name: t.name, params });
            try { ac.abort(); } catch (_) {}
            return undefined; // never reached past abort, but keeps types happy
          }
        });
      }
    }

    if (process.env.TROTH_CHAT_DEBUG_SIZE === '1') {
      const sc = (systemPrompt || '').length, pc = prompt.length;
      let hc = 0; for (const m of msgs) hc += String(m.text || m.content || '').length;
      const tc = (Array.isArray(opts.tools) ? JSON.stringify(opts.tools).length : 0);
      const tn = (Array.isArray(opts.tools) ? opts.tools.length : 0);
      try { console.error(`[local-chat] sizes chars: system=${sc} prompt=${pc} history=${hc} tools=${tn}(${tc}c) (~tokens system=${Math.round(sc/3.5)} tools=${Math.round(tc/3.5)} ctx=${_ctxSize})`); } catch (_) {}
    }

    const promptOpts = { signal: ac.signal, stopOnAbortSignal: true };
    if (functions) promptOpts.functions = functions;
    if (typeof opts.onToken === 'function') {
      promptOpts.onTextChunk = (chunk) => { try { opts.onToken(chunk); } catch (_) {} };
    }

    const meta = await session.promptWithMeta(prompt, promptOpts);
    const text = (meta && (meta.responseText != null ? meta.responseText : meta.response)) || '';
    const toolCalls = captured.map((c, i) => ({
      id: 'call_' + i,
      name: c.name,
      input: c.params || {}
    }));

    // No per-turn warm bookkeeping needed: the next turn's setChatHistory diffs
    // against whatever KV this turn left (partial/aborted included) via
    // adaptStateToTokens and truncates at the first divergence. The session
    // stays alive; only a model switch disposes it.
    return { text: String(text || ''), toolCalls, model_id: MODEL_ID };
  } catch (e) {
    // Surface the failure to stderr (entity forwards it to logs/UI). This was
    // a bare `return null` — which is why a malformed-history throw made the
    // partner go mute with ZERO diagnostic for an entire session. A real error
    // here is NOT the same as "engine unavailable"; say so.
    try { console.error('[local-chat] complete() failed: ' + (e && e.message ? e.message : e)); } catch (_) {}
    return null;
  }
}

function isAvailable() { return !!_ctx; }

function status() {
  // Disk-aware: a complete .gguf on disk counts as done even if THIS process
  // never ran the download (survives proxy/app restarts).
  const onDisk = (_dlDone) || modelPresentOnDisk(_modelUri);
  return {
    available: !!_ctx,
    unavailable: _unavailable,
    initializing: !!_initPromise && !_ctx && !_unavailable,
    download_progress: onDisk ? 1 : _dlProgress,
    download_done: onDisk,
    downloading: !!_dlPromise && !_dlDone,
    download_total_bytes: _dlTotal,
    download_done_bytes: _dlGot,
    download_cancelled: _dlCancelled,
    model_id: MODEL_ID,
    model_uri: _modelUri,
    context_size: _ctxSize,
    threads: MAX_THREADS
  };
}

module.exports = {
  complete,
  ensureContext,
  prepareModel,
  cancelDownload,
  isAvailable,
  status,
  MODEL_ID,
  MODEL_URI,
  contextSize: () => _ctxSize
};
