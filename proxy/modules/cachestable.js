// SPDX-License-Identifier: AGPL-3.0-only
// cachestable — byte-stable prefix layout so Anthropic / provider prompt caches
// actually hit instead of being silently invalidated by cosmetic drift.
//
// Why this module exists
// ──────────────────────
// Anthropic cache_read is 10% of base input price; cache_write is 125–200%.
// For an agent loop that fires 20–40 turns per task, a 70%+ cache_read ratio
// cuts token bills by ~50% AND drops TTFT 13–31% (arXiv:2601.06007). But the
// cache matches byte-for-byte on a strict hierarchy (tools → system →
// messages): any cosmetic drift in a higher level invalidates everything
// downstream. Agent harnesses leak drift via:
//   • MCP tool schemas with nondeterministic JSON key order
//   • Timestamps, cwd paths, dynamic telemetry injected into system prompt
//   • More than 20 content blocks since the last cache_control (the
//     "20-block lookback window" — Anthropic scans back only 20 blocks
//     to find a cached prefix, then declares a miss)
//
// What this module does
// ─────────────────────
// Three pure functions that a caller applies to the outbound request body:
//
//   1. canonicalizeTools(tools)  — RFC 8785-style JSON canonicalization
//      so MCP drift never invalidates the prefix. Tools are also sorted
//      by name for determinism.
//
//   2. sanitizeSystem(system)    — strips known volatile patterns
//      (timestamps, cwd, plugin hot-cache keys) so the system block
//      stays byte-identical across turns.
//
//   3. placeCacheControls(body, model)
//      injects up to 4 cache_control breakpoints following the strategy
//      validated in "Don't Break the Cache" (arXiv:2601.06007): explicit
//      breakpoints only at static boundaries, dynamic tool results
//      excluded to avoid the 125%+ cache_write penalty.
//
// Threshold awareness
// ───────────────────
// Anthropic silently ignores cache_control on segments below a model-
// specific minimum token count. For Opus 4.7 / Haiku 4.5 that's 4096
// tokens — a small system prompt gets the directive stripped and
// cache_creation_input_tokens comes back 0. We check the token estimate
// via tokenestimate.js and skip placing the directive if we'd just be
// burning a breakpoint slot on a silent no-op.
//
// Not included (intentional)
// ──────────────────────────
//   • No keepalive pings — that belongs in the proxy's request loop, not
//     a pure mutator.
//   • No cache_edits surgery — vendor-undocumented (anthropic-beta:
//     claude-code-20250219). Too risky for first ship.
//   • No semantic tool-output cache — different concern, separate module.

"use strict";

var tokenestimate;
try { tokenestimate = require("./tokenestimate"); } catch (e) { tokenestimate = null; }

// ────────────────────────────────────────────────────────────────────
// 1. Canonical JSON (RFC 8785-lite)
// ────────────────────────────────────────────────────────────────────
// We don't need the full RFC 8785 spec — our inputs are pure JSON tool
// schemas (no NaN, no bigint, no unicode-normalisation edge cases). A
// stable-key stringify covers the real-world drift case. If we ever
// accept user-supplied prompts containing odd numeric forms we'll
// revisit with the `canonical-json` npm package.
function canonicalStringify(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!isFinite(value)) return "null"; // JSON has no NaN/Inf
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(JSON.stringify(keys[i]) + ":" + canonicalStringify(value[keys[i]]));
    }
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

// Given a tools array (Anthropic shape), return a new array where each
// tool is canonically re-serialized. Also sort the array by tool name so
// MCP servers that emit tools in shuffled order don't cost us the cache.
function canonicalizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  var canonical = tools.map(function (t) {
    // JSON.parse(canonicalStringify(…)) round-trips with sorted keys.
    try { return JSON.parse(canonicalStringify(t)); } catch (e) { return t; }
  });
  canonical.sort(function (a, b) {
    var an = (a && a.name) || "";
    var bn = (b && b.name) || "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return canonical;
}

// ────────────────────────────────────────────────────────────────────
// 2. System prompt sanitizer
// ────────────────────────────────────────────────────────────────────
// Patterns that leak into system prompts and rot cache hits. Conservative
// by default — we only strip things known to change turn-to-turn. Each
// pattern has a comment justifying why it's safe to drop.
var VOLATILE_PATTERNS = [
  // "Today's date is " — changes nightly, useless for cache
  /^Today'?s date is .*$/gim,
  // "Current date: T..." — ditto, ISO form
  /^Current date:\s*\S.*$/gim,
  // "Last updated at HH:MM:SS" style timestamps
  /^Last (?:updated|modified)(?: at)?:?\s*[0-9T:\- ]+Z?$/gim,
  // Ephemeral session ids leaked into system prompts
  /session[-_]?id[:=]\s*[0-9a-f-]{8,}/gi,
];

// Strip volatile lines. Returns { sanitized, stripped } so callers can log
// what was removed for forensics without peeking into the prompt itself.
function sanitizeSystem(system) {
  if (!system) return { sanitized: system, stripped: 0 };
  var stripped = 0;
  function pass(text) {
    var out = text;
    for (var i = 0; i < VOLATILE_PATTERNS.length; i++) {
      out = out.replace(VOLATILE_PATTERNS[i], function () { stripped++; return ""; });
    }
    // Collapse any runs of blank lines the strips created.
    return out.replace(/\n{3,}/g, "\n\n");
  }
  if (typeof system === "string") {
    return { sanitized: pass(system), stripped: stripped };
  }
  if (Array.isArray(system)) {
    var out = system.map(function (block) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        return Object.assign({}, block, { text: pass(block.text) });
      }
      return block;
    });
    return { sanitized: out, stripped: stripped };
  }
  return { sanitized: system, stripped: 0 };
}

// ────────────────────────────────────────────────────────────────────
// 3. Model cache thresholds
// ────────────────────────────────────────────────────────────────────
// Anthropic silently ignores cache_control on segments shorter than
// these minimums. Numbers from the April 2026 platform docs.
var CACHE_MIN_TOKENS = {
  "claude-opus-4-7":      4096,
  "claude-opus-4-6":      4096,
  "claude-opus-4-5":      4096,
  "claude-haiku-4-5":     4096,
  "claude-mythos-preview": 4096,
  "claude-sonnet-4-6":    2048,
  "claude-sonnet-4-5":    1024,
  "claude-opus-4-1":      1024,
  "claude-opus-4":        1024,
  "claude-sonnet-4":      1024,
};
function minCacheTokens(model) {
  if (!model) return 1024;
  var m = String(model).toLowerCase();
  // Prefix-match: "claude-opus-4-7[1m]" etc. strip trailing tags
  var keys = Object.keys(CACHE_MIN_TOKENS);
  for (var i = 0; i < keys.length; i++) {
    if (m.indexOf(keys[i]) === 0) return CACHE_MIN_TOKENS[keys[i]];
  }
  return 1024;
}

// ────────────────────────────────────────────────────────────────────
// 4. Breakpoint placement
// ────────────────────────────────────────────────────────────────────
// Strategy from the research (arXiv:2601.06007 + Anthropic docs):
//   B1: last tools array element          — ttl 1h (static, recompute-
//                                             expensive, rarely changes)
//   B2: last system block                  — ttl 1h (if above threshold)
//   B3: intermediary in messages every ~19 blocks — ttl 5m
//       (avoids the 20-block lookback miss)
//   B4: last assistant/user message       — ttl 5m
//
// We stop at 4 breakpoints total (Anthropic hard limit: 400 error if
// exceeded). If threshold check fails we skip a slot rather than
// burning it on a silent-ignore.
var BP_1H = { type: "ephemeral", ttl: "1h" };
var BP_5M = { type: "ephemeral" }; // default TTL is 5m; omit ttl key

function tokenCount(obj, model) {
  if (!tokenestimate) return 9999; // be optimistic if estimator missing
  try { return tokenestimate.estimateTokens(JSON.stringify(obj), model); }
  catch (e) { return 9999; }
}

// Count cache_control markers ALREADY present (placed by the injector's
// static/dynamic split, or by the client). placeCacheControls MUST seed its
// counter from these — otherwise injector(1-2) + cachestable(up to 4) can exceed
// Anthropic's hard limit of 4 breakpoints, which 400s the whole request and was
// the  caching-crisis / double-billing regression both modules warn about.
function countExistingBreakpoints(body) {
  if (!body || typeof body !== "object") return 0;
  var n = 0, i, c, b;
  if (Array.isArray(body.tools)) for (i = 0; i < body.tools.length; i++) if (body.tools[i] && body.tools[i].cache_control) n++;
  if (Array.isArray(body.system)) for (i = 0; i < body.system.length; i++) if (body.system[i] && body.system[i].cache_control) n++;
  if (Array.isArray(body.messages)) for (i = 0; i < body.messages.length; i++) {
    c = body.messages[i] && body.messages[i].content;
    if (Array.isArray(c)) for (b = 0; b < c.length; b++) if (c[b] && c[b].cache_control) n++;
  }
  return n;
}

function placeCacheControls(body, model) {
  if (!body || typeof body !== "object") return { body: body, breakpointsPlaced: 0 };
  // Seed from breakpoints already placed upstream (injector) so the total never
  // exceeds Anthropic's 4-breakpoint cap. The `placed < 4` guards below then
  // correctly stop early instead of stacking a 5th/6th marker.
  var alreadyPlaced = countExistingBreakpoints(body);
  var placed = alreadyPlaced;
  var threshold = minCacheTokens(model);

  // B1 — tools array tail
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    var toolsTokens = tokenCount(body.tools, model);
    if (toolsTokens >= threshold && placed < 4) {
      var last = body.tools[body.tools.length - 1];
      if (last && typeof last === "object") {
        last.cache_control = BP_1H;
        placed++;
      }
    }
  }

  // B2 — system block tail
  if (body.system) {
    var sysTokens = tokenCount(body.system, model);
    if (sysTokens >= threshold && placed < 4) {
      if (typeof body.system === "string") {
        // Convert string form to blocks so we can attach cache_control
        body.system = [{ type: "text", text: body.system, cache_control: BP_1H }];
        placed++;
      } else if (Array.isArray(body.system) && body.system.length > 0) {
        var lastSys = body.system[body.system.length - 1];
        if (lastSys && typeof lastSys === "object") {
          lastSys.cache_control = BP_1H;
          placed++;
        }
      }
    }
  }

  // B3 — messages lookback anchor (every ~19 blocks)
  // Count content blocks in messages; if > 19 since start, anchor at
  // position (len - 15) to keep next 15 blocks inside the lookback window.
  if (Array.isArray(body.messages) && placed < 4) {
    var totalBlocks = 0;
    var anchorMsgIdx = -1;
    for (var i = 0; i < body.messages.length; i++) {
      var msg = body.messages[i];
      var content = msg && msg.content;
      if (Array.isArray(content)) totalBlocks += content.length;
      else if (content) totalBlocks += 1;
      if (totalBlocks >= 19 && anchorMsgIdx === -1) anchorMsgIdx = i;
    }
    if (anchorMsgIdx >= 0 && anchorMsgIdx < body.messages.length - 2) {
      // Attach to the last content block of that message
      var am = body.messages[anchorMsgIdx];
      if (Array.isArray(am.content) && am.content.length > 0) {
        am.content[am.content.length - 1].cache_control = BP_5M;
        placed++;
      } else if (typeof am.content === "string") {
        am.content = [{ type: "text", text: am.content, cache_control: BP_5M }];
        placed++;
      }
    }
  }

  // B4 — last message tail (5m TTL, catches fresh work)
  if (Array.isArray(body.messages) && body.messages.length > 0 && placed < 4) {
    var tailIdx = body.messages.length - 1;
    var tm = body.messages[tailIdx];
    if (Array.isArray(tm.content) && tm.content.length > 0) {
      var tail = tm.content[tm.content.length - 1];
      if (tail && typeof tail === "object") {
        tail.cache_control = BP_5M;
        placed++;
      }
    } else if (typeof tm.content === "string" && tm.content.length > 0) {
      // Wrap string content so we can attach cache_control
      tm.content = [{ type: "text", text: tm.content, cache_control: BP_5M }];
      placed++;
    }
  }

  return { body: body, breakpointsPlaced: placed - alreadyPlaced };
}

// ────────────────────────────────────────────────────────────────────
// 5. Orchestrator — apply all three passes
// ────────────────────────────────────────────────────────────────────
// Single entry point for callers. Returns the mutated body plus a small
// metrics record suitable for logging or /api/stats surfacing.
function apply(body, opts) {
  opts = opts || {};
  var model = opts.model || (body && body.model);
  var stats = { toolsCanonicalized: 0, systemStripped: 0, breakpointsPlaced: 0 };
  if (!body || typeof body !== "object") return { body: body, stats: stats };

  if (Array.isArray(body.tools)) {
    body.tools = canonicalizeTools(body.tools);
    stats.toolsCanonicalized = body.tools.length;
  }

  if (body.system) {
    var s = sanitizeSystem(body.system);
    body.system = s.sanitized;
    stats.systemStripped = s.stripped;
  }

  var r = placeCacheControls(body, model);
  stats.breakpointsPlaced = r.breakpointsPlaced;

  return { body: body, stats: stats };
}

module.exports = {
  apply: apply,
  canonicalizeTools: canonicalizeTools,
  canonicalStringify: canonicalStringify,
  sanitizeSystem: sanitizeSystem,
  placeCacheControls: placeCacheControls,
  minCacheTokens: minCacheTokens,
  _VOLATILE_PATTERNS: VOLATILE_PATTERNS,
};
