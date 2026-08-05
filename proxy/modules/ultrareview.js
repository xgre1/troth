// SPDX-License-Identifier: AGPL-3.0-only
// /ultrareview replication via prompt injection.
//
// Opus 4.7 ships an /ultrareview slash command in Claude Code itself that
// triggers a structured multi-perspective review. The command is CLI-side,
// so third-party clients or users on other harnesses don't have access.
// This module replicates it at the proxy layer: when the latest user
// message contains the trigger, we wrap the request in a 4-part audit
// system block and force effort='max' for maximum reasoning depth.
//
var TRIGGER_PATTERNS = [
  /^\/ultrareview\b/i,
  /\bultrareview\b/i,
  /\bdeep\s+review\b/i,
  /\bthorough\s+review\b/i
];

var PROMPT_BLOCK =
  '## Ultrareview protocol — execute ALL four passes rigorously\n\n' +
  '### Pass 1 — Architecture Audit\n' +
  'Examine proposed changes against existing project architecture. Identify\n' +
  'pattern adherence, anti-patterns, coupling issues, layer violations, and\n' +
  'whether the approach aligns with the codebase\'s existing abstractions.\n\n' +
  '### Pass 2 — Logic & Edge Case Verification\n' +
  'Mental dry-run of the code with realistic + adversarial inputs. Flag\n' +
  'off-by-one errors, null/undefined handling, race conditions, resource\n' +
  'leaks, unhandled error branches, and ordering assumptions.\n\n' +
  '### Pass 3 — Security Pass\n' +
  'Scan for injection points (SQL, command, path, XSS, SSRF), insecure\n' +
  'credential handling, authz/authn bypasses, unsafe deserialization,\n' +
  'and input-validation gaps at trust boundaries.\n\n' +
  '### Pass 4 — Performance & Maintainability\n' +
  'Identify technical debt (tight coupling, duplicated logic, god objects),\n' +
  'algorithmic cost regressions, scalability concerns, and documentation/\n' +
  'test coverage gaps that will compound.\n\n' +
  'Produce a structured report with findings categorized by severity.';

var state = {
  triggered: 0,
  lastTriggerAt: 0
};

function latestUserText(data) {
  if (!data || !Array.isArray(data.messages)) return '';
  for (var i = data.messages.length - 1; i >= 0; i--) {
    var msg = data.messages[i];
    if (msg.role !== 'user') continue;
    var c = msg.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      var parts = [];
      for (var j = 0; j < c.length; j++) {
        if (c[j] && c[j].type === 'text' && typeof c[j].text === 'string') parts.push(c[j].text);
      }
      return parts.join(' ');
    }
    break;
  }
  return '';
}

function detectTrigger(userText) {
  if (!userText) return false;
  // Trim + lowercase-friendly scan
  var probe = userText.trim();
  for (var i = 0; i < TRIGGER_PATTERNS.length; i++) {
    if (TRIGGER_PATTERNS[i].test(probe)) return true;
  }
  return false;
}

// Apply ultrareview to a body. Returns { body, triggered }.
// - Prepends the 4-pass audit as a system-array text block
// - Forces output_config.effort = 'max' (overrides earlier defaults)
// Idempotent: if the audit block is already present, nothing changes.
function apply(bodyStr) {
  var result = { body: bodyStr, triggered: false };
  try {
    var data = JSON.parse(bodyStr);
    var userText = latestUserText(data);
    if (!detectTrigger(userText)) return result;

    // Guard: don't double-inject on re-runs
    var alreadyInjected = false;
    if (Array.isArray(data.system)) {
      for (var i = 0; i < data.system.length; i++) {
        var b = data.system[i];
        if (b && b.text && b.text.indexOf('Ultrareview protocol') !== -1) { alreadyInjected = true; break; }
      }
    } else if (typeof data.system === 'string' && data.system.indexOf('Ultrareview protocol') !== -1) {
      alreadyInjected = true;
    }

    if (!alreadyInjected) {
      var block = { type: 'text', text: PROMPT_BLOCK };
      if (Array.isArray(data.system)) data.system.unshift(block);
      else if (typeof data.system === 'string') data.system = [block, { type: 'text', text: data.system }];
      else data.system = [block];
    }

    // Force max effort
    if (!data.output_config) data.output_config = {};
    data.output_config.effort = 'max';

    state.triggered++;
    state.lastTriggerAt = Date.now();

    result.body = JSON.stringify(data);
    result.triggered = true;
    return result;
  } catch (e) {
    return result;
  }
}

function getStats() {
  return {
    module: 'ultrareview',
    triggered: state.triggered,
    lastTriggerAgo: state.lastTriggerAt ? Math.round((Date.now() - state.lastTriggerAt) / 1000) : null
  };
}

// K-sample voting wrapper. AlphaCode-Lite was test-only;
// promoting here because ultrareview is the natural fit — when the user
// asks for a thorough/deep review, we can K-sample the response and pick
// the most consistent answer across 3 generations rather than trusting
// one shot. Caller passes a generator that runs ONE generation.
//
// Cost: K× the API call. Only triggers when ultrareview is active AND
// the caller explicitly opts in via runWithVoting (not the apply path).
async function runWithVoting(generateFn, k) {
  try {
    const alphacode = require('./alphacode');
    return await alphacode.kSampleVote(generateFn, k || 3);
  } catch (e) {
    // Fallback to single generation if alphacode is unavailable.
    try { return await generateFn(); } catch (err) { return null; }
  }
}

module.exports = {
  apply: apply,
  detectTrigger: detectTrigger,
  latestUserText: latestUserText,
  getStats: getStats,
  runWithVoting: runWithVoting,
  PROMPT_BLOCK: PROMPT_BLOCK,
  TRIGGER_PATTERNS: TRIGGER_PATTERNS
};
