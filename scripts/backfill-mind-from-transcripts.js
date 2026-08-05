#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Bulk-import historical Claude Code chat transcripts into the mind mind
// substrate. Heuristic: scans user/assistant turns for decision-language
// markers, extracts the surrounding sentence, writes a mind_decision
// record with the ORIGINAL timestamp. Pre-creates a project per cwd if
// one doesn't already exist.
//
// Usage:
//   node scripts/backfill-mind-from-transcripts.js [--dry] [--limit N] <session.jsonl> [<session.jsonl> ...]
//
// Flags:
//   --dry       Print what would be written; no DB writes.
//   --limit N   Cap decisions written per session (default 30).

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const state    = require('../shared-core/state.js');
const mind     = require('../shared-core/mind-state.js');
const sharedAR = require('../shared-core/action-record.js');

const DEC_MARKERS = [
  // English
  /\b(decided|deciding|going with|chose|choosing|will go with|locked? in|locking|locked)\b/i,
  /\b(rejected|reject|won['’]t|won t|abandon(ing|ed)?|drop(ped|ping)?)\b/i,
  /\b(let['’]s go with|let['’]s do|let['’]s ship|let['’]s try)\b/i,
  // Spec-style
  /\bP\d+:\s/i,
  /\bQ-?\d+:\s/i,
  // Greek
  /(αποφάσισα|αποφασίσαμε|πάμε με|λοκάρω|δίκιο σου|τελειωμένο|απορρίπτουμε|απέρριψα)/i
];

function parseArgs(argv) {
  const opts = { dry: false, limit: 30, files: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') opts.dry = true;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || 30;
    else opts.files.push(a);
  }
  return opts;
}

function deriveProject(cwd, sessionText) {
  // Reject the user's home dir as a project signal — sessions launched
  // from $HOME shouldn't bind to a "alice" / "bob" project.
  const HOME = require('os').homedir();
  if (cwd && cwd !== HOME && cwd !== '/' && path.dirname(cwd) !== '/') {
    const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (base) return { id: base, name: path.basename(cwd) };
  }
  if (!sessionText) return { id: 'general', name: 'General' };
  const lower = sessionText.toLowerCase();
  // Layer 1: known-keyword vote (fast path for canonical projects).
  const candidates = [
    { id: 'troth',      name: 'troth',      re: /(troth)/g },
    // EXAMPLE matchers. Replace with your own project ids and patterns:
    { id: 'atlasforge',   name: 'AtlasForge',   re: /\b(atlasforge|atlas ?forge)\b/g },
  ];
  let best = null, bestN = 0;
  for (const c of candidates) {
    const m = lower.match(c.re);
    const n = m ? m.length : 0;
    if (n > bestN && n >= 3) { best = c; bestN = n; }
  }
  if (best) return { id: best.id, name: best.name };
  // Layer 2: scan text for $HOME/<dirname> mentions, pick the most
  // frequent. Common when the session asks about a specific project path
  // even though cwd was the home dir. Build the regex from $HOME so this
  // works for any user, not just one developer's machine.
  const pathHits = new Map();
  const homeEsc = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${homeEsc}/([A-Za-z][A-Za-z0-9_.-]+)`, 'g');
  let m;
  while ((m = re.exec(sessionText)) !== null) {
    const dir = m[1].toLowerCase();
    if (dir === 'documents' || dir === 'downloads' || dir === '.claude') continue;
    pathHits.set(dir, (pathHits.get(dir) || 0) + 1);
  }
  let topDir = null, topN = 0;
  for (const [k, v] of pathHits.entries()) {
    if (v > topN && v >= 2) { topDir = k; topN = v; }
  }
  if (topDir) {
    const id = topDir.replace(/[^a-z0-9]+/g, '-');
    return { id, name: topDir };
  }
  // Layer 3: catch-all bucket so historical signal isn't lost.
  return { id: 'general', name: 'General' };
}

function getText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

function splitSentences(text) {
  return text.split(/(?<=[.!?。\n])\s+/).map(s => s.trim()).filter(Boolean);
}

function extractDecisions(text, ts) {
  const out = [];
  const sentences = splitSentences(text);
  const seen = new Set();
  for (const s of sentences) {
    if (s.length < 20 || s.length > 400) continue;
    const matched = DEC_MARKERS.some(re => re.test(s));
    if (!matched) continue;
    const norm = s.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ summary: s.slice(0, 240), ts });
  }
  return out;
}

function processSession(filePath, opts, projectsCreated) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let cwd = null;
  let firstTs = null;
  let lastTs = null;
  const candidates = [];
  const userPrompts = []; // {ts, text} — for first/last fallback
  let allText = '';

  for (const ln of lines) {
    if (!ln.trim()) continue;
    let d;
    try { d = JSON.parse(ln); } catch { continue; }
    if (d.cwd && !cwd) cwd = d.cwd;
    const role = d.message && d.message.role || d.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    if (!ts) continue;
    if (!firstTs) firstTs = ts;
    lastTs = ts;
    const text = getText(d.message || d);
    if (!text) continue;
    if (allText.length < 100000) allText += '\n' + text;
    for (const dec of extractDecisions(text, ts)) {
      candidates.push({ ...dec, role });
    }
    // Track substantive user prompts (>30 chars, not a tool-result echo
    // or system-reminder) for the first/last fallback when the session
    // has no explicit decision-language.
    if (role === 'user') {
      const trimmed = text.trim();
      const isNoise = trimmed.startsWith('<') ||
                      trimmed.startsWith('[Request interrupted') ||
                      trimmed.length < 30;
      if (!isNoise) userPrompts.push({ ts, text: trimmed.slice(0, 240) });
    }
  }
  // Fallback: if no decision-language found, surface the session's
  // bookend user prompts so orientation has SOMETHING for this date.
  // Marked with a distinct role tag so we can filter later if noisy.
  if (candidates.length === 0 && userPrompts.length > 0) {
    candidates.push({
      ts: userPrompts[0].ts,
      summary: 'Started: ' + userPrompts[0].text,
      role: 'session-bookend'
    });
    if (userPrompts.length > 1 && userPrompts[userPrompts.length - 1].ts !== userPrompts[0].ts) {
      candidates.push({
        ts: userPrompts[userPrompts.length - 1].ts,
        summary: 'Wrapped: ' + userPrompts[userPrompts.length - 1].text,
        role: 'session-bookend'
      });
    }
  }

  const project = deriveProject(cwd, allText);
  // If project came from text vote (not from cwd), use that project's
  // canonical cwd so all backfilled decisions land in the same bucket.
  // Map known projects to their canonical cwd. Override via env for
  // non-default home dirs:
  //   TROTH_BACKFILL_HOME=/path/to/projects (default $HOME)
  //   TROTH_BACKFILL_DOCS=$HOME/Documents (default)
  const backfillHome = process.env.TROTH_BACKFILL_HOME || process.env.HOME || '';
  const backfillDocs = process.env.TROTH_BACKFILL_DOCS || (backfillHome + '/Documents');
  if (project && (!cwd || cwd === backfillHome)) {
    if (project.id === 'troth')        cwd = backfillDocs + '/troth';
    else if (project.id === 'atlasforge') cwd = backfillDocs + '/atlasforge';
    else cwd = backfillHome + '/' + project.name; // best-guess fallback
  }
  const sessionLabel = path.basename(filePath, '.jsonl').slice(0, 8);
  const summary = {
    session: sessionLabel,
    cwd, project_id: project && project.id,
    first: firstTs && new Date(firstTs).toISOString().slice(0, 16),
    last:  lastTs  && new Date(lastTs).toISOString().slice(0, 16),
    found: candidates.length,
    will_write: 0, written: 0
  };

  if (!project || !cwd) {
    summary.skip = 'no project derivable from cwd';
    return summary;
  }

  // Cap; prefer most recent N
  const capped = candidates.slice(-opts.limit);
  summary.will_write = capped.length;

  // Pre-create project if not seen this run
  if (!projectsCreated.has(project.id)) {
    projectsCreated.set(project.id, project);
    if (!opts.dry) {
      const empty = mind.emptyMindState('default');
      empty.active_projects = [{
        id: project.id, name: project.name,
        stage: 'historical',
        current_focus: 'Backfilled from transcript ' + sessionLabel,
        audience: '', key_decisions: [], open_questions: [],
        constraints: [], collaborators: []
      }];
      const built = mind.buildSnapshotRecord({
        id: crypto.randomUUID(), timestamp: firstTs || Date.now(),
        agent_id: 'backfill', cwd,
        mind_state: empty, trigger: 'backfill_init', prev_snapshot_id: null
      });
      if (built.ok) {
        state.recordAction(built.record, sharedAR.toSearchText(built.record));
      }
    }
  }

  for (const c of capped) {
    const rec = {
      id: crypto.randomUUID(),
      timestamp: c.ts,
      type: 'decision',
      agent_id: 'backfill',
      session_id: null, user_id: null,
      cwd,
      parent_id: null,
      context_hash: null,
      input: {
        kind: 'mind_decision',
        signals: {
          project_id: project.id,
          summary: c.summary,
          rationale: '(backfilled from transcript ' + sessionLabel + ', role=' + c.role + ')'
        }
      },
      output: { decision: 'recorded', reason: 'backfill_heuristic' },
      verification: {}, outcome: {}
    };
    if (!opts.dry) {
      const id = state.recordAction(rec, c.summary);
      if (id) summary.written++;
    }
  }

  return summary;
}

(function main() {
  const opts = parseArgs(process.argv);
  if (opts.files.length === 0) {
    console.error('usage: node scripts/backfill-mind-from-transcripts.js [--dry] [--limit N] <session.jsonl>...');
    process.exit(1);
  }
  console.log('Mode:', opts.dry ? 'DRY-RUN' : 'WRITE', '| limit:', opts.limit);
  const projectsCreated = new Map();
  const summaries = [];
  for (const f of opts.files) {
    if (!fs.existsSync(f)) { console.error('  ! missing:', f); continue; }
    summaries.push(processSession(f, opts, projectsCreated));
  }
  console.log('\n== Per-session summary ==');
  for (const s of summaries) console.log(' ', JSON.stringify(s));
  console.log('\nProjects touched:', Array.from(projectsCreated.values())
    .map(p => p.id + ' (' + p.name + ')').join(', ') || '(none)');

  // Force a fold so /show reflects backfilled decisions
  if (!opts.dry) {
    for (const project of projectsCreated.values()) {
      const cwds = new Set(summaries.filter(s => s.project_id === project.id).map(s => s.cwd));
      for (const cwd of cwds) {
        const out = mind.recomputeFromSubstrate(state, { cwd });
        const built = mind.buildSnapshotRecord({
          id: crypto.randomUUID(), timestamp: Date.now(),
          agent_id: 'backfill', cwd,
          mind_state: out.mind_state, trigger: 'backfill_fold',
          prev_snapshot_id: out.prev_snapshot_id
        });
        if (built.ok) {
          state.recordAction(built.record, sharedAR.toSearchText(built.record));
          console.log('  ✓ persisted fold for', project.id, 'in', cwd,
            '— decisions:', (out.mind_state.active_projects.find(p => p.id === project.id) || {}).key_decisions?.length || 0);
        }
      }
    }
  }
})();
