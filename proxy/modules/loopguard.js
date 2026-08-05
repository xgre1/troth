// SPDX-License-Identifier: AGPL-3.0-only
// LoopBreaker — AST-normalized + no-codebase-delta loop detection.
//
// Research [Proxy][Local]: prevents wasted retries when the agent repeats
// the same logical operation with mutated args (whitespace, indent, etc).
//
// Two detection layers:
//   1. AST-normalized hash: collapses whitespace differences in tool args
//   2. No-codebase-delta: tracks if files actually changed between calls
//      (agent reading/editing same file repeatedly without progress = loop)

const crypto = require('crypto');
const fs = require('fs');

// thresholds env-driven so benchmark harness can relax them.
// qwen-ab-hard run 12 false-tripped during legit multi-Read exploration on a
// 4-bug task — 5/9 vs 9/9 on arm B. Setting TROTH_BENCH_MODE=1 raises both
// thresholds so the benchmark measures real troth lift, not a self-trip.
const BENCH_MODE = process.env.TROTH_BENCH_MODE === '1';
const MAX_HISTORY = BENCH_MODE ? 14 : 10;
const LOOP_THRESHOLD = BENCH_MODE ? 8 : 5;             // identical-hash calls
const NO_DELTA_THRESHOLD = BENCH_MODE ? 6 : 3;         // same file, no change

const history = [];                   // [{ hash, toolName, filePath, fileHashAtTime, ts }]
let stats = { detected: 0, broken: 0, deltaLoops: 0 };

// Normalize tool input to detect semantic equivalence
// (whitespace, quote style, key order shouldn't break the hash)
function normalizeInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim();
  if (typeof input === 'object') {
    // Sort keys, normalize string values
    const sorted = {};
    for (const k of Object.keys(input).sort()) {
      let v = input[k];
      if (typeof v === 'string') v = v.replace(/\s+/g, ' ').trim();
      sorted[k] = v;
    }
    return JSON.stringify(sorted).slice(0, 300);
  }
  return String(input).slice(0, 300);
}

function hashToolCall(toolUse) {
  const key = (toolUse.name || '') + ':' + normalizeInput(toolUse.input);
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

// Get current file content hash for delta detection
function fileContentHash(filePath) {
  if (!filePath) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
  } catch (e) { return null; }
}

function extractToolUse(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    if (data.content && Array.isArray(data.content)) {
      const toolBlocks = data.content.filter(b => b.type === 'tool_use');
      if (toolBlocks.length > 0) return toolBlocks[0];
    }
    if (data.choices?.[0]?.message?.tool_calls?.[0]) {
      const tc = data.choices[0].message.tool_calls[0];
      return { name: tc.function?.name, input: tc.function?.arguments };
    }
  } catch (e) {}
  return null;
}

// Detect "no-progress" pattern: agent has made N tool calls, but no Edit/Write
// has succeeded against a different file in the last N turns. This catches
// "stuck reading without acting" or "edit-fails-revert-edit-fails" loops.
function detectNoProgressPattern() {
  if (history.length < 5) return false;
  const recent = history.slice(-5);
  // Are all recent calls on the same file?
  const files = recent.map(h => h.filePath).filter(Boolean);
  if (files.length < 4) return false;
  const uniqueFiles = new Set(files);
  if (uniqueFiles.size > 1) return false;
  // All on same file. Check if the file content actually changed at any point.
  const hashes = recent.map(h => h.fileHashAtTime).filter(Boolean);
  if (!hashes.length) return false;
  const uniqueHashes = new Set(hashes);
  // If 5 calls on same file but only 1-2 unique hashes → no real progress
  return uniqueHashes.size <= 2;
}

function detectNoDeltaLoop(toolUse) {
  // Only meaningful for file-touching tools.: Read/read was
  // removed from this set because a repeat Read with unchanged content
  // is legitimate exploration on a multi-bug task (see
  // a  A/B run on a small local model). The real "stuck" signal is
  // repeat Edit/Write with no file change — which this still catches.
  const name = toolUse.name || '';
  const input = toolUse.input || {};
  const filePath = input.file_path || input.path;
  if (!filePath) return false;
  if (!['Edit', 'edit', 'Write', 'write', 'MultiEdit', 'NotebookEdit'].includes(name)) return false;

  // Look at recent history of same file
  const recentSame = history.filter(h => h.filePath === filePath).slice(-NO_DELTA_THRESHOLD);
  if (recentSame.length < NO_DELTA_THRESHOLD - 1) return false;

  // Check if file hash changed between any of these calls
  const hashes = recentSame.map(h => h.fileHashAtTime).filter(Boolean);
  if (!hashes.length) return false;
  const allSameHash = hashes.every(h => h === hashes[0]);
  return allSameHash;
}

function checkLoop(responseBody, opts) {
  opts = opts || {};
  const toolUse = extractToolUse(responseBody);
  if (!toolUse) return { body: responseBody, loopDetected: false };

  const hash = hashToolCall(toolUse);
  const filePath = (toolUse.input && (toolUse.input.file_path || toolUse.input.path)) || null;
  const fileHashAtTime = fileContentHash(filePath);

  history.push({ hash, toolName: toolUse.name, filePath, fileHashAtTime, ts: Date.now() });
  if (history.length > MAX_HISTORY) history.shift();

  // Layer 1: AST-normalized identical hash
  let detected = false;
  let detectedKind = null;
  if (history.length >= LOOP_THRESHOLD) {
    const recent = history.slice(-LOOP_THRESHOLD).map(h => h.hash);
    if (recent.every(h => h === recent[0])) {
      detected = true;
      detectedKind = 'identical';
    }
  }

  // Layer 2: no-codebase-delta on same file
  if (!detected && detectNoDeltaLoop(toolUse)) {
    detected = true;
    detectedKind = 'no-delta';
    stats.deltaLoops++;
  }

  // Layer 3: no-progress pattern (5+ calls, 1 file, near-zero hash variation)
  if (!detected && detectNoProgressPattern()) {
    detected = true;
    detectedKind = 'no-progress';
    stats.deltaLoops++;
  }

  if (!detected) return { body: responseBody, loopDetected: false };

  stats.detected++;
  history.length = 0;

  if (opts.logOnly) {
    console.log('[loopguard] ' + detectedKind + ' loop detected, log-only mode');
    return { body: responseBody, loopDetected: true };
  }

  stats.broken++;

  try {
    const data = JSON.parse(responseBody);
    const toolName = toolUse.name || 'unknown';
    const toolInput = JSON.stringify(toolUse.input || {}).slice(0, 200);
    let loopMsg;
    if (detectedKind === 'no-delta') {
      loopMsg = 'LOOP DETECTED (no codebase progress): You called `' + toolName + '` on `' + filePath +
        '` ' + NO_DELTA_THRESHOLD + ' times but the file content has not changed.\n\n' +
        'This means your edits are not being applied OR you are reading the same file without acting.\n\n' +
        'REQUIRED:\n' +
        '1. STOP. Re-read the file to see ACTUAL current content.\n' +
        '2. If editing: your old_string is wrong — copy it EXACTLY from the latest Read.\n' +
        '3. If exploring: stop reading the same file. Move to a different file or take action.\n' +
        '4. Consider: maybe the approach is wrong. Step back and reconsider.';
    } else {
      loopMsg = 'LOOP DETECTED: You called `' + toolName + '` with the same arguments ' +
        LOOP_THRESHOLD + ' times. The approach is failing.\n\n' +
        'Last attempt: ' + toolName + '(' + toolInput + ')\n\n' +
        'REQUIRED RECOVERY:\n' +
        '1. STOP. Do not retry the same action.\n' +
        '2. Read the actual current state of the file/system.\n' +
        '3. Identify why the action keeps failing (read the error output).\n' +
        '4. Try a DIFFERENT approach, not a tweak of the same one.\n' +
        '5. If stuck on a bug: reconsider the entire approach.';
    }

    if (data.content && Array.isArray(data.content)) {
      data.content = data.content.filter(b => b.type !== 'tool_use');
      data.content.push({ type: 'text', text: loopMsg });
      data.stop_reason = 'end_turn';
    }
    if (data.choices) {
      data.choices[0].message.content = loopMsg;
      data.choices[0].message.tool_calls = undefined;
      data.choices[0].finish_reason = 'stop';
    }

    return { body: JSON.stringify(data), loopDetected: true, kind: detectedKind };
  } catch (e) {
    return { body: responseBody, loopDetected: false };
  }
}

function getStats() { return stats; }
function resetHistory() { history.length = 0; }

module.exports = { checkLoop, getStats, resetHistory };
