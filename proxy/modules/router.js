// SPDX-License-Identifier: AGPL-3.0-only
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { anthropicToOpenAI, openAIToAnthropic } = require("./converter");

// Load ~/.troth/.env into process.env BEFORE provider config is read.
// API keys live in.env (0600 perms, gitignored) rather than the legacy
// ~/.troth/config.json plaintext path. loadProviders() then resolves
// each provider's key as: providers.<name>.apiKey from config.json
// (legacy fallback) ?? process.env[<NAME>_API_KEY] (canonical).
try { require("../../shared-core/env-file.js").load({ projectRoot: path.resolve(__dirname, '..', '..') }); } catch (_) {}

// ── Tool result deduplication ──
// Hash tool_result content so identical reads (same file read 3x)
// get replaced with a short pointer instead of 15KB×3.
var toolResultHashes = {};

function deduplicateToolResults(bodyStr) {
  try {
    var data = JSON.parse(bodyStr);
    if (!data.messages) return bodyStr;
    var deduped = 0;

    for (var i = 0; i < data.messages.length; i++) {
      var msg = data.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (var j = 0; j < msg.content.length; j++) {
        var block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;

        var text = typeof block.content === "string" ? block.content
          : Array.isArray(block.content) ? block.content.filter(function(b) { return b && b.type === "text"; }).map(function(b) { return b.text; }).join("\n")
          : "";
        if (text.length < 500) continue; // don't dedup small results

        var hash = crypto.createHash("md5").update(text).digest("hex");
        if (toolResultHashes[hash]) {
          var prev = toolResultHashes[hash];
          block.content = "[identical to previous " + prev.tool + " result — " + prev.chars + " chars]";
          deduped++;
        } else {
          toolResultHashes[hash] = { tool: block.tool_use_id || "tool", chars: text.length };
        }
      }
    }

    if (deduped) console.log("[router] Deduped " + deduped + " repeated tool result(s)");
    return JSON.stringify(data);
  } catch (e) { return bodyStr; }
}

// ── Compaction prompt ──
// Optimized for coding agent conversations. Flash uses this to generate
// summaries that preserve actionable context.
var COMPACTION_PROMPT =
  "You are a context-preservation engine for an autonomous coding agent. " +
  "Summarize the following conversation into a dense technical status report. " +
  "The original transcript will be PERMANENTLY DELETED — your summary is the agent's SOLE MEMORY.\n\n" +
  "CRITICAL — you MUST preserve:\n" +
  "1. EXACT file paths and directory structures (never generalize)\n" +
  "2. The original user task/goal\n" +
  "3. Architectural decisions made and WHY\n" +
  "4. What's DONE vs what's NOT DONE vs what's BROKEN\n" +
  "5. Specific error messages and unresolved bugs\n" +
  "6. Function/variable names the agent was working with\n" +
  "7. The last action the agent was performing\n\n" +
  "Format as bullet points. Be concise but COMPLETE. No filler.";

// ── Model effective limits (empirical, not theoretical) ──
// These are practical limits for agentic tool-calling workloads,
// not the model's advertised context window.
// Known context windows per model. Users can override/extend via
// ~/.troth/config.json → modelLimits: { "model-name": 256000 }
var MODEL_EFFECTIVE_LIMITS = {
  "gemini-3.1-pro-preview": 1000000,
  "gemini-3.1-pro-preview-customtools": 1000000,
  "gemini-3-flash-preview": 1000000,
  // GA names. The google_ai provider default is "gemini-3-flash" (no
  // -preview), so the real default request missed this table and fell to
  // 128K — the same class of bug as the Kimi ids.
  "gemini-3-flash": 1000000,
  "gemini-3.1-pro": 1000000,
  "gemini-3-pro": 1000000,
  "gemini-2.5-pro": 1000000,
  // BYOK defaults that are actually sent, verified against vendor docs
  // qwen3-max 256K, glm-5.1 ~200K, deepseek-v4(-pro) 1M.
  "qwen3-max": 262144,
  "qwen3-coder-480b": 262144,
  "glm-5.1": 200000,
  "deepseek-v4-pro": 1000000,
  "deepseek-v4": 1000000,
  // ChatGPT-plan lane (openai_sub) goes through the CODEX endpoint, whose
  // effective windows are far below the models' advertised 1M: gpt-5.5
  // gets 400K there, gpt-5.6-sol ~258K usable (openai/codex issues 19464,
  // 32806). Empirical-limit philosophy of this table: use what the lane
  // actually serves, not the marketing number.
  "gpt-5.5": 400000,
  "gpt-5.6-sol": 258000,
  "deepseek-ai/deepseek-v3.2": 128000,
  "deepseek-ai/deepseek-v3-0324": 65536,
  "deepseek-ai/deepseek-v3.1": 131072,
  "openai/gpt-oss-120b": 128000,
  "deepseek-chat": 128000,
  "llama-3.3-70b-versatile": 128000,
  "minimax/minimax-m2.5": 1000000,
  "qwen/qwen3.6-plus": 1000000,
  "kimi-k3": 1000000,
  // The ids the Kimi-for-Coding lane ACTUALLY sends (Settings offers "k3",
  // the provider default is "kimi-for-coding"). Only the kimi-k* aliases
  // above were listed, so every real Kimi request missed the table and fell
  // to the 128K default — a k3 pin then hit auto-compaction at ~13% of its
  // true 1M window. k3 is the 1M model; the
  // coding models are 256K.
  "k3": 1000000,
  "k3[1m]": 1000000,
  "kimi-for-coding": 262144,
  "kimi-for-coding-highspeed": 262144,
  "kimi-k2.7-code": 262144,
  "kimi-k2.7-code-highspeed": 262144,
  "kimi-k2.6": 262144,
  "grok-4.20": 2000000,
  "grok-4.3": 1000000,
  "grok-4.5": 500000,
  "grok-4.6": 500000,
  "grok-build-0.1": 262144,
  "claude-fable-5": 1000000,
  "claude-opus-5": 1000000,
  "claude-opus-4-8": 1000000,
  "claude-opus-4-7": 1000000,
  "claude-opus-4-6": 1000000,
  "claude-sonnet-5": 1000000,
  "claude-sonnet-4-6": 1000000,
  "claude-haiku-4-5": 200000
};
var DEFAULT_EFFECTIVE_LIMIT = 128000;

var CURATED_LIMITS = Object.assign(Object.create(null), MODEL_EFFECTIVE_LIMITS);
var OPERATOR_LIMITS = Object.create(null);
function loadModelLimits() {
  for (var _old in MODEL_EFFECTIVE_LIMITS) delete MODEL_EFFECTIVE_LIMITS[_old];
  Object.assign(MODEL_EFFECTIVE_LIMITS, CURATED_LIMITS);
  OPERATOR_LIMITS = Object.create(null);
  _tailMemo = Object.create(null);
  try {
    var _cfgLimits = JSON.parse(fs.readFileSync(path.join(process.env.HOME || require("os").homedir(), ".troth", "config.json"), "utf8"));
    if (!_cfgLimits.modelLimits) return;
    for (var _mk in _cfgLimits.modelLimits) {
      var _mv = Number(_cfgLimits.modelLimits[_mk]) || 0;
      if (_mv <= 0) continue;
      MODEL_EFFECTIVE_LIMITS[_mk] = _mv;
      OPERATOR_LIMITS[_mk] = _mv;
    }
  } catch (e) {}
}
loadModelLimits();

var endpointWindow = require("../../shared-core/endpoint-window.js");
var LOCAL_CTX_FALLBACK = parseInt(process.env.TROTH_CHAT_CTX || "16384", 10) || 16384;
var _endpointCtx = Object.create(null);
var _endpointProbedAt = Object.create(null);
var _ctxWarned = Object.create(null);

function probeEndpointWindow(key, base) {
  var now = Date.now();
  if (now - (_endpointProbedAt[key] || 0) < 60000) return;
  _endpointProbedAt[key] = now;
  endpointWindow.probe(base, function (n) {
    if (n > 0) { _endpointCtx[key] = n; _saveCtxCache(); }
  });
}

function _baseOf(prov) {
  if (prov && prov.base_url) {
    try {
      var u = new URL(prov.base_url);
      return { protocol: u.protocol, host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80) };
    } catch (_) { /* fall through to host/port */ }
  }
  return {
    protocol: "http:",
    host: (prov && prov.host) || "127.0.0.1",
    port: (prov && prov.port) || 1234
  };
}

function warnUnresolvedWindow(model, providerName) {
  if (_ctxWarned[model]) return;
  _ctxWarned[model] = true;
  console.log(
    "[router] No context window published for \"" + model + "\"; using " +
    DEFAULT_EFFECTIVE_LIMIT + ". Set providers." + (providerName || "<provider>") +
    ".context_window in ~/.troth/config.json to make this exact."
  );
}

function localContextSize() {
  if (MODEL_EFFECTIVE_LIMITS.local) return MODEL_EFFECTIVE_LIMITS.local;
  _seedEndpoint("local");
  probeEndpointWindow("local", _baseOf(providers.local));
  return _endpointCtx.local || LOCAL_CTX_FALLBACK;
}

function customEndpointSize() {
  _seedEndpoint("custom_openai");
  probeEndpointWindow("custom_openai", _baseOf(providers.custom_openai));
  return _endpointCtx.custom_openai || 0;
}

// A lane carries a faculty id and a model id, and a config field can end up
// holding the wrong one. Recording the faculty would attribute real tokens to
// something that is not a model and has no price, so it is swapped for the
// lane's own default before it reaches the ledger.
function _asModelName(candidate, fallback) {
  var s = String(candidate || '').trim();
  if (!s) return fallback;
  try {
    var names = require("../../shared-core/engine-names.js");
    if (names.toProvider(s) !== s) return fallback;
  } catch (_) {}
  return s;
}

function isLocalModelId(m) {
  return /\.gguf(\b|$)/i.test(m) || m.charAt(0) === "/" || /^[A-Za-z]:\\/.test(m);
}

function providerDeclaredLimit(model) {
  for (var name in providers) {
    var p = providers[name];
    if (!p || !p.enabled) continue;
    var n = Number(p.context_window || p.contextWindow || 0);
    if (n > 0 && String(p.model || "") === model) return n;
  }
  return 0;
}

var _discovered = Object.create(null);
var _discoveredAt = 0;

function probeOpenRouterCatalogue() {
  var now = Date.now();
  if (now - _discoveredAt < 24 * 60 * 60 * 1000) return;
  _discoveredAt = now;
  try {
    var req = https.get({
      host: "openrouter.ai",
      path: "/api/v1/models",
      timeout: 4000,
      headers: { "accept": "application/json" }
    }, function (res) {
      if (res.statusCode !== 200) { res.resume(); return; }
      var buf = "";
      res.on("data", function (c) { if (buf.length < 4 * 1024 * 1024) buf += c; });
      res.on("end", function () {
        try {
          var rows = (JSON.parse(buf) || {}).data || [];
          for (var i = 0; i < rows.length; i++) {
            var id = rows[i] && rows[i].id;
            var n = Number(rows[i] && rows[i].context_length) || 0;
            if (id && n > 0) _discovered[id] = n;
          }
          _tailMemo = Object.create(null);
          _saveCtxCache();
        } catch (_) {}
      });
    });
    req.on("timeout", function () { req.destroy(); });
    req.on("error", function () {});
  } catch (_) {}
}

var CTX_CACHE_PATH = path.join(process.env.HOME || require("os").homedir(), ".troth", "context-windows.json");
var CTX_CACHE_TTL = 24 * 60 * 60 * 1000;
var _ctxSeed = Object.create(null);
var _ctxSaveTimer = null;

function _laneFingerprint(name) {
  var p = providers[name] || {};
  var b = _baseOf(p);
  return name + "|" + b.host + ":" + b.port + "|" + String(p.model || "");
}

function _seedEndpoint(name) {
  if (_endpointCtx[name] != null) return;
  var row = _ctxSeed[_laneFingerprint(name)];
  var n = Number(row && row.n) || 0;
  if (n > 0) _endpointCtx[name] = n;
}

function _saveCtxCache() {
  if (_ctxSaveTimer) return;
  _ctxSaveTimer = setTimeout(function () {
    _ctxSaveTimer = null;
    try {
      var now = Date.now();
      var eps = Object.create(null);
      for (var f in _ctxSeed) {
        if (now - _ctxSeed[f].at <= CTX_CACHE_TTL) eps[f] = _ctxSeed[f];
      }
      for (var k in _endpointCtx) eps[_laneFingerprint(k)] = { n: _endpointCtx[k], at: now };
      var tmp = CTX_CACHE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ saved_at: now, endpoints: eps, catalogue: _discovered }));
      fs.renameSync(tmp, CTX_CACHE_PATH);
    } catch (_) {}
  }, 1000);
  if (_ctxSaveTimer.unref) _ctxSaveTimer.unref();
}

function _loadCtxCache() {
  try {
    var raw = JSON.parse(fs.readFileSync(CTX_CACHE_PATH, "utf8"));
    var savedAt = Number(raw && raw.saved_at) || 0;
    if (!savedAt || Date.now() - savedAt > CTX_CACHE_TTL) return;
    if (raw.endpoints) {
      for (var f in raw.endpoints) {
        var row = raw.endpoints[f] || {};
        var e = Number(row.n) || 0;
        var at = Number(row.at) || 0;
        if (e > 0 && at && Date.now() - at <= CTX_CACHE_TTL) _ctxSeed[f] = { n: e, at: at };
      }
    }
    if (raw.catalogue) {
      var any = false;
      for (var id in raw.catalogue) {
        var n = Number(raw.catalogue[id]) || 0;
        if (n > 0) { _discovered[id] = n; any = true; }
      }
      if (any) { _discoveredAt = savedAt; _tailMemo = Object.create(null); }
    }
  } catch (_) {}
}
_loadCtxCache();

function warmContextWindows() {
  try { loadModelLimits(); } catch (_) {}
  try { probeOpenRouterCatalogue(); } catch (_) {}
  try {
    if (providers.local && providers.local.enabled) probeEndpointWindow("local", _baseOf(providers.local));
  } catch (_) {}
  try {
    if (providers.custom_openai && providers.custom_openai.enabled) probeEndpointWindow("custom_openai", _baseOf(providers.custom_openai));
  } catch (_) {}
}

function isLocalModelId(m) {
  return /\.gguf(\b|$)/i.test(m) || m.charAt(0) === "/" || /^[A-Za-z]:\\/.test(m);
}

var _tailMemo = Object.create(null);

function _tailOf(id) {
  var s = String(id || "");
  var at = s.lastIndexOf("/");
  return (at === -1 ? s : s.slice(at + 1)).toLowerCase();
}

function _tailWindow(m) {
  var t = _tailOf(m);
  if (!t) return { window: 0, source: "" };
  if (_tailMemo[t]) return _tailMemo[t];
  var best = 0, src = "";
  for (var k in MODEL_EFFECTIVE_LIMITS) {
    if (_tailOf(k) !== t) continue;
    var n = MODEL_EFFECTIVE_LIMITS[k];
    if (n > 0 && (best === 0 || n < best)) {
      best = n;
      src = OPERATOR_LIMITS[k] ? "operator" : "table";
    }
  }
  if (!best) {
    for (var d in _discovered) {
      if (_tailOf(d) !== t) continue;
      var dn = _discovered[d];
      if (dn > 0 && (best === 0 || dn < best)) { best = dn; src = "catalogue"; }
    }
  }
  _tailMemo[t] = { window: best, source: src };
  return _tailMemo[t];
}

function resolveContextWindow(model) {
  var m = String(model || "");
  if (!m) return { window: DEFAULT_EFFECTIVE_LIMIT, source: "default" };
  if (MODEL_EFFECTIVE_LIMITS[m]) {
    return {
      window: MODEL_EFFECTIVE_LIMITS[m],
      source: OPERATOR_LIMITS[m] ? "operator" : "table"
    };
  }
  var ml = m.toLowerCase();
  var declared = providerDeclaredLimit(m);
  if (declared > 0) return { window: declared, source: "declared" };
  if (isLocalModelId(m) || (providers.local && String(providers.local.model || "") === m)) {
    var lw = localContextSize();
    return { window: lw, source: _endpointCtx.local ? "endpoint" : "fallback" };
  }
  probeOpenRouterCatalogue();
  if (_discovered[m]) return { window: _discovered[m], source: "catalogue" };
  var tail = _tailWindow(m);
  if (tail.window > 0) return tail;
  var best = 0, bestLen = 0;
  for (var k in MODEL_EFFECTIVE_LIMITS) {
    var kl = k.toLowerCase();
    if (ml.indexOf(kl) === 0 && kl.length > bestLen) {
      best = MODEL_EFFECTIVE_LIMITS[k];
      bestLen = kl.length;
    }
  }
  if (best) return { window: best, source: "family" };
  var cp = providers.custom_openai;
  if (cp && cp.enabled && String(cp.model || "") === m) {
    var probed = customEndpointSize();
    if (probed > 0) return { window: probed, source: "endpoint" };
    warnUnresolvedWindow(m, "custom_openai");
    return { window: DEFAULT_EFFECTIVE_LIMIT, source: "default" };
  }
  warnUnresolvedWindow(m, null);
  return { window: DEFAULT_EFFECTIVE_LIMIT, source: "default" };
}

function effectiveLimitFor(model) {
  return resolveContextWindow(model).window;
}

const CLIENT_1M = 1000000;
const CLIENT_DEFAULT = 200000;
const BETA_1M_RE = /context-1m/i;
function believedContextWindow(requestedModel, headers) {
  var m = String(requestedModel || "");
  if (/\[1m\]/i.test(m)) return CLIENT_1M;
  var beta = headers && (headers["anthropic-beta"] || headers["Anthropic-Beta"]);
  if (beta && BETA_1M_RE.test(String(beta))) return CLIENT_1M;
  return CLIENT_DEFAULT;
}

function scaleTokens(actualTokens, servedModel, believed) {
  var to = Number(believed) > 0 ? Number(believed) : CLIENT_DEFAULT;
  return Math.ceil(actualTokens * (to / effectiveLimitFor(servedModel)));
}

function scaleUsage(usage, servedModel, believed) {
  if (!usage) return usage;
  var fields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (Number(usage[f]) > 0) usage[f] = scaleTokens(usage[f], servedModel, believed);
  }
  return usage;
}

function scaleUsageInSSE(sseText, servedModel, believed) {
  return String(sseText).replace(/^data: (\{.*\})$/gm, function (line, json) {
    try {
      var ev = JSON.parse(json);
      var u = (ev.message && ev.message.usage) || ev.usage;
      if (!u) return line;
      scaleUsage(u, servedModel, believed);
      return 'data: ' + JSON.stringify(ev);
    } catch (_) {
      return line;
    }
  });
}

// ── Tool result hollowing ──
// Keep tool_use/tool_result structure (preserves ID pairing that
// the API validates) but strip large content from old messages.
// ~95% token reduction while maintaining schema validity.
function hollowOldToolResults(bodyStr) {
  try {
    var data = JSON.parse(bodyStr);
    var msgs = data.messages || [];
    if (msgs.length < 6) return bodyStr;

    var keepCount = Math.max(4, Math.ceil(msgs.length * 0.3));
    var hollowed = 0;

    for (var i = 0; i < msgs.length - keepCount; i++) {
      var content = msgs[i].content;
      if (!Array.isArray(content)) continue;
      for (var j = 0; j < content.length; j++) {
        var b = content[j];
        if (!b) continue;
        if (b.type === "tool_result") {
          var text = typeof b.content === "string" ? b.content : "";
          if (text.length > 500) {
            b.content = "[output — " + text.length + " chars]";
            hollowed++;
          }
        }
        // Also hollow old assistant text
        if (b.type === "text" && msgs[i].role === "assistant" && b.text && b.text.length > 1000) {
          b.text = b.text.slice(0, 300) + "\n[… " + b.text.length + " chars]";
          hollowed++;
        }
      }
    }

    if (hollowed) {
      console.log("[router] Hollowed " + hollowed + " old blocks");
    }
    return JSON.stringify(data);
  } catch (e) { return bodyStr; }
}

var contextfilter = require('./contextfilter');

// ── Request preprocessor ──
// Single pass over inbound Claude Code request. Handles:
// 1. Context-filtering (drop short narration text from older assistant msgs)
// 2. Compaction block truncation (post-compaction messages)
// 3. Thinking block stripping (Anthropic signatures → Gemini rejects)
// 4. Metadata extraction (requestedModel, thinkingConfig)
function preprocessAnthropicBody(bodyStr) {
  var requestedModel = "";
  var thinkingConfig = null;
  var contextManagement = null;

  // Context-filter first — cheap, shrinks payload before everything else.
  var cfResult = contextfilter.filterContext(bodyStr);
  if (cfResult.textBlocksRemoved > 0 || cfResult.messagesRemoved > 0) {
    stats.contextFilterBlocks = (stats.contextFilterBlocks || 0) + cfResult.textBlocksRemoved;
    stats.contextFilterBytes = (stats.contextFilterBytes || 0) + (cfResult.bytesSaved || 0);
    if (cfResult.bytesSaved > 500) {
      console.log("[router] ContextFilter: removed " + cfResult.textBlocksRemoved + " text blocks, " + cfResult.messagesRemoved + " empty msgs (saved " + (cfResult.bytesSaved / 1024).toFixed(1) + "KB)");
    }
    bodyStr = cfResult.body;
  }

  try {
    var data = JSON.parse(bodyStr);
    requestedModel = data.model || "";

    // ── Reasoning-model max_tokens floor ──
    // Models like qwen3.6, deepseek-r1, o1, o3, kimi-k2-thinking emit a
    // large internal-reasoning preamble before any visible output. With a
    // small max_tokens, ALL the budget is consumed by reasoning and the
    // user sees an empty assistant turn (verified live: qwen3.6:35b at
    // max_tokens=200 returns content_len=0 because ~150-200 reasoning
    // tokens fired first). Bump to a sensible floor so visible output
    // can actually emerge. Pattern is matched case-insensitively against
    // the requested model. Caller can extend via cfg.reasoningModels.
    var REASONING_MODEL_RE = /(^|[\/_:-])(o1|o3|deepseek-r1|qwen3\.\d|kimi-k3|kimi-.*-thinking|.*-thinking|.*-reasoning|.*-r1)([:_/-]|$)/i;
    // Bump if EITHER the requested model OR the configured local backend
    // model is a reasoning model. Real-session traffic from Claude Code
    // arrives with model=claude-sonnet-* (CC's default) regardless of
    // backend; the proxy then routes to local where the actual qwen3.6 /
    // o1 / r1 reasoning model runs. Without checking cfg.model, the
    // bumper never fires for the most common path.
    var localReasoning = providers.local.enabled && providers.local.model
      && REASONING_MODEL_RE.test(providers.local.model);
    var requestedReasoning = requestedModel && REASONING_MODEL_RE.test(requestedModel);
    if (requestedReasoning || localReasoning) {
      var orig = data.max_tokens;
      if (typeof orig === "number" && orig < 8192) {
        data.max_tokens = Math.min(32768, Math.max(8192, orig * 4));
        var why = requestedReasoning ? requestedModel : ("local=" + providers.local.model);
        console.log("[router] Reasoning-model max_tokens bumped: " + orig + " → " + data.max_tokens + " (" + why + ")");
        stats.reasoningBudgetBumped = (stats.reasoningBudgetBumped || 0) + 1;
      }
    }

    // ── Opus 4.7 strict mode: strip params that return 400 on 4.7 ──
    // Research: Opus 4.7 rejects deprecated thinking.budget_tokens and
    // non-default sampling params. Failing fast on our side prevents
    // downstream 400s that Claude Code would surface as session errors.
    if (requestedModel.indexOf("claude-opus-4-7") === 0) {
      if (data.thinking && data.thinking.budget_tokens !== undefined) {
        delete data.thinking.budget_tokens;
        stats.opus47Stripped = (stats.opus47Stripped || 0) + 1;
      }
      if (data.temperature !== undefined && data.temperature !== 1) {
        delete data.temperature;
        stats.opus47Stripped = (stats.opus47Stripped || 0) + 1;
      }
      if (data.top_p !== undefined && data.top_p !== 1) {
        delete data.top_p;
        stats.opus47Stripped = (stats.opus47Stripped || 0) + 1;
      }
      if (data.top_k !== undefined) {
        delete data.top_k;
        stats.opus47Stripped = (stats.opus47Stripped || 0) + 1;
      }
    }

    // ── Trim system prompt (12KB auto memory + tone sections) ──
    if (data.system) {
      if (typeof data.system === "string") {
        data.system = trimSystemPrompt(data.system);
      } else if (Array.isArray(data.system)) {
        for (var si = 0; si < data.system.length; si++) {
          if (data.system[si] && data.system[si].text) {
            data.system[si].text = trimSystemPrompt(data.system[si].text);
          }
        }
      }
    }

    // ── Strip redundant + truncate MCP tool descriptions + phase-prune ──
    if (Array.isArray(data.tools) && data.tools.length) {
      var beforeToolsKB = (Buffer.byteLength(JSON.stringify(data.tools)) / 1024).toFixed(1);
      var beforeCount = data.tools.length;
      var phase = detectPhase(data);
      if (phase !== 'mixed') {
        stats.phasePrunes = stats.phasePrunes || {};
        stats.phasePrunes[phase] = (stats.phasePrunes[phase] || 0) + 1;
      }
      data.tools = filterAndTrimTools(data.tools, phase);
      var afterToolsKB = (Buffer.byteLength(JSON.stringify(data.tools)) / 1024).toFixed(1);
      var saved = (beforeToolsKB - afterToolsKB).toFixed(1);
      if (saved > 1) {
        console.log("[router] Tools: " + beforeCount + " → " + data.tools.length + " | " + beforeToolsKB + "KB → " + afterToolsKB + "KB (saved " + saved + "KB, phase=" + phase + ")");
      }
    }

    // ── Extract and remove thinking config ──
    if (data.thinking) {
      if (data.thinking.type === "adaptive") {
        var effort = (data.output_config && data.output_config.effort) || "high";
        // Preserve caller's effort verbatim (including 'xhigh' and 'max' introduced
        // with Opus 4.7). Previously we mapped 'max' → 'high' which lost precision.
        var validEfforts = { "low": 1, "medium": 1, "high": 1, "xhigh": 1, "max": 1 };
        thinkingConfig = {
          thinkingLevel: validEfforts[effort] ? effort : "high",
          thinkingType: "adaptive",
          thinkingDisplay: data.thinking.display,
          effort: validEfforts[effort] ? effort : "high"
        };
      } else if (data.thinking.type === "enabled" && data.thinking.budget_tokens) {
        thinkingConfig = {
          thinkingBudget: data.thinking.budget_tokens,
          thinkingType: "enabled",
          thinkingDisplay: data.thinking.display
        };
      }
      delete data.thinking;
    }
    if (data.output_config) delete data.output_config;
    // Save context_management before removing — needed for compaction intercept
    if (data.context_management) {
      contextManagement = data.context_management;
      delete data.context_management;
    }

    var msgs = data.messages;
    if (!msgs || !msgs.length) {
      return { bodyStr: JSON.stringify(data), requestedModel: requestedModel, thinkingConfig: thinkingConfig, contextManagement: contextManagement };
    }

    // ── Compaction block truncation ──
    // Find the LAST compaction block — everything before it is dead history
    var compactionMsgIdx = -1;
    for (var ci = msgs.length - 1; ci >= 0; ci--) {
      var content = msgs[ci].content;
      if (!Array.isArray(content)) continue;
      for (var cj = 0; cj < content.length; cj++) {
        if (content[cj] && content[cj].type === "compaction") {
          compactionMsgIdx = ci;
          // Convert compaction block to standard text
          content[cj] = { type: "text", text: content[cj].content || content[cj].text || "[compacted conversation]" };
          break;
        }
      }
      if (compactionMsgIdx >= 0) break;
    }

    if (compactionMsgIdx > 0) {
      var dropped = msgs.splice(0, compactionMsgIdx);
      console.log("[router] POST-COMPACTION: dropped " + dropped.length + " messages before compaction block");

      // Ensure first message has role: "user"
      if (msgs[0] && msgs[0].role !== "user") {
        msgs.unshift({ role: "user", content: [{ type: "text", text: "[conversation resumed from compaction]" }] });
      }

      // Sanitize orphaned tool_result at boundary
      if (msgs[0] && Array.isArray(msgs[0].content)) {
        msgs[0].content = msgs[0].content.filter(function(b) {
          if (b.type !== "tool_result") return true;
          // Check if matching tool_use exists in remaining messages
          var hasMatch = msgs.some(function(m) {
            return Array.isArray(m.content) && m.content.some(function(c) {
              return c.type === "tool_use" && c.id === b.tool_use_id;
            });
          });
          return hasMatch;
        });
      }
    }

    // ── Thinking block stripping ──
    // Find last assistant message index
    var lastAssistantIdx = -1;
    for (var li = msgs.length - 1; li >= 0; li--) {
      if (msgs[li].role === "assistant") { lastAssistantIdx = li; break; }
    }

    var strippedThinking = 0;
    for (var ti = 0; ti < msgs.length; ti++) {
      if (msgs[ti].role !== "assistant") continue;
      if (!Array.isArray(msgs[ti].content)) continue;

      var isLatest = (ti === lastAssistantIdx);
      var newContent = [];

      for (var tj = 0; tj < msgs[ti].content.length; tj++) {
        var block = msgs[ti].content[tj];
        if (!block) continue;

        if (block.type === "redacted_thinking") {
          strippedThinking++;
          continue; // strip entirely
        }

        if (block.type === "thinking") {
          strippedThinking++;
          if (isLatest && block.thinking) {
            // Latest turn: preserve thinking text as context, strip signature
            newContent.push({ type: "text", text: "[thought_process]\n" + block.thinking + "\n[/thought_process]" });
          }
          // Older turns: strip entirely
          continue;
        }

        newContent.push(block);
      }

      msgs[ti].content = newContent;

      // If content is now empty, mark for removal
      if (!newContent.length) msgs[ti].content = null;
    }

    // Remove empty messages
    data.messages = msgs.filter(function(m) { return m.content !== null; });

    // Fix consecutive same-role turns (Gemini rejects these)
    var cleaned = [];
    for (var ci = 0; ci < data.messages.length; ci++) {
      if (ci > 0 && data.messages[ci].role === data.messages[ci - 1].role) {
        // Merge into previous message
        var prev = cleaned[cleaned.length - 1];
        var curr = data.messages[ci];
        if (Array.isArray(prev.content) && Array.isArray(curr.content)) {
          prev.content = prev.content.concat(curr.content);
        }
        continue;
      }
      cleaned.push(data.messages[ci]);
    }
    data.messages = cleaned;

    if (strippedThinking) {
      console.log("[router] Stripped " + strippedThinking + " thinking/redacted blocks");
    }

    currentThinkingConfig = thinkingConfig;
    currentRequestedModel = requestedModel;
    return { bodyStr: JSON.stringify(data), requestedModel: requestedModel, thinkingConfig: thinkingConfig, contextManagement: contextManagement };
  } catch (e) {
    currentThinkingConfig = thinkingConfig;
    currentRequestedModel = requestedModel;
    return { bodyStr: bodyStr, requestedModel: requestedModel, thinkingConfig: thinkingConfig, contextManagement: contextManagement };
  }
}

// ── Build transcript for compaction ──
// Serializes messages into a readable transcript for Flash to summarize.
function buildTranscript(messages) {
  var transcript = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var role = msg.role === "assistant" ? "Assistant" : "User";
    var content = msg.content;
    if (typeof content === "string") {
      transcript.push(role + ": " + content.slice(0, 500));
      continue;
    }
    if (!Array.isArray(content)) continue;

    var parts = [];
    for (var j = 0; j < content.length; j++) {
      var block = content[j];
      if (!block) continue;
      if (block.type === "text" && block.text) {
        parts.push(block.text.slice(0, 300));
      } else if (block.type === "tool_use") {
        var args = block.input || {};
        var argStr = args.file_path || args.command || args.pattern || JSON.stringify(args).slice(0, 100);
        parts.push("[Tool: " + block.name + "(" + argStr + ")]");
      } else if (block.type === "tool_result") {
        var resultText = typeof block.content === "string" ? block.content
          : Array.isArray(block.content) ? block.content.map(function(b) { return b.text || ""; }).join(" ")
          : "";
        var prefix = block.is_error ? "[Error] " : "[Result] ";
        parts.push(prefix + resultText.slice(0, 200));
      }
    }
    if (parts.length) transcript.push(role + ": " + parts.join(" | "));
  }
  return transcript.join("\n").slice(0, 80000);
}

// ── Compaction handled at the proxy ──
// A compaction request is a summarisation request, and this proxy is already
// holding the conversation, so it answers it here with a fast model from the
// fallback chain instead of forwarding it. The reply is an ordinary
// Anthropic-format SSE response carrying stop_reason "compaction", which is
// what the client is waiting for before it replaces its local history.
function handleCompaction(parsed, clientRes, requestedModel) {
  var msgs = parsed.messages || [];
  if (msgs.length < 4) return Promise.resolve(false);

  // Keep last ~15% of messages (min 2), summarize the rest
  var keepCount = Math.max(2, Math.min(6, Math.ceil(msgs.length * 0.15)));
  var toSummarize = msgs.slice(0, msgs.length - keepCount);

  console.log("[router] COMPACTION: summarizing " + toSummarize.length + " of " + msgs.length + " messages via fallback chain");

  var transcript = buildTranscript(toSummarize);
  var prompt = COMPACTION_PROMPT + "\n\nCONVERSATION:\n" + transcript;

  // Try to summarize via any available provider (uses same fallback chain as main requests)
  function trySummarize() {
    var fallbackBody = JSON.stringify({
      model: "any", max_tokens: 2000, stream: false,
      messages: [{ role: "user", content: prompt }]
    });
    return callFallbackChain(fallbackBody);
  }

  return trySummarize()
    .then(function(responseStr) {
      if (!responseStr) {
        console.error("[router] COMPACTION: all summarization models failed");
        return false;
      }

      var summary = "";
      try {
        var data = JSON.parse(responseStr);
        summary = (data.content || [])
          .filter(function(b) { return b.type === "text"; })
          .map(function(b) { return b.text; })
          .join("\n").trim();
        // OpenAI-format responses have choices[].message.content
        if (!summary && data.choices && data.choices[0]) {
          summary = data.choices[0].message.content || "";
        }
      } catch (e) {}

      if (!summary || summary.length < 50) {
        console.error("[router] COMPACTION: Flash returned empty summary");
        return false;
      }

      // Return Anthropic-format SSE compaction response
      clientRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      var msgId = "msg_compact_" + Date.now();
      var estimatedInput = Math.ceil(transcript.length / 4);
      var estimatedOutput = Math.ceil(summary.length / 4);

      // message_start
      clientRes.write("event: message_start\ndata: " + JSON.stringify({
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant",
          content: [], model: requestedModel || "claude-sonnet-4-20250514",
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: estimatedInput, output_tokens: 0 }
        }
      }) + "\n\n");

      // content_block with summary
      clientRes.write("event: content_block_start\ndata: " + JSON.stringify({
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" }
      }) + "\n\n");
      clientRes.write("event: content_block_delta\ndata: " + JSON.stringify({
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: summary }
      }) + "\n\n");
      clientRes.write("event: content_block_stop\ndata: " + JSON.stringify({
        type: "content_block_stop", index: 0
      }) + "\n\n");

      // message_delta with stop_reason: "compaction"
      clientRes.write("event: message_delta\ndata: " + JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "compaction", stop_sequence: null },
        usage: { output_tokens: estimatedOutput }
      }) + "\n\n");

      clientRes.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      clientRes.end();

      console.log("[router] COMPACTION OK — " + toSummarize.length + " msgs → " + summary.length + " char summary");
      return true;
    })
    .catch(function(err) {
      console.error("[router] COMPACTION error:", err.message || err);
      return false;
    });
}

// Per-request state set by preprocessAnthropicBody
var currentThinkingConfig = null;
var currentRequestedModel = null;

var stats = {
  geminiCalls: 0, localCalls: 0, deepseekCalls: 0, openrouterCalls: 0, kimi_subCalls: 0,
  nvidiaCalls: 0, anthropicCalls: 0, openai_subCalls: 0, flashCalls: 0, flashCorrections: 0, flashReviews: 0,
  errors: 0, tokenRefreshes: 0, accountSwitches: 0, waits: 0,
  toolCalls: 0, fallbacks: 0,
  // Token tracking per provider for cost estimation
  tokens: {
    gemini: { input: 0, output: 0 },
    anthropic: { input: 0, output: 0 },
    openai_sub: { input: 0, output: 0 },
    nvidia: { input: 0, output: 0 },
    deepseek: { input: 0, output: 0 },
    openrouter: { input: 0, output: 0 },
    moonshot: { input: 0, output: 0 },
    xai: { input: 0, output: 0 },
    custom_openai: { input: 0, output: 0 },
    local: { input: 0, output: 0 }
  }
};

// Operator's "what would I be paying without troth" baseline. Set via
// config.json `baseline_model` field. Defaults to Sonnet 4.6 if unset,
// but operators on Opus 4.7 etc. should set this explicitly so the
// savings number reflects their real counterfactual. Re-resolved on
// every loadProviders() call so config edits take effect without restart.
var baselineModel = 'claude-sonnet-4.6';
function getBaselineModel() { return baselineModel; }

// ────────────────────────────────────────────────────────────────────
// Provider registry — loaded from ~/.troth/config.json at startup.
// Each provider is optional. At least one must be enabled.
// Providers are tried in chain order based on task type and availability.
// ────────────────────────────────────────────────────────────────────
var providers = {
  alibaba: { enabled: false, apiKey: "", model: "qwen3-max" },
  zai: { enabled: false, apiKey: "", model: "glm-5.1", endpoint: "https://api.z.ai/api/paas/v4/chat/completions" },
  // BYOK, OpenAI-compatible. kimi-k3 fixes sampling params server-side (see callMoonshot / stripSampling).
  moonshot: { enabled: false, apiKey: "", model: "kimi-k3", endpoint: "https://api.moonshot.ai/v1/chat/completions" },
  // Kimi Code MEMBERSHIP (subscription). The Kimi Code endpoint
  // (api.kimi.com/coding) is Anthropic-compatible (/v1/messages), so the proxy
  // forwards the Anthropic body almost verbatim (see callKimiSub). DISTINCT from
  // `moonshot` above, which is Kimi's pay-per-token OpenAI-compatible API. The
  // key comes ONLY from the TROTH_KIMI_SUB_KEY env (subscription opt-in signal).
  kimi_sub: { enabled: false, apiKey: "", model: "kimi-for-coding", endpoint: "https://api.kimi.com/coding/" },
  // BYOK, OpenAI-compatible. xAI Grok flagship.
  xai: { enabled: false, apiKey: "", model: "grok-4.3", endpoint: "https://api.x.ai/v1/chat/completions" },
  // Custom (OpenAI-compatible): BYOK for ANY OpenAI-shaped API: NVIDIA NIM,
  // vLLM, LiteLLM/OpenRouter-style gateways, self-hosted servers. base_url is
  // the full OpenAI-compatible ROOT (e.g. https://integrate.api.nvidia.com/v1);
  // the call helper appends /chat/completions and the models probe appends
  // /models. apiKey is OPTIONAL (many self-hosted vLLM/LiteLLM without an
  // auth layer accept no key), so usability keys off base_url, not apiKey
  // (see activeByok). No default model: the operator sets one (free-text).
  custom_openai: { enabled: false, apiKey: "", model: "", base_url: "" },
  deepinfra: { enabled: false, apiKey: "", model: "deepseek-ai/DeepSeek-V3-0324" },
  anthropic: { enabled: false, apiKey: "" },
  // ChatGPT-subscription provider — bills against the operator's flat-rate
  // ChatGPT Plus / Pro quota instead of per-token API. No apiKey field;
  // auth is OAuth via shared-core/codex-token-store.js (sign-in handled
  // by /api/providers/codex/login), and the client identity that flow needs
  // is operator-supplied, not bundled (see shared-core/codex-auth.js).
  // Endpoint + body translated
  // to OpenAI Responses API via proxy/modules/openai-translate.js.
  openai_sub: { enabled: false, model: "gpt-5.6-sol" },
  nvidia: { enabled: false, apiKey: "", model: "deepseek-ai/deepseek-v3.1" },
  deepseek: { enabled: false, apiKey: "" },
  openrouter: { enabled: false, apiKey: "", model: "" },
  // Google AI Studio (Gemini API) — BYOK. troth supports one auth path for
  // Anthropic and Google: an API key the operator issues themselves. No
  // OAuth against a consumer subscription for either.
  google_ai: { enabled: false, apiKey: "", model: "gemini-3-flash" },
  local: { enabled: false, host: "127.0.0.1", port: 1234, model: "" }
};

// Names that all resolve to the ONE local provider entry. Config calls it
// "local"; the engine-override control and the substrate dispatcher speak in
// faculty names. Single source of truth for both the pin resolver and the
// dispatcher.
var LOCAL_FACULTIES = ["local", "llamacpp", "ollama"];

var routingPrefs = {
  planning: "auto",
  coding: "auto",
  simple: "auto",
  dispatch: "auto",
  scheduled: "auto",
  // Operator pin — "always use this provider". "" = auto (tier chain).
  // Set via config.routing.pin; the app's Auto / One-model control writes
  // it. Unlike the per-class prefs above (dashboard-display legacy, not
  // consulted by the chain), pin IS enforced in callFallbackChain.
  pin: "",
  // Operator-declared engine ORDER (array of provider names). Empty = let the
  // the router already resolved, never as an expansion, so a stale entry can
  // never resurrect a disabled or unhealthy engine.
  order: [],
  // Lead-engine preference when several are usable (the app's "This Mac first"
  // vs "Best quality first" pills, top-level config.dispatch_prefer):
  //   'local'  → local leads simple+medium, cloud only for hard reasoning
  //   'hosted' → cloud frontier leads all tiers, local is backup
  // Read from config.dispatch_prefer in loadProviders() and consulted by the
  // chain order below — was previously IGNORED (pill did nothing). Default
  // 'local' keeps the sane "trivial chat stays on-device" behavior.
  dispatch_prefer: "local"
};

// Pristine defaults — captured ONCE at module load so loadProviders() can
// reset to a known-good baseline before re-merging on every call. Without
// this, calling loadProviders() after the user removes a provider from
// config.json (or sets enabled:false then deletes the key entirely)
// leaves the previous in-memory state intact — so a "removed" provider
// stays enabled in the running process until restart. Same goes for
// routingPrefs: editing routing.{coding,planning,...} in the dashboard
// never UN-sets a previously-set value because the merge is additive.
var _providersDefaults = JSON.parse(JSON.stringify(providers));
var _routingPrefsDefaults = JSON.parse(JSON.stringify(routingPrefs));

function loadProviders() {
  try {
    // Ask the config store where the file is instead of rebuilding the path:
    // it honours TROTH_CONFIG_PATH / TROTH_CONFIG_DIR and every WRITE already
    // goes through it. Hardcoding ~/.troth/config.json here meant an operator
    // who redirected the config wrote to one file while the router kept
    // reading another — explicit settings invisible, saves apparently lost.
    var _cfgPath;
    try { _cfgPath = require('../../shared-core/config-file.js').configPath(); }
    catch (_) { _cfgPath = path.join(process.env.HOME || require("os").homedir(), ".troth", "config.json"); }
    var cfg = JSON.parse(fs.readFileSync(_cfgPath, "utf8"));
    // Reset to defaults before merging — otherwise removed config keys
    // never un-set the in-memory value (the additive merge below has no
    // way to know "this provider should now be off again").
    for (var pk in _providersDefaults) {
      providers[pk] = JSON.parse(JSON.stringify(_providersDefaults[pk]));
    }
    for (var rk in _routingPrefsDefaults) {
      routingPrefs[rk] = _routingPrefsDefaults[rk];
    }
    if (cfg.providers) {
      for (var k in cfg.providers) {
        if (providers[k]) {
          for (var f in cfg.providers[k]) {
            providers[k][f] = cfg.providers[k][f];
          }
        }
      }
    }
    // Auto-enable local from the top-level backendHost/backendPort shortcut.
    //
    // Earlier behavior had three bad gates that silently disabled local:
    //   - !cfg.providers (refused if ANY cloud provider was set)
    //   backendHost !== "127.0.0.1" (excluded the most common local addr)
    // Both made it impossible to use a local model alongside cloud BYOK.
    //
    // New rule: if backendHost+port are set AND the user didn't include an
    // explicit providers.local block, enable local from the shortcut. Any
    // user-supplied providers.local block (either enabled:true or false)
    // wins — handled by the loop above.
    if (cfg.backendHost && cfg.backendPort
        && !(cfg.providers && cfg.providers.local)) {
      providers.local.enabled = true;
      providers.local.host = cfg.backendHost;
      providers.local.port = cfg.backendPort;
      providers.local.model = providers.local.model || cfg.model || "";
    }
    if (cfg.routing) {
      for (var r in cfg.routing) {
        if (routingPrefs[r] !== undefined) routingPrefs[r] = cfg.routing[r];
      }
    }
    // Lead-engine preference is TOP-LEVEL config.dispatch_prefer (not under
    // routing), written by the app's "This Mac first" / "Best quality first"
    // pills. Read it so the chain order below honors the user's choice.
    if (cfg.dispatch_prefer === 'local' || cfg.dispatch_prefer === 'hosted') {
      routingPrefs.dispatch_prefer = cfg.dispatch_prefer;
    } else {
      // Nothing chosen yet, which is every fresh install. The default used to
      // be the constant 'local', so a machine with no local model advertised
      // "this Mac first" and sent the first message somewhere that does not
      // exist. Derive it instead: prefer this Mac only when this Mac can
      // actually answer. An explicit choice above always wins over this.
      routingPrefs.dispatch_prefer =
        (providers.local && providers.local.enabled) ? 'local' : 'hosted';
    }
    // Operator-declared baseline model for savings comparison. Re-resolves
    // every loadProviders() so editing config.json updates the comparison
    // without a proxy restart. Falls back to claude-sonnet-4.6 if unset.
    if (typeof cfg.baseline_model === 'string' && cfg.baseline_model.length) {
      baselineModel = cfg.baseline_model;
    } else {
      baselineModel = 'claude-sonnet-4.6';
    }
  } catch (e) {}
  // Backfill API keys from environment when config.json doesn't carry
  // them. Canonical storage is now ~/.troth/.env (loaded above into
  // process.env) — config.json keeps only enable/model/endpoint flags.
  // Env wins on collision so a freshly-rotated key in.env always
  // overrides a stale one accidentally left in config.json.
  var ENV_KEY_MAP = {
    anthropic:  'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    deepseek:   'DEEPSEEK_API_KEY',
    deepinfra:  'DEEPINFRA_API_KEY',
    nvidia:     'NVIDIA_API_KEY',
    alibaba:    'ALIBABA_API_KEY',
    zai:        'ZAI_API_KEY',
    moonshot:   'MOONSHOT_API_KEY',
    xai:        'XAI_API_KEY',
    custom_openai: 'CUSTOM_OPENAI_API_KEY',
    kimi_sub:   'TROTH_KIMI_SUB_KEY'
  };
  for (var prov in ENV_KEY_MAP) {
    var envName = ENV_KEY_MAP[prov];
    // Trim before adopting: a whitespace-only env value is truthy, passes the
    // per-provider `apiKey` guard, and then ships "Authorization: Bearer "
    // with no token — the provider answers 401 "Missing Authentication
    // header" on every turn.
    var envVal = process.env[envName] ? String(process.env[envName]).trim() : "";
    if (envVal && providers[prov]) {
      providers[prov].apiKey = envVal;
      // DO NOT auto-flip enabled. Enable state stays whatever the
      // operator set in config.json (or default false). The dashboard
      // can show "key configured, provider disabled — click to enable"
      // so no provider runs without explicit opt-in.
    }
  }
  // Kimi Code membership is a SUBSCRIPTION lane the launcher opts into via the
  // dedicated TROTH_KIMI_SUB_KEY env (not a shared apiKey field). Presence of
  // that env is treated as the opt-in, so the lane enables itself here — a
  // scoped exception to the no-auto-enable rule above.
  //
  // But only where the operator has NOT said otherwise. Written unconditionally
  // it overrode an explicit `"enabled": false` in config.json: the toggle went
  // off in the dashboard, the lane came back on at the next load, and requests
  // naming a Kimi model were served by an engine the operator had switched
  // off. An explicit off always beats an implicit on.
  if (process.env.TROTH_KIMI_SUB_KEY && providers.kimi_sub) {
    // `cfg` is assigned inside the try above, so it is undefined whenever the
    // config is missing or unparseable — and this block sits outside that try,
    // in a function called at module load. Reading cfg.providers there threw
    // before the proxy could listen: every fresh install launched with the
    // membership key exported, and every member whose config got corrupted.
    var _kimiCfg = cfg && cfg.providers && cfg.providers.kimi_sub;
    var _explicitlyOff = !!_kimiCfg && _kimiCfg.enabled === false;
    if (!_explicitlyOff) providers.kimi_sub.enabled = true;
    // Fill-only, like every other env fallback: an operator who pinned k3 in
    // config had it replaced by a 256K model on every load, silently.
    if (process.env.TROTH_KIMI_SUB_MODEL && !(_kimiCfg && _kimiCfg.model)) {
      providers.kimi_sub.model = String(process.env.TROTH_KIMI_SUB_MODEL).trim();
    }
  }
  var active = Object.keys(providers).filter(function(k) { return providers[k].enabled; });
  console.log("[router] Providers:", active.join(", ") || "none configured");
}

function getProviders() {
  // Mask API keys in the response — never expose full keys via dashboard/API
  var masked = {};
  for (var k in providers) {
    masked[k] = {};
    for (var f in providers[k]) {
      if (f === 'apiKey' && providers[k][f]) {
        masked[k][f] = providers[k][f].slice(0, 8) + '...';
      } else {
        masked[k][f] = providers[k][f];
      }
    }
    // `ready` — the server-computed "this lane can actually answer" truth,
    // matching what the chain builder itself requires. The Engine order UI
    // used to list every enabled lane; an enabled provider with no key
    // rendered as a routing rung that would never fire, which read as
    // "engines you have" when it was "engines you once toggled".
    var p = providers[k];
    if (k === 'local') {
      // Reachability, not just the flag. Asserting ready from `enabled` alone
      // reported a live engine for a port nothing has ever listened on — the
      // same shape of claim the doctor rewrite exists to end. isLocalAvailable
      // reads a cached probe (refreshed asynchronously, never blocking) and
      // returns false until one has succeeded.
      var _lready = false;
      try { _lready = !!(p.enabled && isLocalAvailable()); } catch (_) { _lready = false; }
      masked[k].ready = _lready;
    } else if (k === 'openai_sub') {
      var tok = null;
      try { tok = require('../../shared-core/codex-token-store.js').load(); } catch (_) {}
      masked[k].ready = !!(p.enabled && tok);
    } else if (k === 'custom_openai') {
      masked[k].ready = !!(p.enabled && p.base_url);
    } else {
      masked[k].ready = !!(p.enabled && p.apiKey);
    }
  }
  return masked;
}
function getRoutingPrefs() { return routingPrefs; }



function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

function stripMetadata(text) {
  if (!text) return "";
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  text = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  text = text.replace(/<command-name>[\s\S]*?<\/command-name>/g, "");
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  return text.trim();
}

// Trim sections of the inbound system prompt that cannot apply to the backend
// this proxy is routing to.
//
// Two are dropped. Instructions for managing a memory file the backend has no
// access to cannot be followed by it, and they are the larger half of what
// arrives. Formatting and tone preferences are addressed to a different client
// surface and do not change what the code answer is.
//
// The section names are read from the text at runtime, not from any copy of a
// vendor's prompt: this matches on what the request actually contains, and
// removes nothing whose section it cannot find.
function trimSystemPrompt(text) {
  if (!text) return text;
  var before = text.length;

  // Strip "# auto memory" section (12.3 KB) — MEMORY.md management, not relevant for Gemini
  text = text.replace(/\n# auto memory[\s\S]*?(?=\n# [A-Z]|$)/i, "");

  // Strip "# Tone and style" section (0.7 KB) — emoji rules, formatting
  text = text.replace(/\n# Tone and style[\s\S]*?(?=\n# [A-Z]|$)/i, "");

  var saved = before - text.length;
  if (saved > 1000) console.log("[router] Trimmed system prompt: -" + (saved / 1024).toFixed(1) + " KB");
  return text;
}

// MCP tools that troth modules already provide — strip them when CodeLens is enabled.
// These duplicate functionality and waste 10-25KB per request.
var REDUNDANT_MCP_PREFIXES = [
  "mcp__codebase-memory__",  // CodeLens module does the same (graph, search, indexing)
  "mcp__troth__",           // Dashboard (HTTP) covers this — model doesn't need to call troth control
];

// Heuristic: detect if task involves UI/browser work
function taskNeedsBrowser(messages) {
  if (!Array.isArray(messages)) return false;
  var text = "";
  for (var i = 0; i < messages.length; i++) {
    var c = messages[i].content;
    if (typeof c === "string") text += " " + c.toLowerCase();
    else if (Array.isArray(c)) {
      for (var j = 0; j < c.length; j++) {
        if (c[j] && c[j].type === "text" && c[j].text) text += " " + c[j].text.toLowerCase();
      }
    }
  }
  // Look for browser/UI keywords
  return /\b(browser|playwright|screenshot|click|navigate|page|chrome|firefox|safari|webdriver|selenium|html|css|button|form|ui)\b/.test(text);
}

// Phase-based tool pruning (research: Optimizing LLM Agent Context and Tools).
// Examines recent assistant tool_uses to detect what the agent is doing NOW.
// Returns: 'exploration' | 'implementation' | 'review' | 'mixed'.
var EXPLORE_TOOLS = { Read: 1, Grep: 1, Glob: 1, LS: 1, WebFetch: 1, WebSearch: 1, NotebookRead: 1 };
var IMPLEMENT_TOOLS = { Edit: 1, Write: 1, NotebookEdit: 1, Bash: 1 };
// Per-phase tool pruning policy (research-backed, April 2026):
//  exploration: pruning Agent+WebSearch IMPROVES quality (prevents the model
//    from getting distracted by external info before it has understood the
//    local codebase). This is an empirical win, not just a token saving.
//  implementation: pruning CAN DEGRADE quality — agents sometimes need to
//    spawn a sub-agent or fetch a doc mid-implementation. Research warns
//    against pruning here. Policy: no pruning.
//  review: narrow pruning of spawn-heavy tools is safe.
var PHASE_PRUNE_LIST = {
  exploration: { Agent: 1, WebSearch: 1 },        // verified improves quality
  // implementation: intentionally empty — research says pruning here degrades
  review: { Agent: 1, WebSearch: 1 }              // safe narrow prune, no Write/NotebookEdit
};

function detectPhase(data) {
  try {
    if (!data || !Array.isArray(data.messages)) return 'mixed';
    var recent = [];
    // Walk from last msg back, collect up to 12 tool_use names
    for (var m = data.messages.length - 1; m >= 0 && recent.length < 12; m--) {
      var msg = data.messages[m];
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (var b = msg.content.length - 1; b >= 0 && recent.length < 12; b--) {
        var blk = msg.content[b];
        if (blk && blk.type === 'tool_use' && blk.name) recent.push(blk.name);
      }
    }
    if (recent.length < 3) return 'mixed'; // not enough signal
    var explore = 0, implement = 0;
    for (var i = 0; i < recent.length; i++) {
      if (EXPLORE_TOOLS[recent[i]]) explore++;
      else if (IMPLEMENT_TOOLS[recent[i]]) implement++;
    }
    // Strong signal: ≥70% of recent tools in one category
    var total = recent.length;
    if (explore / total >= 0.7 && implement === 0) return 'exploration';
    if (implement / total >= 0.5) return 'implementation';
    return 'mixed';
  } catch (e) { return 'mixed'; }
}

function filterAndTrimTools(tools, phase) {
  var pruneSet = (phase && PHASE_PRUNE_LIST[phase]) || null;
  var out = [];
  for (var i = 0; i < tools.length; i++) {
    var tool = tools[i];
    if (!tool || !tool.name) continue;
    var name = tool.name;

    // Strip redundant MCP tools
    var skip = false;
    for (var p = 0; p < REDUNDANT_MCP_PREFIXES.length; p++) {
      if (name.indexOf(REDUNDANT_MCP_PREFIXES[p]) === 0) { skip = true; break; }
    }
    if (skip) continue;

    // Strip playwright — user can re-enable via dashboard if needed.
    if (name.indexOf("mcp__playwright__") === 0) continue;

    // Phase-based pruning — strip tools unlikely to be used in current phase.
    // Keeps core Read/Edit/Bash/Glob/Grep always; only prunes heavy spawn/search tools.
    if (pruneSet && pruneSet[name]) continue;

    // Truncate long descriptions to 250 chars (was up to 9.5 KB for Agent tool!)
    var trimmed = Object.assign({}, tool);
    if (trimmed.description && trimmed.description.length > 250) {
      // Keep first sentence/line + truncation marker
      var firstLine = trimmed.description.split(/[\n.]/)[0].slice(0, 250);
      trimmed.description = firstLine + (trimmed.description.length > firstLine.length ? "…" : "");
    }
    out.push(trimmed);
  }
  return out;
}



// ────────────────────────────────────────────────────────────────────
// OpenAI-compatible provider calls (DeepSeek, OpenRouter)
// ────────────────────────────────────────────────────────────────────
//
// All three use the same pattern: convert Anthropic → OpenAI format,
// HTTPS POST to the provider, convert response back. The converter
// module handles format translation; these functions handle the HTTP
// transport and provider-specific quirks.

function callOpenAICompatible(bodyStr, providerOpts) {
  var converted = anthropicToOpenAI(bodyStr, { model: providerOpts.model });
  if (!converted) return Promise.resolve(null);

  // kimi-k3 fixes temperature / top_p / penalties server-side and rejects
  // (or silently ignores) any sampling params in the payload. Strip them so
  // the outgoing body honors Moonshot's fixed-sampling contract for k3.
  if (providerOpts.stripSampling && converted) {
    delete converted.temperature;
    delete converted.top_p;
    delete converted.presence_penalty;
    delete converted.frequency_penalty;
  }

  var postData = JSON.stringify(converted);

  // Every named cloud is HTTPS, so the default preserves their exact behavior.
  // Only the Custom (OpenAI-compatible) provider may pass protocol:'http:' for
  // a self-hosted plaintext server (vLLM/LiteLLM on a LAN); nothing else does.
  var transport = providerOpts.protocol === 'http:' ? http : https;
  return new Promise(function(resolve) {
    var req = transport.request({
      hostname: providerOpts.hostname,
      port: providerOpts.port || 443,
      path: providerOpts.path || "/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + providerOpts.apiKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: providerOpts.timeout || 120000
    }, function(res) {
      var body = "";
      res.on("data", function(d) { body += d; });
      res.on("end", function() {
        if (res.statusCode === 429) {
          console.error("[router]", providerOpts.name, "rate limited:", res.statusCode);
          resolve(null);
          return;
        }
        if (res.statusCode !== 200) {
          var errMsg = "";
          try { errMsg = JSON.parse(body).error?.message || body.slice(0, 200); } catch(e) { errMsg = body.slice(0, 200); }
          if (typeof providerOpts.onError === 'function') {
            try { providerOpts.onError(res.statusCode, errMsg, body); } catch(_) {}
          }
          // P4.2: classify + record so /api/stats shows error patterns
          try { require('./errortax').record(res.statusCode, errMsg, providerOpts.model || providerOpts.name); } catch (_) {}
          console.error("[router]", providerOpts.name, "error:", res.statusCode, errMsg);
          resolve(null);
          return;
        }

        var anthropicResponse = openAIToAnthropic(body, currentRequestedModel || providerOpts.model);
        if (!anthropicResponse) {
          console.error("[router]", providerOpts.name, "empty response");
          resolve(null);
          return;
        }

        var usage = {};
        try { usage = JSON.parse(body).usage || {}; } catch(e) {}
        // Track tokens per provider
        var provKey = (providerOpts.name || '').toLowerCase();
        if (provKey.includes('nim') || provKey.includes('nvidia')) { stats.tokens.nvidia.input += usage.prompt_tokens || 0; stats.tokens.nvidia.output += usage.completion_tokens || 0; }
        else if (provKey.includes('deepseek')) { stats.tokens.deepseek.input += usage.prompt_tokens || 0; stats.tokens.deepseek.output += usage.completion_tokens || 0; }
        else if (provKey.includes('openrouter')) { stats.tokens.openrouter.input += usage.prompt_tokens || 0; stats.tokens.openrouter.output += usage.completion_tokens || 0; }
        else if (provKey.includes('moonshot') || provKey.includes('kimi')) { stats.tokens.moonshot.input += usage.prompt_tokens || 0; stats.tokens.moonshot.output += usage.completion_tokens || 0; }
        else if (provKey.includes('xai') || provKey.includes('grok')) { stats.tokens.xai.input += usage.prompt_tokens || 0; stats.tokens.xai.output += usage.completion_tokens || 0; }
        else if (provKey.includes('custom')) { stats.tokens.custom_openai.input += usage.prompt_tokens || 0; stats.tokens.custom_openai.output += usage.completion_tokens || 0; }
        // Cost tracking — record real $ spend per model
        try {
          var costMod = require('./cost');
          var inT  = usage.prompt_tokens || 0;
          var outT = usage.completion_tokens || 0;
          var cachT = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
          costMod.recordUsage(_asModelName(providerOpts.model, providerOpts.model), inT, outT, cachT);
          // P4.1 — feed the per-model cache HIT-RATIO tracker for OpenAI-shape
          // providers too (was Anthropic-only, so the dashboard showed 0% cache
          // for DeepSeek/Gemini/Qwen even when their implicit prefix-cache hit).
          // OpenAI usage: prompt_tokens is TOTAL, cached_tokens is the cached
          // subset -> uncached = inT - cachT; no separate cache-write billing.
          try { require('./cacheratio').record(providerOpts.model, { input_tokens: Math.max(0, inT - cachT), cache_read_input_tokens: cachT, cache_creation_input_tokens: 0 }); } catch (_) {}
          // Baseline = the model THE CLIENT ASKED FOR in the inbound
          // request (preprocessAnthropicBody captured it into
          // currentRequestedModel above). This is the only honest
          // counterfactual: "you'd pay X if we hadn't intercepted and
          // routed to cheaper provider Y." config.baseline_model is the
          // last-resort fallback for cases where the inbound model
          // wasn't captured (rare). Hardcoded sonnet 4.6 fallback removed
          // it was lying about what the user was actually using.
          try {
            var _bm = currentRequestedModel || baselineModel || providerOpts.model;
            var actualC   = costMod.calculateCost(providerOpts.model, inT, outT, cachT);
            var baselineC = costMod.calculateCost(_bm, inT, outT, cachT);
            var sharedState = require('../../shared-core/state.js');
            sharedState.recordBaselineCost({
              actual_model: providerOpts.model,
              actual_cost: actualC.cost || 0,
              baseline_model: _bm,
              baseline_cost: baselineC.cost || 0,
              tokens_in: inT, tokens_out: outT, tokens_cached: cachT
            });
            // P16.5 I2 — emit cost_event into the substrate, attributed to
            // the most-recent linkable action in the active plugin session.
            // Silently skipped if no plugin active or no recent action,
            // so we never write orphan cost rows.
            try {
              var sharedCost = require('../../shared-core/cost.js');
              sharedCost.recordCostForActiveSession(sharedState, 'proxy', {
                input_tokens: inT, output_tokens: outT, cached_tokens: cachT,
                usd: actualC.cost || 0, model: providerOpts.model,
                provider: providerOpts.name, source: 'measured'
              });
            } catch (_) {}
          } catch (_) {}
        } catch (e) {}
        console.log("[router]", providerOpts.name, "OK | in:", usage.prompt_tokens || 0, "out:", usage.completion_tokens || 0);

        resolve({
          success: true,
          response: anthropicResponse,
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0
        });
      });
    });
    req.on("error", function(err) {
      console.error("[router]", providerOpts.name, "network error:", err.message);
      resolve(null);
    });
    req.on("timeout", function() {
      console.error("[router]", providerOpts.name, "timeout");
      req.destroy();
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}

// Alibaba Model Studio supports both generic aliases AND versioned model IDs.
// Free quota is tracked per EXACT model ID — so qwen-max and qwen-max-latest have
// SEPARATE 1M-token free pools, and each versioned release (qwen3-max-,
// qwen3-max-2025-09-23, qwen3-max-preview) also has its own 1M pool.
// The unversioned alias "qwen3-max" is NOT SUPPORTED for free quota — Not Supported
// status in the dashboard. Use versioned IDs to actually consume free credits.
// [Alibaba docs: alibabacloud.com/help/en/model-studio/new-free-quota]
var ALIBABA_VALID_MODELS = [
  // Versioned (have per-version free quota)
  'qwen3-max-2026-01-23',  // newest, 1M free
  'qwen3-max-2025-09-23',  // older, 1M free
  'qwen3-max-preview',     // preview, 1M free
  'qwen-max',              // stable alias with own 1M free
  'qwen-max-latest',       // separate quota from qwen-max
  // Generic aliases (may or may not map to free)
  'qwen3-max', 'qwen3.6-plus', 'qwen-plus', 'minimax-m2.5', 'glm-5.1'
];
var alibabaCaps = require('./alibabaCaps');
var tokenestimate = require('./tokenestimate');
// Legacy constant kept for backward compatibility of the export surface.
// Real caps live in alibabaCaps.js per model; this is the conservative floor.
var ALIBABA_HARD_CAP_TOKENS = alibabaCaps.DEFAULT_CAP;

function callAlibaba(bodyStr, opts) {
  opts = opts || {};
  if (!providers.alibaba.enabled || !providers.alibaba.apiKey) return Promise.resolve(null);
  // Optional caller-supplied model override — used by the architect path so
  // forcing qwen3-max for a hard task doesn't mutate providers.alibaba.model
  // globally (which previously created a race when concurrent requests read
  // the field between the override and the.then restore).
  var model = opts.model || providers.alibaba.model || "qwen3-max";
  // glm-5.1 is served by Z.ai's Coding Plan, NOT Alibaba DashScope. The model
  // ID appears in the Alibaba whitelist for legacy config reasons, but the
  // real request must go elsewhere. Decline here so the fallback chain's
  // Z.ai provider (if enabled) picks it up. [P1.4]
  if (model === "glm-5.1") {
    console.log("[router] Alibaba skipped for glm-5.1 (served by Z.ai, not DashScope). Falling through.");
    return Promise.resolve(null);
  }
  if (ALIBABA_VALID_MODELS.indexOf(model) === -1) {
    // Advisory only — don't silently downgrade to qwen3-max. The whitelist
    // is built from models known on a specific date; users with a fresh
    // DashScope key for qwen3-coder-plus / qwen3.5-max-* / etc. would
    // otherwise get downgraded without notice. Let DashScope reject if
    // genuinely invalid; surface the warning either way.
    console.log("[router] Alibaba model '" + model + "' is not in the bundled whitelist — sending anyway. If DashScope returns 400, file an issue with the model id.");
  }
  // Per-model context cap check (replaces blanket 170K hard-cap from Phase 90).
  // [research: P3 per-model caps; Hermes Agent approach]
  var modelCap = alibabaCaps.getCap(model);
  // Alibaba models are not 4.7; estimator uses legacy constant + CJK detection.
  var estTokens = tokenestimate.estimateBodyTokens(bodyStr, model);
  // P3.2: compression buffer — warn (and surface in stats) when body is
  // within 80% of the cap, so upstream can choose to compress BEFORE we
  // hit the hard rejection below. Hermes Agent pattern.
  try {
    var compressionbuffer = require('./compressionbuffer');
    var advice = compressionbuffer.checkAndMark(model, estTokens, modelCap);
    if (advice.compress) {
      console.log("[router] Alibaba compression buffer triggered: " + (advice.pctUsed * 100).toFixed(1) + "% of " + modelCap + " used (est " + estTokens + " tokens, margin " + advice.margin + "). Consider compression.");
    }
  } catch (e) {}
  if (estTokens > modelCap) {
    alibabaCaps.recordRejection(model, estTokens);
    stats.alibabaOverflow = (stats.alibabaOverflow || 0) + 1;
    console.log("[router] Alibaba skipped — est " + estTokens + " tokens > " + modelCap + " cap for " + model + ". Falling through.");
    return Promise.resolve(null);
  }
  // Alibaba dashscope-intl rejects oversized max_tokens with
  // InvalidParameter (live: REQ #95, qwen-max → "Range of
  // max_tokens should be [1, 8192]"). CC sends Sonnet-class limits
  // (32k–64k); cap to whatever the model advertises BEFORE the round-trip
  // so a fixable mismatch doesn't blacklist the provider for 30s. The cap
  // is per-model and learnable from error responses; see alibabaCaps.
  try {
    var outCap = alibabaCaps.getOutputCap && alibabaCaps.getOutputCap(model);
    if (typeof outCap === 'number' && outCap > 0) {
      var aliBody = JSON.parse(bodyStr);
      if (typeof aliBody.max_tokens === 'number' && aliBody.max_tokens > outCap) {
        aliBody.max_tokens = outCap;
        bodyStr = JSON.stringify(aliBody);
      }
    }
  } catch (e) { /* not JSON or no cap known — let downstream handle */ }
  stats.alibabaCalls = (stats.alibabaCalls || 0) + 1;
  return callOpenAICompatible(bodyStr, {
    name: "Alibaba Coding Plan",
    hostname: providers.alibaba.endpoint || "dashscope-intl.aliyuncs.com",
    path: "/compatible-mode/v1/chat/completions",
    apiKey: providers.alibaba.apiKey,
    model: model,
    // Runtime cap discovery: parse Range errors (input + output) and
    // shrink the matching cap so future requests short-circuit before
    // the round-trip.
    onError: function(status, errorMsg) {
      var inDisc = alibabaCaps.parseRangeError(errorMsg);
      if (inDisc) alibabaCaps.updateCap(model, inDisc);
      if (alibabaCaps.parseOutputRangeError) {
        var outDisc = alibabaCaps.parseOutputRangeError(errorMsg);
        if (outDisc) alibabaCaps.updateOutputCap(model, outDisc);
      }
    }
  });
}

// Z.ai Coding Plan — serves glm-5.1 and other Z-branded models.
// Distinct from Alibaba DashScope despite both being "Coding Plan" subscriptions;
// different auth, quota, endpoint.
//  docs.z.ai/devpack/using5.1]
function callZai(bodyStr, opts) {
  opts = opts || {};
  if (!providers.zai.enabled || !providers.zai.apiKey) return Promise.resolve(null);
  stats.zaiCalls = (stats.zaiCalls || 0) + 1;
  var endpoint = providers.zai.endpoint || "https://api.z.ai/api/paas/v4/chat/completions";
  var parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    console.error("[router] Z.ai endpoint invalid:", endpoint);
    return Promise.resolve(null);
  }
  return callOpenAICompatible(bodyStr, {
    name: "Z.ai Coding Plan",
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + (parsed.search || ""),
    apiKey: providers.zai.apiKey,
    model: opts.model || providers.zai.model || "glm-5.1"
  });
}

// Moonshot (Kimi) — BYOK, OpenAI-compatible. Serves kimi-k3, a reasoning
// model whose temperature / top_p / penalties are FIXED server-side; the
// stripSampling flag drops them from the outgoing payload (see
// callOpenAICompatible). reasoning_effort defaults to max, so we send none.
function callMoonshot(bodyStr, opts) {
  opts = opts || {};
  if (!providers.moonshot.enabled || !providers.moonshot.apiKey) return Promise.resolve(null);
  stats.moonshotCalls = (stats.moonshotCalls || 0) + 1;
  var endpoint = providers.moonshot.endpoint || "https://api.moonshot.ai/v1/chat/completions";
  var parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    console.error("[router] Moonshot endpoint invalid:", endpoint);
    return Promise.resolve(null);
  }
  return callOpenAICompatible(bodyStr, {
    name: "Moonshot (" + (opts.model || providers.moonshot.model || "kimi-k3") + ")",
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + (parsed.search || ""),
    apiKey: providers.moonshot.apiKey,
    model: opts.model || providers.moonshot.model || "kimi-k3",
    stripSampling: true
  });
}

// Kimi Code MEMBERSHIP (subscription) — native Anthropic passthrough, NOT the
// OpenAI-compatible moonshot API. The Kimi Code endpoint speaks the same
// /v1/messages wire shape, so we forward the Anthropic body as-is (only the
// model id is normalised off a Claude default) and return the Anthropic-shaped
// response unchanged: same callsite contract as callAnthropic. The membership
// key rides x-api-key and is never logged.
function callKimiSub(bodyStr, opts) {
  opts = opts || {};
  if (!providers.kimi_sub.enabled || !providers.kimi_sub.apiKey) return Promise.resolve(null);
  stats.kimiSubCalls = (stats.kimiSubCalls || 0) + 1;
  var base = providers.kimi_sub.endpoint || "https://api.kimi.com/coding/";
  var parsed;
  try { parsed = new URL(base); } catch (e) {
    console.error("[router] Kimi endpoint invalid:", base);
    return Promise.resolve(null);
  }
  var reqPath = parsed.pathname.replace(/\/+$/, "") + "/v1/messages";
  var postData = bodyStr;
  try {
    var pb = JSON.parse(bodyStr);
    var changed = false;
    if (pb.model === "any" || !pb.model || /claude/i.test(String(pb.model))) {
      pb.model = opts.model || providers.kimi_sub.model || "kimi-for-coding";
      changed = true;
    }
    if ("think" in pb) { delete pb.think; changed = true; }
    // The Kimi Code endpoint runs thinking on ITS side and rejects forced
    // tool use outright ("tool_choice 'specified' is incompatible with
    // thinking enabled" — live 400, surfaced by recallforce's first field
    // test). A lane that cannot carry a forced choice drops it WHOLE and
    // lets the model choose — same discipline as the OpenAI-compat
    // conversion — because a dropped force degrades to advice while a 400
    // kills the turn.
    if (pb.tool_choice && (pb.tool_choice.type === "tool" || pb.tool_choice.type === "any")) {
      delete pb.tool_choice; changed = true;
    }
    // Fallback-chain contract: this fn must resolve ONE complete JSON Anthropic
    // message so the proxy can re-synthesize the SSE stream for Claude Code
    // itself (server.js streaming wrapper). If we forward stream:true, the Kimi
    // Code endpoint replies with an SSE event stream (event: message_start …);
    // the JSON.parse below (and in server.js) then throws "Unexpected token 'e',
    // event:mess…", the wrap fails, and the turn breaks. Force non-streaming so
    // Kimi returns a single JSON message object — the same shape callAnthropic
    // returns. (Bug surfaced  once K3 was correctly pinned; k3 streams,
    // exposing this latent stream:true passthrough.)
    if (pb.stream !== false) { pb.stream = false; changed = true; }
    if (changed) postData = JSON.stringify(pb);
  } catch (_) {}
  return new Promise(function (resolve) {
    var req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: reqPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        "x-api-key": providers.kimi_sub.apiKey,
        "anthropic-version": "2023-06-01"
      },
      timeout: 300000
    }, function (res) {
      var body = "";
      res.on("data", function (c) { body += c; });
      res.on("end", function () {
        if (res.statusCode === 200) {
          stats.kimi_subCalls = (stats.kimi_subCalls || 0) + 1;
          // Name the MODEL, not just the lane. "Kimi Code OK" could not tell a
          // k3 turn from a silent fall back to the base tier, which is exactly
          // how a Moderato subscriber kept paying for a flagship and reading
          // base-tier answers.
          var _sentModel = "?";
          try { _sentModel = (JSON.parse(postData).model) || "?"; } catch (_) {}
          try {
            var pj = JSON.parse(body);
            var u = pj.usage || {};
            stats.tokens.moonshot.input += u.input_tokens || 0;
            stats.tokens.moonshot.output += u.output_tokens || 0;
            // Kimi's coding endpoint auto-caches and bills input_tokens as
            // the UNCACHED remainder — an identical body sent twice comes
            // back input 3180 / cache_read 0, then input 0 / cache_read 3180.
            // So .input above is quota burn, not payload size. The cache
            // columns were dropped until here, which left telemetry's
            // cache-ratio table empty on the one lane whose entire cost
            // story is cache behaviour — the product was blind on its
            // flagship subscription lane.
            try { require('./cacheratio').record(_sentModel, u); } catch (_) {}
            // The persistent ledger, same as every other lane — this one
            // wrote only in-memory stats, so the subscription's usage
            // vanished on every proxy restart and the usage surfaces showed
            // three lanes out of four.
            try {
              require('./cost').recordUsage(_sentModel + ' (plan)', u.input_tokens || 0, u.output_tokens || 0,
                (u.cache_read_input_tokens || 0));
            } catch (_) {}
          } catch (_) {}
          console.log("[router] Kimi Code OK (" + _sentModel + ")");
          resolve({ success: true, response: body });
        } else if (res.statusCode === 429) {
          try { require('./errortax').record(429, 'rate limited', 'kimi_sub'); } catch (_) {}
          resolve(null);
        } else {
          var km = body.slice(0, 200);
          try { var pe = JSON.parse(body); if (pe.error && pe.error.message) km = pe.error.message; } catch (_) {}
          try { require('./errortax').record(res.statusCode, km, 'kimi_sub'); } catch (_) {}
          console.error("[router] Kimi Code", res.statusCode, body.slice(0, 200));
          if (res.statusCode >= 400 && res.statusCode < 500) {
            resolve({ success: false, requestError: true, status: res.statusCode });
          } else { resolve(null); }
        }
      });
    });
    req.on("error", function (err) { console.error("[router] Kimi Code error:", err.message); resolve(null); });
    req.on("timeout", function () { console.error("[router] Kimi Code timeout"); req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// xAI — BYOK, OpenAI-compatible. Serves grok-4.3, the current API flagship.
// No sampling quirk, so no stripSampling flag.
function callXai(bodyStr, opts) {
  opts = opts || {};
  if (!providers.xai.enabled || !providers.xai.apiKey) return Promise.resolve(null);
  stats.xaiCalls = (stats.xaiCalls || 0) + 1;
  var endpoint = providers.xai.endpoint || "https://api.x.ai/v1/chat/completions";
  var parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    console.error("[router] xAI endpoint invalid:", endpoint);
    return Promise.resolve(null);
  }
  return callOpenAICompatible(bodyStr, {
    name: "xAI (" + (opts.model || providers.xai.model || "grok-4.3") + ")",
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + (parsed.search || ""),
    apiKey: providers.xai.apiKey,
    model: opts.model || providers.xai.model || "grok-4.3"
  });
}

// Custom (OpenAI-compatible): BYOK for ANY OpenAI-shaped API (NVIDIA NIM,
// vLLM, LiteLLM, OpenRouter-style gateways, self-hosted). Unlike the named
// clouds above, the endpoint is NOT a hardcoded constant: base_url comes
// entirely from config (providers.custom_openai.base_url) and is the full
// OpenAI-compatible ROOT (e.g. https://integrate.api.nvidia.com/v1). We derive
// the chat path by appending /chat/completions to that root's path.
//
// apiKey is OPTIONAL here (self-hosted vLLM/LiteLLM often need none), so the
// only hard requirement is base_url. callOpenAICompatible still sends an
// "Authorization: Bearer " header; with an empty key that is a bare "Bearer ",
// which keyless servers ignore and keyed servers reject as expected, matching
// the operator's own config. The "custom" substring in name routes token
// stats into stats.tokens.custom_openai (see callOpenAICompatible).
function callCustomOpenai(bodyStr, opts) {
  opts = opts || {};
  // Usable = enabled AND base_url set. Deliberately NOT gated on apiKey.
  if (!providers.custom_openai.enabled || !providers.custom_openai.base_url) return Promise.resolve(null);
  stats.customOpenaiCalls = (stats.customOpenaiCalls || 0) + 1;
  var base = providers.custom_openai.base_url;
  var parsed;
  try {
    parsed = new URL(base);
  } catch (e) {
    console.error("[router] Custom (OpenAI-compatible) base_url invalid:", base);
    return Promise.resolve(null);
  }
  // Join the base path with /chat/completions, tolerating a trailing slash on
  // base_url (…/v1 or …/v1/ both yield …/v1/chat/completions).
  var basePath = parsed.pathname.replace(/\/+$/, "");
  var chatPath = basePath + "/chat/completions";
  return callOpenAICompatible(bodyStr, {
    name: "Custom OpenAI (" + (opts.model || providers.custom_openai.model || "unspecified") + ")",
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
    path: chatPath + (parsed.search || ""),
    protocol: parsed.protocol,
    apiKey: providers.custom_openai.apiKey || "",
    model: opts.model || providers.custom_openai.model || ""
  });
}

// All provider hostnames are user-overridable via providers.<name>.endpoint.
// Lets users route through self-hosted gateways (LiteLLM, Helicone),
// regional shards, EU mirrors, or air-gapped proxies without forking.
function callDeepSeek(bodyStr, opts) {
  opts = opts || {};
  if (!providers.deepseek.enabled || !providers.deepseek.apiKey) return Promise.resolve(null);
  stats.deepseekCalls++;
  return callOpenAICompatible(bodyStr, {
    name: "DeepSeek (" + (opts.model || providers.deepseek.model || "deepseek-chat") + ")",
    hostname: providers.deepseek.endpoint || "api.deepseek.com",
    path: "/chat/completions",
    apiKey: providers.deepseek.apiKey,
    model: opts.model || providers.deepseek.model || "deepseek-chat"
  });
}

function callNvidia(bodyStr, opts) {
  opts = opts || {};
  if (!providers.nvidia.enabled || !providers.nvidia.apiKey) return Promise.resolve(null);
  stats.nvidiaCalls++;
  var primaryModel = opts.model || providers.nvidia.model || "deepseek-ai/deepseek-v3.1";
  // Internal fallback model is configurable so NIM accounts that don't
  // have access to gpt-oss-120b (or have a different "always-on" model)
  // can pick their own. Empty / null disables the fallback entirely.
  var fallbackModel = providers.nvidia.internalFallbackModel != null
    ? providers.nvidia.internalFallbackModel
    : "openai/gpt-oss-120b";
  var nimOpts = {
    name: "NVIDIA NIM",
    hostname: providers.nvidia.endpoint || "integrate.api.nvidia.com",
    path: "/v1/chat/completions",
    apiKey: providers.nvidia.apiKey,
    model: primaryModel,
    timeout: 30000
  };
  return callOpenAICompatible(bodyStr, nimOpts).then(function(r) {
    if (r && r.success) return r;
    if (fallbackModel && primaryModel !== fallbackModel) {
      console.log("[router] NIM primary (" + primaryModel + ") failed — trying internal fallback " + fallbackModel);
      nimOpts.model = fallbackModel;
      nimOpts.name = "NVIDIA NIM (" + fallbackModel + ")";
      nimOpts.timeout = 30000;
      return callOpenAICompatible(bodyStr, nimOpts);
    }
    return null;
  });
}

function callDeepInfra(bodyStr, opts) {
  opts = opts || {};
  if (!providers.deepinfra.enabled || !providers.deepinfra.apiKey) return Promise.resolve(null);
  stats.deepinfraCalls = (stats.deepinfraCalls || 0) + 1;
  return callOpenAICompatible(bodyStr, {
    name: "DeepInfra",
    hostname: providers.deepinfra.endpoint || "api.deepinfra.com",
    path: "/v1/openai/chat/completions",
    apiKey: providers.deepinfra.apiKey,
    model: opts.model || providers.deepinfra.model || "deepseek-ai/DeepSeek-V3-0324"
  });
}

function callOpenRouter(bodyStr, opts) {
  opts = opts || {};
  if (!providers.openrouter.enabled || !providers.openrouter.apiKey) return Promise.resolve(null);
  stats.openrouterCalls++;
  return callOpenAICompatible(bodyStr, {
    name: "OpenRouter",
    hostname: providers.openrouter.endpoint || "openrouter.ai",
    path: "/api/v1/chat/completions",
    apiKey: providers.openrouter.apiKey,
    model: opts.model || providers.openrouter.model || "deepseek/deepseek-chat"
  });
}

// Google AI Studio (Gemini API) — BYOK. Gemini's OpenAI-compatible
// endpoint lives at generativelanguage.googleapis.com/v1beta/openai/.
// Anthropic OAuth path is closed to third-parties (Feb 2026 ban); the
// only sanctioned route is a BYOK API key from aistudio.google.com.
// Auth header is Bearer <key>, identical shape to OpenAI-compatible.
function callGoogleAI(bodyStr) {
  if (!providers.google_ai.enabled || !providers.google_ai.apiKey) return Promise.resolve(null);
  stats.geminiCalls++;
  return callOpenAICompatible(bodyStr, {
    name: "Google AI Studio",
    hostname: providers.google_ai.endpoint || "generativelanguage.googleapis.com",
    path: "/v1beta/openai/chat/completions",
    apiKey: providers.google_ai.apiKey,
    model: providers.google_ai.model || "gemini-3-flash"
  });
}

// ── Anthropic API passthrough ──
// Forward request directly to Anthropic's API. Two modes:
// 1. API key mode: full modification allowed (request-side intelligence)
// 2. Subscription passthrough: body sent as-is (response-side intelligence only)
function callAnthropic(bodyStr, headers) {
  if (!providers.anthropic.enabled || !providers.anthropic.apiKey) return Promise.resolve(null);
  stats.anthropicCalls = (stats.anthropicCalls || 0) + 1;

  // Aux callers (compaction, MoA, Flash, architect) pass `model: "any"` as a
  // chain-level sentinel meaning "any working provider picks." OpenAI-shape
  // providers resolve it via providerOpts.model; Anthropic forwards the body
  // verbatim, so the sentinel reaches the API and 404s. Rewrite to a concrete
  // Anthropic default here so the sentinel keeps its chain-level meaning
  // without breaking Anthropic.
  var postData = bodyStr;
  try {
    var parsedBody = JSON.parse(bodyStr);
    var changed = false;
    if (parsedBody.model === 'any' || !parsedBody.model) {
      parsedBody.model = providers.anthropic.model || 'claude-haiku-4-5-20251001';
      changed = true;
    }
    // `think` is a Qwen/Ollama-shape opt-out used by callFlash to suppress
    // local-model thinking overhead. Anthropic uses `thinking: {type,...}`
    // and rejects the bare `think` key with 400 "Extra inputs are not
    // permitted". Strip before forwarding.
    if ('think' in parsedBody) {
      delete parsedBody.think;
      changed = true;
    }
    // Fallback-chain contract: resolve ONE complete JSON message so the proxy
    // can re-synthesize SSE for Claude Code itself. Forwarding stream:true makes
    // Anthropic reply with an SSE event-stream that the downstream JSON.parse
    // chokes on ("Unexpected token 'e', event:mess..."), the same fault that
    // broke kimi_sub. Force non-streaming here too (server.js also has a
    // passthrough safety net as a second line of defense).
    if (parsedBody.stream !== false) { parsedBody.stream = false; changed = true; }
    if (changed) postData = JSON.stringify(parsedBody);
  } catch (_) {}

  return new Promise(function(resolve) {
    var reqHeaders = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
      "x-api-key": providers.anthropic.apiKey,
      "anthropic-version": "2023-06-01"
    };

    // Forward beta headers if present
    if (headers && headers["anthropic-beta"]) {
      reqHeaders["anthropic-beta"] = headers["anthropic-beta"];
    }

    var req = https.request({
      hostname: providers.anthropic.endpoint || "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: reqHeaders,
      timeout: 300000
    }, function(res) {
      var body = "";
      res.on("data", function(chunk) { body += chunk; });
      res.on("end", function() {
        if (res.statusCode === 200) {
          // Track tokens for cost dashboard (same as all other providers)
          try {
            var parsed = JSON.parse(body);
            var usage = parsed.usage || {};
            stats.tokens.anthropic.input += usage.input_tokens || 0;
            stats.tokens.anthropic.output += usage.output_tokens || 0;
            var costMod2 = require('./cost');
            var modelName2 = parsed.model || 'claude-sonnet-4-20250514';
            var inT2  = usage.input_tokens || 0;
            var outT2 = usage.output_tokens || 0;
            var cachT2 = usage.cache_read_input_tokens || 0;
            costMod2.recordUsage(modelName2, inT2, outT2, cachT2);
            // Baseline comparison — for direct-to-Anthropic calls the
            // "actual" IS effectively the baseline; record both equal so
            // the row exists for completeness (savings = 0 here).
            try {
              // Same logic as the BYOK path above — baseline = what the
              // CLIENT asked for. On the Anthropic-direct path the actual
              // model and the requested model are usually identical (no
              // downgrade), so savings = 0 on this row, which is correct:
              // routing Anthropic-direct is the no-arbitrage case.
              var _bm2 = currentRequestedModel || baselineModel || modelName2;
              var actualC2   = costMod2.calculateCost(modelName2, inT2, outT2, cachT2);
              var baselineC2 = costMod2.calculateCost(_bm2, inT2, outT2, cachT2);
              var sharedState2 = require('../../shared-core/state.js');
              sharedState2.recordBaselineCost({
                actual_model: modelName2,
                actual_cost: actualC2.cost || 0,
                baseline_model: _bm2,
                baseline_cost: baselineC2.cost || 0,
                tokens_in: inT2, tokens_out: outT2, tokens_cached: cachT2
              });
              // P16.5 I2 — substrate cost_event mirror (Anthropic direct path).
              try {
                var sharedCost2 = require('../../shared-core/cost.js');
                sharedCost2.recordCostForActiveSession(sharedState2, 'proxy', {
                  input_tokens: inT2, output_tokens: outT2, cached_tokens: cachT2,
                  usd: actualC2.cost || 0, model: modelName2,
                  provider: 'anthropic', source: 'measured'
                });
              } catch (_) {}
            } catch (_) {}
            // P4.1: per-model cache hit/write/uncached ratio
            try { require('./cacheratio').record(modelName2, usage); } catch (_) {}
          } catch (e) {}
          console.log("[router] Anthropic API OK");
          resolve({ success: true, response: body });
        } else if (res.statusCode === 429) {
          try { require('./errortax').record(429, 'rate limited', 'anthropic'); } catch (_) {}
          console.log("[router] Anthropic API rate limited");
          resolve(null);
        } else {
          var anthMsg = body.slice(0, 200);
          try { var parsed = JSON.parse(body); if (parsed.error && parsed.error.message) anthMsg = parsed.error.message; } catch (_) {}
          try { require('./errortax').record(res.statusCode, anthMsg, 'anthropic'); } catch (_) {}
          console.error("[router] Anthropic API", res.statusCode, body.slice(0, 200));
          // 4xx != provider unhealthy — these are request errors (bad model
          // name, validation, auth). Returning a tagged failure so the chain
          // tries the next provider without penalising this one's cooldown.
          // 5xx falls through to plain null which triggers the cooldown.
          if (res.statusCode >= 400 && res.statusCode < 500) {
            resolve({ success: false, requestError: true, status: res.statusCode });
          } else {
            resolve(null);
          }
        }
      });
    });

    req.on("error", function(err) {
      console.error("[router] Anthropic API error:", err.message);
      resolve(null);
    });
    req.on("timeout", function() {
      console.error("[router] Anthropic API timeout");
      req.destroy();
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}

// ── OpenAI Responses API via ChatGPT subscription (OAuth) ─────────────
//
// Same callsite contract as callAnthropic: takes the Anthropic-shaped
// body string, returns Promise<{success, response}|{success:false,
// requestError}|null>. response is Anthropic-shaped (translated from
// the OpenAI Responses API payload via openai-translate.js) so the
// downstream proxy pipeline (cache, critic, codelens, cost) keeps
// working without per-provider branches.
//
// Auth: OAuth bearer from shared-core/codex-token-store.js. Refreshes
// once on isExpired or 401. Hard-fails if no saved token (operator runs
// the dashboard sign-in once).
function callOpenAISubscription(bodyStr, headers) {
  if (!providers.openai_sub.enabled) return Promise.resolve(null);
  var tokenStore = require('../../shared-core/codex-token-store.js');
  var codexAuth  = require('../../shared-core/codex-auth.js');
  var translate  = require('./openai-translate.js');

  return (async function () {
    // Resolve a usable token. Hard-fail (null + log) if no token saved
    // operator hasn't completed the OAuth flow yet.
    var tok = tokenStore.load();
    if (!tok) {
      console.error('[router] openai_sub: no token saved (run sign-in via dashboard /api/providers/codex/login)');
      return null;
    }
    if (tokenStore.isExpired(tok)) {
      try { tok = await codexAuth.refresh(tok); }
      catch (e) {
        console.error('[router] openai_sub: token refresh failed (' + (e && e.message || e) + ') — re-sign-in needed');
        try { require('./errortax').record(401, 'token_refresh_failed', 'openai_sub'); } catch (_) {}
        _fireAuthExpired('openai_sub', 'token refresh failed');
        return null;
      }
    }
    stats.openai_subCalls = (stats.openai_subCalls || 0) + 1;

    var anthropicBody;
    try { anthropicBody = JSON.parse(bodyStr); }
    catch (e) {
      console.error('[router] openai_sub: body parse failed:', e.message);
      return null;
    }
    // This lane does not go through shared-core's codex transport, so it
    // never inherited resolveCodexModel. A config poisoned before that seed
    // was removed still holds a *-codex model, and the endpoint answers 400
    // for every one of them; coercing here heals those installs without a
    // migration and costs nothing on a healthy one.
    var _codexModel;
    try { _codexModel = require('../../shared-core/transports/codex-oauth.js').resolveCodexModel(null, providers.openai_sub.model); }
    catch (_) { _codexModel = providers.openai_sub.model; }
    var responsesBody = translate.anthropicToResponses(anthropicBody, {
      defaultModel: _codexModel || 'gpt-5.6-sol'
    });
    // The codex /backend-api/codex/responses endpoint ONLY streams — it 400s
    // on stream:false ("Stream must be set to true"). Force SSE here and
    // reassemble the terminal response below; downstream stays non-streaming.
    responsesBody.stream = true;
    var postData = JSON.stringify(responsesBody);

    var crypto = require('crypto');
    var sessionId      = crypto.randomUUID();
    var conversationId = crypto.randomUUID();

    return new Promise(function (resolve) {
      var reqHeaders = {
        'content-type':       'application/json',
        'content-length':     Buffer.byteLength(postData),
        'authorization':      'Bearer ' + tok.access_token,
        'accept':             'text/event-stream',
        'openai-beta':        'responses=experimental',
        'session_id':         sessionId,
        'conversation_id':    conversationId
      };
      // Operator-supplied only; omitted when unset. Same rule as the client
      // id: naming the application to the vendor is the operator's call.
      var codexOriginator = codexAuth.originator();
      if (codexOriginator) reqHeaders['originator'] = codexOriginator;
      if (tok.account_id) reqHeaders['chatgpt-account-id'] = tok.account_id;

      var req = https.request({
        hostname: 'chatgpt.com',
        path:     '/backend-api/codex/responses',
        method:   'POST',
        headers:  reqHeaders,
        timeout:  300000
      }, function (res) {
        var body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
          if (res.statusCode === 200) {
            // Codex streams Server-Sent Events. The terminal
            // "response.completed" event carries the full response object
            // (output + usage) in the same shape the non-stream API returns;
            // reassemble it so responsesToAnthropic stays unchanged.
            // The assistant text arrives as response.output_text.delta events
            // (NOT in response.completed, whose.output is [] on this endpoint).
            // Accumulate the deltas; take usage + envelope from the completed
            // event, then graft the text in the shape responsesToAnthropic wants.
            var responsesPayload = null;
            try {
              var completed = null, deltaText = '', doneText = '';
              var functionCalls = [];
              var lines = body.split('\n');
              for (var li = 0; li < lines.length; li++) {
                var ln = lines[li];
                if (ln.indexOf('data:') !== 0) continue;
                var jsonStr = ln.slice(5).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;
                var evt;
                try { evt = JSON.parse(jsonStr); } catch (_) { continue; }
                if (!evt) continue;
                if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') deltaText += evt.delta;
                else if (evt.type === 'response.output_text.done' && typeof evt.text === 'string') doneText += evt.text;
                // Tool calls arrive as completed output items (type
                // function_call, carrying call_id/name/arguments). Collect them
                // so responsesToAnthropic can surface real tool_use blocks.
                else if (evt.type === 'response.output_item.done' && evt.item && evt.item.type === 'function_call') {
                  functionCalls.push(evt.item);
                }
                else if (evt.type === 'response.completed' && evt.response) completed = evt.response;
              }
              var finalText = deltaText || doneText;
              // Contract guard: response.completed is the terminal event and the
              // Responses API always sends it before closing. If the stream ended
              // WITHOUT it (connection dropped mid-stream), the accumulated text
              // is an unmarked partial — translating it would hand the caller a
              // truncated turn labeled success (no stop_reason, no signal).
              // Fail the attempt as a tagged request error instead: the chain
              // retries elsewhere, and (401/403-only cooldown rule) a one-off
              // network drop does not blacklist the lane.
              if (!completed) {
                console.error('[router] openai_sub: stream ended without response.completed — discarding partial (' + finalText.length + ' chars)');
                try { require('./errortax').record(502, 'stream ended without response.completed', 'openai_sub'); } catch (_) {}
                return resolve({ success: false, requestError: true, status: 502 });
              }
              responsesPayload = completed;
              // The completed event's.output is [] on this endpoint — rebuild
              // it from the streamed text + collected function_call items.
              var rebuilt = [];
              if (finalText) rebuilt.push({ type: 'message', content: [{ type: 'output_text', text: finalText }] });
              for (var fci = 0; fci < functionCalls.length; fci++) rebuilt.push(functionCalls[fci]);
              if (!Array.isArray(responsesPayload.output) || !responsesPayload.output.length) {
                responsesPayload.output = rebuilt.length ? rebuilt : [{ type: 'message', content: [{ type: 'output_text', text: '' }] }];
              }
            } catch (e) {
              // Per-request malformed frame, not provider health — resolve a
              // tagged request error so the chain moves on WITHOUT the
              // null-path cooldown blacklisting the lane for minutes.
              console.error('[router] openai_sub: SSE parse failed:', e.message);
              return resolve({ success: false, requestError: true, status: 422 });
            }
            // Translate back to Anthropic shape so downstream stays oblivious.
            var anthropicShaped;
            try {
              anthropicShaped = translate.responsesToAnthropic(responsesPayload, {
                modelHint: providers.openai_sub.model || 'gpt-5.5'
              });
            } catch (e) {
              // Same classification as the parse guard above: request-shaped
              // failure, not lane health — no cooldown.
              console.error('[router] openai_sub: response translation failed:', e.message);
              return resolve({ success: false, requestError: true, status: 422 });
            }
            // Token tracking — same shape as callAnthropic uses.
            try {
              var u = responsesPayload.usage || {};
              var inTsub  = u.input_tokens  || 0;
              var outTsub = u.output_tokens || 0;
              // Responses API reports prefix-cache hits here — was dropped, so the
              // codex/GPT-5.x subscription showed ZERO cache savings + overstated
              // cost in the dashboard even when OpenAI was caching the prefix.
              var cachTsub = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
              stats.tokens.openai_sub.input  += inTsub;
              stats.tokens.openai_sub.output += outTsub;
              var modelSub = _asModelName(providers.openai_sub.model, 'gpt-5.5');
              try { require('./cost').recordUsage(modelSub + ' (plan)', inTsub, outTsub, cachTsub); } catch (_) {}
              try { require('./cacheratio').record(modelSub, { input_tokens: Math.max(0, inTsub - cachTsub), cache_read_input_tokens: cachTsub, cache_creation_input_tokens: 0 }); } catch (_) {}
            } catch (_) {}
            console.log('[router] OpenAI subscription OK');
            resolve({ success: true, response: JSON.stringify(anthropicShaped) });
          } else if (res.statusCode === 401) {
            // Surface as auth-needed; operator re-signs-in via dashboard.
            try { require('./errortax').record(401, 'auth_expired', 'openai_sub'); } catch (_) {}
            _fireAuthExpired('openai_sub', '401 token rejected');
            console.error('[router] openai_sub: 401 — token rejected; re-sign-in via dashboard');
            resolve({ success: false, requestError: true, status: 401 });
          } else if (res.statusCode === 429) {
            try { require('./errortax').record(429, 'rate limited', 'openai_sub'); } catch (_) {}
            console.error('[router] openai_sub: 429 rate limited');
            resolve(null);
          } else {
            var msg = body.slice(0, 200);
            try { require('./errortax').record(res.statusCode, msg, 'openai_sub'); } catch (_) {}
            console.error('[router] openai_sub:', res.statusCode, msg);
            if (res.statusCode >= 400 && res.statusCode < 500) {
              resolve({ success: false, requestError: true, status: res.statusCode });
            } else {
              resolve(null);
            }
          }
        });
      });
      req.on('error', function (err) {
        console.error('[router] openai_sub error:', err.message);
        resolve(null);
      });
      req.on('timeout', function () {
        console.error('[router] openai_sub timeout');
        req.destroy();
        resolve(null);
      });
      req.write(postData);
      req.end();
    });
  })();
}

// Full fallback chain: NIM → DeepSeek → OpenRouter → Local
// Returns the first successful response string, or null if all fail.
// Track provider health — skip providers that failed recently
// Circuit breaker with adaptive cooldown.
// Single failure = 15s cooldown. Repeated failures = exponential backoff
// (15s → 30s → 60s → 120s → cap at 300s = 5min).
// Successful call resets the failure count.
var providerHealth = {};
var BASE_COOLDOWN_MS = 15000;
var MAX_COOLDOWN_MS = 300000; // 5 min cap

function getProviderCooldown(failureCount) {
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, failureCount - 1)));
}

function isProviderHealthy(name) {
  var h = providerHealth[name];
  if (!h) return true;
  var cooldown = getProviderCooldown(h.failureCount || 1);
  if (Date.now() - h.failedAt > cooldown) {
    // Cooldown expired — give the provider another chance, but keep failure count
    // for next backoff calculation if it fails again
    h.failedAt = 0;
    return true;
  }
  return false;
}

function markProviderFailed(name) {
  var existing = providerHealth[name];
  var failureCount = existing ? (existing.failureCount || 0) + 1 : 1;
  var cooldown = getProviderCooldown(failureCount);
  providerHealth[name] = { failedAt: Date.now(), failureCount: failureCount };
  console.log("[router] Provider " + name + " marked unhealthy for " + (cooldown/1000) + "s (failure #" + failureCount + ")");
}

function markProviderHealthy(name) {
  // Successful call — reset failure tracking
  if (providerHealth[name]) {
    delete providerHealth[name];
  }
}

// Local-backend reachability probe with a short cache. The proxy used to
// fall back to local (Ollama / LM Studio @ 127.0.0.1:11434) unconditionally
// whenever cloud providers failed. When the user has the local box offline
// (Tailscale closed, Ollama stopped, etc.) every fall-through cost a full
// CC API_TIMEOUT_MS hang — the user sees "Retrying in 0s" for 20 minutes.
// Probe is a 200ms TCP connect; result cached for 30s. Conservative: on
// any error we treat local as unavailable so the chain can return a clean
// error to CC instead of hanging.
var _localProbe = { ts: 0, ok: false, host: null, port: null };
function localTarget() {
  // Use whatever the user configured. NEVER substitute a default IP/port —
  // if the user hasn't enabled local, we have no business probing somewhere
  // arbitrary. Returns null when there's no target to probe.
  if (!providers.local || !providers.local.enabled) return null;
  if (!providers.local.host || !providers.local.port) return null;
  return { host: providers.local.host, port: providers.local.port };
}
function isLocalAvailable() {
  var t = localTarget();
  if (!t) return false;
  // Cache invalidates if user reconfigured host/port between probes.
  if (_localProbe.host === t.host && _localProbe.port === t.port &&
      Date.now() - _localProbe.ts < 30000) {
    return _localProbe.ok;
  }
  // Async probe — updates cache for the NEXT request. The current call
  // returns the previous cache value (or false on first call).
  try {
    var net = require('net');
    var sock = net.createConnection({ host: t.host, port: t.port, timeout: 200 });
    var settled = false;
    var settle = function (ok) {
      if (settled) return; settled = true;
      _localProbe = { ts: Date.now(), ok: ok, host: t.host, port: t.port };
      try { sock.destroy(); } catch (_) {}
    };
    sock.once('connect', function () { settle(true); });
    sock.once('error',   function () { settle(false); });
    sock.once('timeout', function () { settle(false); });
  } catch (e) {
    _localProbe = { ts: Date.now(), ok: false, host: t.host, port: t.port };
  }
  return _localProbe.ok;
}
// Synchronous variant for the very first probe at startup so the first
// request doesn't have to pay the async-probe race.
function probeLocalSync() {
  var t = localTarget();
  if (!t) {
    _localProbe = { ts: Date.now(), ok: false, host: null, port: null };
    return false;
  }
  try {
    var execFileSync = require('child_process').execFileSync;
    // Portable sync TCP probe: spawn OUR OWN node for a one-shot
    // net.createConnection (exit 0 = connected). The old `nc -z` probe is an
    // external binary that minimal Linux/Docker images don't ship — ENOENT
    // landed in the catch and marked a LIVE local backend UNREACHABLE at
    // every boot. process.execPath is
    // absolute, so this works even with an empty PATH.
    var probeSrc = "var s=require('net').createConnection({host:process.argv[1],port:+process.argv[2],timeout:1000});" +
      "s.once('connect',function(){process.exit(0)});" +
      "s.once('error',function(){process.exit(1)});" +
      "s.once('timeout',function(){process.exit(1)});";
    execFileSync(process.execPath, ['-e', probeSrc, t.host, String(t.port)], { stdio: 'ignore', timeout: 1500 });
    _localProbe = { ts: Date.now(), ok: true, host: t.host, port: t.port };
  } catch (e) {
    _localProbe = { ts: Date.now(), ok: false, host: t.host, port: t.port };
  }
  return _localProbe.ok;
}
// Run once at module load so the first incoming request has an answer.
try {
  probeLocalSync();
  var _target = localTarget();
  if (_target) {
    console.log('[router] Local backend ' + (_localProbe.ok ? 'reachable' : 'UNREACHABLE') + ' at ' + _target.host + ':' + _target.port);
  } else {
    console.log('[router] Local backend not configured — fallback chain will skip it');
  }
} catch (e) {}

// task-tier classifier. Loaded lazily so the proxy boots even if
// shared-core isn't on the path for some odd dev setup.
var _taskTier = null;
function taskTier() {
  if (_taskTier !== null) return _taskTier;
  try { _taskTier = require("../../shared-core/task-tier.js"); }
  catch (e) { _taskTier = false; }
  return _taskTier;
}

// Operator-facing engine names. Kept in sync with bin/troth-chat.js and the
// dashboard PROVIDER_LABELS so the failure message names the engine the
// operator recognizes ("ChatGPT subscription"), not the internal key.
var PIN_DISPLAY_NAMES = {
  openai_sub: "ChatGPT subscription",
  anthropic:  "Claude (Anthropic)",
  alibaba:    "Qwen (Alibaba)",
  zai:        "GLM (Z.ai)",
  moonshot:   "Kimi (Moonshot)",
  xai:        "Grok (xAI)",
  deepinfra:  "DeepInfra",
  deepseek:   "DeepSeek",
  openrouter: "OpenRouter",
  google_ai:  "Gemini (Google AI)",
  nvidia:     "NVIDIA NIM",
  local:      "Local model"
};
function pinDisplayName(name) { return PIN_DISPLAY_NAMES[name] || name; }

// Read the honest reason the pinned engine is not serving. A recently
// recorded HTTP failure is the STRONGEST signal and is consulted first: a
// 429 / 401 / 5xx proves the credential exists and names the true cause, so
// it outranks the "not linked" guess. Only when nothing is on the error
// record do we fall back to the credential/enable state. The mapping is kept
// deliberately small and truthful; if we cannot recognize the cause we say
// so rather than inventing one.
//   recent 429            -> plan rate limit (resets automatically)
//   401 / refresh failure -> sign-in expired, re-link in Settings
//   credit exhausted      -> balance exhausted
//   recent 5xx            -> engine unreachable (server error)
//   engine disabled       -> turned off in Settings
//   no token / no key     -> not linked
//   network cooldown      -> engine unreachable (network errors)
//   anything else on file -> "errored repeatedly (see proxy log)"
function detectPinReason(name) {
  var prov = providers[name] || {};
  // 1) Most recent classified error for this provider. errortax records
  // openai_sub / anthropic by provider name; OpenAI-compatible lanes record
  // by model string, so try both keys.
  var last = null;
  try {
    var et = require("./errortax");
    var stats2 = et.getStats();
    var candidates = [name];
    if (prov && prov.model) candidates.push(prov.model);
    var byClass = stats2.lastByClass || {};
    for (var cls in byClass) {
      var rec = byClass[cls];
      if (!rec) continue;
      if (candidates.indexOf(rec.model) === -1) continue;
      if (!last || (rec.at || 0) > (last.at || 0)) { last = rec; last._class = cls; }
    }
  } catch (_) {}
  if (last) {
    var status = last.status;
    var cls2 = last._class;
    if (status === 429 || cls2 === "rate_limit") {
      return "rate limited by the plan (limit resets automatically)";
    }
    if (status === 403 && /usage limit|quota|billing cycle/i.test(String(last.msg || last.message || ''))) {
      // A subscription that ran out of quota is NOT a broken sign-in. Telling
      // the operator to re-link sends them to fix something that is not
      // wrong; the honest instruction is to wait for the cycle or switch
      // engines.
      return "the plan's quota for this billing cycle is used up (it refreshes on renewal)";
    }
    if (status === 401 || status === 403 || cls2 === "auth_error") {
      return "the sign-in expired (re-link the engine in Settings)";
    }
    if (cls2 === "credit_insufficient") {
      return "the account balance is exhausted (top up or switch engines)";
    }
    if (status >= 500 || cls2 === "server_error" || cls2 === "overloaded") {
      return "the engine is unreachable right now (server error)";
    }
    return "the engine errored repeatedly (see proxy log)";
  }
  // 2) No error on record: fall back to the credential/enable state, which
  // is the likeliest cause when the engine never got far enough to error.
  if (name === "openai_sub") {
    if (!prov.enabled) return "the engine is turned off in Settings";
    var hasToken = false;
    try { hasToken = !!require("../../shared-core/codex-token-store.js").load(); } catch (_) {}
    if (!hasToken) return "not linked yet (sign in from Settings)";
  } else if (name !== "local") {
    if (!prov.enabled) return "the engine is turned off in Settings";
    if (!prov.apiKey) return "not linked (no API key in Settings)";
  }
  // 3) Credential looks fine and nothing on the error record: the provider
  // is in a network-failure cooldown (markProviderFailed with no HTTP status,
  // e.g. connection refused / timeout) or was excluded for an unclassified
  // reason. Be honest about the uncertainty.
  if (!isProviderHealthy(name)) {
    return "the engine is unreachable right now (recent network errors)";
  }
  return "the engine errored repeatedly (see proxy log)";
}

// Build the DISTINCT fail-fast body for a pinned-but-unavailable engine.
// Shaped like an Anthropic error so upstream CLIs surface it verbatim; the
// HTTP layer sends it as 400 (fatal to the CLI, no retry storm) instead of
// the generic 503 that triggered exponential-backoff silence. The message
// names the engine, the reason, and the way out.
// An empty chain has two very different causes and they deserve different
// sentences. Everything configured is rate-limited or down is one thing;
// nothing was ever configured is another, and only this layer can tell them
// apart, because by the time the answer reaches a surface both look like
// silence. This rides the same descriptor the pinned-engine failure uses, so
// proxy/server.js writes it with no new plumbing and the CLI renders it
// verbatim: the moment of failure is the only moment the operator is looking.
function buildNoEngineFailure() {
  var message =
    "No engine is configured, so nothing can answer. " +
    "Run `troth setup` to pick one and paste your key, or open the dashboard " +
    "and add a provider under Providers (a cloud key) or Settings (a local model).";
  return {
    set: true,
    provider: "none",
    reason: "no_engine_configured",
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: message } }
  };
}

function buildPinFailure(name) {
  var reason = detectPinReason(name);
  var message = "Pinned engine '" + pinDisplayName(name) + "' is unavailable right now: " +
    reason + ". No fallback because the engine is pinned. " +
    "Switch engines in Settings or wait for the limit window.";
  return {
    set: true,
    provider: name,
    reason: reason,
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: message } }
  };
}

// The chain the most recent request actually resolved to. The dashboard used
// to print a hard-coded display order (ChatGPT first, Kimi last, local always
// shown) which matched nothing the router does: order is cost/tier computed
// and unreachable lanes are dropped.
var _lastEffectiveChain = null;
function getEffectiveChain() { return _lastEffectiveChain; }

function callFallbackChain(bodyStr, cfcOpts) {
  // cfcOpts.wantMeta — opt-in richer return for in-process callers (the
  // entity's router transport): resolves { body, served_by: { provider,
  // model } } instead of the bare body string, so the surface can show
  // WHICH provider actually answered (the chain decides, not the caller).
  // Default shape is unchanged for every existing caller.
  cfcOpts = cfcOpts || {};
  function finish(providerName, respBody) {
    if (!cfcOpts.wantMeta) return respBody;
    var servedModel = null;
    try { servedModel = JSON.parse(respBody).model || null; } catch (_) {}
    return {
      body: respBody,
      served_by: {
        provider: providerName,
        model: servedModel,
        // Host is part of the truth for local — "on this Mac" vs a
        // remote box over the LAN/VPN is a real difference to the user.
        host: providerName === "local" ? (providers.local.host || null) : null
      }
    };
  }
  // Live attempt signal — fired the moment the chain starts a provider so
  // surfaces can show "who is working" DURING the turn (the served meta
  // above only exists after the answer). process-level event: the entity
  // requires this module in-process and listens; in the standalone proxy
  // process nobody listens and the emit is a no-op.
  function announceAttempt(providerName) {
    try {
      process.emit("troth:router:attempt", {
        provider: providerName,
        model: providerName === "local"
          ? (providers.local.model || null)
          : ((providers[providerName] || {}).model || null),
        host: providerName === "local" ? (providers.local.host || null) : null
      });
    } catch (_) { /* never let telemetry break a turn */ }
  }
  // Build ordered list of healthy providers.
  //
  // reorder based on task complexity.
  //   simple  → local backend (llama-server / Ollama) first, then fall back
  //   medium  → free quota first (Alibaba), then BYOK, then local
  //   hard    → BYOK paid directly, skip local entirely
  // If tier classifier isn't available, fall back to the legacy order.
  var tier = 'medium';
  var tierReasons = [];
  var tt = taskTier();
  if (tt) {
    try {
      var parsed = JSON.parse(bodyStr);
      var cls = tt.classify(parsed);
      tier = cls.tier;
      tierReasons = cls.reasons;
    } catch (e) { /* default to medium */ }
  }

  var chain = [];
  // Anthropic included so "only Claude enabled" proxy-mode works end-to-end.
  // Placed last — if the user has free/cheap providers enabled, they go first.
  var byokProviders = [
    { name: "alibaba", fn: callAlibaba },
    { name: "zai", fn: callZai },
    { name: "deepinfra", fn: callDeepInfra },
    { name: "nvidia", fn: callNvidia },
    { name: "deepseek", fn: callDeepSeek },
    { name: "openrouter", fn: callOpenRouter },
    { name: "google_ai", fn: callGoogleAI },
    { name: "xai", fn: callXai },
    { name: "moonshot", fn: callMoonshot },
    { name: "kimi_sub", fn: callKimiSub },
    { name: "custom_openai", fn: callCustomOpenai },
    { name: "anthropic", fn: function(b) { return callAnthropic(b, {}); } },
    // openai_sub uses OAuth token instead of apiKey — availability check
    // below has its own branch.
    { name: "openai_sub", fn: function(b) { return callOpenAISubscription(b, {}); } },
  ];
  function activeByok() {
    var out = [];
    for (var ci = 0; ci < byokProviders.length; ci++) {
      var entry = byokProviders[ci];
      var prov = providers[entry.name];
      if (!prov || !prov.enabled) continue;
      if (!isProviderHealthy(entry.name)) continue;
      // openai_sub auth = OAuth token presence, not apiKey field.
      if (entry.name === 'openai_sub') {
        try {
          var ts = require('../../shared-core/codex-token-store.js');
          if (!ts.load()) continue;
        } catch (_) { continue; }
        out.push(entry);
        continue;
      }
      // Custom (OpenAI-compatible) is key-OPTIONAL: many self-hosted targets
      // (vLLM/LiteLLM without an auth layer) accept no key. Usable = enabled
      // (checked above) AND base_url present. Do NOT require apiKey here.
      if (entry.name === 'custom_openai') {
        if (prov.base_url) out.push(entry);
        continue;
      }
      if (prov.apiKey) out.push(entry);
    }
    return out;
  }
  function localEntry() {
    if (providers.local.enabled && providers.local.host && isProviderHealthy("local")) {
      return { name: "local", fn: null };
    }
    return null;
  }
  var loc = localEntry();
  var byok = activeByok();

  // Lead engine honors the user's dispatch_prefer pill (was ignored before):
  //   'local'  ("This Mac first")     → local leads simple + medium, cloud for hard
  //   'hosted' ("Best quality first") → cloud frontier leads every tier, local backup
  // HARD always leads with the cloud frontier in BOTH modes — local 7B/35B-class
  // models aren't ideal for architectural/security/long-horizon work — degrading
  // to local only if BYOK is empty (cooldown / none configured) beats a 502.
  var preferLocal = routingPrefs.dispatch_prefer !== 'hosted';
  // The byokProviders array is COST-ordered (cheap lanes first) — right
  // for the local-first economy mode's backups, WRONG as a lead order.
  // 'Best quality first' must mean exactly that, and the hard tier leads
  // with the frontier in BOTH modes (the comment above always promised
  // it; the code never reordered — deepseek outranked the operator's GPT
  // subscription on every turn, operator-reported).
  // custom_openai ranks AFTER all named clouds: its quality is unknown (any
  // OpenAI-compatible target the operator points at), so best-first prefers a
  // known frontier and falls to the custom lane last among BYOK.
  var QUALITY_RANK = { openai_sub: 0, anthropic: 1, openrouter: 2, google_ai: 3, xai: 4, moonshot: 5, deepseek: 6, nvidia: 7, deepinfra: 8, zai: 9, alibaba: 10, custom_openai: 11 };
  function qualityFirst(list) {
    return list.slice().sort(function (a, b) {
      return (QUALITY_RANK[a.name] != null ? QUALITY_RANK[a.name] : 99) -
             (QUALITY_RANK[b.name] != null ? QUALITY_RANK[b.name] : 99);
    });
  }
  if (tier === 'hard') {
    chain = qualityFirst(byok);
    if (!chain.length && loc) chain.push(loc);
  } else if (preferLocal && loc) {
    // simple + medium: local leads (private, free, fast — trivial chat never
    // leaves the machine), cloud as backup in the cheap-first order.
    chain = [loc].concat(byok);
  } else {
    // 'hosted' ("Best quality first"): the cloud frontier leads every tier and
    // local rides LAST as a backup. A user with a strong local box still gets
    // it used when every cloud lane is down, but never ahead of the frontier
    // best-first means cloud first and local LAST, not local removed.
    // The real cause of "best-first still ran local" was config-side:
    // dispatch_prefer was 'local', which put local FIRST via the branch above.
    // That is corrected in config, not by dropping local from the chain here.
    chain = qualityFirst(byok);
    if (loc) chain.push(loc);
  }

  // Operator pin — "always use X" (config.routing.pin, set by the app's
  // Auto / One-model control). When the pinned provider is usable the
  // chain is EXACTLY [pinned]: no silent fallback to other engines — the
  // user said always, and errors surfacing visibly beats answering from
  // an engine they excluded.: the same rule
  // now holds when the pinned provider is NOT usable (disabled / key
  // removed / health cooldown). The old behavior fell back to the auto
  // chain "rather than failing every turn" — which meant a cooldown on
  // the pinned lane silently answered from an engine the operator
  // excluded (pinned ChatGPT, Qwen answered). Pinned-but-unusable now
  // serves an EMPTY chain: the turn fails visibly and names the pin.
  // Model-addressed Kimi membership: a request whose model IS a Kimi id
  // (k3, k3[1m], kimi-for-coding…) can only be answered by the kimi_sub
  // lane, so route it there WITHOUT needing the global routing pin. The pin
  // is one global slot — two panes on two engines would race it — but the
  // model id travels inside each request. Before this, the app's panes went
  // DIRECT to api.kimi.com and skipped every saving the proxy exists for;
  // the operator measured 63-67% of a weekly Kimi quota vanishing in
  // minutes on the direct lane while the proxied CLI felt free
  //. Takes precedence over the pin: the model id is the more
  // specific instruction, and a kimi-model request served by a non-kimi pin
  // would be answering with the wrong engine.
  var kimiLaneForced = false;
  var reqModelForLane = '';
  try { reqModelForLane = String((JSON.parse(bodyStr) || {}).model || ''); } catch (_) {}
  if (/^(k3(\[1m\])?$|kimi[-.])/i.test(reqModelForLane)
      && providers.kimi_sub && providers.kimi_sub.enabled && providers.kimi_sub.apiKey
      && isProviderHealthy('kimi_sub')) {
    chain = [{ name: 'kimi_sub', fn: callKimiSub }];
    kimiLaneForced = true;
    console.log('[router] model "' + reqModelForLane + '" → kimi_sub lane (model-addressed, no pin needed)');
  }
  var pinApplied = false;
  if (kimiLaneForced) {
    pinApplied = true; // suppress the tier/dispatcher reorders below — the lane is decided
  } else if (routingPrefs.pin) {
    var pinnedEntry = null;
    // The pin may arrive as the provider name ("local") or as the faculty name
    // the engine-override writes ("llamacpp", "ollama"). Matching only "local"
    // sends a faculty pin into the byok scan, which holds no local entry, and
    // the chain fails closed with a 400 while the provider is healthy.
    if (LOCAL_FACULTIES.indexOf(routingPrefs.pin) !== -1) {
      pinnedEntry = loc;
    } else {
      for (var pni = 0; pni < byok.length; pni++) {
        if (byok[pni].name === routingPrefs.pin) { pinnedEntry = byok[pni]; break; }
      }
    }
    if (pinnedEntry) {
      chain = [pinnedEntry];
      pinApplied = true;
      console.log("[router] pin → " + routingPrefs.pin + " (chain of one)");
    } else {
      chain = [];
      pinApplied = true;
      // The pinned engine cannot serve. Record the DISTINCT fail-fast
      // descriptor into the caller-supplied out-param so the HTTP layer can
      // return a 400 that names the pin + reason, instead of the generic 503
      // that made upstream CLIs retry into ~2 minutes of silence. We still
      // resolve null below so every existing caller (compaction / judge /
      // architect / the entity transport's _exhausted path) is unchanged.
      if (cfcOpts && typeof cfcOpts === "object") {
        try { cfcOpts.pinFailure = buildPinFailure(routingPrefs.pin); } catch (_) {}
      }
      console.log("[router] pin '" + routingPrefs.pin + "' not usable (disabled / no key / cooldown) - failing closed, no auto fallback: the operator said always");
    }
  }

  // dispatcher — substrate-signal preempts tier order.
  // PINNED dream: substrate decides which faculty handles this turn.
  // When substrate state carries explicit signal (project preferred_faculty,
  // explicit transport_hint on the action, decode constraints, intent tag),
  // that signal moves the matching provider to the front of the chain. With
  // no substrate signal, dispatch returns a priority-default we ignore — the
  // tier logic above stays the only decision-maker. This is the seam where
  // the substrate dispatcher drives production routing instead of living only
  // in bin/troth-entity.js.
  var dispatchPick = null;
  try {
    var dispatchMod = require('../../shared-core/dispatch.js');
    var available = ['router'];
    if (providers.anthropic.enabled && providers.anthropic.apiKey) available.push('anthropic');
    if (providers.local.enabled && providers.local.host && providers.local.port) {
      available.push('llamacpp', 'ollama');
    }
    var actionForDispatch = {};
    try {
      var parsedForDispatch = JSON.parse(bodyStr);
      actionForDispatch = {
        options: parsedForDispatch.options || {},
        decode_constraints: parsedForDispatch.decode_constraints
      };
    } catch (_) {}
    var view = {};
    try {
      var stateMod = require('../../shared-core/state.js');
      var mindStateMod = require('../../shared-core/mind-state.js');
      var mind = mindStateMod.recomputeFromSubstrate(stateMod, { cwd: process.cwd() });
      if (mind) view = { mind: mind };
    } catch (_) {}
    var dispatcher = dispatchMod.makeDispatcher({ available: available });
    var picked = dispatcher.pick(actionForDispatch, view);
    // Honor only substrate-driven rules — priority_default and first_available
    // mean "no signal", which is the tier logic's territory.
    if (picked && picked._rule !== 'priority_default' && picked._rule !== 'first_available') {
      dispatchPick = picked;
    }
  } catch (_) {}
  if (dispatchPick && pinApplied) {
    // Substrate signal noted but the operator pin outranks it — the user
    // explicitly excluded other engines.
    dispatchPick = null;
  }
  if (dispatchPick) {
    var preferName = null;
    if (dispatchPick.faculty === 'anthropic') preferName = 'anthropic';
    else if (LOCAL_FACULTIES.indexOf(dispatchPick.faculty) !== -1) preferName = 'local';
    if (preferName) {
      var preferIdx = chain.findIndex(function(c) { return c.name === preferName; });
      if (preferIdx > 0) {
        var preferred = chain.splice(preferIdx, 1)[0];
        chain.unshift(preferred);
      } else if (preferIdx === -1 && preferName === 'local' && loc) {
        chain.unshift(loc);
      }
      console.log("[router] dispatch.pick → " + dispatchPick.faculty +
        " (rule: " + dispatchPick._rule + ") — moved " + preferName + " to chain head");
    }
  }

  var names = chain.map(function(c) { return c.name; });
  console.log("[router] tier=" + tier + (tierReasons.length ? " (" + tierReasons[0] + ")" : "") +
    " · chain: " + (names.length ? names.join(" → ") : "NONE — all providers down"));
  stats.tierCounts = stats.tierCounts || { simple: 0, medium: 0, hard: 0 };
  stats.tierCounts[tier] = (stats.tierCounts[tier] || 0) + 1;
  if (!chain.length) {
    // Distinguish "nothing configured" from "everything exhausted": if not one
    // provider is enabled, the operator has not finished setting up, and a
    // silent null tells them nothing at all.
    try {
      var _anyConfigured = !!(providers && Object.keys(providers).some(function (k) {
        var pv = providers[k];
        return pv && pv.enabled;
      }));
      if (!_anyConfigured && cfcOpts && typeof cfcOpts === "object" && !(cfcOpts.pinFailure && cfcOpts.pinFailure.set)) {
        cfcOpts.pinFailure = buildNoEngineFailure();
      }
    } catch (_) { /* diagnosis is best-effort; the null below still stands */ }
    return Promise.resolve(null);
  }

  var idx = 0;
  function tryNext() {
    if (idx >= chain.length) return Promise.resolve(null);
    var provider = chain[idx++];

    if (provider.name === "local") {
      console.log("[router] Trying local model");
      stats.localCalls++;
      announceAttempt("local");
      return forwardToLocal(null, bodyStr, providers.local.host, providers.local.port || 1234, { model: providers.local.model }).then(function(lr) {
        if (lr && lr.body) {
          markProviderHealthy("local");
          // Wire per-provider token counter for the fallback-chain local
          // path (server.js:1893 only covers the legacy direct-local path).
          // Real Claude Code traffic flows through here, so without this
          // routerStats().tokens.local stays at {0,0} regardless of load.
          // forwardToLocal already translates response to Anthropic shape
          // when sentinel was set, so input_tokens/output_tokens are the
          // canonical keys; OpenAI-shape fallback covers raw passthrough.
          try {
            var u = JSON.parse(lr.body).usage || {};
            var inT  = (typeof u.input_tokens  === "number") ? u.input_tokens  : (u.prompt_tokens     || 0);
            var outT = (typeof u.output_tokens === "number") ? u.output_tokens : (u.completion_tokens || 0);
            stats.tokens.local.input  = (stats.tokens.local.input  || 0) + inT;
            stats.tokens.local.output = (stats.tokens.local.output || 0) + outT;
          } catch (_) {}
          return finish("local", lr.body);
        }
        markProviderFailed("local");
        return tryNext();
      }).catch(function() { markProviderFailed("local"); return tryNext(); });
    }

    announceAttempt(provider.name);
    return provider.fn(bodyStr).then(function(r) {
      if (r && r.success) { markProviderHealthy(provider.name); return finish(provider.name, r.response); }
      if (typeof r === "string") { markProviderHealthy(provider.name); return finish(provider.name, r); }
      // 4xx request-errors don't mean the provider is unhealthy — bad model
      // name / validation all live here. Skip the cooldown so a single bad
      // request doesn't take the only provider offline 60+s. EXCEPTION:
      // 401/403 auth failures ARE structural — an invalid key can't heal
      // between requests, and without a cooldown the dead provider re-fires
      // on EVERY turn (observed: deepseek 401 invalid key +
      // openrouter 401 on each app request while kimi was down, so a silent
      // fallback answered instead). Cool it down; a providers reload with a
      // fresh key clears providerHealth and re-admits it.
      if (r && r.requestError) {
        if (r.status === 401 || r.status === 403) markProviderFailed(provider.name);
        return tryNext();
      }
      markProviderFailed(provider.name);
      return tryNext();
    }).catch(function() { markProviderFailed(provider.name); return tryNext(); });
  }
  // When a pin is applied and the pinned engine WAS in the chain but its call
  // failed (429 plan cap / 401 sign-in / network), tryNext resolves null just
  // like the empty-chain case. Attach the same distinct fail-fast descriptor
  // (with the now-fresh errortax reason recorded by the failed call) so the
  // HTTP layer returns the 400 instead of the generic 503, and never falls
  // through to other engines. Still resolves null to preserve all callers.
  try {
    if (!pinApplied && Array.isArray(routingPrefs.order) && routingPrefs.order.length && chain.length > 1) {
      var wanted = [];
      for (var oi = 0; oi < routingPrefs.order.length; oi++) {
        for (var cj = 0; cj < chain.length; cj++) {
          if (chain[cj].name === routingPrefs.order[oi] && wanted.indexOf(chain[cj]) === -1) wanted.push(chain[cj]);
        }
      }
      for (var ck3 = 0; ck3 < chain.length; ck3++) if (wanted.indexOf(chain[ck3]) === -1) wanted.push(chain[ck3]);
      if (wanted.length === chain.length) {
        chain = wanted;
        console.log('[router] operator order applied: ' + chain.map(function (c) { return c.name; }).join(' \u2192 '));
      }
    }
  } catch (_) {}
  try { _lastEffectiveChain = chain.map(function (c) { return c.name; }); } catch (_) {}
  return Promise.resolve(tryNext()).then(function (result) {
    if (result == null && pinApplied && cfcOpts && typeof cfcOpts === "object" && !(cfcOpts.pinFailure && cfcOpts.pinFailure.set)) {
      // Name the lane that actually failed. The model-addressed kimi lane sets
      // pinApplied WITHOUT a routing pin, so this used to render "Pinned
      // engine '' is unavailable" — an empty name and a wrong instruction
      // ("switch engines in Settings") for what is really a Kimi quota 403.
      try { cfcOpts.pinFailure = buildPinFailure(kimiLaneForced ? 'kimi_sub' : routingPrefs.pin); } catch (_) {}
    }
    return result;
  });
}

function forwardToLocal(req, body, bHost, bPort, opts2) {
  stats.localCalls++;
  opts2 = opts2 || {};
  // Override model in body if configured. NOTE: do NOT force think:false here.
  // This is the PRIMARY path (agent's main turn) — Qwen3.6's 73.4% SWE-bench
  // result assumes thinking ON. We disable thinking only in auxiliary paths
  // (callFlash, critic) where we just want fast yes/no judgments.
  var anthropicSentinel = false;
  if (opts2.model) {
    try {
      var parsed = JSON.parse(body);
      parsed.model = opts2.model;
      anthropicSentinel = !!(parsed.system || (Array.isArray(parsed.messages)
        && parsed.messages.some(function(m) { return m && Array.isArray(m.content); })));
      body = JSON.stringify(parsed);
    } catch (e) {}
  } else {
    try {
      var probe0 = JSON.parse(body);
      anthropicSentinel = !!(probe0.system || (Array.isArray(probe0.messages)
        && probe0.messages.some(function(m) { return m && Array.isArray(m.content); })));
    } catch (_) {}
  }

  // Universal local-backend path: always translate Anthropic body →
  // OpenAI shape and POST to /v1/chat/completions, then translate the
  // response back. Works for Ollama, LM Studio, vLLM, llama-server, Jan,
  // Mistral.rs — ANY OpenAI-compatible backend. The Anthropic sentinel
  // tracks whether to translate the response back to Anthropic shape
  // (it always is when the inbound body was Anthropic — Claude Code's
  // shape — so the agent gets {input_tokens,output_tokens,content[]}
  // not {prompt_tokens,completion_tokens,choices[]}).
  var sendBody = body;
  if (anthropicSentinel) {
    try {
      var converter = require("./converter");
      // anthropicToOpenAI returns a plain object (not a JSON string) —
      // re-stringify before sending or http.request gets [object Object].
      // openAIToAnthropic in the response path already returns a string,
      // so this asymmetry is converter-side, fixed at the call site.
      var openaiObj = converter.anthropicToOpenAI(body, { model: opts2.model });
      if (openaiObj && typeof openaiObj === "object") {
        // KV PREFIX REUSE on the local backend. Without this, a local
        // llama-server re-prefills the entire ~9.6K-token system+tools prefix
        // from scratch EVERY turn (seconds of wasted prefill). cache_prompt:true
        // tells llama-server to reuse the cached KV prefix. This is the proxy's
        // local path — only the local backend sees it; OpenAI-only backends that
        // ever sit here ignore unknown fields. (The native entity transport
        // already sets this; the proxied-local path was missing it.)
        openaiObj.cache_prompt = true;
        sendBody = JSON.stringify(openaiObj);
      } else if (typeof openaiObj === "string") {
        sendBody = openaiObj;
      }
    } catch (_) {}
  }

  return new Promise(function(resolve, reject) {
    var baseHeaders = (req && req.headers) ? req.headers : { "content-type": "application/json" };
    var headers = Object.assign({}, baseHeaders, { host: bHost + ":" + bPort, "content-length": Buffer.byteLength(sendBody) });
    delete headers["transfer-encoding"];
    if (opts2.apiKey) headers["authorization"] = "Bearer " + opts2.apiKey;

    // Always go through /v1/chat/completions — universal across every
    // OpenAI-compatible backend. (We previously sniffed body shape and
    // routed Anthropic-shape to Ollama's /v1/messages?beta=true, but that
    // route only exists on Ollama 0.4+ and broke every other backend.)
    var reqPath = "/v1/chat/completions";
    var reqMethod = (req && req.method) ? req.method : "POST";
    var opts = { hostname: bHost, port: bPort, path: reqPath, method: reqMethod, headers: headers, timeout: 600000 };
    var p = http.request(opts, function(r) {
      var c = [];
      r.on("data", function(d) { c.push(d); });
      r.on("end", function() {
        var bodyStr = Buffer.concat(c).toString();
        // Translate response back to Anthropic shape if the inbound body
        // was Anthropic. The agent (Claude Code) parses input_tokens /
        // output_tokens / content[] — without this conversion it sees
        // OpenAI's {prompt_tokens, completion_tokens, choices[]} and
        // breaks usage tracking + auto-compaction.
        if (r.statusCode >= 200 && r.statusCode < 300 && anthropicSentinel) {
          try {
            var converter = require("./converter");
            var convertedStr = converter.openAIToAnthropic(bodyStr, opts2.model || "");
            if (convertedStr) bodyStr = convertedStr;
          } catch (_) {}
        }
        resolve({ statusCode: r.statusCode, headers: r.headers, body: bodyStr });
      });
    });
    p.on("error", reject);
    p.on("timeout", function() { p.destroy(); reject(new Error("timeout")); });
    p.write(sendBody);
    p.end();
  });
}

loadProviders();

// Mixture-of-Agents Lite (research [MoA] +7.6% AlpacaEval) — 2-stage refinement.
// For high-stakes Writes: get response from primary, then ask a different
// provider to REFINE (not just review). Picks best chunks of both.
// Optional, opt-in via config.moaLite=true. Doubles cost when enabled.
function moaRefine(originalBody, primaryResponse, depth) {
  depth = depth || 0;
  if (depth >= 1) return Promise.resolve(primaryResponse); // single refinement only
  try {
    var primary = JSON.parse(primaryResponse);
    if (!primary.content || !Array.isArray(primary.content)) return Promise.resolve(primaryResponse);
    // Extract primary's text
    var primaryText = primary.content.filter(function(b) { return b.type === 'text' && b.text; }).map(function(b) { return b.text; }).join('\n');
    if (!primaryText || primaryText.length < 200) return Promise.resolve(primaryResponse);

    // Build refinement prompt
    var refinePrompt = "You are an aggregator agent (MoA pattern). Below is one model's response to the user's task. " +
      "Improve it: catch errors, fill gaps, sharpen reasoning. Keep what's good. Output the IMPROVED final response only.\n\n" +
      "===PRIMARY RESPONSE===\n" + primaryText.slice(0, 8000) + "\n===END===";

    var refineBody = JSON.stringify({
      model: "any", max_tokens: 2000, stream: false,
      messages: [{ role: "user", content: refinePrompt }]
    });
    return callFallbackChain(refineBody).then(function(refined) {
      if (!refined) return primaryResponse;
      try {
        var refinedParsed = JSON.parse(refined);
        var refinedText = (refinedParsed.content || []).filter(function(b) { return b.type === 'text' && b.text; }).map(function(b) { return b.text; }).join('\n');
        if (!refinedText || refinedText.length < 100) return primaryResponse;
        // Replace primary's text content with refined version (preserve tool_use blocks)
        var newContent = [];
        var textReplaced = false;
        for (var i = 0; i < primary.content.length; i++) {
          if (primary.content[i].type === 'text' && !textReplaced) {
            newContent.push({ type: 'text', text: refinedText });
            textReplaced = true;
          } else if (primary.content[i].type !== 'text') {
            newContent.push(primary.content[i]);
          }
        }
        primary.content = newContent;
        return JSON.stringify(primary);
      } catch (e) { return primaryResponse; }
    }).catch(function() { return primaryResponse; });
  } catch (e) { return Promise.resolve(primaryResponse); }
}

// Aider infinite-output prefilling — bypass max_tokens cap by chaining.
// If response stopped due to max_tokens, take the partial output, append a
// continuation message ("continue exactly where you left off"), and re-call.
// Concatenate the new chunk to the original. Repeat up to 3x.
function continueIfTruncated(originalBodyStr, responseStr, depth) {
  depth = depth || 0;
  if (depth >= 3) return Promise.resolve(responseStr);
  try {
    var parsed = JSON.parse(responseStr);
    var stopReason = parsed.stop_reason;
    if (stopReason !== 'max_tokens') return Promise.resolve(responseStr);

    // Extract the partial text content
    var partialText = '';
    if (Array.isArray(parsed.content)) {
      for (var i = 0; i < parsed.content.length; i++) {
        if (parsed.content[i].type === 'text' && parsed.content[i].text) {
          partialText += parsed.content[i].text;
        }
      }
    }
    if (!partialText || partialText.length < 100) return Promise.resolve(responseStr);

    // B7: if the truncated response ends with a tool_use block, the tool's
    // input JSON is incomplete and a text-only continuation can't safely
    // merge with it (we'd produce a malformed conversation: text appended
    // after an unfinished tool_use). Skip continuation; return as-is so
    // the agent sees stop_reason=max_tokens on a tool_use turn and the
    // upstream caller decides how to handle (typically retry with bigger
    // budget).
    var lastBlock = parsed.content[parsed.content.length - 1];
    if (lastBlock && lastBlock.type === 'tool_use') {
      console.log('[router] CONTINUATION skipped — last block is tool_use (would corrupt tool args)');
      return Promise.resolve(responseStr);
    }

    // Build continuation request
    var origBody = JSON.parse(originalBodyStr);
    var contMessages = (origBody.messages || []).slice();
    contMessages.push({ role: 'assistant', content: partialText });
    contMessages.push({ role: 'user', content: 'Continue exactly where you left off. Do not repeat any text.' });
    var contBody = JSON.stringify(Object.assign({}, origBody, { messages: contMessages }));

    console.log('[router] CONTINUATION #' + (depth + 1) + ' — output was truncated at max_tokens');
    return callFallbackChain(contBody).then(function(contResp) {
      if (!contResp) return responseStr;
      try {
        var contParsed = JSON.parse(contResp);
        var contText = '';
        if (Array.isArray(contParsed.content)) {
          for (var j = 0; j < contParsed.content.length; j++) {
            if (contParsed.content[j].type === 'text' && contParsed.content[j].text) {
              contText += contParsed.content[j].text;
            }
          }
        }
        if (!contText) return responseStr;
        // Merge into original response
        if (Array.isArray(parsed.content)) {
          var lastTextIdx = -1;
          for (var k = parsed.content.length - 1; k >= 0; k--) {
            if (parsed.content[k].type === 'text') { lastTextIdx = k; break; }
          }
          if (lastTextIdx >= 0) {
            parsed.content[lastTextIdx].text += contText;
          } else {
            parsed.content.push({ type: 'text', text: contText });
          }
        }
        parsed.stop_reason = contParsed.stop_reason || 'end_turn';
        if (parsed.usage && contParsed.usage) {
          parsed.usage.output_tokens = (parsed.usage.output_tokens || 0) + (contParsed.usage.output_tokens || 0);
        }
        var merged = JSON.stringify(parsed);
        // Recurse if still truncated
        return continueIfTruncated(originalBodyStr, merged, depth + 1);
      } catch (e) { return responseStr; }
    });
  } catch (e) { return Promise.resolve(responseStr); }
}

function detectTier() {
  if (providers.anthropic.enabled && providers.anthropic.apiKey) return "byok";
  if (providers.alibaba.enabled && providers.alibaba.apiKey) return "pro";
  if (providers.deepinfra.enabled && providers.deepinfra.apiKey) return "economy";
  return "free";
}

function getStats() {
  // local_backend: the dashboard used to show the Local row as "ready"
  // purely because the provider was enabled in config, while the router
  // was logging "Local backend not configured" — two surfaces, two truths.
  // Expose what the router actually knows so the UI can say it plainly.
  var lb = { configured: false, reachable: false, host: null, port: null };
  try {
    var lt = localTarget();
    if (lt) {
      lb.configured = true; lb.host = lt.host; lb.port = lt.port;
      lb.reachable = !!(_localProbe && _localProbe.ok);
    }
  } catch (_) {}
  return Object.assign({}, stats, { tier: detectTier(), local_backend: lb });
}

// ────────────────────────────────────────────────────────────────────
// Vision analysis (disabled — no Gemini accounts)
// ────────────────────────────────────────────────────────────────────

// Utility: call a fast model with a text prompt. Returns response text or null.
// Uses the same fallback chain as main requests — picks up any enabled provider.
function callFlash(prompt) {
  stats.flashCalls++;
  // Auxiliary path: fast yes/no review, summarize, classify. No deep
  // reasoning needed. Disable Qwen-style `think` when the backend is
  // thinking-capable (Ollama / Qwen3.6) — measured 8× overhead on
  // trivial judgment calls. Primary coder still runs with default
  // thinking behaviour; see forwardToLocal.
  var fallbackBody = JSON.stringify({
    model: "any", max_tokens: 2000, stream: false, think: false,
    messages: [{ role: "user", content: prompt }]
  });
  return callFallbackChain(fallbackBody).then(function(responseStr) {
    if (!responseStr) return null;
    return extractText(responseStr);
  }).catch(function() { return null; });
}

function extractText(responseStr) {
  try {
    var data = JSON.parse(responseStr);
    // Anthropic format
    var text = (data.content || []).filter(function(b) { return b.type === "text"; }).map(function(b) { return b.text; }).join("").trim();
    if (text) return text;
    // OpenAI format
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content || null;
    }
    return null;
  } catch (e) {
    if (typeof responseStr === "string" && responseStr.length > 10) return responseStr;
    return null;
  }
}

function analyzeImage(imagePath, prompt) {
  // Vision analysis via Anthropic API (Claude has native vision support).
  // Falls back to null if no Anthropic BYOK key or image unreadable.
  if (!providers.anthropic.enabled || !providers.anthropic.apiKey) return Promise.resolve(null);
  try {
    var imageData = fs.readFileSync(imagePath);
    var ext = (imagePath || '').split('.').pop().toLowerCase();
    var mediaType = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
    var base64 = imageData.toString('base64');
    if (base64.length > 10 * 1024 * 1024) return Promise.resolve(null); // skip >10MB images

    var postData = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: prompt || 'Describe what you see in this screenshot.' }
      ] }]
    });

    return new Promise(function(resolve) {
      var req = https.request({
        hostname: providers.anthropic.endpoint || 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'x-api-key': providers.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
        timeout: 30000
      }, function(res) {
        var body = '';
        res.on('data', function(d) { body += d; });
        res.on('end', function() {
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            var parsed = JSON.parse(body);
            var text = (parsed.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('').trim();
            console.log('[vision] Analyzed ' + imagePath + ' via Anthropic API (' + text.length + ' chars)');
            resolve(text || null);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', function() { resolve(null); });
      req.on('timeout', function() { req.destroy(); resolve(null); });
      req.write(postData);
      req.end();
    });
  } catch (e) { return Promise.resolve(null); }
}

// ────────────────────────────────────────────────────────────────────
// Architect / Editor split (research [Plan] — Aider 85% benchmark)
// ────────────────────────────────────────────────────────────────────
//
// ARCHITECT: best available model for planning. Priority:
//   1. Anthropic API key (Sonnet/Opus)
//   2. Alibaba qwen3-max (frontier reasoning)
//   3. OpenRouter MiniMax M2.5
//   4. DeepInfra DeepSeek
//   5. Local
//
// EXECUTOR: faster/cheaper model for tool execution. Priority:
//   1. Alibaba (qwen-plus or qwen-max — fast)
//   2. DeepInfra DeepSeek
//   3. OpenRouter MiniMax
//   4. NIM
//   5. Local
//
// generatePlan(taskText) — calls architect model with structured plan prompt
// returns markdown plan or null on failure.

var PLAN_PROMPT_PREFIX =
  "You are the ARCHITECT. Produce a CONCISE structured plan for this task.\n" +
  "Output format (markdown, NO preamble):\n\n" +
  "## Goal\n[1 sentence]\n\n" +
  "## Files to inspect\n- path/to/file.js — why\n\n" +
  "## Files to modify\n- path/to/file.js — what changes\n\n" +
  "## Steps\n1. [action]\n2. [action]\n\n" +
  "## Verification\n- How to verify success\n\n" +
  "Be terse. No code yet — only plan.\n\n" +
  "TASK:\n";

// The architect is an internal enhancement, and an enhancement must never
// bill a flat-rate subscription the operator bought for their own turns —
// left on the general chain, this helper rides any subscription pin it
// finds there. The architect chain in
// generatePlan already names every lane it is allowed to spend: per-token
// BYOK keys the operator chose to meter, or a live local box. When none of
// those exists — or the operator pinned a subscription lane, which
// callFallbackChain would honor — the honest fallback is NO plan, not a
// quietly billed one. generatePlan documents null as a normal outcome.
var SUBSCRIPTION_LANES = { kimi_sub: 1, openai_sub: 1 };
function architectMayUseGeneralChain() {
  if (SUBSCRIPTION_LANES[routingPrefs.pin || ""]) return false;
  var byok = ["anthropic", "alibaba", "deepseek", "openrouter", "deepinfra",
              "nvidia", "moonshot", "xai", "google_ai", "zai"];
  for (var i = 0; i < byok.length; i++) {
    var p = providers[byok[i]];
    if (p && p.enabled && p.apiKey) return true;
  }
  var c = providers.custom_openai;
  if (c && c.enabled && c.base_url) return true;
  if (providers.local && providers.local.enabled && isLocalAvailable()) return true;
  return false;
}

function generatePlan(taskText) {
  if (!taskText || taskText.length < 30) return Promise.resolve(null);
  var prompt = PLAN_PROMPT_PREFIX + taskText.slice(0, 4000);
  var fallbackBody = JSON.stringify({
    model: "any", max_tokens: 1500, stream: false,
    messages: [{ role: "user", content: prompt }]
  });
  // Architect prefers strong models. Order: anthropic → alibaba qwen3-max →
  // deepseek-v3.2 → openrouter (configured architect model) → local.
  // Earlier code only knew anthropic + alibaba; users with only DeepInfra
  // / OpenRouter / local got the worst case (no architect at all).
  // Override is passed via opts (no global mutation = no race).
  var architectChain = [];
  if (providers.anthropic.enabled && providers.anthropic.apiKey) {
    architectChain.push(function() { return callAnthropic(fallbackBody, {}); });
  }
  if (providers.alibaba.enabled && providers.alibaba.apiKey) {
    architectChain.push(function() {
      // qwen3-max for architect role — passed as opts, not mutating globals.
      return callAlibaba(fallbackBody, { model: 'qwen3-max' });
    });
  }
  if (providers.deepseek.enabled && providers.deepseek.apiKey) {
    architectChain.push(function() { return callDeepSeek(fallbackBody); });
  }
  if (providers.openrouter.enabled && providers.openrouter.apiKey) {
    architectChain.push(function() { return callOpenRouter(fallbackBody); });
  }
  if (providers.local.enabled) {
    architectChain.push(function() {
      return forwardToLocal(null, fallbackBody, providers.local.host, providers.local.port || 1234, { model: providers.local.model })
        .then(function(lr) { return (lr && lr.body) ? lr.body : null; });
    });
  }
  // Fall through to the general chain only when it would not land on a
  // flat-rate subscription.
  if (!architectChain.length) {
    if (!architectMayUseGeneralChain()) {
      console.log("[router] architect: only subscription lanes reachable — skipping the plan instead of spending quota");
      return Promise.resolve(null);
    }
    return callFallbackChain(fallbackBody).then(function(r) { return extractText(r); });
  }
  // Try architect chain
  function tryNext(i) {
    if (i >= architectChain.length) {
      if (!architectMayUseGeneralChain()) {
        console.log("[router] architect: preferred lanes failed and only subscription lanes remain — skipping the plan");
        return Promise.resolve(null);
      }
      return callFallbackChain(fallbackBody).then(function(r) { return extractText(r); });
    }
    return architectChain[i]().then(function(r) {
      if (r && r.success) return extractText(r.response);
      if (typeof r === "string") return extractText(r);
      return tryNext(i + 1);
    }).catch(function() { return tryNext(i + 1); });
  }
  return tryNext(0);
}

// Inject the generated plan into a request body's system prompt
function injectPlan(bodyStr, planText) {
  if (!planText) return bodyStr;
  try {
    var data = JSON.parse(bodyStr);
    var planBlock = "## Architect Plan (follow this)\n" + planText + "\n\n## Now execute the plan above using your tools.\n";
    if (data.system !== undefined) {
      if (typeof data.system === "string") {
        data.system = planBlock + "\n\n" + data.system;
      } else if (Array.isArray(data.system)) {
        data.system.unshift({ type: "text", text: planBlock });
      }
    }
    return JSON.stringify(data);
  } catch (e) { return bodyStr; }
}

// -- Fidelity critic judge (Layer 3) --------------------------------------
// A cheap REASONING second opinion that checks the operator HOW-rules. Unlike
// callFlash (think:false, non-reasoning) this keeps thinking ON and routes via
// the provider-agnostic policy in shared-core/fidelity-judge.js: free-first,
// cross-family preferred, never flash, never Anthropic BYOK serially, GPT sub as
// a cross-family fallback. Returns judge(prompt)->Promise<string|null>, fail-open.
function _judgeText(r) {
  if (!r) return null;
  if (typeof r === "string") return extractText(r);
  if (r.success && r.response) return extractText(r.response);
  if (r.body) return extractText(r.body);
  return null;
}
function makeFidelityJudge(opts) {
  opts = opts || {};
  var fjMod = require("../../shared-core/fidelity-judge.js");
  function buildBody(prompt) {
    return JSON.stringify({ model: "any", max_tokens: 1200, stream: false, messages: [{ role: "user", content: prompt }] });
  }
  function wrap(fn) { return function (body, model) { return Promise.resolve().then(function () { return fn(body, { model: model }); }).then(_judgeText).catch(function () { return null; }); }; }
  // Pin the judge body to the chosen model for providers that read it from the
  // payload rather than an opts argument (callAnthropic / callGoogleAI).
  function _withModel(bodyStr, model) {
    if (!model) return bodyStr;
    try { var b = JSON.parse(bodyStr); b.model = model; return JSON.stringify(b); } catch (e) { return bodyStr; }
  }
  var adapters = {
    providers: function () { try { loadProviders(); } catch (e) {} return providers; },
    isLocalAvailable: function () { try { return isLocalAvailable(); } catch (e) { return false; } },
    buildBody: buildBody,
    call: {
      local:      function (body, model) { return forwardToLocal(null, body, providers.local.host, providers.local.port || 1234, { model: model }).then(_judgeText).catch(function () { return null; }); },
      alibaba:    function (body, model) { return callAlibaba(body, { model: model }).then(_judgeText).catch(function () { return null; }); },
      deepseek:   wrap(callDeepSeek),
      deepinfra:  wrap(callDeepInfra),
      openrouter: wrap(callOpenRouter),
      zai:        wrap(callZai),
      moonshot:   wrap(callMoonshot),
      xai:        wrap(callXai),
      custom_openai: wrap(callCustomOpenai),
      openai_sub: function (body) { return callOpenAISubscription(body, {}).then(_judgeText).catch(function () { return null; }); },
      // Explicit-pick lanes. The picker now offers every model from every
      // ENABLED provider — choice, not a curated subset —
      // so a chosen Claude / Kimi / Gemini model must actually be callable.
      // Without an adapter the chain skipped the pick in silence and judged
      // with something else. These are pick-only: the AUTO candidate list is
      // unchanged, so nothing new enters the default cheapest-first path.
      kimi_sub:   wrap(callKimiSub),
      anthropic:  function (body, model) { return callAnthropic(_withModel(body, model), {}).then(_judgeText).catch(function () { return null; }); },
      google_ai:  function (body, model) { return callGoogleAI(_withModel(body, model)).then(_judgeText).catch(function () { return null; }); }
    }
  };
  // Operator model pick (Advanced) lives in config.json fidelity_model ("" = Auto).
  // opts.pick (explicit caller) wins; else read the configured pick.
  var pick = opts.pick;
  if (!pick) {
    try {
      var _cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME || require('os').homedir(), '.troth', 'config.json'), 'utf8'));
      if (_cfg && typeof _cfg.fidelity_model === 'string' && _cfg.fidelity_model) pick = _cfg.fidelity_model;
    } catch (_) {}
  }
  return fjMod.makeJudge(adapters, Object.assign({}, opts, { pick: pick }));
}

// Auth-expiry hook. The entity daemon loads this module
// IN-PROCESS, so a subscription 401/refresh failure can reach the operator's
// surfaces directly — before this, it only hit the console while the chain
// silently answered from the next engine. Fires at most once per hour.
var _authEventListeners = [];
var _lastAuthFireTs = 0;
function onAuthEvent(fn) { if (typeof fn === 'function') _authEventListeners.push(fn); }
function _fireAuthExpired(provider, detail) {
  var now = Date.now();
  if (now - _lastAuthFireTs < 60 * 60 * 1000) return;
  _lastAuthFireTs = now;
  for (var li = 0; li < _authEventListeners.length; li++) {
    try { _authEventListeners[li]({ provider: provider, detail: detail, ts: now }); } catch (_) {}
  }
}

module.exports = { onAuthEvent: onAuthEvent, getEffectiveChain: getEffectiveChain, callFallbackChain: callFallbackChain, callAnthropic: callAnthropic, callOpenAISubscription: callOpenAISubscription, callAlibaba: callAlibaba, callZai: callZai, callMoonshot: callMoonshot, callXai: callXai, callCustomOpenai: callCustomOpenai, callFlash: callFlash, handleCompaction: handleCompaction, preprocessAnthropicBody: preprocessAnthropicBody, scaleTokens: scaleTokens, forwardToLocal: forwardToLocal, getStats: getStats, analyzeImage: analyzeImage, getProviders: getProviders, getRoutingPrefs: getRoutingPrefs, loadProviders: loadProviders, generatePlan: generatePlan, injectPlan: injectPlan, continueIfTruncated: continueIfTruncated, moaRefine: moaRefine, ALIBABA_HARD_CAP_TOKENS: ALIBABA_HARD_CAP_TOKENS, detectPhase: detectPhase, filterAndTrimTools: filterAndTrimTools, isLocalAvailable: isLocalAvailable, makeFidelityJudge: makeFidelityJudge, buildPinFailure: buildPinFailure, buildNoEngineFailure: buildNoEngineFailure,
  effectiveLimitFor: effectiveLimitFor,
  resolveContextWindow: resolveContextWindow,
  believedContextWindow: believedContextWindow,
  scaleUsage: scaleUsage,
  scaleUsageInSSE: scaleUsageInSSE,
  warmContextWindows: warmContextWindows,
  // Test-only surface (used by tests/suite-19-router-pin-failfast.js). These
  // expose the in-memory provider/routing/health state so a test can drive a
  // pinned-provider-in-cooldown scenario without writing a config file or
  // making a network call. Not consumed by production code paths.
  __test: {
    providers: providers,
    routingPrefs: routingPrefs,
    isProviderHealthy: isProviderHealthy,
    markProviderFailed: markProviderFailed,
    markProviderHealthy: markProviderHealthy,
    detectPinReason: detectPinReason
  }
};
