// SPDX-License-Identifier: AGPL-3.0-only
// Trajectory recycling — SWE-Replay pattern.
//
// Research: -17.4% tokens, +3.8% quality on SWE-Bench Verified.
// Idea: when agent succeeds at a task, record the (prompt, tool_sequence,
// outcome) tuple. On a similar future task, inject the prior trajectory as
// "this worked last time" prior art. Skips re-exploration.
//
// We record successful tool sequences when the conversation ENDS with success
// signals (no error in last tool_results, agent stopped with end_turn).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const HOME = process.env.HOME || require('os').homedir();
const DB_DIR = path.join(HOME, '.troth');
// Per-project namespacing — successful patterns are project-specific
const projectKey = require('crypto').createHash('sha256')
  .update(process.env.GF_WATCH_DIR || process.cwd())
  .digest('hex').slice(0, 12);
const DB_PATH = path.join(DB_DIR, 'trajectories-' + projectKey + '.db');

let db = null;
let stats = { recorded: 0, retrieved: 0 };

function init() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS trajectories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        keywords TEXT NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        prompt_text TEXT NOT NULL,
        tool_sequence TEXT NOT NULL,
        success INTEGER DEFAULT 1,
        ts INTEGER NOT NULL,
        used_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_traj_keywords ON trajectories(keywords);
      CREATE INDEX IF NOT EXISTS idx_traj_ts ON trajectories(ts DESC);
    `);
    // Prune trajectories older than 60 days
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM trajectories WHERE ts < ?').run(cutoff);
  } catch (e) {
    console.error('[trajectory] init failed:', e.message);
    db = null;
  }
}

const STOP_WORDS = new Set(['the','a','an','to','of','in','on','for','and','or','but','with','this','that','it','is','are','was','were','be','been','have','has','had','do','does','did','will','would','should','could','can','i','you','your','my']);

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 12)
    .sort();
}

function computeSignature(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

// Compact tool sequence for storage: [{tool, file?, op?}, ...]
function compactToolSequence(messages) {
  const seq = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const c = Array.isArray(msg.content) ? msg.content : [];
    for (const block of c) {
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      const entry = { tool: block.name };
      if (input.file_path) entry.file = path.basename(input.file_path);
      if (input.command) entry.cmd = input.command.slice(0, 80);
      if (input.pattern) entry.pattern = input.pattern.slice(0, 60);
      seq.push(entry);
    }
  }
  return seq;
}

// Detect if the conversation appears successful (no recent errors)
function looksSuccessful(messages) {
  if (!messages || messages.length < 4) return false;
  // Check last 4 messages for tool_result errors
  const recent = messages.slice(-6);
  for (const msg of recent) {
    if (msg.role !== 'user') continue;
    const c = Array.isArray(msg.content) ? msg.content : [];
    for (const block of c) {
      if (block && block.type === 'tool_result' && block.is_error) return false;
    }
  }
  return true;
}

// Extract the user's original task from the conversation
function extractTaskPrompt(messages) {
  if (!messages || !messages.length) return null;
  // First user message with substantial text
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const c = msg.content;
    if (typeof c === 'string' && c.length > 30) return c.slice(0, 1000);
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block && block.type === 'text' && block.text && block.text.length > 30) {
          return block.text.slice(0, 1000);
        }
      }
    }
  }
  return null;
}

// Called periodically (e.g. on long conversations) to record trajectory
function recordIfSuccessful(bodyStr) {
  if (!db) return;
  try {
    const data = JSON.parse(bodyStr);
    const msgs = data.messages || [];
    if (msgs.length < 6) return; // need a meaningful trajectory
    if (!looksSuccessful(msgs)) return;

    const taskPrompt = extractTaskPrompt(msgs);
    if (!taskPrompt) return;

    const seq = compactToolSequence(msgs);
    if (seq.length < 2) return;

    const signature = computeSignature(taskPrompt);
    const keywords = extractKeywords(taskPrompt).join(',');
    const seqJson = JSON.stringify(seq);

    db.prepare(
      'INSERT OR IGNORE INTO trajectories (keywords, signature, prompt_text, tool_sequence, success, ts) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(keywords, signature, taskPrompt, seqJson, Date.now());
    stats.recorded++;
  } catch (e) {}
}

// Find similar past successful trajectory for a new task prompt
function findSimilarTrajectory(taskPrompt, maxResults) {
  if (!db || !taskPrompt) return [];
  maxResults = maxResults || 1;
  try {
    const keywords = extractKeywords(taskPrompt);
    if (keywords.length < 2) return [];

    // Score each stored trajectory by keyword overlap
    const all = db.prepare('SELECT id, prompt_text, tool_sequence, keywords, used_count FROM trajectories WHERE success = 1 ORDER BY ts DESC LIMIT 200').all();
    const scored = all.map(function(t) {
      const tk = t.keywords.split(',');
      const overlap = keywords.filter(k => tk.includes(k)).length;
      return { traj: t, score: overlap };
    }).filter(x => x.score >= 2).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, maxResults);
    for (const t of top) {
      try { db.prepare('UPDATE trajectories SET used_count = used_count + 1 WHERE id = ?').run(t.traj.id); } catch (e) {}
    }
    if (top.length) stats.retrieved++;
    return top.map(t => ({ prompt: t.traj.prompt_text, sequence: JSON.parse(t.traj.tool_sequence), score: t.score }));
  } catch (e) { return []; }
}

// Build injection block for new task — shows top similar past trajectory
function buildTrajectoryHint(taskPrompt) {
  const matches = findSimilarTrajectory(taskPrompt, 1);
  if (!matches.length) return null;
  const m = matches[0];
  const seqText = m.sequence.slice(0, 12).map(function(s, i) {
    let line = (i + 1) + '. ' + s.tool;
    if (s.file) line += ' (' + s.file + ')';
    if (s.cmd) line += ': ' + s.cmd;
    return line;
  }).join('\n');
  return "## Prior Successful Trajectory (similar task succeeded with these steps)\n" +
    "Previous task: \"" + m.prompt.slice(0, 200) + "...\"\n" +
    "Tools used:\n" + seqText + "\n\n" +
    "Use as guidance — adapt to current task. Skip steps that don't apply.";
}

function getStats() {
  if (!db) return { ...stats, totalStored: 0 };
  try {
    const total = db.prepare('SELECT COUNT(*) as n FROM trajectories').get().n;
    return { ...stats, totalStored: total };
  } catch (e) { return stats; }
}

init();

module.exports = { recordIfSuccessful, findSimilarTrajectory, buildTrajectoryHint, getStats };
