// SPDX-License-Identifier: AGPL-3.0-only
// Analytics aggregator — single read-only view across all telemetry sources.
//
// Pulls from substrate tables (savings_ledger, hook_events, mcp_tool_calls,
// usage_ledger, tool_output_archive, action_records, tool_response_cache)
// plus in-memory proxy modules (cost, cacheratio, errortax, gemcache stats).
//
// Stable schema —
// downstream UI / API consumers depend on the keys here.

const state = require('./state.js');

// Window labels → ms duration. 'all' returns 0 → from_ts=0.
const WINDOWS = {
  session: 60 * 60 * 1000,           // last hour as a proxy for "current"
  today:   24 * 60 * 60 * 1000,
  '7d':    7  * 24 * 60 * 60 * 1000,
  '30d':   30 * 24 * 60 * 60 * 1000, // was MISSING — UI/callers asking 30d
  '90d':   90 * 24 * 60 * 60 * 1000, //   silently fell back to today's window
  all:     0
};

function windowBounds(label) {
  const ms = WINDOWS[label];
  if (ms === undefined) return windowBounds('today');
  const to_ts = Date.now();
  const from_ts = ms === 0 ? 0 : to_ts - ms;
  return { from_ts, to_ts, label };
}

// Median + p95 from a sorted array of numbers. Returns 0 when empty.
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

// A token removed from the window is absent from every later prompt too, until
// the conversation compacts and the window is rebuilt. The transcripts record
// where that happens, but they belong to another program that prunes them on
// its own schedule — and a pruned project dir silently collapses the carried
// number. So the substrate's own per-session traces rebuild the same timeline,
// and per session the richer of the two views wins. Sessions that produced
// savings are read once and held for a few minutes.
const _sessionCache = { at: 0, byId: new Map() };
const SESSION_CACHE_MS = 5 * 60 * 1000;

// Every lane of a session leaves traces the substrate itself owns: hook
// events, archived tool outputs, action records, the savings rows. Their
// union, one beat per second of activity, is the session's turn series.
// Conversation compactions are only the PreCompact marks the plugin hook
// recorded — the proxy's own window compactions rebuild a different window
// and must not truncate this count.
function _substrateTimeline(db, sid) {
  const beats = [];
  const marks = [];
  const pull = (sql, into) => {
    try { for (const r of db.prepare(sql).all(sid)) into.push(r.t); } catch (_) { /* table absent on older substrates */ }
  };
  pull('SELECT ts AS t FROM hook_events WHERE session_id = ?', beats);
  pull('SELECT ts AS t FROM tool_output_archive WHERE session_id = ?', beats);
  pull("SELECT timestamp AS t FROM action_records WHERE session_id = ? AND type <> 'compact'", beats);
  pull('SELECT ts AS t FROM savings_ledger WHERE session_id = ?', beats);
  pull("SELECT ts AS t FROM hook_events WHERE session_id = ? AND event LIKE 'PreCompact%'", marks);
  pull("SELECT timestamp AS t FROM action_records WHERE session_id = ? AND type = 'compact' AND agent_id = 'claude-code'", marks);
  const dedupe = (arr) => {
    arr.sort((a, b) => a - b);
    const seen = new Set();
    const kept = [];
    for (const t of arr) {
      const b = Math.floor(t / 1000);
      if (seen.has(b)) continue;
      seen.add(b);
      kept.push(t);
    }
    return kept;
  };
  return { turns: dedupe(beats), compactions: dedupe(marks), src: 'substrate' };
}

// Chunked line scan — marathon transcripts outgrow what a single string can
// hold (readFileSync throws past the V8 string cap and the session silently
// vanished from this timeline), so the bytes stream through a carry buffer.
function _scanTranscript(fs, file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  const turns = [], compactions = [];
  const CHUNK = 8 * 1024 * 1024;
  let carry = Buffer.alloc(0);
  const takeLine = (line) => {
    const isTurn = line.indexOf('\"type\":\"user\"') >= 0;
    const isCompact = line.indexOf('isCompactSummary') >= 0 || line.indexOf('compact_boundary') >= 0;
    if (!isTurn && !isCompact) return;
    let j;
    try { j = JSON.parse(line); } catch (_) { return; }
    const t = Date.parse(j.timestamp || '');
    if (!t) return;
    if (j.isCompactSummary === true || j.subtype === 'compact_boundary') compactions.push(t);
    else if (j.type === 'user') turns.push(t);
  };
  try {
    for (;;) {
      const b = Buffer.allocUnsafe(CHUNK);
      const got = fs.readSync(fd, b, 0, CHUNK, null);
      if (got <= 0) break;
      carry = carry.length ? Buffer.concat([carry, b.subarray(0, got)]) : b.subarray(0, got);
      let start = 0;
      for (let nl = carry.indexOf(0x0A, start); nl !== -1; nl = carry.indexOf(0x0A, start)) {
        const line = carry.subarray(start, nl).toString('utf8');
        start = nl + 1;
        if (line) takeLine(line);
      }
      carry = start ? carry.subarray(start) : carry;
      if (carry.length > 64 * 1024 * 1024) carry = Buffer.alloc(0); // no real line is 64MB — drop, don't hold
    }
    if (carry.length) { const line = carry.toString('utf8'); if (line) takeLine(line); }
  } catch (_) { /* mid-read surprise — keep what parsed */ } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
  return { turns, compactions };
}

function sessionTimeline(ids, opts) {
  const fresh = !!(opts && opts.fresh);
  const now = Date.now();
  if (!fresh && now - _sessionCache.at < SESSION_CACHE_MS) return _sessionCache.byId;
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const wanted = new Set(ids);
  const out = new Map();
  const root = path.join(process.env.HOME || os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { dirs = []; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -6);
      if (!wanted.has(sid) || out.has(sid)) continue;
      const scanned = _scanTranscript(fs, path.join(root, d, f));
      if (!scanned) continue;
      scanned.turns.sort((a, b) => a - b);
      scanned.compactions.sort((a, b) => a - b);
      out.set(sid, { turns: scanned.turns, compactions: scanned.compactions, src: 'transcript' });
    }
  }
  // The substrate only stands in for sessions whose transcript is gone — a
  // live transcript keeps its exact semantics untouched.
  if (process.env.TROTH_TIMELINE_SUBSTRATE !== '0') {
    let sdb = null;
    try { sdb = state.db(); } catch (_) { /* substrate closed — transcripts alone */ }
    if (sdb) {
      for (const sid of wanted) {
        if (out.has(sid)) continue;
        let sub = null;
        try { sub = _substrateTimeline(sdb, sid); } catch (_) { continue; }
        if (!sub || !sub.turns.length) continue;
        out.set(sid, sub);
      }
    }
  }
  if (!fresh) {
    _sessionCache.at = now;
    _sessionCache.byId = out;
  }
  return out;
}

function getAnalytics(opts) {
  opts = opts || {};
  const w = windowBounds(opts.window || 'today');
  const sessFilter = opts.session_id ? ` AND session_id = '${String(opts.session_id).replace(/'/g, "''")}'` : '';
  const db = state.db();

  // ── savings_ledger aggregation ────────────────────────────────────────
  // Grouped by kind AND model/session so each saving prices at the rate of
  // the model that actually did the work — a token kept out of a Fable
  // window is a $10/M token, not a $3/M one. Rows without a model inherit
  // one stamped by another row of the SAME session (the output-sandbox
  // hook stamps; the bash lane cannot), else the baseline prices them.
  const savingsRows = db.prepare(
    `SELECT kind, model, session_id, SUM(tokens) AS tokens, COUNT(*) AS events
     FROM savings_ledger
     WHERE ts >= ? AND ts <= ?` + sessFilter +
    ` GROUP BY kind, model, session_id`
  ).all(w.from_ts, w.to_ts);
  const sessionModel = {};
  for (const r of savingsRows) {
    if (r.model && r.session_id && !sessionModel[r.session_id]) sessionModel[r.session_id] = r.model;
  }
  const tokens_saved_by_kind = {};
  let tokens_saved_total = 0;
  for (const r of savingsRows) {
    tokens_saved_by_kind[r.kind] = (tokens_saved_by_kind[r.kind] || 0) + (r.tokens || 0);
    tokens_saved_total += r.tokens || 0;
  }

  // ── engine spend + baseline comparison (usage_ledger) ─────────────────
  // usage_ledger, not baseline_cost_events: the baseline table's two writers
  // sit on router lanes that stopped firing, so every number
  // derived from it was frozen 25-day-old history. usage_ledger gets one row
  // per completed request in EVERY lane (cost.recordUsage), so spend, request
  // counts and the baseline comparison come from it, priced at read time via
  // cost.js: flat-plan subscription models genuinely cost $0, and baseline_usd
  // answers "what would these exact tokens have cost on the baseline model's
  // API". Baseline model = operator's ~/.troth/config.json `baseline_model`,
  // else Sonnet 4.6 — the same resolution the token-equivalent section has
  // effectively used since the events table died.
  let costMod = null;
  try { costMod = require('../proxy/modules/cost.js'); } catch (_) {}
  let tokens_saved_baseline_model = 'claude-sonnet-4.6';
  try {
    const cfgPath = process.env.TROTH_CONFIG_PATH ||
      require('path').join(process.env.HOME || require('os').homedir(), '.troth', 'config.json');
    const rawCfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
    if (rawCfg && typeof rawCfg.baseline_model === 'string' && rawCfg.baseline_model.length) {
      tokens_saved_baseline_model = rawCfg.baseline_model;
    }
  } catch (_) { /* config absent or malformed — keep default */ }
  // usage_ledger has no session dimension, so a session-scoped query reports
  // zero spend rather than attributing global spend to one session (matches
  // the previous behaviour, where the session filter hit an empty window).
  let actual_usd_spent = 0, baseline_usd = 0, requests_billed = 0;
  let api_cost_total = 0, cache_saving_usd = 0;
  let tokens_used_input = 0, tokens_used_output = 0, tokens_used_cached = 0;
  let ledgerModels = [];   // per-model window rows, reused by the providers panel
  if (!opts.session_id) {
    try {
      ledgerModels = db.prepare(
        `SELECT model, COUNT(*) AS requests,
                COALESCE(SUM(tokens_in),0)  AS input,
                COALESCE(SUM(tokens_out),0) AS output,
                COALESCE(SUM(cached_in),0)  AS cached_input
         FROM usage_ledger
         WHERE ts >= ? AND ts <= ?
         GROUP BY model ORDER BY requests DESC`
      ).all(w.from_ts, w.to_ts);
      let bIn = 0, bOut = 0, bCached = 0;
      for (const r of ledgerModels) {
        requests_billed += r.requests;
        bIn += r.input; bOut += r.output; bCached += r.cached_input;
        r.cost = costMod ? costMod.calculateCost(r.model, r.input, r.output, r.cached_input).cost : 0;
        const _bare = String(r.model).replace(/ \(plan\)$/, '');
        r.cost_at_api = (costMod && costMod.costAtApiRates)
          ? costMod.costAtApiRates(_bare, r.input, r.output, r.cached_input)
          : 0;
        const _rt = (costMod && costMod.apiRateFor) ? costMod.apiRateFor(_bare) : null;
        r.cache_saving = (_rt && _rt.in)
          ? (r.cached_input || 0) * ((_rt.in - (_rt.cached_in || 0)) / 1000000)
          : 0;
        api_cost_total += r.cost_at_api;
        cache_saving_usd += r.cache_saving;
        actual_usd_spent += r.cost;
      }
      tokens_used_input = bIn;
      tokens_used_output = bOut;
      tokens_used_cached = bCached;
      if (costMod && requests_billed > 0) {
        baseline_usd = costMod.calculateCost(tokens_saved_baseline_model, bIn, bOut, bCached).cost;
      }
    } catch (_) { /* usage_ledger absent on fresh substrate — zeros */ }
  }

  const REMOVING_KINDS = ['output_archive', 'bash_compression', 'context_filter', 'mcp_cache:hit', 'gemcache:hit'];
  let tokens_removed = 0, tokens_removed_carried = 0, removal_events = 0, removal_turns = 0;
  let removal_carried_estimated = 0;
  let removal_sessions = [];
  const _removalBySid = new Map();
  const _removalByDay = new Map();
  try {
    const removals = db.prepare(
      `SELECT tokens, session_id, ts, carried_turns, note FROM savings_ledger
       WHERE ts >= ? AND ts <= ? AND session_id IS NOT NULL AND tokens > 0
         AND kind IN (${REMOVING_KINDS.map(() => '?').join(',')})`
    ).all(w.from_ts, w.to_ts, ...REMOVING_KINDS);
    const ids = [];
    for (const r of removals) if (ids.indexOf(r.session_id) === -1) ids.push(r.session_id);
    const timeline = ids.length ? sessionTimeline(ids) : new Map();
    for (const r of removals) {
      tokens_removed += r.tokens;
      removal_events++;
      const s = timeline.get(r.session_id);
      let later = 0;
      if (r.carried_turns != null) {
        later = r.carried_turns;
      } else if (s) {
        const stop = s.compactions.find((c) => c > r.ts);
        for (const t of s.turns) {
          if (t <= r.ts) continue;
          if (stop && t >= stop) break;
          later++;
        }
      }
      const _est = r.carried_turns != null && r.note && String(r.note).indexOf('carried_est') === 0;
      if (_est) removal_carried_estimated += r.tokens * (1 + later);
      removal_turns += later;
      tokens_removed_carried += r.tokens * (1 + later);
      const _rd = Math.floor(r.ts / 86400000);
      const _rday = _removalByDay.get(_rd) || { removed: 0, carried: 0 };
      _rday.removed += r.tokens;
      _rday.carried += r.tokens * (1 + later);
      _removalByDay.set(_rd, _rday);
      const _e = _removalBySid.get(r.session_id) || { tokens: 0, carried: 0, events: 0, timeline: r.carried_turns != null ? (_est ? 'estimated' : 'frozen') : (s ? (s.src || 'transcript') : 'none') };
      _e.tokens += r.tokens;
      _e.carried += r.tokens * (1 + later);
      _e.events++;
      _removalBySid.set(r.session_id, _e);
    }
    removal_sessions = Array.from(_removalBySid, ([session_id, e]) => ({ session_id, ...e }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12);
  } catch (_) { /* transcripts unreadable — the certain number still stands */ }

  const daily = [];
  try {
    const DAY = 24 * 60 * 60 * 1000;
    const usageDays = db.prepare(
      `SELECT CAST(ts / ${DAY} AS INTEGER) AS d, COUNT(*) AS reqs,
              COALESCE(SUM(tokens_in),0) AS tin,
              COALESCE(SUM(tokens_out),0) AS tout,
              COALESCE(SUM(cached_in),0) AS tcached
       FROM usage_ledger WHERE ts >= ? AND ts <= ? GROUP BY d ORDER BY d`
    ).all(w.from_ts, w.to_ts);
    const savedDays = db.prepare(
      `SELECT CAST(ts / ${DAY} AS INTEGER) AS d, COALESCE(SUM(tokens),0) AS saved
       FROM savings_ledger WHERE ts >= ? AND ts <= ? GROUP BY d`
    ).all(w.from_ts, w.to_ts);
    const savedByDay = {};
    for (const r of savedDays) savedByDay[r.d] = r.saved;
    for (const r of usageDays) {
      daily.push({
        date: new Date(r.d * DAY).toISOString().slice(0, 10),
        requests: r.reqs,
        tokens_in: r.tin,
        tokens_out: r.tout,
        tokens_cached: r.tcached,
        tokens_saved: savedByDay[r.d] || 0,
        tokens_removed: (_removalByDay.get(r.d) || {}).removed || 0,
        tokens_removed_carried: (_removalByDay.get(r.d) || {}).carried || 0
      });
    }
  } catch (_) { /* usage_ledger absent on fresh substrate */ }

  actual_usd_spent = +actual_usd_spent.toFixed(6);
  baseline_usd = +baseline_usd.toFixed(6);
  const estimated_usd_saved = +Math.max(0, baseline_usd - actual_usd_spent).toFixed(6);
  const savings_percent = baseline_usd > 0
    ? Math.round((1 - actual_usd_spent / baseline_usd) * 100)
    : 0;

  // ── proxy gemcache (savings_ledger derived) ──────────────────────────
  const proxy_cache_hits   = tokens_saved_by_kind['gemcache:hit'] || 0;
  const proxy_cache_pop    = tokens_saved_by_kind['gemcache:populate'] || 0;
  const proxy_cache_events = (savingsRows.find(r => r.kind === 'gemcache:hit') || { events: 0 }).events;
  const proxy_cache_pop_ev = (savingsRows.find(r => r.kind === 'gemcache:populate') || { events: 0 }).events;

  // ── MCP cache per-tool ────────────────────────────────────────────────
  const mcpRows = db.prepare(
    `SELECT tool,
            COUNT(*) AS calls,
            SUM(cache_hit) AS hits,
            SUM(bytes) AS bytes,
            SUM(CASE WHEN error_message IS NOT NULL THEN 1 ELSE 0 END) AS errors
     FROM mcp_tool_calls
     WHERE ts >= ? AND ts <= ?` + sessFilter +
    ` GROUP BY tool`
  ).all(w.from_ts, w.to_ts);
  const mcp_cache = {};
  for (const r of mcpRows) {
    // Pull latency separately for percentiles. Keeps the GROUP BY query cheap.
    const lats = db.prepare(
      `SELECT latency_ms FROM mcp_tool_calls
       WHERE ts >= ? AND ts <= ? AND tool = ?` + sessFilter +
      ` ORDER BY latency_ms`
    ).all(w.from_ts, w.to_ts, r.tool).map(x => x.latency_ms || 0);
    mcp_cache[r.tool] = {
      calls: r.calls,
      hits: r.hits,
      hit_rate: r.calls > 0 ? +(r.hits / r.calls).toFixed(3) : 0,
      bytes: r.bytes || 0,
      p50_latency_ms: pct(lats, 50),
      p95_latency_ms: pct(lats, 95),
      errors: r.errors || 0
    };
  }

  // ── context_filter / loopbreaker / editmatch / hashline / output_archive ──
  // All read from savings_ledger. Use savings counts (not just tokens) for the
  // surfaces where token-equivalent doesn't make sense (e.g. loopbreaker_denied
  // is "1 per catch", not tokens).
  const surface = (kind) => savingsRows
    .filter(r => r.kind === kind)
    .reduce((a, r) => ({ tokens: a.tokens + (r.tokens || 0), events: a.events + (r.events || 0) }),
            { tokens: 0, events: 0 });

  const surfaces = {
    proxy_cache: {
      hits: proxy_cache_events,
      misses: 0, // not directly tracked in ledger; gemcache.stats() has this
      hit_rate: 0,
      tokens_saved: proxy_cache_hits,
      populates: proxy_cache_pop_ev,
      tokens_populated: proxy_cache_pop
    },
    mcp_cache: mcp_cache,
    context_filter: {
      events: surface('context_filter').events,
      tokens_saved: surface('context_filter').tokens
    },
    loopbreaker:    { catches: surface('loopbreaker_denied').events },
    editmatch:      { rescues: surface('editmatch_rescued').events },
    hashline:       { edits_applied: surface('hashline_edit_applied').events },
    output_archive: { events: surface('output_archive').events,
                      bytes_archived: surface('output_archive').tokens },
    bash_compression: { events: surface('bash_compression').events,
                        bytes_saved: surface('bash_compression').tokens },
    verifyfirst:    { blocks: surface('verifyfirst_blocked').events }
  };

  // Compaction events from action_records (type='compact')
  const compactRow = db.prepare(
    `SELECT COUNT(*) AS n FROM action_records
     WHERE timestamp >= ? AND timestamp <= ? AND type = 'compact'` +
    (opts.session_id ? ` AND session_id = ?` : '')
  ).get(...(opts.session_id
    ? [w.from_ts, w.to_ts, opts.session_id]
    : [w.from_ts, w.to_ts]));
  surfaces.compaction = { events: compactRow.n || 0 };

  // ── live in-memory snapshots from proxy modules (best-effort) ────────
  // Providers: window-scoped per-model spend from the ledger rows computed
  // above (same shape as cost.getTotals(), so the dashboard's "$ this
  // window" panel needs no change). The in-memory totals reset on every
  // proxy restart, so they only serve as a fallback when the ledger has
  // nothing in this window (fresh substrate / no traffic yet).
  let providers = null;
  if (ledgerModels.length) {
    const perModel = {};
    let grandTotalUSD = 0;
    for (const r of ledgerModels) {
      perModel[r.model] = {
        requests: r.requests, input: r.input, cached_input: r.cached_input,
        output: r.output, cost: +(r.cost || 0).toFixed(6),
        cost_at_api: +(r.cost_at_api || 0).toFixed(6)
      };
      grandTotalUSD += r.cost || 0;
    }
    providers = { perModel, grandTotalUSD: +grandTotalUSD.toFixed(6) };
  } else {
    try { providers = require('../proxy/modules/cost.js').getTotals(); } catch (_) {}
  }
  let cacheratio = null;
  try {
    cacheratio = require('../proxy/modules/cacheratio.js').getStats();
  } catch (_) {}
  let errortax = null;
  try {
    errortax = require('../proxy/modules/errortax.js').getStats();
  } catch (_) {}
  let gemcacheLive = null;
  try {
    gemcacheLive = require('../proxy/modules/troth-cache.js').getDefault().stats();
  } catch (_) {}

  // Backfill proxy_cache hit_rate / misses from live gemcache if available.
  if (gemcacheLive) {
    surfaces.proxy_cache.misses   = gemcacheLive.misses || 0;
    surfaces.proxy_cache.hit_rate = +(gemcacheLive.hit_rate || 0).toFixed(3);
  }

  // ── errors from persisted module_errors (window-scoped) ─────────────
  const errorRows = db.prepare(
    `SELECT module, kind, COUNT(*) AS n, MAX(message) AS last_message, MAX(ts) AS last_ts
     FROM module_errors
     WHERE ts >= ? AND ts <= ?
     GROUP BY module, kind ORDER BY n DESC`
  ).all(w.from_ts, w.to_ts);
  const errors_by_module = {};
  for (const r of errorRows) {
    if (!errors_by_module[r.module]) errors_by_module[r.module] = { total: 0, by_kind: {}, last_message: r.last_message };
    errors_by_module[r.module].total += r.n;
    errors_by_module[r.module].by_kind[r.kind || 'unknown'] = r.n;
  }

  // ── health: degradation flags (simple thresholds, no false-positives) ─
  const degraded = [];
  for (const [tool, m] of Object.entries(mcp_cache)) {
    if (m.calls >= 10 && m.hit_rate < 0.10) {
      degraded.push({ metric: `mcp_cache.${tool}.hit_rate`, value: m.hit_rate, threshold: 0.10 });
    }
    if (m.calls >= 5 && m.p50_latency_ms > 50) {
      degraded.push({ metric: `mcp_cache.${tool}.p50_latency_ms`, value: m.p50_latency_ms, threshold: 50 });
    }
  }
  for (const [mod, info] of Object.entries(errors_by_module)) {
    if ((info.by_kind || {}).auth_error >= 5) {
      degraded.push({ metric: `auth.${mod}`, value: info.by_kind.auth_error, threshold: 5 });
    }
  }

  // ── token-savings USD-equivalent (per-kind, per-model) ───────────────
  // The proxy serves Claude subscription users (no per-token billing) AND
  // API-key users. The latter get $ saved directly from baseline_cost_events.
  // The former see "0 requests billed, 0 saved" today — wrong, because
  // tokens saved via gemcache / MCP cache / context filter still translate
  // into preserved rate-limit headroom + context budget. Compute a USD
  // equivalent so subscription users have a meaningful number.
  //
  // Model rates live in proxy/modules/cost.js — single source of truth so
  // Opus 4.7's input/output split, Haiku 4.5's discount, etc. all stay
  // accurate as that table evolves. We import RATES + rateFor and apply
  // per-kind logic:
  //   gemcache:hit       → both input AND output saved (full request +
  //                        response skipped). Use (in + out) / 2 as a
  //                        conservative average; in-vs-out ratio for
  //                        cached requests skews toward input but we
  //                        don't track the split per-row yet.
  //   gemcache:populate  → counted as savings_ledger row for instrumentation
  //                        but NOT a real saving (we populated, not hit).
  //                        Don't credit USD for it.
  //   context_filter,
  //   compaction,
  //   hashline,
  //   bash_compression   → input tokens dropped from prompt. Input rate.
  //   default            → input rate (conservative).
  //
  // Baseline model: resolved once at the top of this function (operator's
  // config `baseline_model`, else Sonnet 4.6) and shared with the spend
  // comparison above, so both sections price against the same model.
  // Look up the real per-model rate via cost.js (USD per 1M tokens).
  let _rate;
  try { _rate = require('../proxy/modules/cost.js').rateFor(tokens_saved_baseline_model); }
  catch (_) { _rate = null; }
  // Fallback if cost.js doesn't resolve the model.
  if (!_rate) _rate = { in: 3.00, out: 15.00, cached_in: 0.30 };
  const rateInputPer1M  = _rate.in  || 0;
  const rateOutputPer1M = _rate.out || 0;
  function _kindRate(kind, rateIn, rateOut) {
    // Credit $ only to kinds whose tokens would otherwise reach the model's
    // BILLED context. Cache writes and event counters are instrumented but
    // mint nothing — writing a cache or counting an event saves no billed
    // token.
    //   gemcache:hit  → request + response both skipped → average in+out rate.
    if (kind === 'gemcache:hit') return (rateIn + rateOut) / 2;
    //   Prompt-token reductions, priced at the input rate. output_archive
    //   belongs here: archived output is REMOVED from the live window, and
    //   the window is re-sent as input with every subsequent request — one
    //   pass at the input rate is the conservative price, not an inflation.
    //   (Priced at zero it made the dashboard pair 216M "tokens saved" with
    //   $17 — two numbers describing different sets.)
    if (kind === 'mcp_cache:hit' ||
        kind === 'context_filter' ||
        kind === 'bash_compression' ||
        kind === 'hashline_edit_applied' ||
        kind === 'output_archive' ||
        kind === 'compaction') return rateIn;
    // gemcache:populate (a cache WRITE, not a hit), verifyfirst_blocked /
    // loopbreaker_denied / editmatch_rescued / test (event counters, not
    // tokens) — counted in the ledger, priced at nothing.
    return 0;
  }
  let tokens_saved_usd_equiv = 0;
  // tokens_saved_billable = the tokens that produced the $ equiv (kinds where
  // _kindRate > 0). tokens_saved_total additionally counts cache writes and
  // event counters, so the dashboard pairs THIS count with the $ — one set
  // of tokens, one valuation.
  let tokens_saved_billable = 0;
  // Priced set split by resolved model — the dashboard's rate label and the
  // per-model lines in the $ split read from this.
  const tokens_saved_by_model = {};
  let _rateForFn = null;
  try { _rateForFn = require('../proxy/modules/cost.js').rateFor; } catch (_) {}
  for (const r of savingsRows) {
    const resolved = r.model || (r.session_id && sessionModel[r.session_id]) || null;
    const mr = (resolved && _rateForFn) ? _rateForFn(resolved) : null;
    const kr = _kindRate(r.kind, (mr && mr.in) || rateInputPer1M, (mr && mr.out) || rateOutputPer1M);
    if (kr > 0) {
      tokens_saved_billable += (r.tokens || 0);
      const label = mr ? resolved : tokens_saved_baseline_model;
      const slot = tokens_saved_by_model[label] || (tokens_saved_by_model[label] = { tokens: 0, usd: 0 });
      slot.tokens += (r.tokens || 0);
      slot.usd += (r.tokens || 0) / 1_000_000 * kr;
    }
    tokens_saved_usd_equiv += (r.tokens || 0) / 1_000_000 * kr;
  }
  for (const k of Object.keys(tokens_saved_by_model)) {
    tokens_saved_by_model[k].usd = +tokens_saved_by_model[k].usd.toFixed(6);
  }
  tokens_saved_usd_equiv = +tokens_saved_usd_equiv.toFixed(6);

  // ── overview ──────────────────────────────────────────────────────────
  const overview = {
    tokens_removed,
    tokens_removed_carried,
    removal_events,
    removal_turns_avg: removal_events ? Math.round(removal_turns / removal_events) : 0,
    removal_sessions,
    removal_carried_estimated,
    api_cost_total: +api_cost_total.toFixed(6),
    cache_saving_usd: +cache_saving_usd.toFixed(6),
    total_saved_usd: +(cache_saving_usd + Math.max(0, api_cost_total - actual_usd_spent) + tokens_saved_usd_equiv).toFixed(6),
    tokens_used_input,
    tokens_used_output,
    tokens_used_cached,
    tokens_used_total: tokens_used_input + tokens_used_output,
    tokens_saved_total,
    tokens_saved_billable,
    tokens_saved_by_kind,
    tokens_saved_by_model,
    estimated_usd_saved,
    actual_usd_spent,
    baseline_usd,
    savings_percent,
    requests_billed,
    // autonomous-mode step — additional surfaces so the dashboard can show meaningful
    // savings to subscription users (no baseline_cost_events) when token
    // savings exist via gemcache / MCP cache / etc.
    tokens_saved_usd_equiv,
    tokens_saved_baseline_model,
    tokens_saved_baseline_rate_input_per_1m:  rateInputPer1M,
    tokens_saved_baseline_rate_output_per_1m: rateOutputPer1M
  };

  // ── performance: aggregate cache hit latencies + per-provider request count ─
  // Cache hit p50/p95 across all MCP tools (only hit rows count — misses
  // mix in real I/O which inflates).
  const hitLats = db.prepare(
    `SELECT latency_ms FROM mcp_tool_calls
     WHERE ts >= ? AND ts <= ? AND cache_hit = 1` + sessFilter +
    ` ORDER BY latency_ms`
  ).all(w.from_ts, w.to_ts).map(r => r.latency_ms || 0);
  const missLats = db.prepare(
    `SELECT latency_ms FROM mcp_tool_calls
     WHERE ts >= ? AND ts <= ? AND cache_hit = 0 AND error_message IS NULL` + sessFilter +
    ` ORDER BY latency_ms`
  ).all(w.from_ts, w.to_ts).map(r => r.latency_ms || 0);
  const performance = {
    cache_hit_p50_ms:  pct(hitLats, 50),
    cache_hit_p95_ms:  pct(hitLats, 95),
    cache_miss_p50_ms: pct(missLats, 50),
    cache_miss_p95_ms: pct(missLats, 95),
    hit_samples:  hitLats.length,
    miss_samples: missLats.length
  };

  return {
    window: w,
    daily,
    overview,
    surfaces,
    providers,
    cacheratio,
    performance,
    health: {
      // Persisted errors (window-scoped) take precedence; in-memory
      // errortax.byClass is shown as a live snapshot for current proxy
      // process (resets on restart).
      errors_by_module,
      errors_live_byClass: errortax ? errortax.byClass || {} : {},
      degraded
    }
  };
}

module.exports = { getAnalytics, windowBounds, WINDOWS, sessionTimeline };
