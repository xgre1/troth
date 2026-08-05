// SPDX-License-Identifier: AGPL-3.0-only
// WAL replication.
//
// Continuous backup of the substrate state.db to an operator-configured
// remote target. Without this, partner mortality is bounded by SSD
// reliability — which is wrong for a years-of-living entity.
//
// V1 scope: SQLite online backup API (better-sqlite3 `db.backup`) to
// an operator-configured LOCAL PATH destination. The local path can be:
//   - A NAS mount (rsync'd / time-machined elsewhere)
//   - An rclone-mounted cloud bucket (S3 / Backblaze / Drive)
//   - A syncthing-watched folder
//   - A USB drive
// Direct cloud-SDK push (S3 / Backblaze HTTP) deferred to v2 — the
// local-path target covers 99% of operator setups via existing tools
// without bringing native SDK dependencies into the substrate.
//
// Backup semantics:
//   - SQLite's backup API respects WAL — captures a consistent snapshot
//     even while writes are in-flight. No need to pause the substrate.
//   - We write to dest + '.tmp' then rename to dest atomically, so a
//     crashed-mid-backup never leaves a torn file as the replica.
//   - Status is tracked in-memory by this module + optionally written
//     to a status engram for operator inspection.
//
// Cadence:
//   - Operator runs `troth replicate-wal --interval 60` for a 60s
//     loop, OR calls runOnce from a cron job, OR background-worker
//     picks up the task (Phase 3 reflection-tick wiring).

'use strict';

const fs   = require('fs');
const path = require('path');

const state = require('./state.js');

// Module-private status tracking. Wraps the operator dashboard's
// future "what's my partner's backup posture?" surface.
const _STATUS = {
  last_backup_ms:    null,
  last_backup_dest:  null,
  last_backup_size:  null,
  last_backup_error: null,
  consecutive_failures: 0
};

function status() {
  return Object.assign({}, _STATUS);
}

// Run one backup to dest. dest may be:
//   - An absolute filesystem path (file)
//   - A directory (we append default filename 'troth-state.db')
//
// Returns { ok, dest, bytes? } or { ok:false, error }.
async function runOnce(opts) {
  opts = opts || {};
  let dest = opts.dest;
  if (!dest || typeof dest !== 'string') {
    return { ok: false, error: 'dest_required' };
  }
  try {
    // If dest is a directory, append default filename.
    let resolvedDest = dest;
    try {
      const st = fs.statSync(dest);
      if (st && st.isDirectory()) {
        resolvedDest = path.join(dest, 'troth-state.db');
      }
    } catch (_) { /* dest doesn't exist yet — treat as file path */ }
    // Ensure parent dir exists.
    const parent = path.dirname(resolvedDest);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmpDest = resolvedDest + '.tmp-' + process.pid + '-' + Date.now();
    // better-sqlite3's backup API is async. SQLite's online backup
    // copies pages without blocking writers.
    const db = state.db();
    await db.backup(tmpDest);
    // Atomic move on the same filesystem. Cross-filesystem renames
    // may fail; we fall back to copy+unlink.
    try {
      fs.renameSync(tmpDest, resolvedDest);
    } catch (_) {
      fs.copyFileSync(tmpDest, resolvedDest);
      try { fs.unlinkSync(tmpDest); } catch (_) {}
    }
    let bytes = null;
    try { bytes = fs.statSync(resolvedDest).size; } catch (_) {}
    _STATUS.last_backup_ms    = Date.now();
    _STATUS.last_backup_dest  = resolvedDest;
    _STATUS.last_backup_size  = bytes;
    _STATUS.last_backup_error = null;
    _STATUS.consecutive_failures = 0;
    return { ok: true, dest: resolvedDest, bytes };
  } catch (e) {
    _STATUS.last_backup_error    = (e && e.message) || String(e);
    _STATUS.consecutive_failures += 1;
    return { ok: false, error: 'backup_failed', detail: (e && e.message) || String(e) };
  }
}

// Long-running replicator loop. Returns a handle with .stop().
// cadence_ms minimum 60_000 (1 min) to avoid I/O storm.
function startReplicator(opts) {
  opts = opts || {};
  const dest = opts.dest;
  const cadence_ms = Math.max(60_000, opts.cadence_ms || 5 * 60_000);
  if (!dest) throw new Error('wal-replicate.startReplicator: opts.dest required');
  let running = true;
  let nextTimer = null;
  async function _tick() {
    if (!running) return;
    try { await runOnce({ dest }); } catch (_) { /* runOnce already records status */ }
    if (running) nextTimer = setTimeout(_tick, cadence_ms);
  }
  // Fire first tick immediately so operators see status fast.
  nextTimer = setTimeout(_tick, 0);
  return {
    stop() {
      running = false;
      if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
    },
    status
  };
}

module.exports = {
  runOnce,
  startReplicator,
  status
};
