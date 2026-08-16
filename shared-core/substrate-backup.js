// SPDX-License-Identifier: AGPL-3.0-only
// Substrate Backup / Restore — disaster recovery + portability.
//
// Substrate L1 is one SQLite file plus, optionally, on-disk slot KV
// caches and chameleon-derived control vector GGUFs. Without a
// documented backup story the user is one disk failure away from
// losing every piece of personalisation the substrate has accumulated.
//
// What this module covers:
//   - exportArchive({out_path, agent_id?, include_kv?, include_cvecs?})
//       SQLite backup (via better-sqlite3 .backup() if available, else
//       file copy) + manifest + optional companion files. Output is a
//       single tar-like JSON+blob bundle (.troth-bundle).
//   - importArchive({in_path, target_db?, replace?})
//       Round-trips the bundle into a fresh substrate instance. Caller
//       chooses replace vs merge semantics.
//   - migrateSchema({db_path, target_version})
//       Forward-only migrations stub (state.js already does
//       additive-only schema changes; this is the audit hook).
//
// Format choice: a single `.troth-bundle` directory. `manifest.json`
// at root, then `state.db`, optional `slots/`, `cvecs/`. Easy for the
// user to inspect/share.

const fs   = require('fs');
const path = require('path');

const cfg = require('./transport-config.js');

const BUNDLE_VERSION = 1;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Resolve the active substrate DB path. Defers to state.js's own
// computed DB_PATH so backup always points at the same file the rest
// of the codebase is reading/writing — even if env changed mid-process
// after state.js cached its path at module-load time.
function resolveDbPath() {
  try {
    const state = require('./state.js');
    if (state.DB_PATH) return state.DB_PATH;
  } catch (_) { /* fall through */ }
  const HOME = process.env.HOME || require('os').homedir();
  let envDataDir = process.env.CLAUDE_PLUGIN_DATA || '';
  if (envDataDir.includes('/.claude/plugins/data/')) envDataDir = '';
  const dir = envDataDir || path.join(HOME, '.troth');
  return path.join(dir, 'state.db');
}

function exportArchive(opts) {
  opts = opts || {};
  const outPath = opts.out_path;
  if (!outPath) return { ok: false, error: 'out_path required' };
  const includeKV    = !!opts.include_kv;
  const includeCvecs = !!opts.include_cvecs;
  const agent_id     = opts.agent_id || null;
  const dbPath       = opts.db_path || resolveDbPath();

  if (!fs.existsSync(dbPath)) return { ok: false, error: 'no substrate db at ' + dbPath };
  ensureDir(outPath);

  // 1. Snapshot the SQLite db. When state.js owns the live handle for the
  //    same path, FLUSH the WAL first so the resulting file copy includes
  //    every committed transaction (otherwise a busy writer can leave new
  //    rows trapped in -wal that never enter state.db). PRAGMA
  //    wal_checkpoint(TRUNCATE) is best-effort: if WAL mode isn't on or
  //    the handle isn't reachable, fall through to a plain file copy and
  //    accept the small risk of a mid-commit tear (documented v1 limit).
  const dbDest = path.join(outPath, 'state.db');
  let dbCopyMethod = 'copy';
  try {
    let liveDb = null;
    try {
      const state = require('./state.js');
      if (state._dbForQuery && state.DB_PATH === dbPath) liveDb = state._dbForQuery();
    } catch (_) { /* fall through to plain copy */ }
    if (liveDb) {
      try {
        liveDb.pragma('wal_checkpoint(TRUNCATE)');
        dbCopyMethod = 'wal_checkpoint+copy';
      } catch (_) { /* not WAL mode or busy — fall through */ }
    }
    fs.copyFileSync(dbPath, dbDest);
  } catch (e) {
    return { ok: false, error: 'db copy failed: ' + (e && e.message || e) };
  }

  // 2. Optional slot KV caches.
  let slotCount = 0;
  if (includeKV) {
    const slotDir = cfg.slotSavePath();
    if (slotDir && fs.existsSync(slotDir)) {
      const dst = path.join(outPath, 'slots');
      ensureDir(dst);
      for (const f of fs.readdirSync(slotDir)) {
        const src = path.join(slotDir, f);
        if (!fs.statSync(src).isFile()) continue;
        if (agent_id && !f.startsWith(agent_id + '__')) continue;
        fs.copyFileSync(src, path.join(dst, f));
        slotCount++;
      }
    }
  }

  // 3. Optional control-vector GGUFs from ~/.troth/cvec-substrate (default).
  let cvecCount = 0;
  if (includeCvecs) {
    const cvecDir = opts.cvec_dir || path.join(process.env.HOME || require('os').homedir(), '.troth', 'cvec-substrate');
    if (fs.existsSync(cvecDir)) {
      const dst = path.join(outPath, 'cvecs');
      ensureDir(dst);
      for (const f of fs.readdirSync(cvecDir)) {
        const src = path.join(cvecDir, f);
        if (!fs.statSync(src).isFile()) continue;
        if (!/\.(gguf|json|txt)$/.test(f)) continue;
        fs.copyFileSync(src, path.join(dst, f));
        cvecCount++;
      }
    }
  }

  // Compute the audit summary so verifyRestore can prove (a) row counts
  // round-trip and (b) the signed-audit chain head matches after restore.
  // Audit summary is best-effort — a substrate with no engrams yet is
  // still a valid bundle.
  let engram_count = null;
  let last_chain_hash = null;
  let sync_latest_gseq = null;
  try {
    const Database = require('better-sqlite3');
    const peek = new Database(dbDest, { readonly: true });
    try {
      // Engrams are stored as engram-typed rows in action_records (the
      // master action table). state.js does not have a dedicated 'engrams'
      // table; everything is one action ledger filtered by tool_name.
      // Engrams in action_records are type='commitment' with
      // output.commitment_type='engram'.
      const r = peek.prepare(
        "SELECT COUNT(*) AS n FROM action_records " +
        "WHERE type='commitment' AND json_extract(output,'$.commitment_type')='engram'"
      ).get();
      if (r) engram_count = Number(r.n);
      const last = peek.prepare(
        'SELECT chain_hash FROM l4_signed_audit_chain ORDER BY id DESC LIMIT 1'
      ).get();
      if (last && last.chain_hash) last_chain_hash = last.chain_hash;
      // The junction between the snapshot lane and the event lane: a bundle
      // stamped with the journal position it was cut at can seed a device
      // that then applies events from that point — snapshot + deltas compose
      // instead of competing. Null on substrates that never synced.
      try {
        const g = peek.prepare('SELECT MAX(gseq) AS g FROM sync_events').get();
        if (g && g.g != null) sync_latest_gseq = Number(g.g);
      } catch (_) { /* pre-sync substrate */ }
    } finally { peek.close(); }
  } catch (_) { /* schema may pre-date these tables — leave nulls */ }

  const manifest = {
    bundle_version: BUNDLE_VERSION,
    generated_at:   new Date().toISOString(),
    source_db:      dbPath,
    db_size_bytes:  fs.statSync(dbDest).size,
    db_copy_method: dbCopyMethod,
    engram_count,
    last_chain_hash,
    sync_latest_gseq,
    agent_id_filter: agent_id,
    include_kv:     includeKV,
    include_cvecs:  includeCvecs,
    slot_count:     slotCount,
    cvec_count:     cvecCount,
    notes:          opts.notes || null
  };
  fs.writeFileSync(path.join(outPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { ok: true, bundle_path: outPath, manifest };
}

function importArchive(opts) {
  opts = opts || {};
  const inPath = opts.in_path;
  if (!inPath) return { ok: false, error: 'in_path required' };
  const manifestPath = path.join(inPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: 'no manifest.json in bundle' };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, error: 'manifest parse failed: ' + e.message }; }
  if (manifest.bundle_version !== BUNDLE_VERSION) {
    return { ok: false, error: 'unsupported bundle_version: ' + manifest.bundle_version };
  }

  const dbSrc = path.join(inPath, 'state.db');
  if (!fs.existsSync(dbSrc)) return { ok: false, error: 'no state.db in bundle' };

  const dbDest = opts.target_db || resolveDbPath();
  if (fs.existsSync(dbDest) && !opts.replace) {
    return { ok: false, error: 'target db exists and replace:false; refusing to overwrite' };
  }
  ensureDir(path.dirname(dbDest));
  fs.copyFileSync(dbSrc, dbDest);

  // Optional restore of slot files.
  let slotsRestored = 0;
  const slotsDir = path.join(inPath, 'slots');
  if (fs.existsSync(slotsDir)) {
    const target = opts.target_slot_dir || cfg.slotSavePath();
    if (target) {
      ensureDir(target);
      for (const f of fs.readdirSync(slotsDir)) {
        const src = path.join(slotsDir, f);
        if (!fs.statSync(src).isFile()) continue;
        fs.copyFileSync(src, path.join(target, f));
        slotsRestored++;
      }
    }
  }

  let cvecsRestored = 0;
  const cvecsDir = path.join(inPath, 'cvecs');
  if (fs.existsSync(cvecsDir)) {
    const target = opts.target_cvec_dir || path.join(process.env.HOME || require('os').homedir(), '.troth', 'cvec-substrate');
    ensureDir(target);
    for (const f of fs.readdirSync(cvecsDir)) {
      const src = path.join(cvecsDir, f);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(target, f));
      cvecsRestored++;
    }
  }

  return { ok: true, target_db: dbDest, manifest, slots_restored: slotsRestored, cvecs_restored: cvecsRestored };
}

// Disaster-recovery probe — open the bundle into a scratch DB (no touching
// of live ~/.troth) and assert it round-trips:
//   - manifest engram_count matches scratch SELECT COUNT
//   - manifest last_chain_hash matches scratch chain head
//   - core tables (engrams, l4_signed_audit_chain, intent_state) are present
//     and queryable (schema_ok)
// Returns { ok:true, engram_count, last_chain_hash, schema_ok } on success;
// otherwise { ok:false, error, expected?, got? } with the first divergence.
// This is the C5 "verifyRestore + monthly DR-verify" hook called out in the
// design: operator can cron it against the latest bundle.
function verifyRestore(opts) {
  opts = opts || {};
  const bundlePath = opts.bundle_path;
  if (!bundlePath) return { ok: false, error: 'bundle_path required' };
  const manifestPath = path.join(bundlePath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: 'no manifest.json' };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, error: 'manifest parse failed: ' + e.message }; }
  const dbSrc = path.join(bundlePath, 'state.db');
  if (!fs.existsSync(dbSrc)) return { ok: false, error: 'no state.db in bundle' };

  // Materialize to a scratch path so the readonly probe never opens the
  // live db — even if the bundle and live happen to share an inode.
  const scratchPath = opts.scratch_db_path ||
    path.join(require('os').tmpdir(), 'troth-verify-' + Date.now() + '-' +
      Math.random().toString(36).slice(2, 8) + '.db');
  try { fs.copyFileSync(dbSrc, scratchPath); }
  catch (e) { return { ok: false, error: 'scratch copy failed: ' + e.message }; }

  let Database, scratch;
  try { Database = require('better-sqlite3'); }
  catch (e) {
    try { fs.unlinkSync(scratchPath); } catch (_) {}
    return { ok: false, error: 'better-sqlite3 unavailable: ' + e.message };
  }
  try { scratch = new Database(scratchPath, { readonly: true }); }
  catch (e) {
    try { fs.unlinkSync(scratchPath); } catch (_) {}
    return { ok: false, error: 'open scratch failed: ' + e.message };
  }

  try {
    // Schema probe — the three core tables every L4 substrate needs.
    // Engrams live in action_records (one master ledger; engram-typed rows
    // are type='commitment' + output.commitment_type='engram'). There is no
    // separate 'engrams' table.
    let schema_ok = true;
    let schema_missing = [];
    for (const tbl of ['action_records', 'l4_signed_audit_chain', 'intent_state']) {
      try { scratch.prepare('SELECT 1 FROM ' + tbl + ' LIMIT 0').run(); }
      catch (_) { schema_ok = false; schema_missing.push(tbl); }
    }
    if (!schema_ok) {
      return { ok: false, error: 'schema_missing', missing: schema_missing };
    }

    // engram_count round-trip — null in manifest means "untracked", which is
    // valid; only enforce when both sides have it.
    const r = scratch.prepare(
      "SELECT COUNT(*) AS n FROM action_records " +
      "WHERE type='commitment' AND json_extract(output,'$.commitment_type')='engram'"
    ).get();
    const engram_count = r ? Number(r.n) : null;
    if (manifest.engram_count != null && engram_count !== manifest.engram_count) {
      return { ok: false, error: 'engram_count_mismatch',
               expected: manifest.engram_count, got: engram_count };
    }

    // last_chain_hash round-trip — same null-tolerant rule.
    const last = scratch.prepare(
      'SELECT chain_hash FROM l4_signed_audit_chain ORDER BY id DESC LIMIT 1'
    ).get();
    const last_chain_hash = last ? last.chain_hash : null;
    if (manifest.last_chain_hash != null && last_chain_hash !== manifest.last_chain_hash) {
      return { ok: false, error: 'last_chain_hash_mismatch',
               expected: manifest.last_chain_hash, got: last_chain_hash };
    }

    return { ok: true, engram_count, last_chain_hash, schema_ok: true,
             scratch_db_path: scratchPath };
  } finally {
    try { scratch.close(); } catch (_) {}
    if (!opts.keep_scratch) {
      // Clean the DB and any -wal / -shm / -journal sidecars SQLite may
      // have created so /tmp doesn't accumulate over repeated DR-verifies.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(scratchPath + suffix); } catch (_) {}
      }
    }
  }
}

module.exports = { exportArchive, importArchive, verifyRestore, resolveDbPath, BUNDLE_VERSION };
