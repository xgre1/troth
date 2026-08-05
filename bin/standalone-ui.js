// SPDX-License-Identifier: AGPL-3.0-only
// Standalone UI server for plugin-only mode.
//
// The existing dashboard (proxy/ui/dashboard.html) hits /api/stats,
// /api/config, /api/runs and ~14 other endpoints that only the full
// proxy can serve. When a user is running Mode A (plugin only, no
// proxy), they still deserve a dashboard — so this mini-server
// serves plugin-dashboard.html plus just two read-only endpoints
// backed by ~/.troth/state.db: /api/state and /api/mode.
//
// Spawned from `troth ui --standalone` on port 9999 (configurable
// via GF_STANDALONE_PORT). Exits when you Ctrl-C it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// The plugin writes to $CLAUDE_PLUGIN_DATA, which Claude Code sets to
// ~/.claude/plugins/data/<plugin-id>/ when a hook fires. When the user
// launches `troth ui --standalone` outside of Claude Code, that env
// var is absent, so state.js falls back to ~/.troth/state.db — a
// different, empty file. Auto-detect the plugin DB so the dashboard
// actually shows the data the user is generating.
if (!process.env.CLAUDE_PLUGIN_DATA) {
  const pluginDb = path.join(os.homedir(), '.claude', 'plugins', 'data', 'troth-troth-local', 'state.db');
  if (fs.existsSync(pluginDb)) {
    process.env.CLAUDE_PLUGIN_DATA = path.dirname(pluginDb);
  }
}

const state = require(path.resolve(__dirname, '..', 'shared-core', 'state.js'));
// Substrate layers (product gap 5 — UI exposes what Phase A-E shipped)
const actionRecord = require(path.resolve(__dirname, '..', 'shared-core', 'action-record.js'));
const causality    = require(path.resolve(__dirname, '..', 'shared-core', 'causality.js'));
const workingSet   = require(path.resolve(__dirname, '..', 'shared-core', 'working-set.js'));
const market       = require(path.resolve(__dirname, '..', 'shared-core', 'market.js'));

const PORT = parseInt(process.env.GF_STANDALONE_PORT || '9999', 10);
const BIND = process.env.GF_STANDALONE_BIND || '127.0.0.1';
const HTML_PATH = path.resolve(__dirname, '..', 'proxy', 'ui', 'plugin-dashboard.html');

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function handleApiState(req, res) {
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const since = parseInt(urlObj.searchParams.get('since') || '0', 10) || undefined;
    const payload = state.getStats(since);
    send(res, 200, JSON.stringify(payload), 'application/json');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function handleApiMode(req, res) {
  try {
    const presence = state.isPluginActive();
    // "Proxy up" in this context = another server on :8000 accepting
    // connections. Probe with a short timeout; tolerate failure.
    probeProxy().then(function (up) {
      const last = presence.last_seen_ts
        ? new Date(presence.last_seen_ts).toISOString()
        : null;
      send(res, 200, JSON.stringify({
        plugin: presence.active,
        proxy: up,
        last_seen: last
      }), 'application/json');
    });
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function probeProxy() {
  return new Promise(function (resolve) {
    const req = http.request({ host: '127.0.0.1', port: 8000, path: '/api/stats', method: 'GET', timeout: 500 }, function (r) {
      resolve(r.statusCode >= 200 && r.statusCode < 500);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.end();
  });
}

const server = http.createServer(function (req, res) {
  const url = req.url.split('?')[0];
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && (url === '/' || url === '/ui' || url === '/ui/')) {
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      send(res, 200, html, 'text/html; charset=utf-8');
    } catch (e) {
      send(res, 500, 'Dashboard HTML missing at ' + HTML_PATH + ' — reinstall the plugin.');
    }
    return;
  }
  if (isRead && url === '/api/state')              return handleApiState(req, res);
  if (isRead && url === '/api/mode')               return handleApiMode(req, res);
  // Substrate visibility (Phase A-E): let the HTML dashboard show what
  // the unified store actually contains. Every endpoint is read-only.
  if (isRead && url === '/api/substrate/actions')  return handleActions(req, res);
  if (isRead && url === '/api/substrate/counts')   return handleCounts(req, res);
  if (isRead && url.startsWith('/api/substrate/trace/')) return handleTrace(req, res);
  if (isRead && url === '/api/substrate/sessions') return handleSessions(req, res);
  if (isRead && url === '/api/substrate/market')   return handleMarket(req, res);
  if (isRead && url === '/health')                 return send(res, 200, 'ok\n');
  send(res, 404, 'standalone viewer serves / , /api/state , /api/mode , /api/substrate/{actions,counts,trace,sessions,market}');
});

// ── Substrate handlers (product gap 5) ────────────────────────────────────

function handleActions(req, res) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const filter = {
      type:       u.searchParams.get('type')       || undefined,
      session_id: u.searchParams.get('session')    || undefined,
      cwd:        u.searchParams.get('cwd')        || undefined,
      limit:      parseInt(u.searchParams.get('limit') || '50', 10)
    };
    const rows = (state.queryActions(filter) || []).map(actionRecord.fromRow);
    send(res, 200, JSON.stringify({ actions: rows }), 'application/json');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function handleCounts(req, res) {
  try {
    // Aggregate: per type, lifetime + 24h. Plus a few substrate-health
    // signals the dashboard exposes as top-line cards (precedent hits,
    // parent_id coverage, verified-edit count).
    const counts = {
      total: state.countActions({}),
      by_type: {}
    };
    for (const t of actionRecord.ALL_TYPES) {
      counts.by_type[t] = state.countActions({ type: t });
    }

    // Quality signals — all computed with single SQL probes so this
    // endpoint stays under 50ms even at 100K rows.
    try {
      const db = state._dbForQuery && state._dbForQuery();
      if (db) {
        const h24 = Date.now() - 24 * 3600 * 1000;
        counts.last_24h = db.prepare(
          'SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ?'
        ).get(h24).n;
        counts.parent_id_coverage = db.prepare(
          'SELECT SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS r FROM action_records'
        ).get().r || 0;
        counts.precedent_hits_24h = db.prepare(
          "SELECT COUNT(*) AS n FROM action_records " +
          "WHERE timestamp >= ? AND type='decision' " +
          "  AND json_extract(input,'$.kind')='context_injection' " +
          "  AND CAST(json_extract(input,'$.precedent_count') AS INTEGER) > 0"
        ).get(h24).n;
        counts.verified_edits = db.prepare(
          "SELECT COUNT(*) AS n FROM action_records " +
          "WHERE type='edit' AND json_extract(verification,'$.ast.ok') = 1"
        ).get().n;
        counts.compacts_lifetime = db.prepare(
          "SELECT COUNT(*) AS n FROM action_records WHERE type='compact'"
        ).get().n;
      }
    } catch (_) { /* skip probes on older DBs */ }

    send(res, 200, JSON.stringify(counts), 'application/json');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function handleTrace(req, res) {
  try {
    const id = decodeURIComponent(req.url.replace('/api/substrate/trace/', '').split('?')[0]);
    if (!id) return send(res, 400, JSON.stringify({ error: 'missing action id' }), 'application/json');
    const chain = causality.traceCausalChain(state, id) || [];
    const descendants = causality.getDescendants(state, id, { maxNodes: 100 }) || [];
    send(res, 200, JSON.stringify({ chain, descendants }), 'application/json');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function handleSessions(req, res) {
  try {
    // List active working-set sessions (in-process state). Useful to see
    // what pages are resident, pinned, and how close to the budget the
    // current session is running.
    const sessions = [];
    // No enumeration API yet; return an explanatory object so callers
    // can query per-session manifests via a future endpoint when one
    // exists. For now, report the default session if present.
    const defaultSess = workingSet.getSession('default');
    if (defaultSess) sessions.push(workingSet.manifest('default'));
    send(res, 200, JSON.stringify({
      note: 'working-set sessions are in-process; enumerate via direct SQL on action_records where type=compact for historical view',
      active: sessions
    }), 'application/json');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function handleMarket(req, res) {
  try {
    const stats = market.analyzeWinners(state);
    send(res, 200, JSON.stringify({ agents: stats }), 'application/json');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('[troth ui] Port ' + PORT + ' is busy. Set GF_STANDALONE_PORT to override.');
    process.exit(1);
  }
  throw err;
});

process.title = 'troth-standalone-' + PORT;

server.listen(PORT, BIND, function () {
  console.log('troth standalone viewer ready');
  console.log('  http://' + BIND + ':' + PORT + '/');
  console.log('  Reading from: ' + state.DB_PATH);
  console.log('  Ctrl-C to stop.');
});

process.on('SIGINT',  function () { server.close(function () { process.exit(0); }); });
process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
