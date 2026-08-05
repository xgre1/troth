// SPDX-License-Identifier: AGPL-3.0-only
// Reflexion — verbal self-reflection on failures.
//
// Research [MoA]: Actor + Evaluator + Reflect pattern.
// Benefits: +10.9% HumanEval, 2x LeetcodeHardGym, 80%→91% Python.
//
// Pattern:
//   1. Actor generates code/action (Claude Code via proxy)
//   2. Evaluator detects failure (tool_result.is_error from Claude Code's tools)
//   3. Self-Reflection: Flash generates verbal cue about what went wrong
//   4. Reflection stored in episodic memory (SQLite)
//   5. Next request injects relevant reflections into system prompt
//
// Difference from critic.recordFailure:
//   - Critic records raw error text
//   - Reflexion generates a VERBAL LESSON (one sentence: "I tried X, it failed
//     because Y. Next time I should Z.")
//   - Reflexion persists across proxy restarts (SQLite)
//   - Reflexion injects relevant lessons into next turn's system prompt

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const HOME = process.env.HOME || require('os').homedir();
const DB_DIR = path.join(HOME, '.troth');
// Per-project namespacing: hash CWD so different projects keep separate
// reflexion stores. Lessons from project A don't pollute project B.
const projectKey = require('crypto').createHash('sha256')
  .update(process.env.GF_WATCH_DIR || process.cwd())
  .digest('hex').slice(0, 12);
const DB_PATH = path.join(DB_DIR, 'reflexion-' + projectKey + '.db');

let db = null;
let stats = { reflectionsStored: 0, reflectionsInjected: 0, asyncJobsActive: 0 };

function init() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS reflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signature TEXT NOT NULL,
        tool TEXT,
        file_path TEXT,
        error_summary TEXT,
        reflection TEXT NOT NULL,
        ts INTEGER NOT NULL,
        used_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_signature ON reflections(signature);
      CREATE INDEX IF NOT EXISTS idx_ts ON reflections(ts DESC);
    `);
    // Prune reflections older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM reflections WHERE ts < ?').run(cutoff);
  } catch (e) {
    console.error('[reflexion] init failed:', e.message);
    db = null;
  }
}

// Compute a stable signature for a failure so we can detect repeats
function failureSignature(toolName, filePath, errorText) {
  const crypto = require('crypto');
  // Normalize: tool + last path segment + first 100 chars of error
  const fileBase = filePath ? path.basename(filePath) : '';
  const errorNorm = (errorText || '').replace(/\d+/g, 'N').replace(/\s+/g, ' ').slice(0, 100);
  return crypto.createHash('sha256').update(toolName + '|' + fileBase + '|' + errorNorm).digest('hex').slice(0, 16);
}

// Check if we've already reflected on this exact failure
function hasReflectedOn(signature) {
  if (!db) return false;
  try {
    const row = db.prepare('SELECT 1 FROM reflections WHERE signature = ? LIMIT 1').get(signature);
    return !!row;
  } catch (e) { return false; }
}

// Generate a verbal reflection via Flash (async, fire-and-forget)
function generateReflection(toolName, filePath, errorText, contextHint) {
  if (!db) return;
  const signature = failureSignature(toolName, filePath, errorText);
  if (hasReflectedOn(signature)) return; // already learned this lesson

  stats.asyncJobsActive++;
  try {
    const callFlash = require('./router').callFlash;
    if (!callFlash) { stats.asyncJobsActive--; return; }

    const prompt =
      "You are the agent's self-reflection module. A tool call just FAILED.\n\n" +
      "Tool: " + toolName + "\n" +
      "File: " + (filePath || '(none)') + "\n" +
      "Error: " + (errorText || '').slice(0, 800) + "\n" +
      (contextHint ? "Context: " + contextHint.slice(0, 500) + "\n" : "") +
      "\nWrite ONE concise sentence (under 30 words) as a lesson learned for next time.\n" +
      "Format: \"When [situation], avoid [mistake]; instead [correct approach].\"\n" +
      "Example: \"When editing files I haven't read this turn, use Read first; old_string from memory often mismatches.\"\n" +
      "Output ONLY the sentence. No preamble, no explanation.";

    callFlash(prompt).then(function(reflection) {
      stats.asyncJobsActive--;
      if (!reflection || reflection.length < 20 || reflection.length > 300) return;
      const cleaned = reflection.trim().replace(/^["']|["']$/g, '');
      try {
        db.prepare(
          'INSERT INTO reflections (signature, tool, file_path, error_summary, reflection, ts) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(signature, toolName, filePath || null, (errorText || '').slice(0, 200), cleaned, Date.now());
        stats.reflectionsStored++;
        console.log('[reflexion] Stored: ' + cleaned.slice(0, 80));
      } catch (e) {}
    }).catch(function() { stats.asyncJobsActive--; });
  } catch (e) { stats.asyncJobsActive--; }
}

// Get reflections relevant to the current task. Returns array of { reflection, used_count }.
// Strategy: most recent + most-used reflections (cap N).
function getRelevantReflections(limit) {
  if (!db) return [];
  limit = limit || 6;
  try {
    const recent = db.prepare(
      'SELECT id, reflection, used_count, ts FROM reflections ORDER BY ts DESC LIMIT ?'
    ).all(limit);
    // Increment used_count
    for (const r of recent) {
      try { db.prepare('UPDATE reflections SET used_count = used_count + 1 WHERE id = ?').run(r.id); } catch (e) {}
    }
    if (recent.length) stats.reflectionsInjected += recent.length;
    return recent.map(function(r) { return r.reflection; });
  } catch (e) { return []; }
}

// Build the injection block for system prompt
function buildReflectionBlock() {
  const reflections = getRelevantReflections(6);
  if (!reflections.length) return null;
  return "## Lessons Learned (from past failures)\n" +
    reflections.map(function(r) { return '- ' + r; }).join('\n') +
    "\n\nApply these lessons proactively.";
}

// Hook for critic.learnFromRequest — call this when a tool failure is detected
function reflectOnFailure(toolName, filePath, errorText, contextHint) {
  generateReflection(toolName, filePath, errorText, contextHint);
}

function getStats() {
  if (!db) return { ...stats, totalStored: 0 };
  try {
    const total = db.prepare('SELECT COUNT(*) as n FROM reflections').get().n;
    return { ...stats, totalStored: total };
  } catch (e) { return stats; }
}

init();

module.exports = { reflectOnFailure, buildReflectionBlock, getRelevantReflections, getStats };
