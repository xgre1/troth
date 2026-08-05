// SPDX-License-Identifier: AGPL-3.0-only
// Shadow Git Checkpoints — Cline-style atomic rollback safety net.
//
// Research [Plan]: every tool call/file write = discrete shadow checkpoint.
// On critical failure: roll back to pristine pre-edit state.
//
// We use git stash as the lightweight checkpoint mechanism. Doesn't pollute
// commit history. Each Write/Edit creates a stash, named with timestamp.
// If subsequent tool_result indicates failure (e.g., test crashed, syntax
// error), the user can roll back via troth CLI or dashboard.
//
// This is opt-in (only fires for projects that ARE git repos).

const { execFileSync } = require('child_process');
const { gitOk } = require('../../shared-core/git-ok.js');
const path = require('path');

let stats = { checkpointed: 0, rollbacks: 0, skipped: 0 };
const checkpoints = []; // [{ stashRef, msg, ts, files: [...] }]
const MAX_CHECKPOINTS = 20;

function isGitRepo(dir) {
  // Popup-free CLT gate: on a fresh Mac /usr/bin/git is a shim whose mere
  // execution opens the developer-tools dialog.
  if (!gitOk()) return false;
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'pipe', timeout: 1000 });
    return true;
  } catch (e) { return false; }
}

function hasChanges(dir) {
  if (!gitOk()) return false;
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'pipe', timeout: 2000 }).toString();
    return out.trim().length > 0;
  } catch (e) { return false; }
}

// Create a checkpoint (git stash) before an upcoming write
// Returns the checkpoint ID (timestamp) or null on failure.
function checkpoint(dir, msg, files) {
  if (!dir) return null;
  if (!isGitRepo(dir)) { stats.skipped++; return null; }
  if (!hasChanges(dir)) { return null; } // nothing to stash, no checkpoint needed

  try {
    const stashMsg = 'troth-checkpoint:' + Date.now() + ':' + (msg || 'pre-edit');
    execFileSync('git', ['-C', dir, 'stash', 'push', '-u', '-m', stashMsg], { stdio: 'pipe', timeout: 5000 });
    // Re-apply immediately so workspace continues to have the changes,
    // but the stash entry remains as a rollback point.
    execFileSync('git', ['-C', dir, 'stash', 'apply', '--quiet'], { stdio: 'pipe', timeout: 5000 });
    const ts = Date.now();
    checkpoints.push({ stashRef: stashMsg, msg, ts, files: files || [], dir });
    if (checkpoints.length > MAX_CHECKPOINTS) {
      // Drop oldest checkpoint (also drop the stash entry)
      const old = checkpoints.shift();
      try {
        // Find and drop matching stash
        const list = execFileSync('git', ['-C', old.dir, 'stash', 'list'], { stdio: 'pipe', timeout: 2000 }).toString();
        const lines = list.split('\n');
        for (const line of lines) {
          if (line.indexOf(old.stashRef) >= 0) {
            const ref = line.split(':')[0];
            try { execFileSync('git', ['-C', old.dir, 'stash', 'drop', ref], { stdio: 'pipe' }); } catch (e) {}
            break;
          }
        }
      } catch (e) {}
    }
    stats.checkpointed++;
    return ts;
  } catch (e) {
    return null;
  }
}

// Rollback to most recent checkpoint
function rollback(dir, count) {
  count = count || 1;
  if (!dir) return false;
  if (!isGitRepo(dir)) return false;
  try {
    // Discard current changes, apply most recent troth stash
    const list = execFileSync('git', ['-C', dir, 'stash', 'list'], { stdio: 'pipe', timeout: 2000 }).toString();
    const lines = list.split('\n').filter(l => l.indexOf('troth-checkpoint:') >= 0);
    if (!lines.length) return false;
    const targetLine = lines[count - 1] || lines[0];
    const ref = targetLine.split(':')[0];
    execFileSync('git', ['-C', dir, 'checkout', '--', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'stash', 'apply', ref], { stdio: 'pipe' });
    stats.rollbacks++;
    return true;
  } catch (e) { return false; }
}

function listCheckpoints() {
  return checkpoints.slice().reverse(); // newest first
}

function getStats() { return stats; }

module.exports = { checkpoint, rollback, listCheckpoints, getStats, isGitRepo };
