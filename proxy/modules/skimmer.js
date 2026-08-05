// SPDX-License-Identifier: AGPL-3.0-only
// SWE-Pruner — Goal Hint + tool_result skimming.
//
// Research: 23-54% token reduction on SWE-Bench Verified.
// Idea: extract a "Goal Hint" from the agent's reasoning (last assistant
// text), then prune tool_result outputs to lines relevant to that hint.
//
// Targets: Bash (cat/grep/ls/find), Read of large files, large tool_results.
// Lines containing Goal Hint keywords are kept. Other lines are kept ONLY if
// they look like errors/warnings/test failures (always relevant to debugging).

const KEEP_PATTERNS = [
  /error/i, /warn/i, /fail/i, /traceback/i, /exception/i,
  /^\+\+\+|^---|^\*\*\*|^@@/,                      // diffs
  /^\s*at\s+\w+/,                                   // stack traces
  /^FAIL|^PASS|^✓|^✗|^✕/,                          // test output
  /\bexpected\b|\bactual\b|\breceived\b/i,
  /undefined|null reference|cannot read/i,
  /SyntaxError|TypeError|ReferenceError/,
];

const SKIM_TOOLS = new Set(['Bash', 'bash', 'Read', 'read', 'Grep', 'grep']);
const SKIM_THRESHOLD_LINES = 30;   // only skim outputs longer than this
const KEEP_FIRST_N = 5;            // always keep first N lines (header context)
const KEEP_LAST_N = 5;             // always keep last N lines (recent context)

function extractGoalHint(messages) {
  // Last assistant text is our hint
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const c = Array.isArray(msg.content) ? msg.content : [];
    const texts = c.filter(b => b && b.type === 'text' && b.text).map(b => b.text);
    if (texts.length) {
      return texts.join(' ').slice(0, 1000);
    }
    // No text in last assistant — also peek at tool_use names + inputs as hints
    const names = c.filter(b => b && b.type === 'tool_use').map(b => {
      const i = b.input || {};
      return b.name + ' ' + (i.file_path || i.command || i.pattern || '');
    });
    if (names.length) return names.join(' ').slice(0, 500);
  }
  return null;
}

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !/^(the|and|for|with|that|this|will|should|need|like|just|your)$/.test(w))
    .slice(0, 25);
}

function skimText(text, keywords) {
  if (!text || text.length < 200) return { text, skimmed: false };
  const lines = text.split('\n');
  if (lines.length < SKIM_THRESHOLD_LINES) return { text, skimmed: false };

  const kept = new Array(lines.length).fill(false);

  // Always keep first N and last N
  for (let i = 0; i < Math.min(KEEP_FIRST_N, lines.length); i++) kept[i] = true;
  for (let i = Math.max(0, lines.length - KEEP_LAST_N); i < lines.length; i++) kept[i] = true;

  // Keep lines matching keywords (case-insensitive substring)
  for (let i = 0; i < lines.length; i++) {
    if (kept[i]) continue;
    const lc = lines[i].toLowerCase();
    for (const kw of keywords) {
      if (lc.indexOf(kw) >= 0) { kept[i] = true; break; }
    }
  }

  // Keep lines matching error/warning patterns
  for (let i = 0; i < lines.length; i++) {
    if (kept[i]) continue;
    for (const p of KEEP_PATTERNS) {
      if (p.test(lines[i])) { kept[i] = true; break; }
    }
  }

  // Build output with elision markers for runs of skipped lines
  const out = [];
  let skipRun = 0;
  for (let i = 0; i < lines.length; i++) {
    if (kept[i]) {
      if (skipRun > 0) {
        out.push('[... ' + skipRun + ' lines elided by goal-hint skimmer ...]');
        skipRun = 0;
      }
      out.push(lines[i]);
    } else {
      skipRun++;
    }
  }
  if (skipRun > 0) out.push('[... ' + skipRun + ' lines elided ...]');

  const newText = out.join('\n');
  if (newText.length >= text.length * 0.85) return { text, skimmed: false }; // not worth it
  return { text: newText, skimmed: true };
}

function skimRequest(bodyStr) {
  let stats = { skimmed: 0, savedBytes: 0 };
  try {
    const data = JSON.parse(bodyStr);
    if (!Array.isArray(data.messages)) return { body: bodyStr, stats };

    // ReAct-aware: if recent tool_results contain errors/test failures,
    // SUSPEND skimming. Error context is critical for recovery — losing
    // even a stack trace line breaks the model's ability to fix.
    // Research [Proxy]: Generate-Test-Repair loop primitive should preserve
    // exact error strings; skim everywhere else.
    var recentMsgs = data.messages.slice(-4);
    for (var ri = 0; ri < recentMsgs.length; ri++) {
      var rc = Array.isArray(recentMsgs[ri].content) ? recentMsgs[ri].content : [];
      for (var rj = 0; rj < rc.length; rj++) {
        if (rc[rj] && rc[rj].type === 'tool_result' && (rc[rj].is_error ||
            (typeof rc[rj].content === 'string' && /Error:|Traceback|FAIL\b|✗/.test(rc[rj].content.slice(0, 500))))) {
          // In recovery mode — don't skim
          return { body: bodyStr, stats };
        }
      }
    }

    const beforeBytes = bodyStr.length;
    const goalHint = extractGoalHint(data.messages);
    if (!goalHint) return { body: bodyStr, stats };
    const keywords = extractKeywords(goalHint);
    if (keywords.length < 2) return { body: bodyStr, stats };

    // Build tool_use_id → toolName map
    const idToTool = new Map();
    for (const msg of data.messages) {
      if (msg.role !== 'assistant') continue;
      const c = Array.isArray(msg.content) ? msg.content : [];
      for (const b of c) {
        if (b && b.type === 'tool_use' && b.id) idToTool.set(b.id, b.name);
      }
    }

    // Skim tool_results from skimmable tools
    for (const msg of data.messages) {
      if (msg.role !== 'user') continue;
      const c = Array.isArray(msg.content) ? msg.content : [];
      for (const block of c) {
        if (!block || block.type !== 'tool_result') continue;
        const tool = idToTool.get(block.tool_use_id);
        if (!tool || !SKIM_TOOLS.has(tool)) continue;

        let text = null;
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) {
          text = block.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
        }
        if (!text) continue;

        const { text: newText, skimmed } = skimText(text, keywords);
        if (!skimmed) continue;

        if (typeof block.content === 'string') {
          block.content = newText;
        } else {
          block.content = [{ type: 'text', text: newText }];
        }
        stats.skimmed++;
      }
    }

    const newBody = JSON.stringify(data);
    stats.savedBytes = beforeBytes - newBody.length;
    return { body: newBody, stats };
  } catch (e) {
    return { body: bodyStr, stats };
  }
}

// Speculative edit hint: when the request mentions a specific file the model
// is about to edit, inject the current file content as a "current state" hint.
// This reduces the model's need to imagine what the file looks like before
// editing — it sees the actual current state. Cursor pattern.
function speculativeEditHint(bodyStr) {
  try {
    const fs = require('fs');
    const data = JSON.parse(bodyStr);
    if (!Array.isArray(data.messages)) return null;

    // Find the latest user message with text
    let userText = '';
    for (let i = data.messages.length - 1; i >= 0; i--) {
      if (data.messages[i].role !== 'user') continue;
      const c = data.messages[i].content;
      if (typeof c === 'string') { userText = c; break; }
      if (Array.isArray(c)) {
        const t = c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join(' ');
        if (t) { userText = t; break; }
      }
    }
    if (!userText || userText.length < 30) return null;

    // Detect explicit file path references in user text
    const fileMatches = userText.match(/\/[a-zA-Z0-9_./-]+\.[a-z]{1,4}\b/g);
    if (!fileMatches || !fileMatches.length) return null;

    const hints = [];
    for (const fp of fileMatches.slice(0, 3)) {
      try {
        const stat = fs.statSync(fp);
        if (stat.size > 50000) continue; // skip large files
        const content = fs.readFileSync(fp, 'utf8');
        if (content.length < 10) continue;
        hints.push("File `" + fp + "` (current content for reference):\n```\n" + content.slice(0, 8000) + "\n```");
      } catch (e) {}
    }
    if (!hints.length) return null;
    return "## Current File State (no Read needed for these)\n" + hints.join('\n\n');
  } catch (e) { return null; }
}

function getStats() { return {}; }

module.exports = { skimRequest, speculativeEditHint, getStats };
