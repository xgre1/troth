#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// backfill-claude-sessions — one-shot import of historical Claude Code sessions.
//
// The operator's collaboration history with Claude Code lives in
// ~/.claude/projects/<encoded-cwd>/*.jsonl. Each file is a streaming
// transcript: `type: 'user'` lines carry the user's prompt as a plain
// string; `type: 'assistant'` lines carry the model's reply as an
// array of content blocks (text, tool_use, tool_result). For substrate
// dialogue purposes we pair each user message with the immediately
// following assistant TEXT content (tool blocks are scaffolding, not
// collaborator dialogue) and call dialogueMemory.recordTurn so the
// substrate's L1 captures the conversation.
//
// Idempotency: a marker file at ~/.troth/.backfill-cursor.json
// records, per session id, the highest timestamp already ingested.
// Re-runs skip turns at-or-before that cursor. Atomic temp+rename
// writes so a crash mid-checkpoint can't corrupt the marker.
//
// Privacy: every user_text and assistant_text passes through
// proxy/modules/secrets.redact() before any L1 write. Patterns
// covered: sk-*, sk-ant-*, AKIA*, ghp_*, AIza*, JWTs, private-key
// blocks, Bearer tokens, password=... in URLs. Belt-and-suspenders.
//
// Noise stripping: Claude Code injects synthetic blocks into user
// turns (system-reminder, task-notification, command-name, etc.).
// These are runtime-only — they aren't real user content and
// shouldn't land in dialogue memory. stripUserNoise() removes the
// known wrappers before the redact pass.
//
// Active-session safety: the file currently being written by this
// very Claude Code conversation will be tail-appended. The cursor
// timestamp protects against re-ingesting partial / future turns —
// only complete pairs strictly newer than the cursor are written.
//
// Usage:
//   node tools/backfill-claude-sessions.js                  # default agent_id from env TROTH_ENTITY_AGENT_ID, max 10000
//   node tools/backfill-claude-sessions.js --max 500
//   node tools/backfill-claude-sessions.js --agent my-agent-id
//   node tools/backfill-claude-sessions.js --dry-run        # count only, no writes

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const dialogueMemory = require('../shared-core/dialogue-memory.js');
const secrets        = require('../proxy/modules/secrets.js');
const { resolveAgentId } = require('../shared-core/agent-id.js');

// Claude Code encodes the project's cwd as a directory under
// ~/.claude/projects/ by replacing every '/' with '-'. For cwd=$HOME the
// dir is e.g. '-Users-alice' on macOS, '-home-alice' on Linux. Deriving
// from $HOME (rather than hardcoding) is what makes this OSS-installable.
const HOME = process.env.HOME || require('os').homedir();
const ENCODED_HOME = HOME.replace(/\//g, '-');
const SESSIONS_DIR  = path.join(HOME, '.claude/projects/' + ENCODED_HOME);
const MARKER_PATH   = path.join(HOME, '.troth/.backfill-cursor.json');
const DEFAULT_AGENT = resolveAgentId();
const DEFAULT_MAX   = 10000;
const MAX_TEXT_CHARS = 8000;     // per turn cap so L1 rows stay sane
const MIN_TEXT_CHARS = 2;        // skip empty/whitespace-only

// ── Marker file ────────────────────────────────────────────────────────

function loadMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); }
  catch (_) { return {}; }
}
function saveMarker(m) {
  try {
    fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true, mode: 0o700 });
    const tmp = MARKER_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, MARKER_PATH);
  } catch (e) { console.error('[backfill] marker save failed:', e.message); }
}

// ── Noise stripping ────────────────────────────────────────────────────

const NOISE_RE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g
];
function stripUserNoise(text) {
  let t = String(text || '');
  for (const re of NOISE_RE) t = t.replace(re, '');
  return t.trim();
}

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

// ── Per-file processing ────────────────────────────────────────────────

async function processFile(filePath, marker, opts) {
  const sessionId = path.basename(filePath, '.jsonl');
  const sinceTs   = marker[sessionId] || 0;
  const dryRun    = !!opts.dry_run;
  const maxRemaining = opts.max != null ? opts.max : Infinity;
  let pendingUser = null;       // { text, ts }
  let written = 0, redacted = 0, skipped = 0;
  let maxTsSeen = sinceTs;

  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (written >= maxRemaining) { rl.close(); stream.destroy(); break; }
    if (!line || !line.length) continue;
    let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (ts && ts <= sinceTs) continue;          // already ingested
    if (ts && ts > maxTsSeen) maxTsSeen = ts;

    if (obj.type === 'user' && obj.message && obj.message.role === 'user') {
      const raw = typeof obj.message.content === 'string' ? obj.message.content : '';
      const cleaned = stripUserNoise(raw);
      if (cleaned.length < MIN_TEXT_CHARS) { skipped++; continue; }
      pendingUser = { text: cleaned, ts, cwd: obj.cwd || null };
    } else if (obj.type === 'assistant' && obj.message) {
      const text = extractAssistantText(obj.message);
      if (text.length < MIN_TEXT_CHARS) { skipped++; continue; }
      if (!pendingUser) { skipped++; continue; }
      // Pair found — redact + record
      const redactedUser = secrets.redact(pendingUser.text);
      const redactedAsst = secrets.redact(text);
      if (redactedUser !== pendingUser.text || redactedAsst !== text) redacted++;
      if (!dryRun) {
        const ok = dialogueMemory.recordTurn({
          agent_id:       opts.agent_id || DEFAULT_AGENT,
          cwd:            pendingUser.cwd || obj.cwd || null,
          user_id:        'default',
          user_text:      redactedUser.slice(0, MAX_TEXT_CHARS),
          assistant_text: redactedAsst.slice(0, MAX_TEXT_CHARS),
          faculty:        'claude-code',
          elapsed_ms:     (pendingUser.ts && ts) ? (ts - pendingUser.ts) : null
        });
        if (ok) written++;
      } else {
        written++; // dry-run still counts pairings
      }
      pendingUser = null;
    }
    // Other types (system, attachment, file-history-snapshot,
    // permission-mode, last-prompt) are scaffolding — ignore.
  }
  if (!dryRun) marker[sessionId] = maxTsSeen;
  return { sessionId, written, redacted, skipped, marker_advanced_to: maxTsSeen };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const argVal = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
  const max     = parseInt(argVal('--max', String(DEFAULT_MAX))) || DEFAULT_MAX;
  const agent   = argVal('--agent', DEFAULT_AGENT);
  const dryRun  = args.includes('--dry-run');

  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error('[backfill] sessions dir missing:', SESSIONS_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(SESSIONS_DIR, f))
    .sort((a, b) => {
      try { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; }
      catch (_) { return 0; }
    });   // oldest first — chronological L1 order

  console.error('[backfill] sessions=' + files.length + '  agent=' + agent +
                '  max=' + max + (dryRun ? '  DRY-RUN' : ''));
  const marker = loadMarker();
  let totalWritten = 0, totalRedacted = 0, totalSkipped = 0;
  for (const f of files) {
    const remaining = max - totalWritten;
    if (remaining <= 0) break;
    const r = await processFile(f, marker, { agent_id: agent, max: remaining, dry_run: dryRun });
    totalWritten  += r.written;
    totalRedacted += r.redacted;
    totalSkipped  += r.skipped;
    console.error('[backfill] ' + r.sessionId.slice(0, 8) +
                  '  written=' + r.written +
                  '  redacted=' + r.redacted +
                  '  skipped=' + r.skipped);
    if (!dryRun) saveMarker(marker);   // checkpoint per file
  }
  console.error('--- TOTAL ---');
  console.error('  written:  ' + totalWritten);
  console.error('  redacted: ' + totalRedacted);
  console.error('  skipped:  ' + totalSkipped);
  console.log(JSON.stringify({ written: totalWritten, redacted: totalRedacted, skipped: totalSkipped, dry_run: dryRun, agent }, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}

module.exports = { stripUserNoise, extractAssistantText, processFile };
