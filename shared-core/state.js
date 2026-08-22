// SPDX-License-Identifier: AGPL-3.0-only
// Unified SQLite state layer — single source of truth for plugin hooks AND proxy.
//
// Both paths write telemetry here; the dashboard UI (served by proxy or by
// `troth ui`) reads from here. No duplication, no two stores to keep in sync.
//
// Schema is additive-only across versions — rely on CREATE TABLE IF NOT EXISTS
// and ALTER TABLE ADD COLUMN for migrations so older rows stay intact.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const HOME = process.env.HOME || require('os').homedir();
// Claude Code spawns plugin MCP servers with CLAUDE_PLUGIN_DATA pointing at
// its per-plugin sandbox (~/.claude/plugins/data/<id>). Hooks inherit the
// user's shell env where that var is unset, so they fall through to
// ~/.troth/. That asymmetry would split the substrate across two DBs:
// hooks writing one, MCP servers reading the other empty one. The hooks
// already work around this in plugin/hooks/_lib.mjs:35; mirror that here
// so any consumer of state.js (MCP servers, CLI subcommands) sees the same
// canonical store. Test env override paths (e.g. /tmp/...) pass through
// unchanged, preserving conformance-test isolation.
let _envDataDir = process.env.CLAUDE_PLUGIN_DATA || '';
if (_envDataDir.includes('/.claude/plugins/data/')) _envDataDir = '';
const DATA_DIR = _envDataDir || path.join(HOME, '.troth');
// STATE_DB_PATH overrides the computed DB path so workers
// spawned by `troth race` / `troth orchestrate` can be pinned to a
// tenant-scoped substrate file without forking the rest of the data
// dir. Set by spawnWorker when --tenant flag is present. When unset,
// behavior is unchanged (single global state.db under DATA_DIR).
const DB_PATH = process.env.STATE_DB_PATH || path.join(DATA_DIR, 'state.db');

let _db = null;

// Incognito mode — substrate write-mute switch.
// When ~/.troth/incognito.json has {enabled:true}, all write paths in this
// module become silent no-ops while reads continue to work. Lets the user
// run experimental / off-topic prompts without contaminating long-term
// memory (engrams, lessons, dialogue mirror, telemetry) — the human-brain
// analog of "a thought that doesn't consolidate to long-term memory".
// Toggled via `troth incognito on|off|toggle`.
//
// Cached for 1s to avoid per-call file IO on hot write paths.
let _incognitoCache = { value: false, checkedAt: 0 };
function isIncognito() {
  const now = Date.now();
  if (now - _incognitoCache.checkedAt < 1000) return _incognitoCache.value;
  let enabled = false;
  try {
    const incoFile = path.join(HOME, '.troth', 'incognito.json');
    const raw = fs.readFileSync(incoFile, 'utf8');
    const parsed = JSON.parse(raw);
    enabled = !!(parsed && parsed.enabled);
  } catch (_) { /* missing/unparseable = OFF, default-safe */ }
  _incognitoCache = { value: enabled, checkedAt: now };
  return enabled;
}

function db() {
  if (_db) return _db;
  // 0700 on the directory, 0600 on the database. Everything the operator has
  // ever said to their partner lives in this one file, and it was landing
  // world-readable: on a Mac with a second account, that is the whole memory
  // readable by someone who was never told any of it. mkdir's mode argument
  // only applies when the directory is created, so existing installs are
  // repaired on the next open rather than left as they were.
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) { /* not ours to tighten */ }
  _db = new Database(DB_PATH);
  try { fs.chmodSync(DB_PATH, 0o600); } catch (_) { /* read-only mount, or not ours */ }
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  // better-sqlite3 is synchronous, so a contended write blocks the whole
  // event loop, not just the caller. The driver default is 5s, which is
  // longer than the cognitive runtime's own 5s drain budget: one locked
  // write and the loop misses its deadline entirely, turns look dropped,
  // and timers that were due never fire. Under WAL a real conflict clears
  // in milliseconds, so anything past 2s is genuine contention and the
  // right answer is to fail that write fast and keep the loop breathing.
  // Callers on the turn path already treat a lost write as survivable.
  _db.pragma('busy_timeout = 2000');
  migrate(_db);

  // Optional state extension: extra tables and their accessors come from the
  // overlay when it is installed. The open build needs none of them, so the
  // schema they describe is not published here.
  try {
    const _ext = require('./state-ext.js');
    if (_ext && typeof _ext.migrate === 'function') _ext.migrate(_db);
  } catch (_) { /* open build */ }
  //  startup self-heal of principal_id NULLs. Long-running
  // processes (MCP servers, the proxy) that loaded state.js BEFORE the
  // P1 substrate-as-mind ship still INSERT without the principal_id
  // column. Those rows land with principal_id=NULL and become invisible
  // to default reads. Every new process that opens the DB heals them
  // here. Idempotent (UPDATE with WHERE NULL is a no-op when clean) and
  // cheap (sub-millisecond when nothing to heal because of the index on
  // principal_id). Catches not just the  stale-process leak
  // but any future schema-migration drift.
  try {
    _db.prepare("UPDATE action_records SET principal_id='partner' WHERE principal_id IS NULL").run();
  } catch (_) { /* schema migration not yet applied (first-run) — skip */ }
  //  race-condition self-heal for audience +
  // memory_class. Mirror of the principal_id pattern above: long-running
  // processes (MCP servers, proxy) that loaded state.js BEFORE the v2
  // recordAction change still INSERT without the new columns. Those rows
  // land NULL and become invisible to model_visible readers. Every new
  // process that opens the DB heals them with the conservative fail-closed
  // defaults (substrate_internal + operational). Idempotent, cheap (indexed).
  // Remove this self-heal AFTER all stale processes restart AND the
  // distribution audit confirms zero new NULLs over a 24h window.
  try {
    _db.prepare("UPDATE action_records SET audience='substrate_internal' WHERE audience IS NULL").run();
    _db.prepare("UPDATE action_records SET memory_class='operational' WHERE memory_class IS NULL").run();
  } catch (_) { /* columns not yet there (very first run before migrate) */ }
  return _db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS hook_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      session_id  TEXT,
      event       TEXT    NOT NULL,
      tool        TEXT,
      decision    TEXT,
      reason      TEXT,
      tokens_in   INTEGER DEFAULT 0,
      tokens_out  INTEGER DEFAULT 0,
      metadata    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hook_events_ts     ON hook_events(ts);
    CREATE INDEX IF NOT EXISTS idx_hook_events_event  ON hook_events(event);

    CREATE TABLE IF NOT EXISTS loopbreaker_hashes (
      session_id  TEXT    NOT NULL,
      hash        TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      PRIMARY KEY (session_id, hash, ts)
    );

    CREATE TABLE IF NOT EXISTS verifyfirst_reads (
      session_id  TEXT    NOT NULL,
      path        TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      PRIMARY KEY (session_id, path)
    );

    CREATE TABLE IF NOT EXISTS tool_output_archive (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT,
      tool        TEXT,
      ts          INTEGER NOT NULL,
      raw         TEXT,
      summary     TEXT,
      bytes_in    INTEGER DEFAULT 0,
      bytes_out   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tool_output_ts ON tool_output_archive(ts);

    -- Full-text search over raw archived content. Separate FTS5 virtual
    -- table so we can drop/rebuild it independently without touching the
    -- canonical archive rows. Populated + kept in sync by triggers below.
    CREATE VIRTUAL TABLE IF NOT EXISTS tool_output_fts
      USING fts5(raw, content='tool_output_archive', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS tool_output_ai AFTER INSERT ON tool_output_archive
      BEGIN INSERT INTO tool_output_fts(rowid, raw) VALUES (new.id, new.raw); END;
    CREATE TRIGGER IF NOT EXISTS tool_output_ad AFTER DELETE ON tool_output_archive
      BEGIN INSERT INTO tool_output_fts(tool_output_fts, rowid, raw) VALUES('delete', old.id, old.raw); END;
    CREATE TRIGGER IF NOT EXISTS tool_output_au AFTER UPDATE ON tool_output_archive
      BEGIN
        INSERT INTO tool_output_fts(tool_output_fts, rowid, raw) VALUES('delete', old.id, old.raw);
        INSERT INTO tool_output_fts(rowid, raw) VALUES (new.id, new.raw);
      END;

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      model      TEXT NOT NULL,
      tokens_in  INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cached_in  INTEGER DEFAULT 0,
      requests   INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts    ON usage_ledger(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_model ON usage_ledger(model);

    -- Knowledge the partner SAW while working, queued for ingestion.
    --
    -- Most reads are re-reads of a file already opened. What survives of all
    -- that reading: the path, the line count, the byte count. Not one byte of
    -- content. The material the partner actually worked from was never kept,
    -- so it had to be fetched again, and again.
    --
    -- This is a queue of POINTERS, not content: the file is on disk and
    -- re-reading it costs nothing, while chunking and embedding cost 51ms per
    -- 800 characters and must never run on the operator's turn. The proxy
    -- appends a row the moment it sees the read; the idle worker drains it.
    -- The sha is the content hash, so a file read 352 times is ingested once and
    -- re-ingested only when it actually changes.
    CREATE TABLE IF NOT EXISTS knowledge_spool (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,           -- 'file' | 'web'
      ref        TEXT NOT NULL,           -- absolute path, or url
      sha        TEXT,                    -- content hash at the time it was seen
      bytes      INTEGER DEFAULT 0,
      payload    TEXT,                    -- only for kinds with no durable source (web)
      why        TEXT,                    -- the operator question in flight when this was read
      created_at INTEGER NOT NULL,
      done_at    INTEGER,                 -- null = pending
      result     TEXT                     -- what the drain decided, for audit
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_spool_pending ON knowledge_spool(done_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_spool_sha ON knowledge_spool(kind, ref, sha);

    CREATE TABLE IF NOT EXISTS proxy_stats (
      ts           INTEGER PRIMARY KEY,
      requests     INTEGER DEFAULT 0,
      tokens_in    INTEGER DEFAULT 0,
      tokens_out   INTEGER DEFAULT 0,
      provider     TEXT,
      model        TEXT,
      cache_hits   INTEGER DEFAULT 0,
      cache_misses INTEGER DEFAULT 0,
      errors       INTEGER DEFAULT 0
    );

    -- Single-row "plugin is here" marker. The PostHook library stamps this
    -- whenever any plugin hook fires so the proxy can tell, without any
    -- IPC, whether the plugin is currently active in the same machine's
    -- Claude Code session. Uses INSERT OR REPLACE on id=1.
    CREATE TABLE IF NOT EXISTS plugin_presence (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_ts  INTEGER NOT NULL,
      session_id    TEXT,
      plugin_version TEXT
    );

    -- Verifiable claims — facts the substrate can CHECK, not just recall.
    -- When a remembered value and the world disagree, a model will bridge the
    -- contradiction with a story rather than stop (the STALE benchmark calls
    -- this premise resistance and measures frontier models at 55%), so a claim
    -- carries a checkable probe. The partial unique index makes two
    -- live values for one (subject, predicate) slot structurally impossible
    -- — supersession is an explicit transaction, never a silent overwrite
    -- (Doyle's justification bookkeeping reduced to one table). probe_kind/
    -- probe_arg carry a TYPED, allowlisted check (http_status / file_exists
    -- / gh_json) — never arbitrary shell from the database. A probe
    -- mismatch flips status to 'disputed': disputed rows are excluded from
    -- every serving path (fail-closed) until an explicit resolution.
    CREATE TABLE IF NOT EXISTS claims (
      id            TEXT PRIMARY KEY,
      subject       TEXT NOT NULL,
      predicate     TEXT NOT NULL,
      value         TEXT NOT NULL,
      valid_from    INTEGER NOT NULL,
      invalid_at    INTEGER,
      superseded_by TEXT,
      status        TEXT NOT NULL DEFAULT 'live',
      volatility    TEXT NOT NULL DEFAULT 'slow',
      verified_at   INTEGER,
      probe_kind    TEXT,
      probe_arg     TEXT,
      source_rank   INTEGER NOT NULL DEFAULT 2,
      source        TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS claims_live_slot
      ON claims(subject, predicate) WHERE invalid_at IS NULL;
    CREATE TABLE IF NOT EXISTS claim_events (
      id       TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      kind     TEXT NOT NULL,
      detail   TEXT
    );
    CREATE INDEX IF NOT EXISTS claim_events_claim ON claim_events(claim_id, ts);

    -- Substrate sync — one mind reachable from every device.
    -- sync_events is the HUB-side journal: every remote write arrives as an
    -- op-event and is sequenced here in ARRIVAL order (gseq). The gseq is
    -- the only order that exists; hlc_ts is operator INTENT time and never
    -- arbitrates. Envelope args are weak-schema JSON, additive-only.
    CREATE TABLE IF NOT EXISTS sync_events (
      gseq        INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT    NOT NULL UNIQUE,   -- UUIDv7, minted on the writing device
      device_id   TEXT    NOT NULL,
      dev_seq     INTEGER NOT NULL,          -- per-device, strictly +1, no gaps
      parent_gseq INTEGER,                   -- device's applied hub prefix at creation
      op          TEXT    NOT NULL,
      op_v        INTEGER NOT NULL DEFAULT 1,
      args        TEXT    NOT NULL,          -- JSON
      ctx         TEXT,                      -- JSON: agent_id / user_id / cwd provenance
      hlc_ts      TEXT,                      -- collatable HLC string; metadata only
      app_version TEXT,
      received_at INTEGER NOT NULL,
      outcome     TEXT,                      -- JSON; NULL only inside the crash window
      UNIQUE(device_id, dev_seq)
    );
    CREATE INDEX IF NOT EXISTS sync_events_device ON sync_events(device_id, dev_seq);

    -- Devices allowed to reach the substrate over the network. Tokens are
    -- stored as sha256 hex — the raw token is printed exactly once at
    -- device add and never touches disk. last_dev_seq is the watermark:
    -- at-or-below is a replay (answered from the journal), plus-one is
    -- next, anything further is a gap and is refused.
    CREATE TABLE IF NOT EXISTS sync_devices (
      device_id    TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      token_hash   TEXT    NOT NULL,
      last_dev_seq INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER
    );

    -- Satellite-side: the transactional outbox. A mind-write on a device
    -- whose substrate lives elsewhere becomes a journal row here in the
    -- same breath as the caller's request, and a flusher ships rows to the
    -- hub strictly in dev_seq order. Rows survive restarts and offline
    -- stretches; sent rows keep the hub-assigned gseq for the record.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      dev_seq    INTEGER PRIMARY KEY,
      event_id   TEXT    NOT NULL UNIQUE,
      envelope   TEXT    NOT NULL,           -- the full journal event, as POSTed
      created_at INTEGER NOT NULL,
      sent_at    INTEGER,
      gseq       INTEGER                     -- the hub's answer, once acked
    );

    -- Satellite-side scalar state: device identity, dev_seq counter, HLC.
    CREATE TABLE IF NOT EXISTS sync_client_state (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    -- Session lessons — the glue between critic blocks and the next
    -- UserPromptSubmit's additionalContext. When critic rejects a turn,
    -- we write *why* here; when injector fires on the next prompt, it
    -- looks back at recent matching lessons and injects them so the
    -- model doesn't repeat the same mistake on the rebound.
    --
    -- fingerprint is a cheap hash over the failed action (tool name +
    -- first N chars of error reason) so we can dedupe and match.
    CREATE TABLE IF NOT EXISTS session_lessons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      source      TEXT    NOT NULL,   -- 'critic' | 'errortax' | 'loopbreaker'
      fingerprint TEXT    NOT NULL,
      lesson      TEXT    NOT NULL,   -- the short lesson text to re-inject
      consumed    INTEGER DEFAULT 0   -- 1 once it's been surfaced, to avoid loops
    );
    CREATE INDEX IF NOT EXISTS idx_session_lessons_sess ON session_lessons(session_id, ts);

    CREATE TABLE IF NOT EXISTS savings_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      kind       TEXT    NOT NULL,
      tokens     INTEGER NOT NULL,
      session_id TEXT,
      note       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_savings_ts   ON savings_ledger(ts);
    CREATE INDEX IF NOT EXISTS idx_savings_kind ON savings_ledger(kind);
  `);

  // Migration: add cwd column to session_lessons so lessons can cross
  // sessions within the same project. Older rows get cwd=NULL and are
  // still retrievable by (session_id match). No-op if column already
  // exists (SQLite throws, we swallow).
  try {
    d.exec('ALTER TABLE session_lessons ADD COLUMN cwd TEXT');
  } catch (_) { /* column already there */ }
  // Tri-pool autonomy limits: per-charge provider so the
  // circuit-breaker can cap the SUBSCRIPTION pool by tokens (a flat-rate
  // quota is invisible to USD caps). Older rows: provider=NULL (counted as
  // metered — conservative).
  try {
    d.exec('ALTER TABLE l4_cost_events ADD COLUMN provider TEXT');
  } catch (_) { /* column already there */ }
  // Which model the saving belongs to, where the writer knows it (the
  // output-sandbox hook reads it off the session transcript). Older rows:
  // NULL — analytics resolves them via a model-stamped row of the same
  // session, else prices them at the baseline model.
  try {
    d.exec('ALTER TABLE savings_ledger ADD COLUMN model TEXT');
  } catch (_) { /* column already there */ }
  // One-time unit repair (user_version 0 -> 1): output_archive and
  // bash_compression recorded BYTES in the tokens column; every other kind
  // records estimated tokens (bytes/4). The mixed units ran the archive
  // share of every savings figure ~4x hot. Writers now record bytes/4;
  // this converts the historical rows once. BEGIN IMMEDIATE + re-check
  // keeps the division race-safe across the proxy, the MCP servers, and
  // the one-shot hooks that all open this DB.
  try {
    if (d.pragma('user_version', { simple: true }) < 1) {
      d.exec('BEGIN IMMEDIATE');
      try {
        if (d.pragma('user_version', { simple: true }) < 1) {
          d.exec("UPDATE savings_ledger SET tokens = CAST((tokens + 3) / 4 AS INTEGER) WHERE kind IN ('output_archive','bash_compression')");
          d.pragma('user_version = 1');
        }
        d.exec('COMMIT');
      } catch (e2) { try { d.exec('ROLLBACK'); } catch (_) {} }
    }
  } catch (_) { /* repair is best-effort; analytics works either way */ }
  try {
    d.exec('CREATE INDEX IF NOT EXISTS idx_session_lessons_cwd ON session_lessons(cwd, ts)');
  } catch (_) { /* noop */ }

  // Persisted supersession index (user_version 1 -> 2). Supersession
  // pointers (output.lifetime.supersedes) were honoured only when the
  // successor happened to land in the same fetched window as its
  // predecessor — a retired fact whose successor fell outside the window
  // kept surfacing, which is what made /forget look broken. The table is
  // maintained by recordAction from here on; this one-time scan indexes
  // every pointer already on disk. BEGIN IMMEDIATE + re-check keeps it
  // race-safe across the proxy, the MCP servers and the one-shot hooks,
  // same shape as the savings repair above.
  try {
    d.exec('CREATE TABLE IF NOT EXISTS superseded_ids (' +
           'superseded_id TEXT PRIMARY KEY, successor_id TEXT NOT NULL, ts INTEGER NOT NULL)');
    if (d.pragma('user_version', { simple: true }) < 2) {
      d.exec('BEGIN IMMEDIATE');
      try {
        if (d.pragma('user_version', { simple: true }) < 2) {
          const rows = d.prepare(
            "SELECT id, timestamp, json_extract(output, '$.lifetime.supersedes') AS sup " +
            "FROM action_records WHERE output LIKE '%supersedes%'").all();
          const ins = d.prepare('INSERT OR REPLACE INTO superseded_ids (superseded_id, successor_id, ts) VALUES (?, ?, ?)');
          for (const r of rows) {
            if (!r.sup) continue;
            // json_extract returns a JSON-array STRING for the array shape.
            let ids = r.sup;
            if (typeof ids === 'string' && ids[0] === '[') { try { ids = JSON.parse(ids); } catch (_) { ids = [r.sup]; } }
            if (!Array.isArray(ids)) ids = [ids];
            for (const sid of ids) { if (sid) ins.run(String(sid), r.id, r.timestamp || 0); }
          }
          d.pragma('user_version = 2');
        }
        d.exec('COMMIT');
      } catch (e2) { try { d.exec('ROLLBACK'); } catch (_) {} }
    }
  } catch (_) { /* index is additive; reads fall back to the window scan */ }

  //  substrate-as-mind invariant fix (P1 of fragmentation
  // crisis handoff). principal_id is the READ-side brain identity:
  // 'partner' for personal use (all surfaces share one mind),
  // 'team:<slug>' for enterprise teams, 'deployed:<id>' for extended-mode
  // deployed agents. Distinct from agent_id which stays as WRITE-side
  // provenance ('claude-code', 'cli', 'voice', 'subagent:role',...).
  // Older rows were backfilled by a one-time pre-principal migration (the 6
  // active personal pools collapse to 'partner', bench-* to 'bench').
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN principal_id TEXT');
  } catch (_) { /* column already there */ }
  try {
    d.exec('CREATE INDEX IF NOT EXISTS idx_ar_principal ON action_records(principal_id, timestamp)');
  } catch (_) { /* noop */ }

  //  audience/memory-class reconstruction.
  //
  // audience separates content meant for the LLM prefix
  // ('model_visible') from substrate-internal observability
  // ('substrate_internal') — eliminates the failure mode where agent-to-
  // agent memos or operational traces leak into trivial-query context.
  //
  // memory_class enforces brain-grounded type separation grounded in
  // Tulving 1972 / Andrews-Hanna 2010: identity (always-on anchors),
  // episodic (events/dialogue), semantic (research/lessons), procedural
  // (compiled procedures), operational (intents/decisions/traces),
  // ephemeral (intra-session). Each class has its own retrieval policy
  // and mounting eligibility (see paper §B design note table).
  //
  // Both columns nullable on legacy rows; backfilled by
  // scripts/backfill-audience-memory-class.js (Phase 2). NOT NULL
  // constraint added in Phase 4 via INSERT trigger after operator
  // validates distribution. Sentinel '__legacy__' (audience) /
  // 'operational' (memory_class) treated as substrate_internal at read.
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN audience TEXT');
  } catch (_) { /* column already there */ }
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN memory_class TEXT');
  } catch (_) { /* column already there */ }
  try {
    d.exec('CREATE INDEX IF NOT EXISTS idx_ar_audience_class ON action_records(audience, memory_class)');
  } catch (_) { /* noop */ }
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN context_id TEXT');
  } catch (_) { /* column already there */ }
  try {
    d.exec('CREATE INDEX IF NOT EXISTS idx_ar_context ON action_records(context_id, timestamp)');
  } catch (_) { /* noop */ }

  //  foundation step (foundation schema additions). Three columns
  // added to action_records to support the agentic-layer state machine:
  //
  //   transition_signature — content hash of (step_name, tool_invoked,
  //     target_resource). Loop-detector groups records with identical
  //     signatures in a sliding window; ≥ threshold repeats trigger
  //     escalation (see the design).
  //
  //   transition_kind — one of 'proposed' | 'accepted' | 'rejected' |
  //     'applied'. STVC pipeline stamps every substrate transition with
  //     its validation phase so the substrate can replay decisions and
  //     audit rejection rates per goal class.
  //
  //   schema_version — INT DEFAULT 1. Per-row schema fingerprint so the
  //     migration runner (the design — `troth migrate`) can identify rows
  //     written under an older shape and upgrade them in place rather than
  //     silently breaking new readers.
  //
  // All nullable on legacy rows; treated as null/1 at read until
  // backfilled.
  // sections C.1, C.4, C.5 for the design rationale.
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN transition_signature TEXT');
  } catch (_) { /* column already there */ }
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN transition_kind TEXT');
  } catch (_) { /* column already there */ }
  try {
    d.exec('ALTER TABLE action_records ADD COLUMN schema_version INTEGER DEFAULT 1');
  } catch (_) { /* column already there */ }
  // Loop-detector lookup index: signature + recency window scan.
  try {
    d.exec('CREATE INDEX IF NOT EXISTS idx_ar_transition_sig ON action_records(transition_signature, timestamp)');
  } catch (_) { /* noop */ }

  // ── action_records — the unified substrate atom ────────────────
  // See shared-core/action-record.js for the canonical schema and
  // the substrate design notes for the design rationale. Legacy
  // tables (hook_events, session_lessons, tool_output_archive) stay
  // populated in parallel during the hook migration so nothing
  // depending on them breaks mid-flight.
  d.exec(`
    CREATE TABLE IF NOT EXISTS action_records (
      id            TEXT    PRIMARY KEY,     -- UUIDv7 (chrono-sortable)
      timestamp     INTEGER NOT NULL,        -- ms since epoch
      type          TEXT    NOT NULL,        -- edit | read | search | tool_call | decision | compact | lesson
      agent_id      TEXT    NOT NULL,        -- claude-code, cursor, ... (WRITE-side provenance)
      session_id    TEXT,
      user_id       TEXT,
      cwd           TEXT,
      parent_id     TEXT,                    -- causality edge (action that caused this)
      context_hash  TEXT,                    -- fingerprint of the input context
      input         TEXT,                    -- JSON: type-specific input shape
      output        TEXT,                    -- JSON: type-specific output shape
      verification  TEXT,                    -- JSON: { ast, tests, types, content_hash, human }
      outcome       TEXT,                    -- JSON: { accepted, reverted, led_to_commit, ... }
      principal_id  TEXT    NOT NULL DEFAULT 'partner', -- READ-side brain identity ('partner' | 'team:*' | 'deployed:*'). DEFAULT means even stale writers (loaded pre-column code) that omit the column still get a sane value at the SQL layer.
      audience      TEXT,                    -- 'model_visible' | 'substrate_internal' | 'synthesis_of_external' | NULL (legacy → treated as substrate_internal at read).
      memory_class  TEXT,                    -- 'identity' | 'episodic' | 'semantic' | 'procedural' | 'operational' | 'ephemeral' | NULL (legacy → operational at read).
      transition_signature TEXT,             -- SHA-1 hash of (step_name, tool_invoked, target_resource) for loop-detector window scan. NULL = legacy writer; loop-detector skips.
      transition_kind TEXT,                  -- 'proposed' | 'accepted' | 'rejected' | 'applied'. STVC pipeline phase stamp. NULL = legacy writer.
      schema_version INTEGER DEFAULT 1,      -- per-row schema fingerprint so migration runner can identify rows written under older shapes. Stamped with CURRENT_SCHEMA on every new write via recordAction().
      context_id    TEXT,                    -- subject-context binding ('ctx:<slug>'). NULL = unbound (legacy rows, pre-binding writers); read-side treats NULL as ctx:unsorted.
      FOREIGN KEY (parent_id) REFERENCES action_records(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ar_context     ON action_records(context_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_timestamp   ON action_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_type        ON action_records(type);
    CREATE INDEX IF NOT EXISTS idx_ar_session     ON action_records(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_cwd         ON action_records(cwd, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_agent       ON action_records(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_parent      ON action_records(parent_id);
    CREATE INDEX IF NOT EXISTS idx_ar_type_sess   ON action_records(type, session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_principal   ON action_records(principal_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ar_audience_class ON action_records(audience, memory_class);
    CREATE INDEX IF NOT EXISTS idx_ar_transition_sig ON action_records(transition_signature, timestamp);

    -- FTS5 companion for free-text search across input/output/metadata.
    -- Separate virtual table so we can drop/rebuild it independently without
    -- touching the canonical rows. Populated + kept in sync by triggers.
    CREATE VIRTUAL TABLE IF NOT EXISTS action_records_fts
      USING fts5(search_text, content='', contentless_delete=1, tokenize='porter unicode61');

    -- P17 Tier 3 — LLM-evolved wire-format profiles. Each row stores a
    -- TOON header proposed by an LLM (or hand-authored) for a specific
    -- domain signature (cwd / agent / record-type mix). status is
    -- 'candidate' | 'active' | 'discarded'. Only one profile per
    -- (domain_signature, status='active') at a time — the active one
    -- is consulted by the wire-format middleware when encoding.
    -- perf_score is a 0..1 quality estimate (set by the LMDT bench or
    -- post-hoc measurement); higher wins on tie-break.
    CREATE TABLE IF NOT EXISTS wire_format_profiles (
      id               TEXT    PRIMARY KEY,
      domain_signature TEXT    NOT NULL,
      header_json      TEXT    NOT NULL,
      created_at       INTEGER NOT NULL,
      activated_at     INTEGER,
      discarded_at     INTEGER,
      status           TEXT    NOT NULL,
      perf_score       REAL,
      author           TEXT,
      sample_count     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wfp_signature ON wire_format_profiles(domain_signature, status);
    CREATE INDEX IF NOT EXISTS idx_wfp_status    ON wire_format_profiles(status);

    -- Phase 3 (sub-brain registry) — first-class entity records.
    -- agent_id stays the substrate's atomic isolation key (engrams,
    -- dialogue, action_records all filter on it); this table just adds
    -- the metadata that turns an agent_id into a named, navigable
    -- sub-brain (parent-link, tag, persona, system-stance, last seen).
    -- Lazy population: existing single-agent installs register on first
    -- lookup with name='main' parent_agent_id=NULL.
    CREATE TABLE IF NOT EXISTS agents (
      id                TEXT    PRIMARY KEY,    -- the agent_id used everywhere else
      name              TEXT    NOT NULL,       -- human-facing label, unique per parent
      tag               TEXT,                   -- optional specialization slug
      parent_agent_id   TEXT,                   -- main-brain pointer; NULL = top-level
      system_stance     TEXT,                   -- short identity-tone string
      persona           TEXT,                   -- optional longer persona note
      created_at        INTEGER NOT NULL,
      last_active_at    INTEGER,
      active            INTEGER NOT NULL DEFAULT 1,  -- 0 = retired
      FOREIGN KEY (parent_agent_id) REFERENCES agents(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agents_name   ON agents(name);
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(active, last_active_at);

    -- P16.5 I3 — Counterfactual replay branches. Each row records a
    -- "what if at intent X we'd picked path B instead of A" branch. Status
    -- transitions: candidate → materialized | discarded. Append-only —
    -- discarded branches stay in the table for audit. branch_point_id
    -- references action_records.id (typically a type='intent' record).
    -- Counterfactual ActionRecords (replayed actions inside a branch) are
    -- written normally with outcome.branch_id set so they're easy to
    -- isolate from the canonical causal graph.
    CREATE TABLE IF NOT EXISTS counterfactual_branches (
      id              TEXT    PRIMARY KEY,
      branch_point_id TEXT    NOT NULL,
      substituted_path TEXT   NOT NULL,
      status          TEXT    NOT NULL,
      parent_branch_id TEXT,
      created_at      INTEGER NOT NULL,
      materialized_at INTEGER,
      cost_estimate   REAL,
      outcome_summary TEXT,
      FOREIGN KEY (branch_point_id) REFERENCES action_records(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cf_branch_point ON counterfactual_branches(branch_point_id);
    CREATE INDEX IF NOT EXISTS idx_cf_status       ON counterfactual_branches(status);

    -- P16 Tier 1 — DecisionGraph typed edges. Inter-record causality with
    -- semantic labels (refines_intent, contradicts_prior, supersedes,
    -- produces_edit, satisfies, rationalizes). Custom labels MUST start
    -- with 'ext:'. Indexes cover from/to/label/(label,from)/(label,to) so
    -- recursive CTE traversals stay sub-100ms at 50k edges. FK-checked at
    -- write time in recordEdge() rather than via PRAGMA so existing rows
    -- with orphaned parent_ids (if any) are not retroactively invalidated.
    CREATE TABLE IF NOT EXISTS action_record_edges (
      id         TEXT    PRIMARY KEY,
      from_id    TEXT    NOT NULL,
      to_id      TEXT    NOT NULL,
      label      TEXT    NOT NULL,
      weight     REAL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_id) REFERENCES action_records(id),
      FOREIGN KEY (to_id)   REFERENCES action_records(id)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from        ON action_record_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to          ON action_record_edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_edges_label_from  ON action_record_edges(label, from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_label_to    ON action_record_edges(label, to_id);

    -- semantic embedding cache. Embeddings
    -- live in a SEPARATE table (not append-only) for the same reason as
    -- engram_retrieval_stats: derived data, can be rebuilt by walking
    -- engrams and re-embedding. Dropping this table loses semantic
    -- rerank but FTS5 token-overlap still works (graceful degrade).
    -- vector is a Float32Array as a BLOB. dim must match the runtime
    -- embedding model's output size.
    CREATE TABLE IF NOT EXISTS engram_embeddings (
      engram_id   TEXT    PRIMARY KEY,
      dim         INTEGER NOT NULL,
      vector      BLOB    NOT NULL,
      model       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ee_created ON engram_embeddings(created_at);

    -- retrieval frequency feedback (Bjork's
    -- desirable difficulty). Facts that get recalled often should
    -- strengthen; untouched facts fade relative to active ones. Stored
    -- in a SEPARATE table (NOT append-only) because retrieval counts are
    -- derived stats — they can always be reconstructed from telemetry
    -- and should update freely without bloating action_records.
    -- Rebuilds cleanly: dropping this table loses retrieval feedback but
    -- doesn't damage substrate truth.
    CREATE TABLE IF NOT EXISTS engram_retrieval_stats (
      engram_id        TEXT PRIMARY KEY,
      retrieval_count  INTEGER NOT NULL DEFAULT 0,
      last_seen        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ers_last_seen ON engram_retrieval_stats(last_seen);

    -- Per-call MCP tool telemetry. One row per tools/call invocation in
    -- troth MCP servers. Powers the Analytics panel's hit-rate, latency,
    -- and error breakdowns. session_id is sourced from CLAUDE_SESSION_ID
    -- env var when the MCP server is launched by Claude Code.
    CREATE TABLE IF NOT EXISTS mcp_tool_calls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      session_id    TEXT,
      tool          TEXT    NOT NULL,
      cache_hit     INTEGER NOT NULL,         -- 0/1
      bytes         INTEGER DEFAULT 0,
      latency_ms    INTEGER DEFAULT 0,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mtc_ts      ON mcp_tool_calls(ts);
    CREATE INDEX IF NOT EXISTS idx_mtc_tool_ts ON mcp_tool_calls(tool, ts);
    CREATE INDEX IF NOT EXISTS idx_mtc_session ON mcp_tool_calls(session_id, ts);

    -- Per-LLM-request cost comparison: actual provider $ vs the baseline
    -- "what would Claude direct have cost". Baseline defaults to
    -- claude-sonnet-4.6 — the assumption being that without troth the
    -- user would route to the same model Claude Code uses by default.
    CREATE TABLE IF NOT EXISTS baseline_cost_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      session_id      TEXT,
      actual_model    TEXT,
      actual_cost     REAL    NOT NULL,
      baseline_model  TEXT    NOT NULL,
      baseline_cost   REAL    NOT NULL,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      tokens_cached   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bce_ts      ON baseline_cost_events(ts);
    CREATE INDEX IF NOT EXISTS idx_bce_session ON baseline_cost_events(session_id, ts);

    -- Per-error log so errortax survives proxy restart and Analytics can
    -- show "errors in last 24h" instead of "errors since last restart".
    CREATE TABLE IF NOT EXISTS module_errors (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      module   TEXT NOT NULL,        -- 'router.anthropic', 'mcp.cache', ...
      kind     TEXT,                 -- errortax class or free-text
      message  TEXT,
      model    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_me_ts     ON module_errors(ts);
    CREATE INDEX IF NOT EXISTS idx_me_module ON module_errors(module, ts);

    -- Cacheratio snapshots so historical hit-ratio survives restart.
    -- One row per record() call (cheap — only fires on Anthropic responses).
    CREATE TABLE IF NOT EXISTS cacheratio_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      model    TEXT NOT NULL,
      reads    INTEGER DEFAULT 0,
      writes   INTEGER DEFAULT 0,
      uncached INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cre_ts    ON cacheratio_events(ts);
    CREATE INDEX IF NOT EXISTS idx_cre_model ON cacheratio_events(model, ts);

    -- foundation step foundation tables.
    -- for the schema list and the design for the build sequence.

    -- Auto-Calibrated Confidence Substrate (the design).
    -- Empirical per-goal-class success/failure counts feed the confidence
    -- calibrator so the partner can answer "how likely am I to succeed at
    -- this class of task" from real data, not the LLM's self-report.
    -- variance captures spread for downstream uncertainty propagation.
    CREATE TABLE IF NOT EXISTS goal_class_stats (
      goal_class    TEXT    PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_run_ts   INTEGER,
      variance      REAL    NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    );

    -- State-Transition-Validated Cognition (STVC) — substrate-stored
    -- invariants that any proposed transition must satisfy. Examples:
    -- "principal_id is never NULL", "refusal predicates immutable",
    -- "budget warden must be alive before agentic loop fires". Scoped so
    -- different goal classes / capabilities can register their own
    -- preconditions. Read by state-machine.js validateTransition() before
    -- any substrate mutation lands.
    CREATE TABLE IF NOT EXISTS state_invariants (
      id            TEXT    PRIMARY KEY,    -- UUIDv7
      predicate     TEXT    NOT NULL,       -- JSON predicate (RPL — see the design)
      scope         TEXT,                   -- null = global, else goal_class / capability / module
      severity      TEXT    NOT NULL,       -- 'error' (block) | 'warn' (audit) | 'info'
      description   TEXT,                   -- human-readable rationale
      created_ts    INTEGER NOT NULL,
      created_by    TEXT                    -- agent_id of writer
    );
    CREATE INDEX IF NOT EXISTS idx_invariants_scope ON state_invariants(scope, severity);

    -- design: intent state tracking. Engrams are append-only,
    -- so the mutable parts of an intent's lifecycle (status transitions,
    -- dispatch_attempts counter, dispatcher claim) live in a separate
    -- tiny table keyed by the intent engram id. The engram body remains
    -- immutable (payload, capability_ref, grounded_in, etc.); only this
    -- side table mutates as the intent flows pending → validated →
    -- dispatched → observed / failed / refused. Atomic dispatcher claim
    -- uses UPDATE... WHERE status='validated' RETURNING * to prevent
    -- double-dispatch when multiple workers race.
    CREATE TABLE IF NOT EXISTS intent_state (
      intent_engram_id   TEXT    PRIMARY KEY,    -- FK to action_records.id
      status             TEXT    NOT NULL,        -- pending|validated|dispatched|observed|failed|refused|superseded
      dispatch_attempts  INTEGER NOT NULL DEFAULT 0,
      dispatched_at      INTEGER,                 -- ms when atomic claim won
      observed_at        INTEGER,                 -- ms when observation engram landed
      observation_id     TEXT,                    -- FK to action_records.id (the observation engram)
      last_error         TEXT,
      created_ts         INTEGER NOT NULL,
      updated_ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_intent_state_status ON intent_state(status, created_ts);

    -- Behavioral Determinism Layer (the design). Per goal_class,
    -- an ordered list of canonical steps with entry/exit criteria,
    -- allowed/forbidden tool sets, and worker role. The LLM is creative
    -- WITHIN each step; the substrate determines step transitions. Loaded
    -- by the closed autonomy tier; seeded with the built-in goal-class definitions per
    -- the design.
    CREATE TABLE IF NOT EXISTS step_definitions (
      goal_class      TEXT    NOT NULL,
      step_name       TEXT    NOT NULL,
      step_order      INTEGER NOT NULL,         -- sequence within goal_class
      entry_criteria  TEXT    NOT NULL,         -- JSON: predicate list (the design)
      exit_criteria   TEXT    NOT NULL,         -- JSON: predicate list
      allowed_tools   TEXT,                     -- JSON array of tool names (null = any)
      forbidden_tools TEXT,                     -- JSON array of tool names (null = none)
      worker_role     TEXT,                     -- 'fetcher' | 'synthesizer' | 'planner' | ...
      max_iterations  INTEGER DEFAULT 5,        -- loop-detector escalation threshold
      timeout_ms      INTEGER DEFAULT 60000,
      created_ts      INTEGER NOT NULL,
      PRIMARY KEY (goal_class, step_name)
    );
    CREATE INDEX IF NOT EXISTS idx_step_defs_class_order
      ON step_definitions(goal_class, step_order);

    -- Schema-version meta. Single-row table (key='current') tracks the
    -- substrate schema version. Replaces the prior pattern of
    -- "try/catch ALTER + assume the column exists" — that worked for
    -- additive changes but provides no version visibility, no migration
    -- triggers, no way to detect a row written under an older shape.
    -- Mirror of the pattern already shipped in proxy/modules/migrate.js
    -- (for reflexion/trajectory side DBs), finally wired into the main
    -- state.db per the design.
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- cost subsystem — per-charge cost ledger.
    --
    -- The in-process budget warden caps spend WITHIN a single task. Without
    -- persistence, restart resets the counters and the partner can quietly
    -- burn budget across days. This table gives /api/l4/status a real
    -- cost_24h figure and lets operators audit "what did the partner spend
    -- last week" without scraping action_records (which only emits cost
    -- events for tasks deep enough to land in cost.js).
    --
    -- Granularity: one row per budget-warden.charge() — one per LLM call,
    -- not one per goal. goal_id chains to the goal record; goal_class lets
    -- us aggregate without a join. usd is the dollar cost at the lookup
    -- rate the warden used (so historical rate changes don't retroactively
    -- alter what we charged).
    CREATE TABLE IF NOT EXISTS l4_cost_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      goal_id         TEXT,                 -- nullable: ad-hoc charges (e.g. chat) may not bind to a goal
      goal_class      TEXT,
      agent_id        TEXT,
      model           TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      usd             REAL    NOT NULL DEFAULT 0,
      provider        TEXT                  -- transport truth (local/codex/deepseek/...); drives per-pool caps
    );
    CREATE INDEX IF NOT EXISTS idx_l4ce_ts        ON l4_cost_events(ts);
    CREATE INDEX IF NOT EXISTS idx_l4ce_class_ts  ON l4_cost_events(goal_class, ts);
    CREATE INDEX IF NOT EXISTS idx_l4ce_goal      ON l4_cost_events(goal_id, ts);

    -- D2 — effect ledger: crash-safe dedup of real-world side-effects.
    -- effect_key is STABLE (sha256 of scope+payload+irreversibility, NO time
    -- bucket — intent.computeEffectKey), so a resume HOURS after a crash that
    -- landed between "adapter succeeded" and "observation written" recognises
    -- the side-effect as already done and SKIPS re-dispatch, so a retry never
    -- repeats it. PRIMARY KEY + INSERT OR IGNORE = the dedup.
    CREATE TABLE IF NOT EXISTS l4_effect_ledger (
      effect_key   TEXT PRIMARY KEY,
      intent_id    TEXT,
      goal_id      TEXT,
      scope        TEXT,
      external_id  TEXT,
      result_hash  TEXT,
      status       TEXT NOT NULL DEFAULT 'done',
      ts           INTEGER NOT NULL,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l4el_ts     ON l4_effect_ledger(ts);
    CREATE INDEX IF NOT EXISTS idx_l4el_intent ON l4_effect_ledger(intent_id);

    -- audit subsystem — web allowlist audit log. When mode=auto_grow or
    -- mode=open, the substrate auto-permits previously-unknown hosts the
    -- partner fetches. Every such auto-grant lands here so the operator
    -- can review + revoke later. Strict mode never writes to this table
    -- (operator-deliberate adds use the existing inbox path).
    CREATE TABLE IF NOT EXISTS l4_allowlist_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      host        TEXT NOT NULL,
      sample_url  TEXT,
      mode        TEXT NOT NULL,        -- 'auto_grow' | 'open'
      goal_id     TEXT,
      goal_class  TEXT,
      action      TEXT NOT NULL DEFAULT 'auto_added',  -- 'auto_added' | 'revoked'
      revoked_ts  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_l4aa_ts   ON l4_allowlist_audit(ts);
    CREATE INDEX IF NOT EXISTS idx_l4aa_host ON l4_allowlist_audit(host, ts);

    -- operator-request subsystem — operator-request inbox.
    --
    -- The autonomous partner hits real-world ceilings the substrate can't
    -- transparently cross: a fetch off the allowlist, a credential that
    -- isn't in the vault, a transaction that costs money, an approval
    -- the operator gated via show_plan_and_approve transparency. Without a
    -- structured channel for "I need X from you, here's why", the partner
    -- silently degrades (falls back to chat, refuses, or burns budget
    -- retrying). This table is the queryable inbox surfaces the dashboard
    -- renders so the operator sees pending asks at a glance + clears them
    -- with one click. status='pending' rows are what the inbox card shows;
    -- 'resolved' / 'dismissed' rows stay for audit.
    --
    -- detail is the JSON payload specific to kind:
    --   allowlist_add  → { host, sample_url, why? }
    --   credential     → { service, scope, why? }
    --   money          → { amount, currency, destination?, why? }
    --   approval       → { plan, transparency_promote? (bool) }
    --   manual         → { instruction }  // free-text fallback
    CREATE TABLE IF NOT EXISTS l4_operator_requests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      goal_id        TEXT,
      goal_class     TEXT,
      kind           TEXT NOT NULL,                 -- allowlist_add | credential | money | approval | manual
      urgency        TEXT NOT NULL DEFAULT 'normal',-- low | normal | high
      detail         TEXT,                          -- JSON payload (per kind)
      status         TEXT NOT NULL DEFAULT 'pending',-- pending | resolved | dismissed
      resolved_ts    INTEGER,
      resolved_by    TEXT,                          -- 'operator' | 'auto' | agent_id
      resolution_note TEXT,
      dedup_key      TEXT                           -- hash for dedup-window suppression
    );
    CREATE INDEX IF NOT EXISTS idx_l4or_status_ts ON l4_operator_requests(status, ts);
    CREATE INDEX IF NOT EXISTS idx_l4or_dedup     ON l4_operator_requests(dedup_key, ts);
    CREATE INDEX IF NOT EXISTS idx_l4or_goal      ON l4_operator_requests(goal_id, ts);

    -- briefing subsystem — briefing log.
    --
    -- The autonomy tier emits a briefing on every executed/refused/pending goal.
    -- Without a log, /api/l4/status fakes recent_briefings from the
    -- satisfaction list (loses refused / pending / execution_failed +
    -- erases reasoning). This table makes the partner's reasoning
    -- queryable across restarts so the dashboard RECENT BRIEFINGS card
    -- shows what the partner actually did, not just what it finished.
    CREATE TABLE IF NOT EXISTS l4_briefings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      goal_id     TEXT,
      goal_class  TEXT,
      decision    TEXT NOT NULL,    -- executed | execution_failed | pending_approval | disabled_by_config | no_providers | class_pursuit_disabled
      faculty     TEXT,             -- which orchestrator picked (D.2 routing)
      briefing    TEXT,             -- composed briefing text (operator-facing summary)
      success     INTEGER NOT NULL DEFAULT 0,  -- 1 = executed cleanly
      spent_usd   REAL    NOT NULL DEFAULT 0,
      reflection_text TEXT,         -- raw_text from reflection.reflect, when run
      classification_text TEXT      -- classifier match: e.g. 'code:0.500' for grep
    );
    CREATE INDEX IF NOT EXISTS idx_l4b_ts        ON l4_briefings(ts);
    CREATE INDEX IF NOT EXISTS idx_l4b_class_ts  ON l4_briefings(goal_class, ts);
    CREATE INDEX IF NOT EXISTS idx_l4b_goal      ON l4_briefings(goal_id, ts);



    -- design: calibration ledger for confidence scoring.
    -- One row per (claim, outcome) pair so we can fit a Platt scaler
    -- monthly (Platt 1999) and reconcile predicted vs. actual.
    CREATE TABLE IF NOT EXISTS l4_confidence_calibration (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL,
      claim_engram_id   TEXT,
      kind              TEXT NOT NULL,    -- 'critic' | 'reflection' | 'anticipation' | ...
      predicted         REAL NOT NULL,    -- 0-1 raw confidence at claim time
      actual            INTEGER,          -- 1 = confirmed true, 0 = falsified, NULL = unknown
      outcome_ts        INTEGER,          -- when outcome was recorded
      notes             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l4cc_ts        ON l4_confidence_calibration(ts);
    CREATE INDEX IF NOT EXISTS idx_l4cc_kind_ts   ON l4_confidence_calibration(kind, ts);
    CREATE INDEX IF NOT EXISTS idx_l4cc_engram    ON l4_confidence_calibration(claim_engram_id);


    -- design: signed append-only action audit chain
    -- (Chan et al. 2024 'Visibility into AI Agents'). Each row
    -- signs the SHA256 hash of (prev_hash + canonical(record)) with
    -- ed25519. Verifier walks the chain forward; any tamper breaks
    -- the chain (hash mismatch OR signature invalid).
    CREATE TABLE IF NOT EXISTS l4_signed_audit_chain (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      action_id       TEXT,           -- engram/tool_call id this row attests
      kind            TEXT,           -- engram | tool_call | l4_briefing | ...
      record_hash     TEXT NOT NULL,  -- sha256 hex of canonical record body
      prev_chain_hash TEXT,           -- previous row's chain_hash, NULL for genesis
      chain_hash      TEXT NOT NULL,  -- sha256(prev_chain_hash + record_hash)
      signature       TEXT NOT NULL,  -- ed25519 signature over chain_hash (base64)
      public_key_id   TEXT NOT NULL   -- which key signed (rotation support)
    );
    CREATE INDEX IF NOT EXISTS idx_l4sac_ts         ON l4_signed_audit_chain(ts);
    CREATE INDEX IF NOT EXISTS idx_l4sac_action_id  ON l4_signed_audit_chain(action_id);
  `);

  // Initialize schema version after CREATE so the row exists for downstream
  // getSchemaVersion() calls. Idempotent — only writes if absent. Future
  // migrations bump CURRENT_SCHEMA + register an upgrade function in a
  // dedicated migrate-runner (see the design — `troth migrate` command).
  try {
    d.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('current_version', ?)")
      .run(String(CURRENT_SCHEMA));
  } catch (_) { /* meta init failure → readers fall back to version 1 */ }

  // design universal STVC invariants.
  //
  // Without seed data the state-machine validator is a no-op: empty
  // invariants table means everything passes. Seed at migrate() so
  // every substrate (fresh or migrated) inherits the safety floor.
  // All three are INSERT OR IGNORE → idempotent across re-runs.
  //
  // Severity tuning to not break existing writers:
  //   audience required: error. recordAction defaults to
  //     'substrate_internal' when caller omits, so every existing path
  //     satisfies this without code changes.
  //   memory_class valid enum: error. recordAction defaults to
  //     'operational' which is in the enum.
  //   tool_call has transition_kind: WARN (not error). Existing tool_call
  //     writers don't stamp it; promoting to error would reject every
  //     legacy tool dispatch. Warn surfaces them in the rejected_transition
  //     audit channel without blocking. Promote to error in (later milestone) once
  //     the coordinator stamps transition_kind on every dispatch.
  try {
    const seedStmt = d.prepare(`
      INSERT OR IGNORE INTO state_invariants
      (id, predicate, scope, severity, description, created_ts, created_by)
      VALUES (?, ?, NULL, ?, ?, ?, 'state.js:migrate')
    `);
    const now = Date.now();
    seedStmt.run(
      'seed:audience-required',
      JSON.stringify({ kind: 'field_required', field: 'audience' }),
      'error',
      'Every action_record must declare its audience (model_visible | substrate_internal | synthesis_of_external).',
      now
    );
    seedStmt.run(
      'seed:memory-class-enum',
      JSON.stringify({
        kind: 'field_value', field: 'memory_class', op: 'oneOf',
        values: ['identity','episodic','semantic','procedural','operational','ephemeral']
      }),
      'error',
      'memory_class must be one of the 6 brain-grounded classes (Tulving 1972 / Andrews-Hanna 2010).',
      now
    );
    // SLICE-A-aug — seed a credential-leak guard. Blocks
    // tool_call args containing the canonical secret shapes operators
    // never want shipped to remote services (or committed to a repo via
    // a tool-driven write). Catches the most common.env-leak failure
    // modes without false-positive risk on normal prose. Operator can
    // /invariants remove seed:credential-leak-guard if a workflow
    // legitimately needs to pass these (rare — usually means the
    // pattern itself is wrong and should be tightened).
    //
    // Patterns covered:
    //   sk-[20+ chars]      Anthropic / OpenAI API keys
    //   AKIA[16 chars]      AWS access key id
    //   ASIA[16 chars]      AWS temporary access key
    //   ghp_ / gho_ / ghu_ / ghs_ / ghr_   GitHub PATs + OAuth + refresh
    //   xox[bsoap]-[10+]    Slack bot / user / app / refresh tokens
    //   AIza[35 chars]      Google API key
    //   eyJ[base64]         JWT tokens
    //   -----BEGIN.* PRIVATE KEY----- any PEM private key
    //   .env-style assignments where value looks credential-shaped
    seedStmt.run(
      'seed:credential-leak-guard',
      JSON.stringify({
        kind: 'tool_args_regex',
        patterns: [
          { name: 'anthropic_openai_key', pattern: 'sk-[A-Za-z0-9_-]{20,}' },
          { name: 'aws_access_key',       pattern: '(?:AKIA|ASIA)[0-9A-Z]{16}' },
          { name: 'github_token',         pattern: 'gh[poushr]_[A-Za-z0-9]{30,}' },
          { name: 'slack_token',          pattern: 'xox[bsoapr]-[A-Za-z0-9-]{10,}' },
          { name: 'google_api_key',       pattern: 'AIza[0-9A-Za-z_-]{35}' },
          { name: 'jwt',                  pattern: 'eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+' },
          { name: 'pem_private_key',      pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
          { name: 'env_password_assign',  pattern: '(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\\s*=\\s*["\\\']?[^\\s"\\\']{8,}', flags: 'i' }
        ]
      }),
      'error',
      'Blocks tool_call args containing canonical credential shapes (API keys, AWS/GitHub/Slack tokens, JWTs, PEM keys, .env-style secret assignments). Prevents accidental .env leak via tool execution. Remove only if a workflow legitimately needs to pass these.',
      now
    );

    // (transition_kind-required for tool_call is deferred — it needs a
    // conditional predicate kind (`when_type=X require_field=Y`) which the
    // v1 predicate language doesn't have. Slated for (later milestone) when the
    // coordinator starts stamping transition_kind on every dispatch.)
  } catch (_) { /* seed failure → table missing or schema race; safe to skip */ }

  // SLICE-B.1 — Seed v1 goal-class step definitions. Lazy
  // require avoids tight module-load coupling. seedAll() uses INSERT OR
  // REPLACE so re-running picks up code-side tweaks to seed steps
  // without a manual migration.
  try {
    const goalRegistry = require('./goal-class-registry.js');
    if (typeof goalRegistry.seedAll === 'function') goalRegistry.seedAll();
  } catch (_) { /* registry load failure → step_definitions table stays empty; downstream step-engine will skip */ }
}

// substrate schema version. Bump when adding a column or table that downstream
// readers require. Migration runners check getSchemaVersion() < CURRENT_SCHEMA
// to detect rows written under an older shape.
//
// Version log:
//   1 — initial action_records + audience/memory_class/principal_id
//   2 — foundation step: transition_signature/_kind,
//       schema_version per-row, goal_class_stats, state_invariants,
//       step_definitions, schema_meta.
//   3 — cost subsystem: l4_cost_events for persistent per-charge
//       cost ledger; lets /api/l4/status surface real cost_24h.
//   4 — briefing subsystem: l4_briefings log so the partner's
//       reasoning is queryable across restart (not just satisfactions).
//   5 — operator-request subsystem: l4_operator_requests inbox so the
//       partner can structurally ask the operator for things it can't
//       cross on its own (allowlist additions, credentials, money,
//       approvals).
//   6 — audit subsystem: l4_allowlist_audit so auto-grow
//       and open-mode allowlist additions land in a queryable audit log.
const CURRENT_SCHEMA = 6;

function getSchemaVersion() {
  try {
    const row = db().prepare("SELECT value FROM schema_meta WHERE key='current_version'").get();
    return row ? parseInt(row.value, 10) || 1 : 1;
  } catch (_) {
    // schema_meta table not yet created (first-run pre-migrate) → version 1.
    return 1;
  }
}

function recordHookEvent(ev) {
  const stmt = db().prepare(`
    INSERT INTO hook_events
    (ts, session_id, event, tool, decision, reason, tokens_in, tokens_out, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    ev.ts || Date.now(),
    ev.session_id || null,
    ev.event,
    ev.tool || null,
    ev.decision || null,
    ev.reason || null,
    ev.tokens_in || 0,
    ev.tokens_out || 0,
    ev.metadata ? JSON.stringify(ev.metadata) : null
  );

  // Every hook fire refreshes the plugin-presence heartbeat so the
  // proxy can tell — without any IPC — whether the plugin is currently
  // active on this machine. Proxy reads this on each request and
  // self-disables overlapping modules when active.
  try {
    // Only overwrite session_id when the hook actually has one. Some hook
    // events (e.g. PreCompact, certain UserPromptSubmit fires) arrive
    // without session_id in the payload — clobbering the stored value
    // with NULL would erase the actual session that's running.
    db().prepare(`
      INSERT INTO plugin_presence (id, last_seen_ts, session_id, plugin_version)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen_ts = excluded.last_seen_ts,
        session_id   = COALESCE(excluded.session_id, plugin_presence.session_id),
        plugin_version = excluded.plugin_version
    `).run(Date.now(), ev.session_id || null, process.env.TROTH_PLUGIN_VERSION || null);
  } catch (e) { /* swallow — telemetry must never break a hook */ }
}

// Proxy-side: is the plugin currently active? `withinMs` defaults to 5 min
// so idle sessions clear after a few minutes without needing a tear-down signal.
function isPluginActive(withinMs) {
  try {
    const cutoff = Date.now() - (withinMs || 5 * 60 * 1000);
    const row = db().prepare(
      'SELECT last_seen_ts, session_id FROM plugin_presence WHERE id = 1'
    ).get();
    if (!row) return { active: false };
    return {
      active: row.last_seen_ts >= cutoff,
      last_seen_ts: row.last_seen_ts,
      session_id: row.session_id
    };
  } catch (e) { return { active: false }; }
}

// Per-request usage row — the PERSISTENT twin of cost.js's in-memory totals.
// The dashboard totals reset on every proxy restart (the operator's app
// restarts several times a day), so "transparent usage" was per-boot fiction;
// proxy_stats above was created for this but keyed ts-only (no model
// dimension) and was never written. usage_ledger is append-only and cheap:
// one small row per completed request.
function recordProxyUsage(model, tokensIn, tokensOut, cachedIn) {
  if (!model) return;
  try {
    db().prepare(
      'INSERT INTO usage_ledger (ts, model, tokens_in, tokens_out, cached_in) VALUES (?, ?, ?, ?, ?)'
    ).run(Date.now(), String(model), tokensIn | 0, tokensOut | 0, cachedIn | 0);
  } catch (_) { /* usage history is a feature, never a request blocker */ }
}

function recordSavings(kind, tokens, session_id, note, model) {
  db().prepare(`
    INSERT INTO savings_ledger (ts, kind, tokens, session_id, note, model)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now(), kind, tokens, session_id || null, note || null, model || null);
}

function recordModuleError(opts) {
  // opts: { module, kind?, message?, model? }
  if (!opts || !opts.module) return;
  db().prepare(`
    INSERT INTO module_errors (ts, module, kind, message, model)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    opts.module,
    opts.kind || null,
    (opts.message || '').toString().slice(0, 500),
    opts.model || null
  );
}

function recordCacheRatioEvent(opts) {
  // opts: { model, reads?, writes?, uncached? }
  if (!opts || !opts.model) return;
  db().prepare(`
    INSERT INTO cacheratio_events (ts, model, reads, writes, uncached)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    opts.model,
    opts.reads | 0,
    opts.writes | 0,
    opts.uncached | 0
  );
}

function recordBaselineCost(opts) {
  // opts: { actual_model, actual_cost, baseline_model, baseline_cost,
  //         tokens_in?, tokens_out?, tokens_cached?, session_id? }
  if (!opts || typeof opts.actual_cost !== 'number' || typeof opts.baseline_cost !== 'number') return;
  db().prepare(`
    INSERT INTO baseline_cost_events
      (ts, session_id, actual_model, actual_cost, baseline_model, baseline_cost,
       tokens_in, tokens_out, tokens_cached)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    opts.session_id || null,
    opts.actual_model || null,
    opts.actual_cost,
    opts.baseline_model || 'claude-sonnet-4.6',
    opts.baseline_cost,
    opts.tokens_in | 0,
    opts.tokens_out | 0,
    opts.tokens_cached | 0
  );
}

function recordMcpToolCall(opts) {
  // opts: { tool, cache_hit, bytes?, latency_ms?, error_message?, session_id? }
  if (!opts || !opts.tool) return;
  db().prepare(`
    INSERT INTO mcp_tool_calls (ts, session_id, tool, cache_hit, bytes, latency_ms, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    opts.session_id || null,
    opts.tool,
    opts.cache_hit ? 1 : 0,
    opts.bytes | 0,
    opts.latency_ms | 0,
    opts.error_message || null
  );
}

function recordToolCallHash(session_id, hash) {
  db().prepare(`
    INSERT OR IGNORE INTO loopbreaker_hashes (session_id, hash, ts)
    VALUES (?, ?, ?)
  `).run(session_id, hash, Date.now());
}

function countRecentToolCallHashes(session_id, hash, windowMs) {
  const since = Date.now() - windowMs;
  const row = db().prepare(`
    SELECT COUNT(*) as n FROM loopbreaker_hashes
    WHERE session_id = ? AND hash = ? AND ts >= ?
  `).get(session_id, hash, since);
  return row.n;
}

function markFileRead(session_id, filepath) {
  db().prepare(`
    INSERT OR REPLACE INTO verifyfirst_reads (session_id, path, ts)
    VALUES (?, ?, ?)
  `).run(session_id, filepath, Date.now());
}

function wasFileRead(session_id, filepath) {
  const row = db().prepare(`
    SELECT 1 FROM verifyfirst_reads
    WHERE session_id = ? AND path = ?
    LIMIT 1
  `).get(session_id, filepath);
  return !!row;
}

function archiveToolOutput(session_id, tool, raw, summary) {
  const stmt = db().prepare(`
    INSERT INTO tool_output_archive
    (session_id, tool, ts, raw, summary, bytes_in, bytes_out)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    session_id || null,
    tool || null,
    Date.now(),
    raw,
    summary,
    Buffer.byteLength(raw || '', 'utf8'),
    Buffer.byteLength(summary || '', 'utf8')
  );
  return info.lastInsertRowid;
}

// FTS5-backed search across all archived raw content. Supports standard
// FTS5 syntax ("foo AND bar", "col:value"), returns snippet-extracted rows.
function searchArchive(query, opts) {
  opts = opts || {};
  const limit = Math.min(parseInt(opts.limit || 20), 100);
  const sessionFilter = opts.session_id ? ' AND a.session_id = @session_id' : '';
  const rows = db().prepare(`
    SELECT a.id, a.session_id, a.tool, a.ts, a.bytes_in, a.bytes_out,
           snippet(tool_output_fts, 0, '«', '»', '…', 16) AS snippet
    FROM tool_output_fts f
    JOIN tool_output_archive a ON a.id = f.rowid
    WHERE tool_output_fts MATCH @query ${sessionFilter}
    ORDER BY a.ts DESC
    LIMIT @limit
  `).all({ query, session_id: opts.session_id, limit });
  return rows;
}

function getArchiveEntry(id) {
  return db().prepare(`
    SELECT id, session_id, tool, ts, raw, summary, bytes_in, bytes_out
    FROM tool_output_archive WHERE id = ?
  `).get(id) || null;
}

function getArchiveExcerpt(id, startLine, endLine) {
  const row = getArchiveEntry(id);
  if (!row) return null;
  const lines = (row.raw || '').split('\n');
  const total = lines.length;
  const from = Math.max(0, (startLine || 1) - 1);
  const to = Math.min(total, endLine || total);
  return {
    id: row.id, tool: row.tool, ts: row.ts,
    total_lines: total,
    start: from + 1, end: to,
    content: lines.slice(from, to).join('\n')
  };
}

// ── Session lessons (critic ↔ reflexion loop) ─────────────────
// Signature: recordLesson(session_id, cwd, source, fingerprint, lesson, opts).
// Older callers passed (session_id, source, fingerprint, lesson) — we
// detect that shape and shift args so we don't break the plugin mid-
// migration.
//
// opts.durable=false writes ONLY the delivery queue. The dual-write made
// every lesson permanent, and most lessons are not: a working-style warning
// about the previous turn is coaching for the next one, not a fact about the
// world — yet 886 fidelity warnings sat in the permanent store as semantic,
// model-visible memories, each one a sentence about a turn nobody can see
// any more. What deserves to outlive the session says so; what does not is
// delivered once and swept with the queue.
function recordLesson(session_id, cwd, source, fingerprint, lesson, opts) {
  // Backwards-compat: old 4-arg call → shift.
  if (arguments.length === 4 && typeof cwd === 'string' && typeof fingerprint === 'string' &&
      lesson === undefined) {
    lesson = fingerprint;
    fingerprint = source;
    source = cwd;
    cwd = null;
  }
  if (!session_id || !lesson) return null;
  const info = db().prepare(`
    INSERT INTO session_lessons (session_id, cwd, ts, source, fingerprint, lesson)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(session_id, cwd || null, Date.now(), source || 'unknown', fingerprint || '', lesson);

  // Substrate-conformant mirror. GMP v0.1 says lessons are ActionRecords
  // of type='lesson'. Without this dual-write the canonical store
  // (action_records) only sees lessons that errortax explicitly wrote there
  // critic + loopbreaker + any other caller of recordLesson bypassed
  // the substrate entirely, fragmenting cross-tool reads and breaking the
  // KnowledgeAtlas export contract. The legacy session_lessons table is
  // kept above so pullLessons() and existing readers still work, but the
  // substrate is now the canonical store.
  if (opts && opts.durable === false) return info.lastInsertRowid;
  try {
    const actionRecord = require('./action-record.js');
    const rec = actionRecord.create({
      type: 'lesson',
      agent_id: 'troth-plugin',
      session_id,
      cwd: cwd || null,
      input: {
        source: source || 'unknown',
        fingerprint: fingerprint || ''
      },
      output: { text: lesson }
    });
    const v = actionRecord.validate(rec);
    if (v.ok) recordAction(rec, actionRecord.toSearchText(rec));
  } catch (e) {
    // Telemetry must never break the legacy path — substrate-mirror
    // failure is logged to stderr only.
    process.stderr.write('[recordLesson substrate mirror] ' + e.message + '\n');
  }

  return info.lastInsertRowid;
}

// A lesson the OPERATOR taught, as opposed to one a guard noticed.
//
// The two are different animals wearing the same word. What errortax, the
// critic and the fidelity rails write is a transient warning: relevant to the
// next turn, consumed on read, forgotten after. What an operator states is a
// standing rule: it must survive every session, never be consumed, and come
// back through recall whenever it is relevant. Lesson rows fill with imported
// curricula and automated warnings; none of them come from operator
// instruction while there is no way to write one.
// write one. A rule taught in conversation ended up in an engram if the
// assistant happened to remember, and nowhere if it did not.
//
// This writes the durable half ONLY: an action_record of type='lesson' that
// query.getLessons and recall's semantic arm both read. It deliberately does
// NOT touch session_lessons, because pullLessons() marks what it returns as
// consumed — a standing rule pushed through that path would be shown once and
// then silently disappear, which is the opposite of the point.
//
// scope: 'global' (applies everywhere) | 'project' (this cwd only).
// Dedup is by fingerprint so the same rule restated does not pile up.
function recordOperatorLesson(opts) {
  opts = opts || {};
  const text = String(opts.lesson || opts.text || '').trim();
  if (!text) return null;
  const scope = opts.scope === 'project' ? 'project' : 'global';
  const cwd = scope === 'project' ? (opts.cwd || null) : null;
  // Fingerprint on the normalised text: restating the same rule in the same
  // words is a no-op, restating it differently is a new rule the operator
  // meant to add.
  const fingerprint = 'operator:' + require('crypto').createHash('sha1')
    .update(text.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
  try {
    const existing = db().prepare(
      "SELECT id FROM action_records WHERE type = 'lesson' AND json_extract(input,'$.fingerprint') = ? LIMIT 1"
    ).get(fingerprint);
    if (existing) return { id: existing.id, duplicate: true, fingerprint };
  } catch (_) { /* first run / missing index: fall through and write */ }
  try {
    const actionRecord = require('./action-record.js');
    const rec = actionRecord.create({
      type: 'lesson',
      agent_id: opts.agent_id || 'operator',
      session_id: opts.session_id || null,
      cwd,
      input: { source: 'operator', fingerprint, scope, why: opts.why || null },
      output: { text, scope, source_authority: 'operator_confirmed' }
    });
    // create() builds the causal shape and drops anything outside it, so
    // these two ride on AFTER it. They are not decoration: recall filters on
    // exactly these columns (memory_class in the recallable set AND audience
    // model_visible), and the writer's fail-closed defaults are
    // operational/substrate_internal. Passing them into create() looked
    // right and produced a rule the partner could never retrieve — written,
    // listed by the durable reader, invisible to every recall. Measured
    // 2026-08-10 before this line existed.
    rec.memory_class = 'semantic';
    rec.audience = 'model_visible';
    const v = actionRecord.validate(rec);
    if (!v || !v.ok) return null;
    const wrote = recordAction(rec, text);
    return wrote ? { id: rec.id, duplicate: false, fingerprint, scope } : null;
  } catch (_) { return null; }
}

// The standing rules, newest first. Read-only; never consumes.
function listOperatorLessons(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit || 20, 10)));
  try {
    const rows = db().prepare(`
      SELECT id, timestamp, cwd,
             json_extract(output,'$.text')  AS text,
             json_extract(output,'$.scope') AS scope
      FROM action_records
      WHERE type = 'lesson' AND json_extract(input,'$.source') = 'operator'
      ORDER BY timestamp DESC LIMIT ?
    `).all(limit) || [];
    if (!opts.cwd) return rows;
    // Global rules always apply; project rules only in their own project.
    return rows.filter((r) => r.scope !== 'project' || r.cwd === opts.cwd);
  } catch (_) { return []; }
}

// Pull up to `limit` unconsumed lessons. Returns current-session lessons
// first, then unconsumed lessons from OTHER sessions in the same project
// (by cwd). Deduped by fingerprint — if two sessions flagged the same
// failure, the user sees it once. Marks everything returned consumed so
// the injection doesn't fire repeatedly.
//
// Signature: pullLessons(session_id, cwd, opts). Callers that only pass
// (session_id, opts) get the old behaviour (same-session only).
function pullLessons(session_id, cwd, opts) {
  if (typeof cwd === 'object' && cwd !== null && opts === undefined) {
    opts = cwd;
    cwd = null;
  }
  if (!session_id) return [];
  opts = opts || {};
  const windowMs = opts.windowMs || 24 * 60 * 60 * 1000; // 24h cross-session
  const limit    = opts.limit    || 3;
  const cutoff   = Date.now() - windowMs;

  // Current session first (recency + specificity beat cross-session).
  const inSess = db().prepare(`
    SELECT id, source, fingerprint, lesson, session_id, cwd, 0 AS cross_session
    FROM session_lessons
    WHERE session_id = ? AND consumed = 0 AND ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(session_id, cutoff, limit);

  let crossRows = [];
  if (cwd && inSess.length < limit) {
    crossRows = db().prepare(`
      SELECT id, source, fingerprint, lesson, session_id, cwd, 1 AS cross_session
      FROM session_lessons
      WHERE cwd = ? AND session_id != ? AND consumed = 0 AND ts >= ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(cwd, session_id, cutoff, limit - inSess.length);
  }

  // Dedupe by fingerprint across both sets (keep current-session copy).
  const seen = new Set();
  const rows = [];
  for (const r of inSess.concat(crossRows)) {
    if (r.fingerprint && seen.has(r.fingerprint)) continue;
    if (r.fingerprint) seen.add(r.fingerprint);
    rows.push(r);
    if (rows.length >= limit) break;
  }

  if (rows.length) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db().prepare('UPDATE session_lessons SET consumed = 1 WHERE id IN (' + placeholders + ')').run(...ids);
  }
  return rows;
}

// ── action_records: write/read helpers ────────────────────────────
// Caller builds the record via shared-core/action-record.js (which validates
// and shapes). We just persist + mirror into FTS5.
// Cached state-machine reference. require()'d lazily on first recordAction
// call so module load order doesn't bite (state-machine.js requires state.js
// for the schema bootstrap; we lazy-load the reverse direction).
let _stateMachine = null;
function _getStateMachine() {
  if (_stateMachine) return _stateMachine;
  try { _stateMachine = require('./state-machine.js'); }
  catch (_) { _stateMachine = { validateTransition: null }; }
  return _stateMachine;
}

function recordAction(rec, searchText) {
  if (!rec || !rec.id || !rec.type || !rec.agent_id) return null;
  const d = db();
  const stmt = d.prepare(`
    INSERT INTO action_records
    (id, timestamp, type, agent_id, session_id, user_id, cwd, parent_id,
     context_hash, input, output, verification, outcome, principal_id,
     audience, memory_class, transition_signature, transition_kind,
     schema_version, context_id)
    VALUES
    (@id, @timestamp, @type, @agent_id, @session_id, @user_id, @cwd,
     @parent_id, @context_hash, @input, @output, @verification, @outcome,
     @principal_id, @audience, @memory_class, @transition_signature,
     @transition_kind, @schema_version, @context_id)
  `);
  // Which parent_id actually landed (the retry path below strips it). The
  // signed-chain attestation at the end hashes what was STORED, not what was
  // asked for, so a verifier can recompute record_hash from the row alone.
  let _storedParent;
  // Context default-stamp at the substrate boundary — same one-shot-coverage
  // rationale as principal_id above: every session-carrying writer inherits
  // the session's file-activity context without knowing the concept exists.
  // NULL survives as "unbound" (read side treats it as ctx:unsorted —
  // reachable by explicit recall, never auto-mounted).
  let _ctxStamp = rec.context_id || null;
  if (!_ctxStamp && rec.session_id && rec.type !== 'rejected_transition') {
    try { _ctxStamp = require('./context-registry.js').resolveSessionContext(rec.session_id); }
    catch (_) { _ctxStamp = null; }
  }
  try {
    // Default-stamp principal_id at the substrate boundary so EVERY writer
    // contributes to the unified read-side brain regardless of whether the
    // caller knows the concept exists. 48 call sites today; doing it here
    // is one-shot coverage. Order: explicit on record > env > 'partner'.
    const principal_id =
      rec.principal_id ||
      process.env.TROTH_PRINCIPAL ||
      'partner';
    //  audience + memory_class default-stamping
    // reconstruction v2. Writers SHOULD pass these explicitly per the
    // per-writer table (design note). Fail-closed defaults are deliberately
    // conservative: 'substrate_internal' so a forgetful caller can't
    // accidentally leak operational content into the LLM prefix, and
    // 'operational' (never auto-mount) as the safe memory bucket. Order:
    // explicit on record > fail-closed default.
    const audience =
      rec.audience ||
      'substrate_internal';
    const memory_class =
      rec.memory_class ||
      'operational';

    // substrate STVC validation gate. Runs AFTER default-
    // stamping so the augmented record (with audience/memory_class filled
    // in) is what gets validated. error-severity violations reject the
    // write; warn/info are recorded but allowed through. Fail-open on
    // validator crash (telemetry must never break the agent — R18).
    //
    // Bypass paths (recursion safety, system-internal writes):
    //   rec.type === 'rejected_transition' — the LOG we write to mark a
    //     rejection, must not itself trigger validation
    //   process.env.TROTH_STVC_BYPASS === '1' — operator escape hatch
    if (rec.type !== 'rejected_transition' && process.env.TROTH_STVC_BYPASS !== '1') {
      try {
        const sm = _getStateMachine();
        if (sm && typeof sm.validateTransition === 'function') {
          const augmented = Object.assign({}, rec, { principal_id, audience, memory_class });
          const v = sm.validateTransition({ proposed: augmented });
          if (!v.ok) {
            // Persist a 'rejected_transition' audit row. Uses a fresh id +
            // type='rejected_transition' which bypasses validation on the
            // recursive call. Best-effort; never throws back to caller.
            try {
              const arMod = require('./action-record.js');
              recordAction({
                id: arMod.uuidv7(),
                timestamp: Date.now(),
                type: 'rejected_transition',
                agent_id: rec.agent_id,
                cwd: rec.cwd || null,
                input: { rejected_rec_summary: { id: rec.id, type: rec.type, audience: rec.audience, memory_class: rec.memory_class } },
                output: { violations: v.violations },
                audience: 'substrate_internal',
                memory_class: 'operational'
              }, 'rejected_transition ' + v.violations.map(x => x.reason).join('; '));
            } catch (_) { /* audit-trail best-effort */ }
            return null;
          }
        }
      } catch (_) { /* validator crash → fail open */ }
    }

    stmt.run({
      id: rec.id,
      timestamp: rec.timestamp,
      type: rec.type,
      agent_id: rec.agent_id,
      session_id: rec.session_id || null,
      user_id: rec.user_id || null,
      cwd: rec.cwd || null,
      parent_id: rec.parent_id || null,
      context_hash: rec.context_hash || null,
      input: JSON.stringify(rec.input || {}),
      output: JSON.stringify(rec.output || {}),
      verification: JSON.stringify(rec.verification || {}),
      outcome: JSON.stringify(rec.outcome || {}),
      principal_id,
      audience,
      memory_class,
      // foundation step — transition_signature/_kind feed the
      // loop-detector + STVC pipeline. Writers that don't yet stamp them
      // get NULL; the loop-detector skips records with no signature so
      // legacy writers contribute zero false positives.
      transition_signature: rec.transition_signature || null,
      transition_kind:      rec.transition_kind || null,
      // Per-row schema fingerprint so migration runners can identify rows
      // written under the current shape vs an older one. New writes are
      // always stamped with CURRENT_SCHEMA.
      schema_version:       rec.schema_version || CURRENT_SCHEMA,
      context_id:           _ctxStamp
    });
    _storedParent = rec.parent_id || null;
  } catch (e) {
    // Duplicate id (rare with UUIDv7) or FK violation on parent_id. A dangling
    // parent must NOT cost the record itself: E2E-1 (post L4-split) caught a
    // follow-up dialogue turn silently vanishing because its parent percept
    // was never written. Retry once WITHOUT the lineage edge - losing an edge
    // beats losing the memory. Anything else still swallows (hook safety).
    if (rec.parent_id) {
      try {
        // Recompute the defaults: the try-block consts are out of scope here.
        const principal_id = rec.principal_id || process.env.TROTH_PRINCIPAL || 'partner';
        const audience = rec.audience || 'substrate_internal';
        const memory_class = rec.memory_class || 'operational';
        stmt.run({
          id: rec.id,
          timestamp: rec.timestamp,
          type: rec.type,
          agent_id: rec.agent_id,
          session_id: rec.session_id || null,
          user_id: rec.user_id || null,
          cwd: rec.cwd || null,
          parent_id: null,
          context_hash: rec.context_hash || null,
          input: JSON.stringify(rec.input || {}),
          output: JSON.stringify(rec.output || {}),
          verification: JSON.stringify(rec.verification || {}),
          outcome: JSON.stringify(rec.outcome || {}),
          principal_id,
          audience,
          memory_class,
          transition_signature: rec.transition_signature || null,
          transition_kind:      rec.transition_kind || null,
          schema_version:       rec.schema_version || CURRENT_SCHEMA,
          context_id:           _ctxStamp
        });
        _storedParent = null;
      } catch (_) { return null; }
    } else {
      return null;
    }
  }
  // FTS5 mirror. We store the rowid as a content-less index keyed by id via
  // a sidecar lookup (action_records.id is the primary key). Keep it simple
  // for now: store search_text with a rowid = rowid of the main row.
  if (searchText) {
    try {
      // Using SQLite's rowid equivalence — action_records.rowid matches here
      // since id is TEXT PK (rowid is the implicit integer).
      const row = d.prepare('SELECT rowid FROM action_records WHERE id = ?').get(rec.id);
      if (row) {
        d.prepare('INSERT INTO action_records_fts(rowid, search_text) VALUES (?, ?)')
          .run(row.rowid, searchText);
      }
    } catch (_) { /* FTS mirror failure is non-fatal */ }
  }
  // Persisted supersession index. buildSupersededIds (recall.js) and the
  // listEngrams filter scan only the rows a query happened to fetch, so a
  // successor outside the window let its retired predecessor keep surfacing
  // — the window was the whole guarantee. Mirror every lifetime.supersedes
  // pointer into its own table at write time; the read side unions this set
  // with the window scan. Best-effort like the FTS mirror: losing an index
  // row degrades back to exactly the old window behaviour, never worse.
  try {
    const _sup = rec.output && rec.output.lifetime && rec.output.lifetime.supersedes;
    if (_sup) {
      const _ids = Array.isArray(_sup) ? _sup : [_sup];
      const _ins = d.prepare('INSERT OR REPLACE INTO superseded_ids (superseded_id, successor_id, ts) VALUES (?, ?, ?)');
      for (const _sid of _ids) { if (_sid) _ins.run(String(_sid), rec.id, rec.timestamp || Date.now()); }
    }
  } catch (_) { /* index mirror failure is non-fatal */ }
  // Extend the tamper-evident signed chain over THIS write. The chain used
  // to attest only control-channel dispatches — 40 rows against ~582,000
  // engram writes — so a raw UPDATE of memory, identity or goals was
  // invisible to `troth audit verify`: it attested a chain that covered
  // nothing. Every recordAction now appends one signed row (sha256 of the
  // stored columns, ed25519 over the running chain hash; the read-head +
  // append is one immediate transaction so concurrent writers serialize
  // instead of forking the chain). Synchronous — sub-millisecond — and
  // fail-open: losing one chain row beats losing the memory.
  try {
    const _sa = require('./signed-audit.js');   // lazy: signed-audit requires state at its top
    _sa.attestSync({
      action_id: rec.id,
      kind: 'action_record',
      record: {
        id: rec.id,
        timestamp: rec.timestamp,
        type: rec.type,
        agent_id: rec.agent_id,
        session_id: rec.session_id || null,
        user_id: rec.user_id || null,
        cwd: rec.cwd || null,
        parent_id: _storedParent === undefined ? (rec.parent_id || null) : _storedParent,
        context_hash: rec.context_hash || null,
        input: JSON.stringify(rec.input || {}),
        output: JSON.stringify(rec.output || {}),
        verification: JSON.stringify(rec.verification || {}),
        outcome: JSON.stringify(rec.outcome || {}),
        principal_id: rec.principal_id || process.env.TROTH_PRINCIPAL || 'partner',
        audience: rec.audience || 'substrate_internal',
        memory_class: rec.memory_class || 'operational'
      }
    });
  } catch (_) { /* attestation is best-effort; the write stands */ }
  return rec.id;
}

function getAction(id) {
  if (!id) return null;
  const row = db().prepare(`
    SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
           parent_id, context_hash, input, output, verification, outcome,
           principal_id, audience, memory_class,
           transition_signature, transition_kind, schema_version, context_id
    FROM action_records WHERE id = ?
  `).get(id);
  return row || null;
}

// ── P16 Tier 1 — DecisionGraph typed edges ─────────────────────────────────
// Six canonical labels per research G16.D (evidence-based, minimal,
// explosion-resistant). Custom labels allowed via 'ext:' prefix; only the
// six are first-class for query optimization.
const CANONICAL_EDGE_LABELS = Object.freeze([
  'refines_intent',
  'contradicts_prior',
  'supersedes',
  'produces_edit',
  'satisfies',
  'rationalizes'
]);

// Write a typed edge between two ActionRecords. Returns the edge id on
// success, null on validation/FK failure. Telemetry must never break a
// hook — failures are silent.
//
// FK enforcement: SQLite's foreign_keys pragma is OFF on this connection
// (we do not change it globally to avoid invalidating any existing rows
// with orphaned parent_ids). We pre-check from_id + to_id existence here
// so writes against nonexistent records cleanly return null.
function recordEdge(opts) {
  if (!opts || !opts.from_id || !opts.to_id || !opts.label) return null;
  if (!CANONICAL_EDGE_LABELS.includes(opts.label) && !opts.label.startsWith('ext:')) return null;
  if (opts.weight !== undefined && opts.weight !== null) {
    if (typeof opts.weight !== 'number' || !Number.isFinite(opts.weight)) return null;
  }
  const d = db();
  // FK pre-check
  const fromRow = d.prepare('SELECT 1 FROM action_records WHERE id = ?').get(opts.from_id);
  if (!fromRow) return null;
  const toRow = d.prepare('SELECT 1 FROM action_records WHERE id = ?').get(opts.to_id);
  if (!toRow) return null;
  const id = require('./action-record').uuidv7();
  try {
    d.prepare(`
      INSERT INTO action_record_edges (id, from_id, to_id, label, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, opts.from_id, opts.to_id, opts.label,
           typeof opts.weight === 'number' ? opts.weight : null, Date.now());
    return id;
  } catch (_) { return null; }
}

// Filter edges by from_id / to_id / label. Returns raw edge rows (no
// JSON parsing — edges have no JSON columns).
function queryEdges(opts) {
  opts = opts || {};
  const where = [];
  const bind  = {};
  if (opts.from_id) { where.push('from_id = @from_id'); bind.from_id = opts.from_id; }
  if (opts.to_id)   { where.push('to_id = @to_id');     bind.to_id   = opts.to_id; }
  if (opts.label)   { where.push('label = @label');     bind.label   = opts.label; }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(parseInt(opts.limit || 200), 2000);
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  return db().prepare(`
    SELECT id, from_id, to_id, label, weight, created_at
    FROM action_record_edges ${whereSQL}
    ORDER BY created_at ${order}
    LIMIT ${limit}
  `).all(bind);
}

function getEdge(id) {
  if (!id) return null;
  return db().prepare(`
    SELECT id, from_id, to_id, label, weight, created_at
    FROM action_record_edges WHERE id = ?
  `).get(id) || null;
}

// ── P16.5 I3 — Counterfactual branch CRUD ─────────────────────────────────
const CF_STATUSES = Object.freeze(['candidate', 'materialized', 'discarded']);

function createBranch(opts) {
  if (!opts || !opts.branch_point_id || !opts.substituted_path) return null;
  const status = opts.status || 'candidate';
  if (!CF_STATUSES.includes(status)) return null;
  const d = db();
  // FK pre-check on branch_point_id.
  const ref = d.prepare('SELECT 1 FROM action_records WHERE id = ?').get(opts.branch_point_id);
  if (!ref) return null;
  if (opts.parent_branch_id) {
    const pref = d.prepare('SELECT 1 FROM counterfactual_branches WHERE id = ?').get(opts.parent_branch_id);
    if (!pref) return null;
  }
  const id = require('./action-record').uuidv7();
  try {
    d.prepare(`
      INSERT INTO counterfactual_branches
      (id, branch_point_id, substituted_path, status, parent_branch_id,
       created_at, materialized_at, cost_estimate, outcome_summary)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id, opts.branch_point_id, opts.substituted_path, status,
      opts.parent_branch_id || null, Date.now(),
      typeof opts.cost_estimate === 'number' ? opts.cost_estimate : null,
      opts.outcome_summary ? JSON.stringify(opts.outcome_summary) : null
    );
    return id;
  } catch (_) { return null; }
}

function getBranch(id) {
  if (!id) return null;
  const row = db().prepare(`
    SELECT id, branch_point_id, substituted_path, status, parent_branch_id,
           created_at, materialized_at, cost_estimate, outcome_summary
    FROM counterfactual_branches WHERE id = ?
  `).get(id);
  if (!row) return null;
  if (row.outcome_summary) {
    try { row.outcome_summary = JSON.parse(row.outcome_summary); } catch (_) {}
  }
  return row;
}

function listBranches(opts) {
  opts = opts || {};
  const where = [];
  const bind  = {};
  if (opts.branch_point_id) { where.push('branch_point_id = @bp'); bind.bp = opts.branch_point_id; }
  if (opts.status)          { where.push('status = @status');      bind.status = opts.status; }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(parseInt(opts.limit || 100), 1000);
  return db().prepare(`
    SELECT id, branch_point_id, substituted_path, status, parent_branch_id,
           created_at, materialized_at, cost_estimate, outcome_summary
    FROM counterfactual_branches ${whereSQL}
    ORDER BY created_at DESC LIMIT ${limit}
  `).all(bind).map(r => {
    if (r.outcome_summary) { try { r.outcome_summary = JSON.parse(r.outcome_summary); } catch (_) {} }
    return r;
  });
}

// ── P17 Tier 3 — wire-format profile CRUD ────────────────────────────────
const WFP_STATUSES = Object.freeze(['candidate', 'active', 'discarded']);

function saveWireFormatProfile(opts) {
  if (!opts || !opts.domain_signature || !opts.header_json) return null;
  const status = opts.status || 'candidate';
  if (!WFP_STATUSES.includes(status)) return null;
  // Validate the header is parseable JSON shaped like a TOON header.
  try {
    const h = typeof opts.header_json === 'string'
      ? JSON.parse(opts.header_json) : opts.header_json;
    if (!h || h.__toon !== 1 || !Array.isArray(h.keys)) return null;
  } catch { return null; }
  const id = require('./action-record').uuidv7();
  const headerStr = typeof opts.header_json === 'string'
    ? opts.header_json : JSON.stringify(opts.header_json);
  try {
    db().prepare(`
      INSERT INTO wire_format_profiles
      (id, domain_signature, header_json, created_at, activated_at,
       discarded_at, status, perf_score, author, sample_count)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    `).run(
      id, opts.domain_signature, headerStr, Date.now(), status,
      typeof opts.perf_score === 'number' ? opts.perf_score : null,
      opts.author || null,
      typeof opts.sample_count === 'number' ? opts.sample_count : null
    );
    return id;
  } catch (_) { return null; }
}

function getWireFormatProfile(id) {
  if (!id) return null;
  return db().prepare(`
    SELECT id, domain_signature, header_json, created_at, activated_at,
           discarded_at, status, perf_score, author, sample_count
    FROM wire_format_profiles WHERE id = ?
  `).get(id) || null;
}

function listWireFormatProfiles(opts) {
  opts = opts || {};
  const where = [];
  const bind  = {};
  if (opts.domain_signature) { where.push('domain_signature = @sig'); bind.sig = opts.domain_signature; }
  if (opts.status)           { where.push('status = @status');         bind.status = opts.status; }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(parseInt(opts.limit || 50), 500);
  return db().prepare(`
    SELECT id, domain_signature, header_json, created_at, activated_at,
           discarded_at, status, perf_score, author, sample_count
    FROM wire_format_profiles ${whereSQL}
    ORDER BY created_at DESC LIMIT ${limit}
  `).all(bind);
}

// Returns the currently-active profile for a domain signature, or null.
// At most one active per signature; this enforces the invariant on read.
function getActiveWireFormatProfile(domain_signature) {
  if (!domain_signature) return null;
  return db().prepare(`
    SELECT id, domain_signature, header_json, created_at, activated_at,
           discarded_at, status, perf_score, author, sample_count
    FROM wire_format_profiles
    WHERE domain_signature = ? AND status = 'active'
    ORDER BY activated_at DESC LIMIT 1
  `).get(domain_signature) || null;
}

// Activate one candidate profile, demoting any prior active for the same
// domain to discarded. Atomic via a single transaction.
function activateWireFormatProfile(id) {
  if (!id) return false;
  const d = db();
  const row = d.prepare('SELECT id, domain_signature, status FROM wire_format_profiles WHERE id = ?').get(id);
  if (!row) return false;
  if (row.status === 'discarded') return false;
  const now = Date.now();
  const tx = d.transaction(() => {
    d.prepare(`
      UPDATE wire_format_profiles
      SET status = 'discarded', discarded_at = ?
      WHERE domain_signature = ? AND status = 'active' AND id != ?
    `).run(now, row.domain_signature, id);
    d.prepare(`
      UPDATE wire_format_profiles
      SET status = 'active', activated_at = ?
      WHERE id = ?
    `).run(now, id);
  });
  tx();
  return true;
}

function discardWireFormatProfile(id) {
  if (!id) return false;
  const info = db().prepare(`
    UPDATE wire_format_profiles
    SET status = 'discarded', discarded_at = ?
    WHERE id = ? AND status != 'discarded'
  `).run(Date.now(), id);
  return info.changes > 0;
}

function setBranchStatus(id, status, extras) {
  if (!id || !CF_STATUSES.includes(status)) return false;
  extras = extras || {};
  const sets = ['status = @status'];
  const bind = { id, status };
  if (status === 'materialized') {
    sets.push('materialized_at = @mts');
    bind.mts = Date.now();
  }
  if (typeof extras.cost_estimate === 'number') {
    sets.push('cost_estimate = @ce'); bind.ce = extras.cost_estimate;
  }
  if (extras.outcome_summary) {
    sets.push('outcome_summary = @os'); bind.os = JSON.stringify(extras.outcome_summary);
  }
  const info = db().prepare(`
    UPDATE counterfactual_branches SET ${sets.join(', ')} WHERE id = @id
  `).run(bind);
  return info.changes > 0;
}

// Generic query helper. Filters by any subset of:
// type, agent_id, session_id, cwd, parent_id, since, until.
// Returns raw rows (caller can fromRow() via action-record.js if needed).
function queryActions(opts) {
  opts = opts || {};
  const where = [];
  const bind = {};
  if (opts.type)         { where.push('type = @type');                 bind.type = opts.type; }
  if (opts.agent_id)     { where.push('agent_id = @agent_id');         bind.agent_id = opts.agent_id; }
  if (opts.principal_id) { where.push('principal_id = @principal_id'); bind.principal_id = opts.principal_id; }
  if (opts.session_id)   { where.push('session_id = @session_id');     bind.session_id = opts.session_id; }
  if (opts.cwd)          { where.push('cwd = @cwd');                   bind.cwd = opts.cwd; }
  if (opts.parent_id)    { where.push('parent_id = @parent_id');       bind.parent_id = opts.parent_id; }
  if (opts.context_id)   { where.push('context_id = @context_id');     bind.context_id = opts.context_id; }
  if (opts.since)        { where.push('timestamp >= @since');          bind.since = opts.since; }
  if (opts.until)        { where.push('timestamp <= @until');          bind.until = opts.until; }
  // Filter by input.kind (JSON-extracted). Lets callers filter without
  // pulling and post-filtering thousands of decision rows. Crucial for
  // mind_decision / mind_retrieval queries in high-volume substrates
  // where the LIMIT cap (1000) would otherwise clip recent mind events.
  if (opts.kind)       { where.push("json_extract(input,'$.kind') = @kind"); bind.kind = opts.kind; }
  // Filter by input.tool_name (JSON-extracted). Without this, recentTurns had
  // to overfetch type='tool_call' rows and post-filter for 'dialogue.turn' —
  // but the background worker writes 10x more tool_call rows (hypotheses,
  // lessons, summaries) under the same principal, flooding the recent window
  // and pushing dialogue turns out entirely → the partner lost in-conversation
  // memory ("every message a new chat"). SQL-prune by tool_name instead.
  if (opts.tool_name) { where.push("json_extract(input,'$.tool_name') = @tool_name"); bind.tool_name = opts.tool_name; }
  // Same trick for output.commitment_type. type='commitment' rows fan
  // out into many sub-kinds (engram, anchor, refusal, opinion, hard,
  // methodology, hypothesis, factual, engram_tombstoned). Without this
  // filter, callers wanting only engrams pull the top-N commitments of
  // ANY kind and then post-filter in JS — and engrams routinely fall
  // outside the LIMIT window in busy substrates, returning empty.
  if (opts.commitment_type) {
    where.push("json_extract(output,'$.commitment_type') = @commitment_type");
    bind.commitment_type = opts.commitment_type;
  }
  //  scope filter (lives in output.scope JSON, same pattern
  // as commitment_type). Lets callers SQL-prune by category (identity,
  // goal, research:foo, etc) instead of fetching wide + JS-filtering.
  if (opts.scope) {
    where.push("json_extract(output,'$.scope') = @scope");
    bind.scope = opts.scope;
  }
  if (opts.scope_prefix) {
    where.push("json_extract(output,'$.scope') LIKE @scope_prefix");
    bind.scope_prefix = String(opts.scope_prefix).replace(/[%_]/g, '') + '%';
  }
  //  column filters. audience + memory_class are
  // first-class columns (not JSON-embedded); SQL-prunable directly.
  // Without these, recall.js had to read the whole table and JS-filter
  // (the partition bug we set out to fix).
  if (opts.audience)     { where.push('audience = @audience');         bind.audience = opts.audience; }
  if (opts.memory_class) { where.push('memory_class = @memory_class'); bind.memory_class = opts.memory_class; }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // forExport lets a deliberate full-substrate export (atlas) read PAST the
  // 1000 recall clamp and pull the entire mind. It is ONLY for full-substrate
  // export — NEVER set forExport for recall, where the 1000 cap guards recall
  // latency and prompt-prefix size.
  const limit = opts.forExport
    ? Math.min(parseInt(opts.limit || 100000), 1000000)
    : Math.min(parseInt(opts.limit || 100), 1000);
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  return db().prepare(`
    SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
           parent_id, context_hash, input, output, verification, outcome,
           principal_id, audience, memory_class, context_id
    FROM action_records
    ${whereSQL}
    ORDER BY timestamp ${order}
    LIMIT ${limit}
  `).all(bind);
}

// FTS5 search. Returns ids, which callers can dereference via getAction().
function searchActions(query, opts) {
  opts = opts || {};
  if (!query || typeof query !== 'string') return [];
  const limit = Math.min(parseInt(opts.limit || 20), 200);
  try {
    const rows = db().prepare(`
      SELECT ar.id AS id, ar.timestamp AS timestamp
      FROM action_records_fts f
      JOIN action_records ar ON ar.rowid = f.rowid
      WHERE action_records_fts MATCH ?
      ORDER BY ar.timestamp DESC
      LIMIT ?
    `).all(query, limit);
    return rows;
  } catch (_) {
    return [];
  }
}

// FTS5 + JOIN that returns full action_records rows in one query, optionally
// filtered by memory_class and/or cwd. Used by recall.js per-class pulls so
// they don't have to do recency-windowed SELECT + post-filter (which loses
// time-invariant content like research / decisions / old episodes when the
// substrate has more than ~500 rows in the past month).
//
// Returns the same column set as getAction(). Caller is responsible for
// parsing input/output JSON and applying any further scoring.
function searchActionsFull(query, opts) {
  opts = opts || {};
  if (!query || typeof query !== 'string') return [];
  const limit = Math.min(parseInt(opts.limit || 200), 5000);
  const where = ['action_records_fts MATCH @query'];
  const bind  = { query, limit };
  if (opts.memory_class) {
    where.push('ar.memory_class = @memory_class');
    bind.memory_class = opts.memory_class;
  }
  // cwd is intentionally NOT a SQL filter: substrate-as-mind has NO per-folder
  // partition (the no-partition invariant). cwd is only a soft JS-side ranking
  // boost in recall.js (cwdBoost), never a hard partition. A prior dead
  // `ar.cwd = @cwd` branch here was a latent footgun — a future caller passing
  // cwd would have silently re-partitioned the brain. Removed so the invariant
  // is structural, not by-convention.
  // Operator-sovereign recall: benchmark/test-harness principals never pollute
  // the operator's substrate. (Real cross-surface data is partner/default/NULL.)
  where.push("(ar.principal_id IS NULL OR ar.principal_id NOT IN ('bench','partner-loop-test'))");
  if (opts.type) {
    where.push('ar.type = @type');
    bind.type = opts.type;
  }
  // No ORDER BY recency — the whole point of this helper is to let the
  // caller rank by relevance, not lose old-but-relevant rows to a
  // recency-truncated LIMIT. Caller decides ordering after scoring.
  try {
    return db().prepare(`
      SELECT ar.id, ar.timestamp, ar.type, ar.agent_id, ar.session_id,
             ar.user_id, ar.cwd, ar.parent_id, ar.context_hash,
             ar.input, ar.output, ar.verification, ar.outcome,
             ar.principal_id, ar.audience, ar.memory_class
      FROM action_records_fts f
      JOIN action_records ar ON ar.rowid = f.rowid
      WHERE ${where.join(' AND ')}
      ${opts.rank ? 'ORDER BY bm25(action_records_fts)' : ''}
      LIMIT @limit
    `).all(bind);
  } catch (_) {
    return [];
  }
}

// recall subsystem — substrate-side dialogue search across raw turns.
// dialogue-memory.recentTurns is recency-only; for "what did we work on
// yesterday" the partner needs FTS + time-range over the dialogue.turn
// rows. Returns hydrated {ts, user_text, assistant_text, faculty,
// agent_id, principal_id} in chronological order so the LLM reads it
// the same way recentTurns formats it.
function searchDialogueTurns(opts) {
  opts = opts || {};
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  const sinceMs = typeof opts.since_ms === 'number' ? opts.since_ms : (7 * 24 * 60 * 60 * 1000);
  const cutoff = Date.now() - sinceMs;
  const limit = Math.max(1, Math.min(500, parseInt(opts.limit || 50, 10)));
  const principal = (opts.principal === null) ? null : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  try {
    let rows;
    if (query) {
      const where = [
        "action_records_fts MATCH @q",
        "ar.type = 'tool_call'",
        "ar.timestamp >= @cutoff",
        "json_extract(ar.input, '$.tool_name') = 'dialogue.turn'",
      ];
      const bind = { q: query, cutoff, limit };
      if (principal) { where.push('ar.principal_id = @principal'); bind.principal = principal; }
      if (opts.agent_id) { where.push('ar.agent_id = @agent_id'); bind.agent_id = opts.agent_id; }
      rows = db().prepare(`
        SELECT ar.id, ar.timestamp, ar.agent_id, ar.principal_id, ar.input, ar.output
        FROM action_records_fts f
        JOIN action_records ar ON ar.rowid = f.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY ar.timestamp ASC
        LIMIT @limit
      `).all(bind);
    } else {
      // No query — time-range only. Cheaper than FTS for "last 2 days" etc.
      const where = [
        "type = 'tool_call'",
        "timestamp >= @cutoff",
        "json_extract(input, '$.tool_name') = 'dialogue.turn'",
      ];
      const bind = { cutoff, limit };
      if (principal) { where.push('principal_id = @principal'); bind.principal = principal; }
      if (opts.agent_id) { where.push('agent_id = @agent_id'); bind.agent_id = opts.agent_id; }
      rows = db().prepare(`
        SELECT id, timestamp, agent_id, principal_id, input, output
        FROM action_records
        WHERE ${where.join(' AND ')}
        ORDER BY timestamp ASC
        LIMIT @limit
      `).all(bind);
    }
    return rows.map((r) => {
      let inp = {}; let out = {};
      try { inp = JSON.parse(r.input || '{}'); } catch (_) {}
      try { out = JSON.parse(r.output || '{}'); } catch (_) {}
      return {
        ts: r.timestamp,
        user_text:      (inp.args && inp.args.user_text) || '',
        assistant_text: out.assistant_text || '',
        faculty:        out.faculty || null,
        agent_id:       r.agent_id,
        principal_id:   r.principal_id,
      };
    });
  } catch (_) {
    return [];
  }
}

function countActions(opts) {
  opts = opts || {};
  const where = [];
  const bind = {};
  if (opts.type)       { where.push('type = @type');             bind.type = opts.type; }
  if (opts.agent_id)   { where.push('agent_id = @agent_id');     bind.agent_id = opts.agent_id; }
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.cwd)        { where.push('cwd = @cwd');               bind.cwd = opts.cwd; }
  if (opts.since)      { where.push('timestamp >= @since');      bind.since = opts.since; }
  if (opts.commitment_type) {
    where.push("json_extract(output,'$.commitment_type') = @commitment_type");
    bind.commitment_type = opts.commitment_type;
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db().prepare(`SELECT COUNT(*) AS n FROM action_records ${whereSQL}`).get(bind).n;
}

function listArchives(opts) {
  opts = opts || {};
  const limit = Math.min(parseInt(opts.limit || 20), 100);
  const sessionFilter = opts.session_id ? 'WHERE session_id = ?' : '';
  const bindings = opts.session_id ? [opts.session_id, limit] : [limit];
  return db().prepare(`
    SELECT id, session_id, tool, ts, bytes_in, bytes_out
    FROM tool_output_archive
    ${sessionFilter}
    ORDER BY ts DESC
    LIMIT ?
  `).all(...bindings);
}

function getStats(since) {
  const cutoff = since || (Date.now() - 24 * 60 * 60 * 1000);
  const hookCounts = db().prepare(`
    SELECT event, COUNT(*) as n FROM hook_events
    WHERE ts >= ? GROUP BY event
  `).all(cutoff);
  const savings = db().prepare(`
    SELECT kind, SUM(tokens) as total FROM savings_ledger
    WHERE ts >= ? GROUP BY kind
  `).all(cutoff);
  const archive = db().prepare(`
    SELECT COUNT(*) as n, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out
    FROM tool_output_archive WHERE ts >= ?
  `).get(cutoff);
  return { hookCounts, savings, archive, since: cutoff };
}

function close() {
  if (_db) { _db.close(); _db = null; }
}

// Incognito wrap helper. The list below names every WRITE function exported
// from this module. When `troth incognito on` is active, each wrapped
// function returns null (silent no-op) instead of writing. Reads, queries,
// and the DB handle stay live. Caller code does NOT need to change — the
// guard is fully transparent.
const _INCOGNITO_MUTED_WRITES = new Set([
  'recordHookEvent', 'recordSavings', 'recordProxyUsage', 'recordBaselineCost', 'recordMcpToolCall',
  'recordModuleError', 'recordCacheRatioEvent', 'recordToolCallHash',
  'markFileRead', 'archiveToolOutput', 'recordLesson', 'recordAction',
  'recordEdge', 'createBranch', 'setBranchStatus',
  'saveWireFormatProfile', 'activateWireFormatProfile', 'discardWireFormatProfile',
  'recordCostEvent', 'recordBriefing', 'recordOperatorRequest', 'resolveOperatorRequest',
  'recordAllowlistAudit', 'recordFailureEvent', 'recordThoughtTick',
  'recordCalibrationPoint', 'updateCalibrationOutcome',
  'recordPaymentEvent', 'updatePaymentStatus', 'appendSignedAuditRow',
  'appendSignedAuditRowChained'
]);

// cost subsystem — persistent per-charge cost ledger. Called by
// budget-warden.charge(); writes one row per LLM call. Best-effort: a
// write failure must not crash an agentic loop (worst case the warden's
// in-process counter stays correct and only the across-restart audit
// view loses that one row).
function recordCostEvent(ev) {
  try {
    db().prepare(`
      INSERT INTO l4_cost_events (ts, goal_id, goal_class, agent_id, model,
                                  input_tokens, output_tokens, usd, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.ts || Date.now(),
      ev.goal_id    || null,
      ev.goal_class || null,
      ev.agent_id   || null,
      ev.model      || null,
      Math.max(0, parseInt(ev.input_tokens  || 0, 10)),
      Math.max(0, parseInt(ev.output_tokens || 0, 10)),
      typeof ev.usd === 'number' && Number.isFinite(ev.usd) ? ev.usd : 0,
      ev.provider   || null
    );
    return true;
  } catch (_) { return false; }
}

// D2 — effect ledger: record a completed real-world side-effect. Idempotent via
// PRIMARY KEY (INSERT OR IGNORE) — the FIRST writer wins; a crash-resume's write
// no-ops, and the skip-if-done check below sees the original.
function recordEffect(ev) {
  ev = ev || {};
  try {
    db().prepare(`
      INSERT OR IGNORE INTO l4_effect_ledger
        (effect_key, intent_id, goal_id, scope, external_id, result_hash, status, ts, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(ev.effect_key || ''),
      ev.intent_id   || null,
      ev.goal_id     || null,
      ev.scope       || null,
      ev.external_id != null ? String(ev.external_id) : null,
      ev.result_hash || null,
      ev.status      || 'done',
      ev.ts || Date.now(),
      ev.error || null
    );
    return true;
  } catch (_) { return false; }
}

// D2 — look up a prior completed side-effect by its stable effect_key.
function getEffect(effect_key) {
  if (!effect_key) return null;
  try {
    return db().prepare(`SELECT * FROM l4_effect_ledger WHERE effect_key = ?`).get(String(effect_key)) || null;
  } catch (_) { return null; }
}

// audit subsystem — allowlist audit helpers.
function recordAllowlistAudit(ev) {
  try {
    const info = db().prepare(`
      INSERT INTO l4_allowlist_audit
        (ts, host, sample_url, mode, goal_id, goal_class, action)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.ts || Date.now(),
      String(ev.host || ''),
      ev.sample_url || null,
      String(ev.mode || 'auto_grow'),
      ev.goal_id || null,
      ev.goal_class || null,
      ev.action || 'auto_added'
    );
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
}

function listAllowlistAudit(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(500, opts.limit || 50));
  try {
    return db().prepare(`
      SELECT id, ts, host, sample_url, mode, goal_id, goal_class, action, revoked_ts
      FROM l4_allowlist_audit
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit);
  } catch (_) { return []; }
}

// operator-request subsystem — operator-request inbox helpers. Dedup window suppresses
// the same (goal/kind/detail) request within 1h so a retrying agentic
// loop doesn't flood the inbox with the same ask. dedup_key is a stable
// hash of (goal_id||'', kind, JSON.stringify(detail)) and a write is
// skipped if an unresolved row with the same dedup_key landed in the
// last hour. Returns {ok, id?, dedup_suppressed?}.
function recordOperatorRequest(ev) {
  try {
    ev = ev || {};
    const kind = String(ev.kind || 'manual');
    const urgency = ['low', 'normal', 'high'].indexOf(ev.urgency) >= 0 ? ev.urgency : 'normal';
    const detail = ev.detail || {};
    const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
    // Stable, short dedup key. crypto require is lazy to keep require-graph thin.
    let dedupKey;
    try {
      const crypto = require('crypto');
      dedupKey = crypto.createHash('sha1')
        .update(String(ev.goal_id || '') + '|' + kind + '|' + detailStr)
        .digest('hex')
        .slice(0, 16);
    } catch (_) {
      dedupKey = (ev.goal_id || '') + '|' + kind;
    }
    // Suppress if same dedup_key landed unresolved in last hour.
    const cutoff = Date.now() - 60 * 60 * 1000;
    const existing = db().prepare(`
      SELECT id FROM l4_operator_requests
      WHERE dedup_key = ? AND status = 'pending' AND ts >= ?
      LIMIT 1
    `).get(dedupKey, cutoff);
    if (existing) return { ok: true, dedup_suppressed: true, id: existing.id };
    const info = db().prepare(`
      INSERT INTO l4_operator_requests
        (ts, goal_id, goal_class, kind, urgency, detail, status, dedup_key)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      ev.ts || Date.now(),
      ev.goal_id    || null,
      ev.goal_class || null,
      kind,
      urgency,
      detailStr,
      dedupKey
    );
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) };
  }
}

function listOperatorRequests(opts) {
  opts = opts || {};
  const status = opts.status || 'pending';
  const limit = Math.max(1, Math.min(200, opts.limit || 25));
  try {
    const rows = db().prepare(`
      SELECT id, ts, goal_id, goal_class, kind, urgency, detail, status,
             resolved_ts, resolved_by, resolution_note
      FROM l4_operator_requests
      WHERE status = ?
      ORDER BY
        CASE urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        ts DESC
      LIMIT ?
    `).all(status, limit);
    return rows.map(r => {
      let detail = null;
      try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (_) { detail = r.detail; }
      return Object.assign({}, r, { detail });
    });
  } catch (_) { return []; }
}

function resolveOperatorRequest(opts) {
  opts = opts || {};
  if (!opts.id) return { ok: false, error: 'id required' };
  const nextStatus = opts.status === 'dismissed' ? 'dismissed' : 'resolved';
  try {
    const info = db().prepare(`
      UPDATE l4_operator_requests
      SET status = ?, resolved_ts = ?, resolved_by = ?, resolution_note = ?
      WHERE id = ? AND status = 'pending'
    `).run(
      nextStatus,
      Date.now(),
      String(opts.resolved_by || 'operator'),
      typeof opts.note === 'string' ? opts.note.slice(0, 4000) : null,
      opts.id
    );
    return { ok: info.changes > 0, changes: info.changes };
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) };
  }
}

function countPendingOperatorRequests() {
  try {
    return db().prepare(`SELECT COUNT(*) AS n FROM l4_operator_requests WHERE status = 'pending'`).get().n || 0;
  } catch (_) { return 0; }
}

// briefing subsystem — persistent briefing log. Best-effort write; never throws.
// design: append a signed audit row.
function appendSignedAuditRow(ev) {
  try {
    const stmt = db().prepare(`
      INSERT INTO l4_signed_audit_chain
        (ts, action_id, kind, record_hash, prev_chain_hash, chain_hash,
         signature, public_key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.ts || Date.now(),
      ev.action_id || null,
      ev.kind || null,
      String(ev.record_hash),
      ev.prev_chain_hash || null,
      String(ev.chain_hash),
      String(ev.signature),
      String(ev.public_key_id)
    );
    return stmt.lastInsertRowid;
  } catch (_) { return null; }
}

function lastSignedAuditRow() {
  try {
    return db().prepare(
      `SELECT id, ts, action_id, kind, record_hash, prev_chain_hash,
              chain_hash, signature, public_key_id
       FROM l4_signed_audit_chain
       ORDER BY id DESC LIMIT 1`
    ).get();
  } catch (_) { return null; }
}

// Read-head + append in ONE immediate transaction. Two processes signing
// concurrently could each read the same head and fork the chain — twin rows
// with one prev_chain_hash, which the verifier reports as tamper where there
// was only a race. BEGIN IMMEDIATE serializes writers across processes; on
// SQLITE_BUSY the caller loses this one attestation (fail-open), never the
// chain's integrity. `build(last)` returns the finished row for the head it
// was shown, or null to abstain.
function appendSignedAuditRowChained(build) {
  try {
    const tx = db().transaction(() => {
      const ev = build(lastSignedAuditRow());
      return ev ? appendSignedAuditRow(ev) : null;
    });
    return tx.immediate();
  } catch (_) { return null; }
}

// The persisted supersession index (see the user_version 2 migration).
// Small by nature — one row per retirement, not per engram — so readers
// load the whole set and union it with their window scan.
function listSupersededIds() {
  try {
    return db().prepare('SELECT superseded_id FROM superseded_ids').all()
      .map((r) => r.superseded_id);
  } catch (_) { return []; }
}

function listSignedAuditChain(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(5000, opts.limit || 1000));
  try {
    return db().prepare(
      `SELECT id, ts, action_id, kind, record_hash, prev_chain_hash,
              chain_hash, signature, public_key_id
       FROM l4_signed_audit_chain
       ORDER BY id ASC LIMIT ?`
    ).all(limit);
  } catch (_) { return []; }
}

// design: log a (predicted, kind, claim_engram_id) point.
// Outcome can be filled in later via updateCalibrationOutcome.
function recordCalibrationPoint(ev) {
  try {
    const stmt = db().prepare(`
      INSERT INTO l4_confidence_calibration
        (ts, claim_engram_id, kind, predicted, actual, outcome_ts, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.ts || Date.now(),
      ev.claim_engram_id || null,
      String(ev.kind || 'unknown'),
      typeof ev.predicted === 'number' ? Math.max(0, Math.min(1, ev.predicted)) : 0,
      typeof ev.actual === 'number' ? (ev.actual ? 1 : 0) : null,
      typeof ev.outcome_ts === 'number' ? ev.outcome_ts : null,
      typeof ev.notes === 'string' ? ev.notes.slice(0, 400) : null
    );
    return stmt.lastInsertRowid;
  } catch (_) { return null; }
}

// Fill in the actual outcome for a prior calibration point.
function updateCalibrationOutcome(id, actual, notes) {
  try {
    db().prepare(`
      UPDATE l4_confidence_calibration
         SET actual = ?, outcome_ts = ?, notes = COALESCE(notes, '') || CASE WHEN ? IS NOT NULL THEN ' | ' || ? ELSE '' END
       WHERE id = ?
    `).run(
      actual === null || actual === undefined ? null : (actual ? 1 : 0),
      Date.now(),
      notes || null,
      notes || null,
      id
    );
    return true;
  } catch (_) { return false; }
}

// List calibration points with optional kind filter + window.
function listCalibrationPoints(opts) {
  opts = opts || {};
  const sinceMs = typeof opts.since_ms === 'number' ? opts.since_ms : (30 * 24 * 60 * 60 * 1000);
  const cutoff  = Date.now() - sinceMs;
  const limit   = Math.max(1, Math.min(2000, opts.limit || 500));
  try {
    if (opts.kind) {
      return db().prepare(
        `SELECT id, ts, claim_engram_id, kind, predicted, actual, outcome_ts, notes
         FROM l4_confidence_calibration
         WHERE ts >= ? AND kind = ?
         ORDER BY ts DESC LIMIT ?`
      ).all(cutoff, opts.kind, limit);
    }
    return db().prepare(
      `SELECT id, ts, claim_engram_id, kind, predicted, actual, outcome_ts, notes
       FROM l4_confidence_calibration
       WHERE ts >= ?
       ORDER BY ts DESC LIMIT ?`
    ).all(cutoff, limit);
  } catch (_) { return []; }
}

function recordBriefing(ev) {
  try {
    db().prepare(`
      INSERT INTO l4_briefings
        (ts, goal_id, goal_class, decision, faculty, briefing, success,
         spent_usd, reflection_text, classification_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.ts || Date.now(),
      ev.goal_id    || null,
      ev.goal_class || null,
      String(ev.decision || 'unknown'),
      ev.faculty || null,
      typeof ev.briefing === 'string' ? ev.briefing.slice(0, 8000) : null,
      ev.success ? 1 : 0,
      typeof ev.spent_usd === 'number' && Number.isFinite(ev.spent_usd) ? ev.spent_usd : 0,
      typeof ev.reflection_text === 'string' ? ev.reflection_text.slice(0, 4000) : null,
      typeof ev.classification_text === 'string' ? ev.classification_text.slice(0, 200) : null
    );
    return true;
  } catch (_) { return false; }
}

/** the autonomy design fresh-ask gate: has this goal EVER been briefed (any decision)?
 * First-ever coordinate() touch of a goal proposes a job card instead of
 * executing; this is the per-goal freshness test behind that gate. Fail
 * CLOSED (false ⇒ treated as fresh ⇒ propose, never silently execute). */
function hasBriefingForGoal(goalId) {
  if (!goalId) return false;
  try {
    const row = db().prepare(
      'SELECT 1 FROM l4_briefings WHERE goal_id = ? LIMIT 1'
    ).get(goalId);
    return !!row;
  } catch (_) { return false; }
}

function listBriefings(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(200, opts.limit || 25));
  try {
    return db().prepare(`
      SELECT id, ts, goal_id, goal_class, decision, faculty, briefing,
             success, spent_usd, reflection_text, classification_text
      FROM l4_briefings
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit);
  } catch (_) { return []; }
}

// Sum cost over a rolling window (default last 24h). Returns
// { total_usd, by_class: { class_name: usd }, rows }. rows is the raw count
// for diagnostics. Used by l4-status.getSnapshot.
// Tri-pool limits: total tokens drawn from a provider set in a
// window — the SUBSCRIPTION pool is capped by tokens, not dollars (flat-rate
// quotas are invisible to USD sums). provider=NULL rows are metered-era or
// pre-migration: excluded (conservative for the sub cap; USD caps cover them).
function sumTokensByProviders(opts) {
  opts = opts || {};
  const sinceMs = typeof opts.since_ms === 'number' ? opts.since_ms : (24 * 60 * 60 * 1000);
  const providers = Array.isArray(opts.providers) ? opts.providers.filter(Boolean) : [];
  if (!providers.length) return 0;
  try {
    const marks = providers.map(() => '?').join(',');
    const stmt = db().prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS toks
       FROM l4_cost_events WHERE ts >= ? AND provider IN (${marks})`
    );
    const row = stmt.get.apply(stmt, [Date.now() - sinceMs].concat(providers));
    return (row && row.toks) || 0;
  } catch (_) { return 0; }
}

function sumCostEvents(opts) {
  opts = opts || {};
  const sinceMs = typeof opts.since_ms === 'number' ? opts.since_ms : (24 * 60 * 60 * 1000);
  const cutoff  = Date.now() - sinceMs;
  // Optional goal_id + model_prefix filters. The budget gate needs the
  // cost of ONE goal; summing every row in a shared class over-counted it.
  // Both filters are additive: a caller can scope to one goal_id, one
  // model family, or both.
  const goalId = (typeof opts.goal_id === 'string' && opts.goal_id) ? opts.goal_id : null;
  const modelPrefix = (typeof opts.model_prefix === 'string' && opts.model_prefix) ? opts.model_prefix : null;
  const where = ['ts >= ?'];
  const args = [cutoff];
  if (goalId)      { where.push('goal_id = ?');     args.push(goalId); }
  if (modelPrefix) { where.push('model LIKE ?');    args.push(modelPrefix + '%'); }
  const whereSql = where.join(' AND ');
  try {
    const totalStmt = db().prepare(
      `SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS rows
       FROM l4_cost_events WHERE ${whereSql}`
    );
    const totalRow = totalStmt.get.apply(totalStmt, args);
    const byClassStmt = db().prepare(
      `SELECT goal_class, COALESCE(SUM(usd), 0) AS usd
       FROM l4_cost_events WHERE ${whereSql}
       GROUP BY goal_class`
    );
    const rows = byClassStmt.all.apply(byClassStmt, args);
    const by_class = {};
    for (const r of rows) by_class[r.goal_class || '_unknown'] = Number((r.usd || 0).toFixed(4));
    return {
      since_ms:  sinceMs,
      total_usd: Number((totalRow.usd || 0).toFixed(4)),
      rows:      totalRow.rows || 0,
      by_class,
      filtered_goal_id: goalId,
      filtered_model_prefix: modelPrefix
    };
  } catch (_) {
    return { since_ms: sinceMs, total_usd: 0, rows: 0, by_class: {} };
  }
}
// embedding cache helpers. Embeddings stored
// as Float32 BLOB so cosine math runs in JS without per-row JSON parse.
// All helpers fail-silent: an embedding-table issue must never block
// the recall path (FTS5 still works).
function setEmbedding(engram_id, vector, opts) {
  if (!engram_id || !Array.isArray(vector) || !vector.length) return null;
  opts = opts || {};
  try {
    const f32 = new Float32Array(vector);
    const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    const d = db();
    d.prepare(`
      INSERT INTO engram_embeddings (engram_id, dim, vector, model, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(engram_id) DO UPDATE SET
        dim = excluded.dim,
        vector = excluded.vector,
        model = excluded.model,
        created_at = excluded.created_at
    `).run(engram_id, vector.length, buf, opts.model || null, Date.now());
    return true;
  } catch (_) { return null; }
}
function getEmbedding(engram_id) {
  if (!engram_id) return null;
  try {
    const d = db();
    const row = d.prepare('SELECT dim, vector FROM engram_embeddings WHERE engram_id = ?').get(engram_id);
    if (!row || !row.vector) return null;
    // Reconstruct Float32Array from BLOB. SQLite returns Buffer in
    // better-sqlite3; the Float32Array view shares the underlying memory.
    return new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim);
  } catch (_) { return null; }
}
// Remove one vector. The missing primitive: nothing in the codebase has ever
// deleted from engram_embeddings, so a vector outlives the memory it belongs
// to forever.
function deleteEmbedding(engram_id) {
  if (!engram_id) return false;
  try {
    const r = db().prepare('DELETE FROM engram_embeddings WHERE engram_id = ?').run(engram_id);
    return !!(r && r.changes);
  } catch (_) { return false; }
}

// Sweep vectors whose memory is already dead.
//
// A tombstoned engram keeps its vector, and a deleted row leaves one behind.
// Both are scanned on every dense query. Sweeping them shortens the full dense
// scan — real, and small.
//
// The first measurement of this said 41.6%, and it was wrong by 37x: it
// counted rows of a JOIN between embeddings and tombstones, and many
// tombstones point at the same engram, so pairs were counted as vectors. The
// number that matters is COUNT(DISTINCT ee.engram_id). Recorded here because
// the inflated figure was persuasive, quotable, and would have justified far
// more work than the defect deserves.
//
// Superseded engrams are deliberately NOT swept. They are real memories kept
// for audit ("what did I used to believe"), recall already excludes them by
// following the supersession chain, and they are 336 vectors — half a percent.
// Taking their vectors would trade an honest 0.5% for the loss of a real
// answer.
function pruneDeadEmbeddings(limit) {
  const n = Math.max(1, Math.min(20000, parseInt(limit || 5000, 10)));
  const out = { tombstoned: 0, orphaned: 0 };
  try {
    const d = db();
    out.tombstoned = d.prepare(`
      DELETE FROM engram_embeddings WHERE engram_id IN (
        SELECT ee.engram_id FROM engram_embeddings ee
        JOIN action_records t ON json_extract(t.output,'$.replaces') = ee.engram_id
        WHERE json_extract(t.output,'$.commitment_type') = 'engram_tombstoned'
        LIMIT ?
      )
    `).run(n).changes || 0;
    out.orphaned = d.prepare(`
      DELETE FROM engram_embeddings WHERE engram_id IN (
        SELECT ee.engram_id FROM engram_embeddings ee
        LEFT JOIN action_records a ON a.id = ee.engram_id
        WHERE a.id IS NULL LIMIT ?
      )
    `).run(n).changes || 0;
  } catch (_) { /* fresh db: nothing to sweep */ }
  return out;
}

function listEngramsMissingEmbeddings(limit) {
  limit = Math.max(1, Math.min(500, parseInt(limit || 50, 10)));
  try {
    const d = db();
    return d.prepare(`
      SELECT ar.id, ar.output, ar.timestamp
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE ar.type = 'commitment'
        AND json_extract(ar.output, '$.commitment_type') = 'engram'
        AND ee.engram_id IS NULL
      ORDER BY ar.timestamp DESC
      LIMIT ?
    `).all(limit) || [];
  } catch (_) { return []; }
}

// Recallable corpus missing embeddings — the ACTUAL pool retrieveRelevant
// surfaces (memory_class episodic / semantic / identity / procedural,
// model-visible). The commitment-only scan above embedded ~1K identity rows
// while recall's pool is dominated by episodic (dialogue turns) and semantic
// (lessons) — which never got vectors, so semantic rerank was blind to exactly
// the memories most queries need. This spans all recallable classes (~57K),
// excluding operational/substrate_internal (259K) which is never recalled.
// Returns type + input + output so the backfill can extract per-class text.
// A row is INDEXABLE only if it carries text to embed — the SQL mirror of
// the backfill's embedTextForRow (statement / text / name / a dialogue
// turn with words). Rows with none of these (tool_call telemetry, blank
// turns) can never leave a missing-list: counting them as "still indexing"
// promised a drain that can never finish, and their permanent presence at
// the head of the recall lane starved the archive lane behind them (the
// frozen dashboard numbers, field 2026-08-09). They are NOT deleted and
// NOT touched — they simply are not part of the index promise.
const EMBEDDABLE_SQL = `(
         COALESCE(json_extract(ar.output,'$.statement'),'') <> ''
      OR COALESCE(json_extract(ar.output,'$.text'),'') <> ''
      OR COALESCE(json_extract(ar.output,'$.name'),'') <> ''
      OR (json_extract(ar.input,'$.tool_name') = 'dialogue.turn'
          AND (COALESCE(json_extract(ar.input,'$.args.user_text'),'') <> ''
            OR COALESCE(json_extract(ar.output,'$.assistant_text'),'') <> '')))`;

function listRecallableMissingEmbeddings(limit, currentModel) {
  limit = Math.max(1, Math.min(500, parseInt(limit || 50, 10)));
  try {
    const d = db();
    // When currentModel is given, ALSO return rows whose embedding was produced
    // by a DIFFERENT model — so an embed-model SWAP triggers a background re-embed
    // MIGRATION of the whole recallable index. Embeddings are a disposable derived
    // index; the recorded memory (action_records) is never touched. Mixed dims/
    // spaces coexist safely during migration (recall skips dim-mismatched vectors).
    if (currentModel) {
      return d.prepare(`
        SELECT ar.id, ar.type, ar.input, ar.output, ar.timestamp
        FROM action_records ar
        LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
        WHERE ar.memory_class IN ('episodic','semantic','identity','procedural')
          AND (ar.audience IS NULL OR ar.audience = 'model_visible')
          AND (json_extract(ar.output,'$.scope') IS NULL OR json_extract(ar.output,'$.scope') NOT LIKE 'docs:chats%')  -- skip recall-EXCLUDED docs:chats (never recalled; embedding them = wasted CPU + 45GB logs)
          AND (ee.engram_id IS NULL OR ee.model IS NULL OR ee.model <> ?)
          AND ${EMBEDDABLE_SQL}
        ORDER BY ar.timestamp DESC
        LIMIT ?
      `).all(currentModel, limit) || [];
    }
    return d.prepare(`
      SELECT ar.id, ar.type, ar.input, ar.output, ar.timestamp
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE ar.memory_class IN ('episodic','semantic','identity','procedural')
        AND (ar.audience IS NULL OR ar.audience = 'model_visible')
        AND (json_extract(ar.output,'$.scope') IS NULL OR json_extract(ar.output,'$.scope') NOT LIKE 'docs:chats%')  -- skip recall-EXCLUDED docs:chats
        AND ee.engram_id IS NULL
        AND ${EMBEDDABLE_SQL}
      ORDER BY ar.timestamp DESC
      LIMIT ?
    `).all(limit) || [];
  } catch (_) { return []; }
}

// The imported archive's own embedding backlog (docs:chats), for the
// bounded background drain. Missing-only ON PURPOSE — no model-swap
// re-embed here: migrating a big archive would burn every idle cycle for
// marginal gain, and scoped search tolerates mixed spaces (recall skips
// dim-mismatched vectors). Same column set as the recall lister so the
// backfill's embedTextForRow path serves both.
function listArchiveMissingEmbeddings(limit) {
  limit = Math.max(1, Math.min(500, parseInt(limit || 64, 10)));
  try {
    return db().prepare(`
      SELECT ar.id, ar.type, ar.input, ar.output, ar.timestamp
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE json_extract(ar.output,'$.scope') LIKE 'docs:chats%'
        AND ee.engram_id IS NULL
      ORDER BY ar.timestamp DESC
      LIMIT ?
    `).all(limit) || [];
  } catch (_) { return []; }
}
// Readiness counts for the memory pipeline (memory-readiness.js). Five
// honest numbers, one cheap pass each:
//   recall_total     — indexable recallable rows (the index PROMISE)
//   recall_embedded  — of those, rows holding a vector (for the current
//                      model when given — a model swap honestly re-opens
//                      the gap while the migration re-embeds)
//   recall_missing   — rows the backfill still owes vectors for (same
//                      predicate as listRecallableMissingEmbeddings, so
//                      the number a surface shows IS the drain's queue)
//   archive_chunks   — docs:chats archive rows (the imported record)
//   archive_embedded — archive rows that hold a vector (ingest-time OR the
//                      bounded background drain).
// recall counts keep the archive OUT (recall's pool excludes docs:chats)
// and count ONLY embeddable rows — total = embedded + missing holds, so a
// surface can render real progress instead of a number that never moves.
function memoryIndexCounts(currentModel) {
  const out = { recall_total: 0, recall_embedded: 0, recall_missing: 0, archive_chunks: 0, archive_embedded: 0 };
  try {
    const d = db();
    const RECALL_WHERE = `
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE ar.memory_class IN ('episodic','semantic','identity','procedural')
        AND (ar.audience IS NULL OR ar.audience = 'model_visible')
        AND (json_extract(ar.output,'$.scope') IS NULL OR json_extract(ar.output,'$.scope') NOT LIKE 'docs:chats%')
        AND ${EMBEDDABLE_SQL}`;
    out.recall_missing = currentModel
      ? d.prepare('SELECT COUNT(*) AS n ' + RECALL_WHERE +
          ' AND (ee.engram_id IS NULL OR ee.model IS NULL OR ee.model <> ?)').get(currentModel).n
      : d.prepare('SELECT COUNT(*) AS n ' + RECALL_WHERE + ' AND ee.engram_id IS NULL').get().n;
    out.recall_total = d.prepare('SELECT COUNT(*) AS n ' + RECALL_WHERE).get().n;
    out.recall_embedded = currentModel
      ? d.prepare('SELECT COUNT(*) AS n ' + RECALL_WHERE + ' AND ee.engram_id IS NOT NULL AND ee.model = ?').get(currentModel).n
      : d.prepare('SELECT COUNT(*) AS n ' + RECALL_WHERE + ' AND ee.engram_id IS NOT NULL').get().n;
    out.archive_chunks = d.prepare(
      "SELECT COUNT(*) AS n FROM action_records WHERE json_extract(output,'$.scope') LIKE 'docs:chats%'").get().n;
    out.archive_embedded = d.prepare(
      "SELECT COUNT(*) AS n FROM action_records ar JOIN engram_embeddings ee ON ee.engram_id = ar.id " +
      "WHERE json_extract(ar.output,'$.scope') LIKE 'docs:chats%'").get().n;
  } catch (_) { /* fresh db or missing tables: zeros are the honest answer */ }
  return out;
}

// Queue one thing the partner just saw, for later ingestion.
//
// Called from the proxy while a request is in flight, so it must be cheap and
// it must never throw: one INSERT, unique on (kind, ref, sha). Re-reading the
// same unchanged file is a no-op at the index level rather than a decision
// anyone has to make — which is what makes 8,407 re-reads cost nothing.
// The spool predates the `why` column on installs that ran the earlier build;
// add it in place rather than making them drop a queue they already have.
let _whyColumnChecked = false;
function _ensureSpoolWhy() {
  if (_whyColumnChecked) return;
  _whyColumnChecked = true;
  try {
    const cols = db().prepare('PRAGMA table_info(knowledge_spool)').all().map((c) => c.name);
    if (cols.length && cols.indexOf('why') === -1) db().exec('ALTER TABLE knowledge_spool ADD COLUMN why TEXT');
  } catch (_) { /* fresh db: the CREATE above already has it */ }
}

function spoolKnowledge(opts) {
  opts = opts || {};
  const kind = opts.kind === 'web' ? 'web' : 'file';
  const ref  = String(opts.ref || '').trim();
  if (!ref) return null;
  try {
    _ensureSpoolWhy();
    const r = db().prepare(`
      INSERT OR IGNORE INTO knowledge_spool (kind, ref, sha, bytes, payload, why, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kind, ref, opts.sha || null, opts.bytes || 0, opts.payload || null,
           opts.why ? String(opts.why).replace(/\s+/g, ' ').slice(0, 400) : null, Date.now());
    return r && r.changes ? r.lastInsertRowid : null;
  } catch (_) { return null; }
}

// What the drain still owes. Oldest first: reading in the order the partner
// saw things keeps a document's parts together when one arrives in pieces.
function listPendingKnowledge(limit) {
  const n = Math.max(1, Math.min(500, parseInt(limit || 50, 10)));
  try {
    return db().prepare(`
      SELECT id, kind, ref, sha, bytes, payload, why, created_at
      FROM knowledge_spool WHERE done_at IS NULL
      ORDER BY created_at ASC LIMIT ?
    `).all(n) || [];
  } catch (_) { return []; }
}

// The same queue, for a human who wants to look INSIDE it.
//
// A count is not an answer. "183 still to read" tells the operator that
// something is owed and nothing about what — whether it is their research or
// a folder of junk, whether the thing they need is at the front or the back,
// whether the queue is stuck on one file. This returns rows they can read and
// search, newest first (what you just gave it is what you are looking for),
// and it never returns the payload: web captures can be megabytes and this
// feeds a list, not a reader.
function searchPendingKnowledge(opts) {
  opts = opts || {};
  const n = Math.max(1, Math.min(200, parseInt(opts.limit || 50, 10)));
  const q = String(opts.q || '').trim().toLowerCase();
  try {
    _ensureSpoolWhy();
    const where = ['done_at IS NULL'];
    const args = [];
    if (q) {
      // ref and why both: an operator searches by what the file is called OR
      // by what they were asking when it was read, and cannot know which of
      // the two they remember.
      where.push('(LOWER(ref) LIKE ? OR LOWER(COALESCE(why,\'\')) LIKE ?)');
      args.push('%' + q + '%', '%' + q + '%');
    }
    const rows = db().prepare(
      'SELECT id, kind, ref, bytes, why, created_at FROM knowledge_spool WHERE ' +
      where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
    ).all(...args, n) || [];
    const total = db().prepare(
      'SELECT COUNT(*) AS n FROM knowledge_spool WHERE ' + where.join(' AND ')
    ).get(...args).n;
    return { rows: rows, total: total, shown: rows.length };
  } catch (_) { return { rows: [], total: 0, shown: 0 }; }
}

// Drop something from the queue without reading it. The operator who can see
// the queue is the operator who will find a folder in it that should not be
// there; a list you cannot act on just relocates the frustration. Marked
// done with a verbatim reason rather than deleted, so "why is this not in
// memory" keeps an answer.
function dropPendingKnowledge(id) {
  if (!id) return false;
  try {
    const r = db().prepare(
      "UPDATE knowledge_spool SET done_at = ?, result = 'dropped by operator' WHERE id = ? AND done_at IS NULL"
    ).run(Date.now(), id);
    return !!(r && r.changes);
  } catch (_) { return false; }
}

// Close a spool row. `result` is kept verbatim so an operator can ask why
// something was skipped rather than wondering whether it was seen at all.
function markKnowledgeDone(id, result) {
  if (!id) return false;
  try {
    const r = db().prepare('UPDATE knowledge_spool SET done_at = ?, result = ? WHERE id = ?')
      .run(Date.now(), result ? String(result).slice(0, 200) : null, id);
    return !!(r && r.changes);
  } catch (_) { return false; }
}

// Has this exact content already been ingested? The drain asks before doing
// any work, because the expensive half is embedding, not reading.
function knowledgeAlreadyIngested(sha) {
  if (!sha) return false;
  try {
    const r = db().prepare(
      "SELECT 1 FROM action_records WHERE json_extract(input,'$.source') = ? LIMIT 1"
    ).get('seen:' + sha);
    return !!r;
  } catch (_) { return false; }
}

// A TRUE inventory of the corpora a substrate holds.
//
// chameleon.listScopes() answered this by pulling engrams through
// listEngrams() and counting scopes among them — and listEngrams caps its
// LIMIT at 2000 rows. So the answer was never "which corpora exist", it was
// "which corpora appear among the 2000 most recent engrams", with counts to
// match. On a grown substrate that reports a fraction of the scopes the table
// holds, and a corpus ingested before the last 2000 writes is simply absent.
// A browse screen built on that lies about every size it shows.
//
// One GROUP BY answers it exactly. Identity semantics mirror listEngrams:
// principal_id is the brain (default 'partner'), agent_id an optional
// secondary filter, and cwd applies only under strict isolation — passing
// cwd without it was already a no-op there and stays one here.
//
// `embedded` rides along because a corpus that is 40% embedded answers
// questions worse than one at 100%, and the operator should see which is
// which rather than wonder why a search came back thin.
function scopeInventory(opts) {
  opts = opts || {};
  const principal_id = (opts.principal === null)
    ? null
    : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  const agent_id = opts.agent_id || null;
  const cwd = opts.strict_isolation ? (opts.cwd || null) : null;
  const prefix = opts.prefix ? String(opts.prefix) : null;
  const limit = Math.max(1, Math.min(2000, parseInt(opts.limit || 500, 10)));
  const where = ["ar.type = 'commitment'",
    "COALESCE(json_extract(ar.output,'$.commitment_type'),'engram') = 'engram'",
    "json_extract(ar.output,'$.scope') IS NOT NULL"];
  const args = [];
  if (principal_id) { where.push('ar.principal_id = ?'); args.push(principal_id); }
  if (agent_id)     { where.push('ar.agent_id = ?');     args.push(agent_id); }
  if (cwd)          { where.push('ar.cwd = ?');          args.push(cwd); }
  if (prefix)       { where.push("json_extract(ar.output,'$.scope') LIKE ?"); args.push(prefix + '%'); }
  try {
    return db().prepare(`
      SELECT json_extract(ar.output,'$.scope') AS scope,
             COUNT(*)                          AS count,
             SUM(CASE WHEN ee.engram_id IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
             MIN(ar.timestamp)                 AS first_ts,
             MAX(ar.timestamp)                 AS last_ts
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE ${where.join(' AND ')}
      GROUP BY scope
      ORDER BY count DESC
      LIMIT ?
    `).all(...args, limit) || [];
  } catch (_) { return []; }
}

// The chunks of ONE corpus, in the order they were ingested.
//
// Recall answers "which chunk matches these words". It cannot answer "what
// is in here" — and that was the operator's actual question about the
// research they had ingested. Reading a corpus needed a query good enough
// to guess its contents, which is backwards. This is the browse road:
// oldest-first (ingest order, so a document reads as a document), paged.
function scopeChunks(opts) {
  opts = opts || {};
  const scope = String(opts.scope || '').trim();
  if (!scope) return { scope: '', total: 0, items: [] };
  const principal_id = (opts.principal === null)
    ? null
    : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  const limit  = Math.max(1, Math.min(200, parseInt(opts.limit || 50, 10)));
  const offset = Math.max(0, parseInt(opts.offset || 0, 10));
  const where = ["ar.type = 'commitment'", "json_extract(ar.output,'$.scope') = ?"];
  const args = [scope];
  if (principal_id) { where.push('ar.principal_id = ?'); args.push(principal_id); }
  try {
    const d = db();
    const total = d.prepare(
      `SELECT COUNT(*) AS n FROM action_records ar WHERE ${where.join(' AND ')}`
    ).get(...args).n;
    const rows = d.prepare(`
      SELECT ar.id, ar.timestamp,
             json_extract(ar.output,'$.statement') AS statement,
             json_extract(ar.input,'$.source')     AS source,
             (ee.engram_id IS NOT NULL)            AS embedded
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE ${where.join(' AND ')}
      ORDER BY ar.timestamp ASC, ar.id ASC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) || [];
    return { scope, total, offset, items: rows };
  } catch (_) { return { scope, total: 0, offset, items: [] }; }
}

// Cross-process heartbeat for the maintenance ledger: the most recent
// background_task_run decision row for a task — ANY process, ANY cwd (the
// entity daemon and the proxy's maintenance worker share this as a lease,
// and readiness reads it as the drain's proof-of-life). The task filter
// lives IN the SQL (a serialized-JSON LIKE, confirmed by a real parse):
// a windowed "read 400 recent rows and scan" version missed long-cadence
// tasks in a busy ledger — the drain writes a row every 30s, so a WEEKLY
// backup's last run fell outside any bounded window and its lease read
// as free, re-running it far too often. Timestamp-bounded + LIKE → ms.
function lastBackgroundRun(taskName, sinceMs) {
  try {
    const since = Date.now() - (sinceMs > 0 ? sinceMs : 24 * 60 * 60 * 1000);
    const rows = db().prepare(`
      SELECT timestamp, input, output FROM action_records
      WHERE type = 'decision' AND timestamp >= ?
        AND input LIKE ?
      ORDER BY timestamp DESC LIMIT 20
      -- Strip only '%' from the name: every real task name carries
      -- underscores (embedding_backfill), and stripping those would make
      -- the filter match nothing — heartbeat dead, lease always free.
      -- '_' as a LIKE single-char wildcard can only over-match, and the
      -- JSON parse below verifies the exact name anyway.
    `).all(since, '%"task":"' + String(taskName).replace(/%/g, '') + '"%') || [];
    for (const r of rows) {
      let inp; try { inp = JSON.parse(r.input); } catch (_) { continue; }
      if (!inp || inp.kind !== 'background_task_run' || inp.task !== taskName) continue;
      let notes = null;
      try { const o = JSON.parse(r.output); if (o && o.notes) notes = String(o.notes).slice(0, 500); } catch (_) {}
      return { timestamp: r.timestamp, notes };
    }
  } catch (_) {}
  return null;
}

// Hygiene for the maintenance ledger. The drain writes a
// background_task_run row every 30s BY DESIGN (that row is the heartbeat
// readiness proves life with, and the lease other workers yield to), so
// left alone the bookkeeping grows ~3K rows/day forever on an idle
// machine. Keep every task's MOST RECENT row at any age — leases and
// hydrate always find their anchor — and drop the rest once they age out.
// Scheduler bookkeeping only: the two predicates (type + kind) cannot
// reach a memory row.
function pruneBackgroundRunLedger(maxAgeMs) {
  try {
    const cutoff = Date.now() - (maxAgeMs > 0 ? maxAgeMs : 7 * 24 * 60 * 60 * 1000);
    const r = db().prepare(`
      DELETE FROM action_records
      WHERE type = 'decision'
        AND json_extract(input,'$.kind') = 'background_task_run'
        AND timestamp < ?
        AND id NOT IN (
          SELECT keep_id FROM (
            SELECT id AS keep_id, MAX(timestamp)
            FROM action_records
            WHERE type = 'decision' AND json_extract(input,'$.kind') = 'background_task_run'
            GROUP BY json_extract(input,'$.task')
          )
        )
    `).run(cutoff);
    return r.changes || 0;
  } catch (_) { return 0; }
}

// Same hygiene family, second ledger: usage_ledger rows feed the trailing
// plan-window (≤168h) and nothing else, yet nothing ever pruned them —
// ~20K rows in days of real use, growing forever. 30 days kept: 4× the
// widest window the API serves, so no reachable read ever misses a row.
function pruneUsageLedger(maxAgeMs) {
  try {
    const cutoff = Date.now() - (maxAgeMs > 0 ? maxAgeMs : 30 * 24 * 60 * 60 * 1000);
    const r = db().prepare('DELETE FROM usage_ledger WHERE ts < ?').run(cutoff);
    return r.changes || 0;
  } catch (_) { return 0; }
}

// The session-lessons DELIVERY QUEUE's own hygiene. pullLessons serves rows
// consumed=0 inside a 24-hour window and marks what it returned; nothing ever
// removed anything, so the queue grew monotonically — 1,178 rows on the
// machine this was measured on, 1,175 of them past every window that could
// still deliver them. This is a queue, not a history: anything worth keeping
// was mirrored to the permanent store at write time by recordLesson, so
// sweeping here loses delivery residue and nothing else.
//
// Two predicates, deliberately conservative: consumed rows go after two days
// (a consumed row exists only for post-hoc debugging of "what was I shown"),
// unconsumed rows only once they are a week old — far past the point any
// pullLessons window could still return them.
function pruneSessionLessons(opts) {
  const o = opts || {};
  const now = Date.now();
  const consumedCutoff = now - (o.consumedMaxAgeMs > 0 ? o.consumedMaxAgeMs : 2 * 24 * 60 * 60 * 1000);
  const anyCutoff      = now - (o.maxAgeMs > 0 ? o.maxAgeMs : 7 * 24 * 60 * 60 * 1000);
  try {
    const r = db().prepare(
      'DELETE FROM session_lessons WHERE (consumed = 1 AND ts < ?) OR ts < ?'
    ).run(consumedCutoff, anyCutoff);
    return r.changes || 0;
  } catch (_) { return 0; }
}

// The memories a human can SEE — newest distilled/committed facts (never
// docs:chats raw chunks, never substrate_internal bookkeeping). Serves the
// dashboard's Recent memories list so "did the import actually produce
// memories?" has a visible answer instead of a bare count (2026-08-09 field
// report: an operator who had just imported could not find the memories
// anywhere on screen).
function listRecentMemories(limit) {
  limit = Math.max(1, Math.min(50, parseInt(limit || 10, 10)));
  try {
    return db().prepare(`
      SELECT ar.id, ar.timestamp,
             json_extract(ar.output,'$.statement') AS statement,
             json_extract(ar.output,'$.scope')     AS scope,
             ar.memory_class
      FROM action_records ar
      WHERE ar.type = 'commitment'
        AND ar.memory_class IN ('semantic','identity','procedural')
        AND (ar.audience IS NULL OR ar.audience = 'model_visible')
        AND COALESCE(json_extract(ar.output,'$.statement'),'') <> ''
        -- Ingested documents are passages, not memories. A corpus chunk reads
        -- "[PLAN.md #11] pply immediately) 2. Docker Compose" — a fragment cut
        -- mid-word, eight of them from one file, and it buried what the
        -- partner actually learned. The operator saw exactly that the hour
        -- after the first backfill landed (2026-08-11). Documents have their
        -- own shelf under the knowledge class; this list is for what was
        -- LEARNED, not what was READ.
        AND (json_extract(ar.output,'$.scope') IS NULL OR json_extract(ar.output,'$.scope') NOT LIKE 'docs:%')
      ORDER BY ar.timestamp DESC
      LIMIT ?
    `).all(limit) || [];
  } catch (_) { return []; }
}

// Dense-retrieval support — TRUE hybrid recall. Stream ALL
// recallable embeddings so recall.js can cosine-scan them as a candidate
// SOURCE (not merely rerank lexical hits), enabling pure-semantic retrieval
// of paraphrases that share NO query keywords — the behavior the lexical FTS
// gate structurally excluded. better-sqlite3.iterate yields lazily over the
// memory-mapped DB → bounded memory, no 200MB+ full load.
function streamRecallableEmbeddings() {
  const d = db();
  return d.prepare(`
    SELECT ee.engram_id AS id, ee.dim AS dim, ee.vector AS vector,
           ar.memory_class AS memory_class, ar.audience AS audience
    FROM engram_embeddings ee
    JOIN action_records ar ON ar.id = ee.engram_id
    WHERE ar.memory_class IN ('episodic','semantic','identity','procedural')
      AND (ar.principal_id IS NULL OR ar.principal_id NOT IN ('bench','partner-loop-test'))
  `).iterate();
}
// Fetch full action rows for an id set — used to build dense-hit result objects
// (statement/class/recency) for engrams the dense arm surfaced but the lexical
// pool never pulled.
function getActionsByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  try {
    const d = db();
    const ph = ids.map(() => '?').join(',');
    return d.prepare(`SELECT * FROM action_records WHERE id IN (${ph})`).all(...ids) || [];
  } catch (_) { return []; }
}

// retrieval frequency feedback helpers.
// Bjork's desirable difficulty: facts pulled often strengthen; untouched
// facts fade relative to active ones. Counts live in
// engram_retrieval_stats (not append-only — derived stat). bumpRetrieval
// is called once per recall hit, getRetrievalCount once per scoring
// pass. Both are bounded SQLite operations; fail-silent on lock/error.
function bumpRetrieval(engram_id) {
  if (!engram_id) return null;
  try {
    const d = db();
    d.prepare(`
      INSERT INTO engram_retrieval_stats (engram_id, retrieval_count, last_seen)
      VALUES (?, 1, ?)
      ON CONFLICT(engram_id) DO UPDATE SET
        retrieval_count = retrieval_count + 1,
        last_seen = excluded.last_seen
    `).run(engram_id, Date.now());
    return true;
  } catch (_) { return null; }
}
function getRetrievalCount(engram_id) {
  if (!engram_id) return 0;
  try {
    const d = db();
    const row = d.prepare('SELECT retrieval_count FROM engram_retrieval_stats WHERE engram_id = ?').get(engram_id);
    return row ? (row.retrieval_count | 0) : 0;
  } catch (_) { return 0; }
}
function bumpRetrievalBatch(engram_ids) {
  if (!Array.isArray(engram_ids) || !engram_ids.length) return 0;
  try {
    const d = db();
    const stmt = d.prepare(`
      INSERT INTO engram_retrieval_stats (engram_id, retrieval_count, last_seen)
      VALUES (?, 1, ?)
      ON CONFLICT(engram_id) DO UPDATE SET
        retrieval_count = retrieval_count + 1,
        last_seen = excluded.last_seen
    `);
    const now = Date.now();
    const tx = d.transaction((ids) => { for (const id of ids) if (id) stmt.run(id, now); });
    tx(engram_ids);
    return engram_ids.length;
  } catch (_) { return 0; }
}

// ── intent state tracking ─────────────────────────────────
//
// Intents live in action_records (engrams, immutable). Their mutable
// state (status, dispatch_attempts, observation_id) lives here in
// intent_state. The atomic claim function uses UPDATE... WHERE
// status='validated' RETURNING * to prevent double-dispatch under
// races — only one caller observes the row transition; others see 0
// rows back and skip.

function insertIntentState(opts) {
  opts = opts || {};
  if (!opts.intent_engram_id) return null;
  const status = opts.status || 'validated';
  try {
    const d = db();
    const now = Date.now();
    d.prepare(`
      INSERT INTO intent_state
        (intent_engram_id, status, dispatch_attempts, created_ts, updated_ts)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(intent_engram_id) DO NOTHING
    `).run(opts.intent_engram_id, status, now, now);
    return getIntentState(opts.intent_engram_id);
  } catch (_) { return null; }
}

function getIntentState(intent_engram_id) {
  if (!intent_engram_id) return null;
  try {
    return db().prepare(
      'SELECT * FROM intent_state WHERE intent_engram_id = ?'
    ).get(intent_engram_id) || null;
  } catch (_) { return null; }
}

function listIntentStates(opts) {
  opts = opts || {};
  const status = opts.status || null;
  const limit  = Math.max(1, Math.min(500, opts.limit || 50));
  try {
    if (status) {
      return db().prepare(
        'SELECT * FROM intent_state WHERE status = ? ORDER BY created_ts ASC LIMIT ?'
      ).all(status, limit);
    }
    return db().prepare(
      'SELECT * FROM intent_state ORDER BY created_ts DESC LIMIT ?'
    ).all(limit);
  } catch (_) { return []; }
}

// Atomic claim — flip status from 'validated' to 'dispatched' and bump
// the attempts counter. Returns the row on win, null on race-loss /
// not-validated / not-present.
function claimIntent(intent_engram_id) {
  if (!intent_engram_id) return null;
  try {
    const d = db();
    const now = Date.now();
    // better-sqlite3 supports RETURNING (SQLite >= 3.35).
    const stmt = d.prepare(`
      UPDATE intent_state
      SET status='dispatched',
          dispatch_attempts = dispatch_attempts + 1,
          dispatched_at = ?,
          updated_ts = ?
      WHERE intent_engram_id = ? AND status = 'validated'
      RETURNING *
    `);
    const row = stmt.get(now, now, intent_engram_id);
    return row || null;
  } catch (_) { return null; }
}

function markIntentObserved(intent_engram_id, observation_id) {
  if (!intent_engram_id) return null;
  try {
    const d = db();
    const now = Date.now();
    const stmt = d.prepare(`
      UPDATE intent_state
      SET status='observed',
          observation_id = ?,
          observed_at = ?,
          updated_ts = ?
      WHERE intent_engram_id = ?
      RETURNING *
    `);
    return stmt.get(observation_id || null, now, now, intent_engram_id) || null;
  } catch (_) { return null; }
}

function markIntentFailed(intent_engram_id, error) {
  if (!intent_engram_id) return null;
  try {
    const d = db();
    const now = Date.now();
    const stmt = d.prepare(`
      UPDATE intent_state
      SET status='failed',
          last_error = ?,
          updated_ts = ?
      WHERE intent_engram_id = ?
      RETURNING *
    `);
    return stmt.get(
      typeof error === 'string' ? error.slice(0, 500) : (error && error.message || null),
      now, intent_engram_id
    ) || null;
  } catch (_) { return null; }
}

function _wrapForIncognito(name, fn) {
  if (typeof fn !== 'function') return fn;
  if (!_INCOGNITO_MUTED_WRITES.has(name)) return fn;
  return function _incoMutedWrapper() {
    if (isIncognito()) return null;
    return fn.apply(this, arguments);
  };
}

const _exports = {
  db,
  DB_PATH,
  DATA_DIR,
  recordHookEvent,
  isPluginActive,
  recordSavings,
  recordProxyUsage,
  recordBaselineCost,
  recordMcpToolCall,
  recordModuleError,
  recordCacheRatioEvent,
  recordToolCallHash,
  countRecentToolCallHashes,
  markFileRead,
  wasFileRead,
  archiveToolOutput,
  searchArchive,
  getArchiveEntry,
  getArchiveExcerpt,
  listArchives,
  recordLesson,
  recordOperatorLesson,
  listOperatorLessons,
  pullLessons,
  // action_records substrate
  recordAction,
  getAction,
  queryActions,
  searchActions,
  searchActionsFull,
  searchDialogueTurns,
  countActions,
  // foundation step — schema version surface
  getSchemaVersion,
  CURRENT_SCHEMA,
  // cost subsystem — persistent cost ledger
  recordCostEvent,
  sumCostEvents,
  sumTokensByProviders,
  // D2 — effect ledger (crash-safe side-effect dedup)
  recordEffect,
  getEffect,
  // briefing subsystem — persistent briefing log
  recordBriefing,
  hasBriefingForGoal,
  listBriefings,
  // design: failure ledger
  // Continuous-thinking telemetry
  // design: confidence calibration ledger
  recordCalibrationPoint,
  updateCalibrationOutcome,
  listCalibrationPoints,
  // design: payment events
  // design: signed audit chain
  appendSignedAuditRow,
  lastSignedAuditRow,
  listSignedAuditChain,
  appendSignedAuditRowChained,
  // persisted supersession index (maintained by recordAction; unioned into
  // every supersedes filter on the read side)
  listSupersededIds,
  // operator-request subsystem — operator-request inbox
  recordOperatorRequest,
  listOperatorRequests,
  resolveOperatorRequest,
  countPendingOperatorRequests,
  // audit subsystem — allowlist audit
  recordAllowlistAudit,
  listAllowlistAudit,
  // P16 Tier 1 — DecisionGraph typed edges
  recordEdge,
  queryEdges,
  getEdge,
  CANONICAL_EDGE_LABELS,
  // P16.5 I3 — Counterfactual branches
  createBranch,
  getBranch,
  listBranches,
  setBranchStatus,
  CF_STATUSES,
  // design: intent state tracking
  insertIntentState,
  getIntentState,
  listIntentStates,
  claimIntent,
  markIntentObserved,
  markIntentFailed,
  // P17 Tier 3 — wire-format profiles
  saveWireFormatProfile,
  getWireFormatProfile,
  listWireFormatProfiles,
  getActiveWireFormatProfile,
  activateWireFormatProfile,
  discardWireFormatProfile,
  WFP_STATUSES,
  // Phase B query layer needs direct db() for json_extract() queries over
  // the input/output JSON columns. Exposed as a getter (not the handle
  // itself) so tests and consumers stay honest about locking/lifecycle.
  _dbForQuery: db,
  getStats,
  // Bjork desirable-difficulty feedback
  bumpRetrieval,
  bumpRetrievalBatch,
  getRetrievalCount,
  // embedding cache
  setEmbedding,
  getEmbedding,
  listEngramsMissingEmbeddings,
  listRecallableMissingEmbeddings,
  memoryIndexCounts,
  scopeInventory,
  scopeChunks,
  deleteEmbedding,
  pruneDeadEmbeddings,
  spoolKnowledge,
  listPendingKnowledge,
  searchPendingKnowledge,
  dropPendingKnowledge,
  markKnowledgeDone,
  knowledgeAlreadyIngested,
  listArchiveMissingEmbeddings,
  lastBackgroundRun,
  pruneBackgroundRunLedger,
  pruneUsageLedger,
  pruneSessionLessons,
  listRecentMemories,
  streamRecallableEmbeddings,
  getActionsByIds,
  close,
  isIncognito,  // exposed so callers (proxy server.js, hooks) can branch
  // Exposed so a caller that legitimately opens its own connection can bring
  // it up to the same schema instead of assuming one. state-machine.js writes
  // invariants through its own handle, and DB_PATH here is resolved once at
  // module load: when the active database changes afterwards (switching tenant
  // does exactly that), the handle it opens is a database this module never
  // migrated, and the write lands on a missing table.
  migrate
};
for (const k of Object.keys(_exports)) _exports[k] = _wrapForIncognito(k, _exports[k]);
module.exports = _exports;

// Overlay accessors merge in beside the built-ins when present.
try { Object.assign(module.exports, require('./state-ext.js').api || {}); } catch (_) {}
