// SPDX-License-Identifier: AGPL-3.0-only
// Critic — quality review on every response with tool_use.
//
// Two layers:
//   1. Synchronous heuristic check (regex/patterns) — fires on every response
//   2. Async Flash review (CriticGPT-style) — fires on every tool_use, lowered
//      thresholds for Write (>20 lines) and Edit (substantial diff). Feedback
//      stored in pendingFeedback, injected into next turn by injector.
//
// Research baseline: CriticGPT preferred over human reviewers in 63% of cases.
// Even a 1.5-3B critic outperforms heuristics. We use Flash via fallback chain.

const fs = require('fs');
const path = require('path');

var projectDir = process.env.GF_WATCH_DIR || process.cwd();
var contextFilePath = path.join(projectDir, '.troth', 'context.md');

function writeContextToDisk(content) {
  try {
    var dir = path.dirname(contextFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(contextFilePath, content, 'utf8');
  } catch (e) {}
}

function clearContextFromDisk() {
  try { if (fs.existsSync(contextFilePath)) fs.unlinkSync(contextFilePath); } catch (e) {}
}

let pendingFeedback = null;
const failureMemory = [];
const MAX_FAILURES = 10;

let stats = {
  reviews: { write: 0, edit: 0, bash: 0 },
  issuesFound: 0,
  qualityScoreAvg: 10,
  qualityScoreSamples: 0,
  // Per-provider quality tracking (Braintrust-style online scoring)
  providerQuality: {}, // { providerName: { samples, avgScore, totalIssues } }
};

function recordProviderQuality(providerName, score, issueCount) {
  if (!providerName) return;
  if (!stats.providerQuality[providerName]) {
    stats.providerQuality[providerName] = { samples: 0, avgScore: 10, totalIssues: 0 };
  }
  var pq = stats.providerQuality[providerName];
  pq.samples++;
  pq.avgScore = ((pq.avgScore * (pq.samples - 1)) + score) / pq.samples;
  pq.totalIssues += issueCount || 0;
}

function setPendingFeedback(fb) {
  pendingFeedback = fb;
  if (fb) writeContextToDisk(fb); else clearContextFromDisk();
}

function getPendingFeedback() {
  const fb = pendingFeedback;
  pendingFeedback = null;
  clearContextFromDisk();
  return fb;
}

function appendFeedback(more) {
  if (!more) return;
  if (pendingFeedback) {
    pendingFeedback += '\n\n' + more;
  } else {
    pendingFeedback = more;
  }
  writeContextToDisk(pendingFeedback);
}

// ── Async Flash review functions ──
// All return immediately and update pendingFeedback in background.

function reviewWrite(filePath, content) {
  stats.reviews.write++;
  try {
    var callFlash = require('./router').callFlash;
    if (!callFlash) return;
    var ext = (filePath || '').split('.').pop() || '';
    var fileSlice = content.slice(0, 15000);

    // Builder-Validator parallel critics (research [Plan]):
    // Fire 3 specialized reviews in parallel. Each catches different bug types.
    // Aggregate findings into single feedback block.
    var prompts = [
      {
        kind: 'logic',
        prompt: "Code logic review of " + ext + " file " + filePath + ":\n```\n" + fileSlice + "\n```\n" +
          "Check ONLY: incomplete functions, off-by-one errors, null/undefined handling, missing early returns, unreachable code.\n" +
          "Respond LGTM if logic is sound. Else 1 line per issue prefixed [LOGIC]."
      },
      {
        kind: 'integration',
        prompt: "Integration review of " + filePath + ":\n```\n" + fileSlice + "\n```\n" +
          "Check ONLY: missing imports, wrong require paths, undefined symbols, broken exports, mismatched function signatures.\n" +
          "Respond LGTM if all integrations are coherent. Else 1 line per issue prefixed [IMPORT] or [SIGNATURE]."
      },
      {
        kind: 'security',
        prompt: "Security review of " + filePath + ":\n```\n" + fileSlice + "\n```\n" +
          "Check ONLY: SQL injection, XSS, hardcoded secrets, unvalidated input, eval(), missing auth checks.\n" +
          "Respond LGTM if no security issues. Else 1 line per issue prefixed [SECURITY]."
      }
    ];

    Promise.all(prompts.map(function(p) {
      return callFlash(p.prompt).then(function(r) { return { kind: p.kind, review: r }; }).catch(function() { return null; });
    })).then(function(results) {
      var issues = [];
      for (var i = 0; i < results.length; i++) {
        if (!results[i] || !results[i].review) continue;
        var r = results[i].review.trim();
        if (r.startsWith("LGTM") || r.length < 10) continue;
        issues.push("**" + results[i].kind.toUpperCase() + "**\n" + r);
      }
      if (issues.length) {
        stats.issuesFound += issues.length;
        appendFeedback("## Parallel Critics — " + filePath + "\n\n" + issues.join("\n\n"));
        console.log("[critic] " + issues.length + " specialized critic(s) flagged Write to " + filePath);
      }
    });
  } catch (e) {}
}

function reviewEdit(filePath, oldStr, newStr) {
  stats.reviews.edit++;
  try {
    var callFlash = require('./router').callFlash;
    if (!callFlash) return;
    // Skip trivial edits
    if (Math.abs(newStr.length - oldStr.length) < 50 && newStr.split('\n').length < 5) return;
    var ext = (filePath || '').split('.').pop() || '';
    var prompt = "Review this " + ext + " edit for bugs:\n\n" +
      "OLD:\n```\n" + oldStr.slice(0, 4000) + "\n```\n\n" +
      "NEW:\n```\n" + newStr.slice(0, 4000) + "\n```\n\n" +
      "Did the change introduce: missing imports, broken syntax, logic regression, removed error handling?\n" +
      "Respond LGTM if change is safe. Else: 1 line per concern, prefixed [BUG] or [REGRESSION].";
    callFlash(prompt).then(function(review) {
      if (review && !review.startsWith("LGTM") && review.length > 10) {
        stats.issuesFound++;
        appendFeedback("## Flash Edit Review — " + filePath + "\n" + review);
        console.log("[critic] Flash flagged Edit to " + filePath);
      }
    }).catch(function() {});
  } catch (e) {}
}

// Codex-style security audit (research [MoA]): for files touching auth,
// crypto, secrets, env, or external input. Explicit threat-model review.
var SECURITY_RELEVANT_PATTERNS = [
  /\b(auth|jwt|token|session|password|crypto|hash|hmac|encrypt|decrypt)\b/i,
  /\b(req\.body|req\.query|req\.params|req\.headers)\b/,
  /\b(eval|exec|spawn|require\s*\()/,
  /\bprocess\.env\./,
  /\b(SELECT|INSERT|UPDATE|DELETE)\s+.*\?\?/i, // unsafe SQL
];

function looksSecurityRelevant(content) {
  if (!content) return false;
  return SECURITY_RELEVANT_PATTERNS.some(p => p.test(content));
}

function securityAudit(filePath, content) {
  if (!looksSecurityRelevant(content)) return;
  try {
    var callFlash = require('./router').callFlash;
    if (!callFlash) return;
    var prompt = "SECURITY AUDIT (Codex Identify-Validate-Remediate):\n" +
      "File: " + filePath + "\n```\n" + content.slice(0, 12000) + "\n```\n\n" +
      "Threat model: assume input is hostile. Find:\n" +
      "1. INJECTION: SQL/command/template injection paths\n" +
      "2. AUTH: missing checks, broken token validation, race conditions\n" +
      "3. SECRETS: hardcoded keys, leaked env vars in errors/logs\n" +
      "4. CRYPTO: weak algorithms, predictable IVs, missing constant-time compare\n" +
      "5. RACE: TOCTOU, unprotected shared state\n\n" +
      "Respond LGTM if no security issues. Else 1 line per issue prefixed [SECURITY] with category.";
    callFlash(prompt).then(function(review) {
      if (review && !review.startsWith("LGTM") && review.length > 10) {
        stats.issuesFound++;
        appendFeedback("## Security Audit — " + filePath + "\n" + review +
          "\n\nFix security issues BEFORE proceeding. These are not optional.");
        console.log('[critic] Security audit flagged ' + filePath);
      }
    }).catch(function() {});
  } catch (e) {}
}

// Cross-provider verification (research [MoA]): for high-stakes Writes
// (DB schema, entry points, deployment configs), get a second opinion from
// a different provider. Uncorrelated failure modes catch bugs single-provider
// missed. Only fires for files matching the high-stakes pattern.
var HIGH_STAKES_PATTERNS = [
  /schema\.(sql|prisma|js|ts)$/i,
  /migrations?\//i,
  /(server|app|main|index)\.(js|ts|py)$/i,
  /docker-compose|Dockerfile/i,
  /\.env(\.|$)/i,
  /\.github\/workflows\//i,
  /next\.config|vite\.config|webpack\.config/i,
];

function isHighStakes(filePath) {
  if (!filePath) return false;
  return HIGH_STAKES_PATTERNS.some(p => p.test(filePath));
}

function crossVerifyWrite(filePath, content) {
  if (!isHighStakes(filePath)) return;
  try {
    var callFlash = require('./router').callFlash;
    if (!callFlash) return;
    var ext = (filePath || '').split('.').pop() || '';
    var prompt = "CROSS-VERIFY (high-stakes file): " + filePath + "\n\n" +
      "Another model wrote this " + ext + " file. As an independent reviewer:\n" +
      "Look for issues the original author may have missed:\n" +
      "- Will this break existing functionality?\n" +
      "- Are migrations/schema changes safe (idempotent, reversible)?\n" +
      "- Are configs syntactically valid AND semantically sensible?\n" +
      "- Any obvious red flags (deleted important code, hardcoded prod values)?\n\n" +
      "```\n" + content.slice(0, 12000) + "\n```\n\n" +
      "Respond LGTM if change is safe. Else 1 line per concern prefixed [VERIFY-FAIL].";
    callFlash(prompt).then(function(review) {
      if (review && !review.startsWith("LGTM") && review.length > 10) {
        stats.issuesFound++;
        appendFeedback("## Cross-Provider Verification — " + filePath + "\n" + review +
          "\n\nThis is a HIGH-STAKES file. Resolve flagged concerns before continuing.");
        console.log('[critic] Cross-verify flagged HIGH-STAKES Write to ' + filePath);
      }
    }).catch(function() {});
  } catch (e) {}
}

function reviewBash(cmd) {
  // Only review non-trivial commands (skip ls, cat, pwd, etc.)
  if (!cmd || cmd.length < 30) return;
  if (/^(ls|cat|pwd|echo|cd|which|whoami|date|head|tail|wc|grep)\s/i.test(cmd.trim())) return;
  stats.reviews.bash++;
  try {
    var callFlash = require('./router').callFlash;
    if (!callFlash) return;
    var prompt = "Review this bash command for issues:\n\n```bash\n" + cmd.slice(0, 1500) + "\n```\n\n" +
      "Will it: delete important data, modify wrong files, expose secrets, fail silently?\n" +
      "Respond LGTM if safe. Else: 1 line, prefixed [DANGER] or [BUG].";
    callFlash(prompt).then(function(review) {
      if (review && !review.startsWith("LGTM") && review.length > 10) {
        stats.issuesFound++;
        appendFeedback("## Flash Bash Review\n" + review);
        console.log("[critic] Flash flagged Bash command");
      }
    }).catch(function() {});
  } catch (e) {}
}

// ── Synchronous heuristic check ──
// coexistence helper — same rationale as proxy/modules/injector.js:
// when the v10 plugin is active, its Stop hook runs the identical
// heuristic critic in-session. Gated behind an explicit opt-in via
// ~/.troth/config.json { "coexistence": true } OR
// TROTH_COEXISTENCE=1 env, so a stale plugin_presence row never
// silently disables proxy-side review.
let _criticState = null;
try { _criticState = require('../../shared-core/state.js'); } catch (e) { /* optional */ }
function criticCoexistenceEnabled() {
  if (process.env.TROTH_COEXISTENCE === '1') return true;
  if (process.env.TROTH_COEXISTENCE === '0') return false;
  try {
    var fsMod = require('fs');
    var pMod = require('path');
    var cfgPath = pMod.join(process.env.HOME || '', '.troth', 'config.json');
    var cfg = JSON.parse(fsMod.readFileSync(cfgPath, 'utf8'));
    return cfg && cfg.coexistence === true;
  } catch (e) { return false; }
}
function criticIsHandledByPlugin() {
  if (!_criticState || typeof _criticState.isPluginActive !== 'function') return false;
  if (!criticCoexistenceEnabled()) return false;
  try { return !!_criticState.isPluginActive().active; } catch (e) { return false; }
}

function criticize(responseBody) {
  try {
    // Coexistence short-circuit — the plugin's Stop hook already reviewed
    // the assistant's last turn. Returning null here means the proxy
    // records no issues and triggers no async Flash review.
    if (criticIsHandledByPlugin()) return null;

    const data = JSON.parse(responseBody);
    if (!data.content || !Array.isArray(data.content)) return null;

    const issues = [];

    var hasText = data.content.some(function(b) { return b.type === 'text' && b.text && b.text.trim().length > 20; });
    var hasToolUse = data.content.some(function(b) { return b.type === 'tool_use'; });
    if (hasToolUse && !hasText) {
      issues.push('Tool called without explanation. State your plan as text BEFORE calling tools.');
    }

    for (const block of data.content) {
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      const name = block.name || '';

      if (input.file_path) {
        try { require('./codelens').recordFileTouched(input.file_path); } catch (e) {}
      }

      // Edit: heuristic + async Flash review
      if (name === 'Edit' || name === 'edit') {
        if (!input.file_path) {
          issues.push('Edit without file_path');
          continue;
        }
        if (input.old_string && input.new_string && input.old_string === input.new_string) {
          issues.push('Edit old_string === new_string (no-op)');
        }
        if (input.file_path && input.old_string) {
          try {
            if (fs.existsSync(input.file_path)) {
              const content = fs.readFileSync(input.file_path, 'utf8');
              if (!content.includes(input.old_string)) {
                issues.push('Edit old_string not found in ' + input.file_path);
              }
            } else {
              issues.push('Edit target file does not exist: ' + input.file_path);
            }
          } catch (e) {}
        }
        // Async Flash review
        if (input.old_string && input.new_string) {
          reviewEdit(input.file_path, input.old_string, input.new_string);
        }
      }

      // Write: heuristic + async Flash review (lowered threshold 50 → 20 lines)
      if (name === 'Write' || name === 'write') {
        if (input.content) {
          var wContent = input.content;
          if (wContent.endsWith('...') || wContent.endsWith('// ...') || wContent.endsWith('/* ... */')) {
            issues.push('Write content appears truncated (ends with "...")');
          }
          var placeholders = wContent.match(/\/\/ TODO|\/\/ FIXME|\/\/ implement|\/\/ add.*here/gi);
          if (placeholders && placeholders.length > 2) {
            issues.push('Write content has ' + placeholders.length + ' placeholder comments');
          }
          var lineCount = wContent.split('\n').length;
          if (lineCount > 20 && wContent.length < 30000) {
            reviewWrite(input.file_path, wContent);
          }
          // Cross-provider verification for HIGH-STAKES files (server, schema, configs)
          if (lineCount > 10 && wContent.length < 20000) {
            crossVerifyWrite(input.file_path, wContent);
          }
          // Security audit for security-relevant code (auth, crypto, env, user input)
          if (lineCount > 5 && wContent.length < 15000) {
            securityAudit(input.file_path, wContent);
          }
          // Auto-fire shadow Git checkpoint for substantial writes (>50 lines)
          if (lineCount > 50 && input.file_path) {
            try {
              if (require('./modtoggle').isModuleEnabled('checkpoint')) {
                var projDir = process.env.GF_WATCH_DIR || process.cwd();
                require('./checkpoint').checkpoint(projDir, 'pre-Write:' + input.file_path, [input.file_path]);
              }
            } catch (e) {}
          }
        }
      }

      // Bash: heuristic + async Flash review
      if (name === 'Bash' || name === 'bash') {
        const cmd = input.command || '';
        if (cmd.includes('rm -rf') && !cmd.includes('/tmp') && !cmd.includes('node_modules')) {
          issues.push('Bash: rm -rf on non-temporary path');
        }
        reviewBash(cmd);
      }
    }

    // Text content + decision detection
    for (const block of data.content) {
      if (block.type !== 'text' || !block.text) continue;
      if (/I('ll| will) (try|attempt|proceed) to/i.test(block.text) && block.text.length < 100) {
        issues.push('Vague filler — execute action instead of describing it');
      }
      var decisionPatterns = /(?:I (?:chose|decided|selected|will use|went with)|(?:using|choosing|picking) .+ (?:because|since|for)|architecture:|design decision:)/i;
      if (decisionPatterns.test(block.text) && block.text.length > 50) {
        var decisionText = block.text.slice(0, 300);
        // dual-write — CodeLens decisions table for code-graph
        // recall AND substrate engram for cross-session causal recall.
        // Decisions become first-class substrate facts with code provenance.
        try {
          var codelensIndex = require('./codelens');
          if (codelensIndex._store && codelensIndex._store.addDecision) {
            codelensIndex._store.addDecision(decisionText);
          }
        } catch (e) {}
        try {
          var engram = require('../../shared-core/engram');
          var agentId = (data && (data.id || data.agent_id)) || 'critic';
          engram.recordEngram({
            agent_id: agentId,
            statement: decisionText,
            source: 'critic_decision_capture',
            cwd: process.cwd(),
            source_module: 'critic.js',
            scope: 'decisions'
          });
        } catch (e) {}
      }
    }

    var qualityScore = Math.max(0, 10 - issues.length * 2);
    stats.qualityScoreSamples++;
    stats.qualityScoreAvg = ((stats.qualityScoreAvg * (stats.qualityScoreSamples - 1)) + qualityScore) / stats.qualityScoreSamples;

    // Per-provider quality tracking (Braintrust online scoring)
    try {
      var modelName = data.model || 'unknown';
      // Map back to provider name
      var providerName = modelName.includes('qwen') || modelName.includes('alibaba') ? 'alibaba' :
                         modelName.includes('deepseek') ? 'deepseek' :
                         modelName.includes('claude') || modelName.includes('anthropic') ? 'anthropic' :
                         modelName.includes('gpt') ? 'openai' :
                         modelName.includes('minimax') ? 'openrouter' :
                         modelName.includes('gemini') ? 'gemini' : 'unknown';
      recordProviderQuality(providerName, qualityScore, issues.length);
    } catch (e) {}

    // Confidence-based escalation hint: if quality is low, mark for next-turn
    // strong-model routing. The injector picks this up to flag "previous turn
    // had quality issues" so model is more careful.
    if (qualityScore <= 4) {
      appendFeedback("## QUALITY GATE — Previous turn quality: " + qualityScore + "/10\n" +
        "Multiple issues detected. Slow down. Re-read the file you're editing. State your reasoning before each tool call.");
      stats.lowQualityTurns = (stats.lowQualityTurns || 0) + 1;
    }

    // CTRL critic loop: scan accumulated feedback for CRITICAL/BUG markers.
    // If found, escalate to "REVISE" instruction in next turn.
    try {
      var fb = pendingFeedback || '';
      var criticalCount = (fb.match(/\[(CRITICAL|BUG|REGRESSION|SECURITY|DANGER)\]/g) || []).length;
      if (criticalCount >= 2) {
        appendFeedback("## REVISE NOW — " + criticalCount + " critical issues outstanding\n" +
          "Multiple CRITICAL/BUG issues are flagged above. Do NOT continue with new work. " +
          "Address every flagged item in your NEXT response before any other action.");
        stats.revisionsRequested = (stats.revisionsRequested || 0) + 1;
        console.log('[critic] CTRL loop: ' + criticalCount + ' critical issues — REVISE requested');
      }
    } catch (e) {}

    if (issues.length > 0) {
      var heuristicFb = '## Critic Feedback\n' +
        'Issues in your last response:\n' +
        issues.map(function(i) { return '- ' + i; }).join('\n') + '\n' +
        'Fix before proceeding.';
      appendFeedback(heuristicFb);
      console.log('[critic] ' + issues.length + ' issue(s), quality: ' + qualityScore + '/10');
    }

    return { feedback: pendingFeedback, qualityScore: qualityScore, issues: issues };
  } catch (e) {
    return null;
  }
}

function recordFailure(toolName, filePath, error) {
  failureMemory.push({
    tool: toolName,
    file: filePath,
    error: (error || '').slice(0, 200),
    ts: Date.now()
  });
  if (failureMemory.length > MAX_FAILURES) failureMemory.shift();
  console.log('[critic] Recorded failure: ' + toolName + ' on ' + (filePath || 'unknown'));
}

function learnFromRequest(bodyStr) {
  try {
    var data = JSON.parse(bodyStr);
    if (!data.messages) return;
    var msgs = data.messages.slice(-2);
    for (var i = 0; i < msgs.length; i++) {
      if (!Array.isArray(msgs[i].content)) continue;
      for (var j = 0; j < msgs[i].content.length; j++) {
        var block = msgs[i].content[j];
        if (!block || block.type !== 'tool_result') continue;

        var errorText = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('\n')
          : '';

        // YOLO compile-error self-loop (Cursor pattern):
        // Even when tool_result is NOT marked is_error, scan Bash output for
        // build/test failures (npm test, tsc, eslint, etc) and surface them
        // as priority feedback for the next turn.
        if (!block.is_error && errorText.length > 50) {
          var buildErrorPatterns = [
            // NONZERO counts only: "0 tests failed" / "0 failed" is a PASS
            // and must never trigger the fix-this-NOW injection (same false-
            // positive family as the exit-0 staple bug.
            /\b[1-9]\d* (?:tests? )?fail/i,
            /Error: |TypeError: |SyntaxError: |ReferenceError:/,
            /✗|✕|FAIL\b/,
            /error TS\d+:/,
            /error\s+ESLint/i,
            /Module not found/i,
            /Cannot find module/i,
            /ENOENT|EACCES/,
            /npm ERR!/,
            /failed with exit code [^0]/,
          ];
          var matched = buildErrorPatterns.find(function(p) { return p.test(errorText); });
          if (matched) {
            var snippet = errorText.slice(0, 1500);
            // Augment with git context — what files changed recently?
            var gitContext = '';
            try {
              // Popup-free CLT gate (see shared-core/git-ok.js).
              if (!require('../../shared-core/git-ok.js').gitOk()) throw new Error('git unavailable');
              var execFileSync = require('child_process').execFileSync;
              var projDir = process.env.GF_WATCH_DIR || process.cwd();
              var gitStatus = execFileSync('git', ['-C', projDir, 'diff', '--name-only', 'HEAD'], { stdio: 'pipe', timeout: 1500 }).toString().trim();
              if (gitStatus) {
                var changedFiles = gitStatus.split('\n').slice(0, 8);
                gitContext = "\n\nRecently changed files (from git diff):\n" + changedFiles.map(f => '- ' + f).join('\n') + "\nThe failure likely relates to one of these.";
              }
            } catch (e) {}
            appendFeedback("## YOLO: Build/Test Failure Detected\n" +
              "The last Bash command output contains a failure pattern. The agent must address this NOW, not later.\n" +
              "Snippet:\n```\n" + snippet + "\n```" + gitContext + "\n" +
              "REQUIRED next action: identify the root cause from the error above and fix it before doing anything else.");
            console.log('[critic] YOLO build error detected in tool_result' + (gitContext ? ' (with git context)' : ''));
          }
        }

        if (!block.is_error) continue;
        var fileMatch = errorText.match(/(?:in |file |path:?\s*)([\/\w\.\-]+\.[a-z]+)/i);
        var filePath = fileMatch ? fileMatch[1] : null;
        var toolName = 'unknown';
        if (/old_string|not found in|not present/i.test(errorText)) toolName = 'Edit';
        else if (/ENOENT|not found|does not exist/i.test(errorText)) toolName = 'Read/Write';
        else if (/exit code|command failed/i.test(errorText)) toolName = 'Bash';
        recordFailure(toolName, filePath, errorText);
        // Trigger Reflexion: async generates verbal lesson via Flash
        try { require('./reflexion').reflectOnFailure(toolName, filePath, errorText, null); } catch (e) {}
      }
    }
  } catch (e) {}
}

function getFailureContext() {
  if (failureMemory.length === 0) return null;
  var recent = failureMemory.filter(function(f) { return Date.now() - f.ts < 300000; });
  if (recent.length === 0) return null;
  var lines = recent.map(function(f) {
    return '- ' + f.tool + (f.file ? ' on ' + f.file : '') + ': ' + f.error;
  });
  var ctx = '## Recent Failures (avoid repeating)\n' + lines.join('\n');
  writeContextToDisk(ctx);
  return ctx;
}

function getStats() {
  return {
    pendingFeedback: !!pendingFeedback,
    failureCount: failureMemory.length,
    reviews: stats.reviews,
    issuesFound: stats.issuesFound,
    qualityScoreAvg: stats.qualityScoreSamples > 0 ? Math.round(stats.qualityScoreAvg * 10) / 10 : null,
  };
}

module.exports = { criticize, getPendingFeedback, setPendingFeedback, getFailureContext, learnFromRequest, recordFailure, getStats };
