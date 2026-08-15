// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Did the work survive?
//
// `action-outcome.js` has answered this question since it was written:
// event-sourced, append-only, multi-observer, with a materialized fold. It
// works — exercised end to end before this file existed. It has never once
// been called. Measured 2026-08-11: 21,188 `edit` records in the substrate,
// **0 outcome events**, so the partner cannot tell you whether anything it has
// ever done worked. The module's own header names the observers it expected —
// "test runner marks accepted, critic marks reverted, commit hook marks
// led_to_commit" — and none of the three was ever built.
//
// This is the first observer. It is deterministic on purpose: no model call,
// no heuristic about intent, nothing that can be confidently wrong.
//
// WHY GIT AND NOT OUR OWN LEDGER. The obvious detector is the edit ledger
// itself: a later edit whose hash_after equals an earlier edit's hash_before
// IS a revert, provable from two rows. Measured before building: of 21,188
// edit records only **314** carry both hashes (different writers fill
// different fields — some carry hashes, 9.8% carry codelens entity ids,
// almost none carry both), and those 314 contain **zero** detectable reverts.
// A detector with no data is a detector that reports "all clear" forever, so
// revert-detection waits until the edit ledger is consistent. What git can
// answer today, it answers exactly: this file was committed after that edit.
//
// Scope, stated honestly: this speaks only for files inside a git repository.
// Of 693 distinct files edited in the last 30 days, 148 were in this repo and
// the rest live in other trees that may or may not be under version control.
// Files outside version control simply get no outcome — which is the truthful
// answer, not a guessed one.
const { execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Walk up for a .git. Returns the repo root or null. Cached per call batch —
// hundreds of edits usually share a handful of repos.
function repoRootOf(filePath, cache) {
  let dir = path.dirname(String(filePath || ''));
  if (!dir || dir === '.') return null;
  const seen = [];
  while (dir && dir !== path.dirname(dir)) {
    if (cache && cache.has(dir)) {
      const hit = cache.get(dir);
      for (const s of seen) cache.set(s, hit);
      return hit;
    }
    seen.push(dir);
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        if (cache) for (const s of seen) cache.set(s, dir);
        return dir;
      }
    } catch (_) { /* unreadable: treat as not-a-repo */ }
    dir = path.dirname(dir);
  }
  if (cache) for (const s of seen) cache.set(s, null);
  return null;
}

// The first commit touching `filePath` at or after `sinceMs`. Returns
// { sha, branch, ts } or null. One git call per (repo, file) — bounded by the
// caller's batch size, and `git log` on a single path is cheap.
function firstCommitAfter(repoRoot, filePath, sinceMs) {
  try {
    const iso = new Date(sinceMs).toISOString();
    const out = execFileSync('git', [
      '-C', repoRoot, 'log', '--since=' + iso, '--reverse',
      '--format=%H%x09%cI', '--max-count=1', '--', filePath
    ], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return null;
    const [sha, when] = out.split('\t');
    if (!sha) return null;
    let branch = null;
    try {
      branch = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (_) { branch = null; }
    return { sha, branch, ts: when ? Date.parse(when) : null };
  } catch (_) {
    return null; // not a repo, git absent, or the path was never tracked
  }
}

// Edits that have no outcome yet. `parent_id` on an outcome event points at
// the edit, so "already folded" is one lookup per candidate rather than a
// join — the volumes here are hundreds, not millions.
function pendingEdits(state, opts) {
  opts = opts || {};
  const limit  = Math.max(1, Math.min(500, opts.limit || 100));
  const olderThanMs = opts.settle_ms != null ? opts.settle_ms : 10 * 60 * 1000;
  const newerThanMs = opts.window_ms != null ? opts.window_ms : 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    return state._dbForQuery().prepare(`
      SELECT ar.id, ar.timestamp, json_extract(ar.input,'$.file_path') AS file_path
      FROM action_records ar
      WHERE ar.type = 'edit'
        AND json_extract(ar.input,'$.file_path') IS NOT NULL
        AND ar.timestamp < ?
        AND ar.timestamp > ?
        AND NOT EXISTS (
          SELECT 1 FROM action_records ev
          WHERE ev.parent_id = ar.id
            AND json_extract(ev.input,'$.kind') = 'outcome_event'
        )
      ORDER BY ar.timestamp DESC
      LIMIT ?
    `).all(now - olderThanMs, now - newerThanMs, limit) || [];
  } catch (_) { return []; }
}

// Fold one batch. Returns counts; never throws.
function foldOnce(state, opts) {
  opts = opts || {};
  const outcome = require('./action-outcome.js');
  const agent_id = opts.agent_id || 'outcome-fold';
  const rows = pendingEdits(state, opts);
  const repoCache = new Map();
  let linked = 0, unversioned = 0, uncommitted = 0;

  for (const row of rows) {
    const root = repoRootOf(row.file_path, repoCache);
    if (!root) { unversioned++; continue; }
    const hit = firstCommitAfter(root, row.file_path, row.timestamp);
    if (!hit) { uncommitted++; continue; }
    // A commit is the strongest survival signal available without asking
    // anyone: the change was kept, and kept deliberately.
    outcome.linkCommit(state, row.id, agent_id, {
      commit_sha: hit.sha, branch: hit.branch, source: 'outcome_fold', cwd: root
    });
    outcome.markAccepted(state, row.id, agent_id, {
      source: 'outcome_fold', cwd: root,
      note: 'committed as ' + String(hit.sha).slice(0, 8) + (hit.branch ? ' on ' + hit.branch : '')
    });
    linked++;
  }
  return { scanned: rows.length, linked, unversioned, uncommitted };
}

module.exports = { foldOnce, pendingEdits, repoRootOf, firstCommitAfter };
