// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Project-dir normalization, BEFORE any module below computes its
// projectDir. The desktop app spawns this proxy with cwd inside the
// signed.app bundle and no GF_WATCH_DIR; eight modules treat
// GF_WATCH_DIR || cwd as "the project dir", and the ones that persist
// state then wrote.troth/workflow.json INTO the bundle, adding a file
// the code seal does not list (found: the installed app
// failed codesign --verify with "file added"). The inside of a bundle
// is never a project; the operator's home is the stable stand-in, and
// <home>/.troth is exactly where the rest of troth keeps its state.
// Dev and CLI spawns pass a real project cwd and are untouched.
(() => {
  const raw = process.env.GF_WATCH_DIR || process.cwd();
  if (/\.app\/Contents\//.test(path.resolve(raw))) {
    process.env.GF_WATCH_DIR = require('os').homedir();
    return;
  }
  // A cwd inside a repository means the project is the repository, not the
  // directory the operator happened to be standing in. The indexer prunes
  // whatever is not under its root, so a proxy started in a subdirectory cut
  // the project's index down to that subdirectory's files. An explicit
  // GF_WATCH_DIR is an operator's answer to this question and is left alone.
  if (!process.env.GF_WATCH_DIR) {
    try {
      const root = require('../shared-core/project-id.js').projectRootFor(raw);
      if (root && root !== path.resolve(raw)) process.env.GF_WATCH_DIR = root;
    } catch (_) { /* no git, no repo, nothing to correct */ }
  }
})();

// Process boot timestamp (ms epoch). Surfaced via /api/logs and /api/stats
// so the dashboard can detect a restart and reset its log-cursor — without
// this, post-restart polling sends `since=lastTs` greater than every entry
// in the new process's empty buffer and the filter returns [] forever.
const PROCESS_STARTED_AT = Date.now();

// Memory self-test state for /api/embed/status. Process-lifetime, so the
// proving embed runs at most once per proxy and a status poll never blocks
// on the ~30s first in-process model load.
let _embedVerified = null;
let _embedVerifyStarted = false;

// Start the proving embed at most once per proxy. Kept as a function because
// TWO endpoints report `verified` (/api/embed/status and /api/setup/local) and
// an endpoint that reports a field must be able to produce it: while only the
// first one started the self-test, any surface polling the other alone showed
// "not verified" forever, and the dashboard only worked because it happens to
// poll both. Same class as the config bugs — never depend on a sibling call
// having been made.
function kickEmbedVerify() {
  if (_embedVerifyStarted) return;
  _embedVerifyStarted = true;
  try {
    require("../shared-core/local-embedder.js")
      .embed("troth memory self-test", { wait: true })
      .then(function (v) { _embedVerified = !!(v && v.length); })
      .catch(function () { _embedVerified = false; });
  } catch (_) { _embedVerified = false; }
}

// Secret redactor — loaded first so the console wrapper below can scrub
// credentials out of every log line (and the ring buffer surfaced via
// /api/logs) before they hit disk or screen. Pure-function module, no
// side effects, safe to require before the console instrumentation.
const secrets = require('./modules/secrets');

// Log ring buffer — must be before module requires to capture init logs.
// Every line is run through secrets.redact() so API keys, Bearer tokens,
// JWTs, etc. that leak into log strings get masked before they're stored
// in the buffer or printed to stdout.
const logBuffer = [];
const MAX_LOG_LINES = 200;
const _origLog = console.log;
const _origErr = console.error;
console.log = function(...args) {
  const line = secrets.redact(args.map(String).join(' '));
  logBuffer.push({ ts: Date.now(), type: 'info', msg: line });
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  _origLog.call(console, line);
};
console.error = function(...args) {
  const line = secrets.redact(args.map(String).join(' '));
  logBuffer.push({ ts: Date.now(), type: 'error', msg: line });
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  _origErr.call(console, line);
};

// Self-heal the service log's permissions at boot. launchd created
// ~/.troth/service.log with a default umask — 644, world-readable — while
// every sibling secret file is 600. The console redactor above keeps
// secrets out of the CONTENT on the happy path; the mode must hold even
// when it misses. service.js now pre-creates it 600 on install; this covers
// machines whose log predates that fix, on the next proxy start.
try {
  const _svcLog = require('path').join(require('os').homedir(), '.troth', 'service.log');
  if (require('fs').existsSync(_svcLog)) require('fs').chmodSync(_svcLog, 0o600);
} catch (_) { /* perms heal is best-effort */ }

const http = require('http');
const { inject } = require('./modules/injector');
const { cleanResponse } = require('./modules/cleaner');
const { compressRequest, compressResponse } = require('./modules/compressor');
const cachestable = require('./modules/cachestable');
const trothCache = require('./modules/troth-cache');
const keepalive = require('./modules/keepalive');
const keepaliveMgr = keepalive.createManager();
const { guard, getStats: guardianStats } = require('./modules/guardian');
const { checkPinning, getStats: pinningStats } = require('./modules/pinning');
const { checkLoop, getStats: loopStats } = require('./modules/loopguard');
const { getStats: cacheStats, init: initCache } = require('./modules/hotcache');
const { initIndex, queryContext, getArchitectureOverview, getStats: codeLensStats } = require('./modules/codelens');
const { callFallbackChain, callAnthropic, handleCompaction, preprocessAnthropicBody, scaleTokens, scaleUsage, scaleUsageInSSE, believedContextWindow, forwardToLocal, getStats: routerStats, getProviders, getRoutingPrefs, loadProviders, generatePlan, injectPlan, continueIfTruncated } = require('./modules/router');
const { augmentToolResults } = require('./modules/vision');
const scheduler = require('./modules/scheduler');
// Closed-extension routes (private overlay; absent on a public clone).
const mcpRoutes = require('./modules/mcp-routes');
const _closedRoutes = (function(){ try { return require('./modules/l4-routes.js'); } catch (_) { return null; } })();
const { resolveAgentId } = require('../shared-core/agent-id');

// Write the DISTINCT pinned-engine fail-fast response when callFallbackChain
// filled fbOpts.pinFailure. Returns true if it wrote (caller must return),
// false if there was no pin failure (caller continues to generic handling).
//
// The status is 400 by design: upstream CLIs (the claude CLI riding
// ANTHROPIC_BASE_URL) treat 400 as fatal and surface it to the operator
// immediately, whereas 5xx/429 trigger their exponential-backoff retry loop.
// Before this, a pinned engine that 429'd (plan cap) resolved to a generic
// 503 all_providers_unavailable and the operator stared at ~128s of silence
// The body is shaped like an Anthropic
// error so the CLI renders the message verbatim: it names the pinned engine,
// the reason, and the way out.
function writePinFailure(res, fbOpts) {
  const pf = fbOpts && fbOpts.pinFailure;
  if (!pf || !pf.set) return false;
  try { stats.errors++; } catch (_) {}
  try { log('Pinned engine ' + pf.provider + ' failed closed (' + pf.reason + '), returning 400 fail-fast'); } catch (_) {}
  if (!res.headersSent) {
    const payload = JSON.stringify(pf.body);
    res.writeHead(pf.status || 400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }
  return true;
}

// Read backend host/port from env (set by troth CLI) or fall back
// to config (for manual `node proxy/server.js` restarts).
function getBackendConfig() {
  if (process.env.GF_BACKEND_HOST) return { host: process.env.GF_BACKEND_HOST, port: parseInt(process.env.GF_BACKEND_PORT || '1234') };
  try {
    var home = process.env.HOME || require('os').homedir();
    var cfg = JSON.parse(fs.readFileSync(path.join(home, '.troth', 'config.json'), 'utf8'));
    return { host: cfg.backendHost || '127.0.0.1', port: cfg.backendPort || 1234 };
  } catch (e) { return { host: '127.0.0.1', port: 1234 }; }
}
const _backend = getBackendConfig();
const BACKEND_HOST = _backend.host;
const BACKEND_PORT = _backend.port;
const PORT = parseInt(process.env.GF_PORT || '8000');
// A proxy spawned by a test runner must not outlive it. SIGKILL leaves no
// chance for teardown, so the child polls: parent gone → exit. Interval only
// exists when the env is set — production proxies never pay for it.
if (process.env.TROTH_EXIT_WITH_PID) {
  const guardPid = parseInt(process.env.TROTH_EXIT_WITH_PID, 10);
  if (guardPid > 0) {
    const t = setInterval(() => {
      try { process.kill(guardPid, 0); } catch (_) { process.exit(0); }
    }, 10000);
    t.unref();
  }
}
// What this process was born from — compared against the disk by /api/version
// so a page served after a pull can tell the operator the routes are older.
let BOOT_SRC_HASH = null;
try { BOOT_SRC_HASH = require('crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12); } catch (_) {}
// Actual bind port — set by the listen retry loop on EADDRINUSE so a
// stale local server on:8000 doesn't crash a fresh `troth run`.
let listenPort = PORT;
const WATCH_DIR = process.env.GF_WATCH_DIR || process.cwd();

// Identifiable process title so `ps aux | grep troth-proxy` shows the
// port this instance is bound to. Lets `troth clean --stuck` tell a
// healthy primary apart from a sibling test instance that was forgotten.
// Re-stamped after a successful listen() so collisions reflect reality.
process.title = 'troth-proxy-' + PORT;
// Single source of truth — read from the package's own package.json
// so version bumps only need to happen in one place.
const VERSION = require('../package.json').version;
// mtime of THIS file at boot — see the health-payload build provenance note.
const PROXY_BUILD = (() => { try { return Math.trunc(require('fs').statSync(__filename).mtimeMs); } catch (_) { return 0; } })();
const HOME = process.env.HOME || require('os').homedir();
// Same file the config store writes to, TROTH_CONFIG_PATH included — reading a
// hardcoded path here while writes honoured the override split the two apart.
const CONFIG_FILE = (() => {
  try { return require('../shared-core/config-file.js').configPath(); }
  catch (_) { return path.join(HOME, '.troth', 'config.json'); }
})();
// The ONE write path for CONFIG_FILE (strict read + atomic replace); every
// endpoint that persists config routes through this. See config-file.js.
const configFileStore = require('../shared-core/config-file.js');

// Bind host — defaults to 127.0.0.1 for security.
// Set GF_BIND_HOST=0.0.0.0 to expose on all interfaces (required for remote access via Tailscale/LAN).
function getBindHost() {
  if (process.env.GF_BIND_HOST) return process.env.GF_BIND_HOST;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.bindHost) return cfg.bindHost;
  } catch (e) {}
  return '127.0.0.1';
}
const BIND_HOST = getBindHost();

// Per-request module toggle check. Read fresh each call so the dashboard
// switches take effect without a proxy restart. Missing config, missing
// `modules` key, or missing specific module key all default to ENABLED —
// nothing changes for users who never touch the switches.
function isModuleEnabled(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.modules || typeof cfg.modules !== 'object') return true;
    return cfg.modules[name] !== false;
  } catch (e) {
    return true;
  }
}

// Real $ spent through the proxy since `sinceTs`, priced at read time from
// usage_ledger rows (one per completed request, every lane) via cost.js.
// baseline_cost_events is NOT used here: its writers sit on dead lanes
//, and flat-plan subscription rows genuinely price $0.
function ledgerSpendSince(sinceTs) {
  try {
    const rows = require('../shared-core/state').db().prepare(
      'SELECT model, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout, ' +
      'COALESCE(SUM(cached_in),0) AS cin FROM usage_ledger WHERE ts >= ? GROUP BY model'
    ).all(sinceTs);
    const costMod = require('./modules/cost');
    let usd = 0;
    for (const r of rows) usd += costMod.calculateCost(r.model, r.tin, r.tout, r.cin).cost;
    return +usd.toFixed(6);
  } catch (_) { return 0; /* table absent on fresh substrate */ }
}
// Cache dashboard HTML
let dashboardHTML = null;
const dashboardPath = path.join(__dirname, 'ui', 'dashboard.html');

// v6.2 — Remote run dispatch API. The /api/runs endpoints let a
// laptop CLI POST a task to a remote troth daemon (e.g. remote server
// over Tailscale) and have the daemon spawn the worker container on
// its own host. The endpoints are gated by a shared bearer token
// stored in ~/.troth/config.json. If the token is missing on
// daemon startup, one is auto-generated and printed to the log.
function loadOrCreateRemoteToken() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
  if (cfg.remoteToken && typeof cfg.remoteToken === 'string' && cfg.remoteToken.length >= 16) {
    return cfg.remoteToken;
  }
  // Auto-generate
  const token = require('crypto').randomBytes(24).toString('base64url');
  // Persist through the single-writer path. It REFUSES (throws) when the
  // file exists but does not parse, so a torn/corrupt config.json can no
  // longer be reset to {remoteToken} on daemon startup (which erased every
  // other field. Fall back to an ephemeral token for this run.
  try {
    configFileStore.patchConfig({ remoteToken: token });
  } catch (e) {
    console.error('[remote] NOT persisting remote token (config protected):', e.message);
    console.error('[remote] Using an ephemeral token for this run.');
  }
  return token;
}
const REMOTE_TOKEN = loadOrCreateRemoteToken();

// Follow-a-mind state for the dashboard (satellite side), plus the tiny
// JSON client the knock-to-pair flow uses toward the other machine.
let _syncFollow = null;
function _syncHttpJson(host, port, method, pathName, body, cb) {
  try {
    const data = body == null ? null : JSON.stringify(body);
    const q = require('http').request({
      host, port, method, path: pathName, timeout: 8000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (r2) => {
      let b = '';
      r2.setEncoding('utf8');
      r2.on('data', (c) => { b += c; if (b.length > 1e6) q.destroy(); });
      r2.on('end', () => { try { cb(JSON.parse(b)); } catch (_) { cb(null); } });
      r2.on('error', () => cb(null));
    });
    q.on('error', () => cb(null));
    q.on('timeout', () => { q.destroy(); cb(null); });
    if (data) q.write(data);
    q.end();
  } catch (_) { cb(null); }
}

// Lazy require so the runner is only loaded when the daemon actually
// receives an /api/runs request — keeps proxy startup lean for users
// who don't use remote dispatch at all.
function getRunner() {
  try { return require('../bin/runner.js'); }
  catch (e) {
    console.error('[remote] Failed to load runner:', e.message);
    return null;
  }
}

// Is this loopback request coming from the operator's own tooling, or from a
// web page they happen to have open?
//
// Being on 127.0.0.1 proves nothing about who asked. Any site the user visits
// can POST to http://localhost:<port>/api/... from their browser, and the
// request arrives on loopback like everything else. With no check, a visited
// page could erase the substrate or, after a DNS rebind (attacker hostname
// re-resolved to 127.0.0.1, which makes the page same-origin), read stored
// API keys straight out of /api/config/reveal.
//
// Three signals separate a browser from a program, and a browser cannot forge
// any of them cross-origin:
//   Sec-Fetch-Site  set by the browser on every fetch/XHR/navigation, and
//                   unsettable from JavaScript.
//   Origin          present on cross-origin requests; absent for curl and CLIs.
//   Host            still carries the ATTACKER's hostname during a rebind,
//                   which is what catches the one attack the first two miss.
// Programs (the CLI, the in-process MCP server, curl) send none of them, so
// they keep working untouched.
function isBrowserDrivenFromElsewhere(req) {
  const h = req.headers || {};

  const site = String(h['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return true;

  const origin = String(h['origin'] || '');
  if (origin) {
    let host;
    try { host = new URL(origin).hostname; } catch (_) { return true; }
    if (!LOOPBACK_NAMES.has(host)) return true;
  }

  // Anti-rebinding: strip the port, and the brackets IPv6 literals arrive in.
  const hostHeader = String(h['host'] || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostHeader && !LOOPBACK_NAMES.has(hostHeader)) return true;

  return false;
}
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function checkRemoteAuth(req) {
  // A valid bearer token is deliberate remote access and settles the question,
  // so it is checked first: a token holder on Tailscale/LAN is not a browser
  // that wandered in, and their Host header is legitimately not loopback.
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === REMOTE_TOKEN) return true;

  // Loopback bypass, so the dashboard and the in-process MCP server do not
  // juggle tokens in JavaScript. There is deliberately NO network-range
  // bypass: a shared tailnet is not a trust boundary, so remote control
  // (goals/chat/config/credentials) is token-gated, never IP-gated. (The
  // 100.64.0.0/10 CGNAT auto-trust was removed; the browser check
  // below was added  after a probe drove three endpoints from a
  // cross-origin page.)
  const remoteAddr = (req.socket && req.socket.remoteAddress) || '';
  const rawIp = remoteAddr.replace('::ffff:', '');
  const onLoopback = (rawIp === '127.0.0.1' || remoteAddr === '::1');
  if (onLoopback && !isBrowserDrivenFromElsewhere(req)) return true;

  return false;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1024 * 1024) { resolve(null); req.destroy(); }});
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

initCache(WATCH_DIR);

// Project indexing does NOT gate the port. It used to run here, at module
// scope, so the whole walk finished before server.listen() was ever reached:
// on a clean machine the dashboard was unreachable for 75 seconds and looked
// broken, and the desktop app aims this at the operator's entire home
// directory. Nothing serves the first request any better for having waited —
// queryContext() returns an empty repo map until the index exists, which costs
// a hint, not an answer. Called from the listen callback below.
//
// The module switch is honoured HERE, not only where the index is read: with
// codelens turned off this still spent 8777ms building an index that every
// query then refused to use.
function startProjectIndexing() {
  if (isModuleEnabled('codelens')) {
    // initIndex is async and yields between chunks; a rejection here must not
    // become an unhandled one, and a failed index is a missing hint, not a
    // failed boot.
    Promise.resolve()
      .then(() => initIndex(WATCH_DIR))
      .catch((e) => console.log('[CodeLens] Init skipped:', e && e.message || e));
  } else {
    log('CodeLens: off — not indexing ' + WATCH_DIR);
  }
  // cochange and buildgraph shell out to git and are fully synchronous, so
  // they hold the loop exactly as the index used to. Deferred by a tick each
  // so the first paint of the dashboard lands before git is asked anything,
  // and timed, because "boot is slow" is not a diagnosis.
  setTimeout(() => {
    const t = Date.now();
    try { require('./modules/cochange').init(WATCH_DIR); } catch (e) {}
    const c = Date.now() - t;
    setTimeout(() => {
      const t2 = Date.now();
      try { require('./modules/buildgraph').init(WATCH_DIR); } catch (e) {}
      log('Project history: co-change ' + c + 'ms, build graph ' + (Date.now() - t2) + 'ms');
    }, 0);
  }, 0);
}

const stats = {
  requests: 0, injected: 0, cleaned: 0, verified: 0,
  syntaxErrors: 0, compressed: 0, errors: 0,
  startedAt: new Date().toISOString(),
};

// Persistent stats ledger — counters survive proxy restart.
// Before this, every restart zero'd the dashboard. Stored in the proxy's
// own state.db (~/.troth/state.db), single-row-per-counter shape.
const STATS_KEYS = ['requests', 'injected', 'cleaned', 'verified', 'syntaxErrors', 'compressed', 'errors'];
let _statsDb = null;
function _statsDbGet() {
  if (_statsDb) return _statsDb;
  try {
    const Database = require('better-sqlite3');
    const HOME = process.env.HOME || require('os').homedir();
    const dbPath = path.join(HOME, '.troth', 'state.db');
    try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (_) {}
    _statsDb = new Database(dbPath);
    _statsDb.exec("CREATE TABLE IF NOT EXISTS proxy_counter_totals (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    return _statsDb;
  } catch (e) { return null; }
}
function loadStatsFromDisk() {
  const db = _statsDbGet(); if (!db) return;
  try {
    const rows = db.prepare("SELECT key, value FROM proxy_counter_totals WHERE key IN (" + STATS_KEYS.map(() => '?').join(',') + ")").all(...STATS_KEYS);
    for (const r of rows) if (STATS_KEYS.includes(r.key)) stats[r.key] = r.value;
    console.log('[stats] loaded from disk:', STATS_KEYS.map(k => k + '=' + stats[k]).join(' '));
  } catch (e) { console.log('[stats] load failed:', e.message); }
}
function flushStatsToDisk() {
  const db = _statsDbGet(); if (!db) return;
  try {
    const up = db.prepare("INSERT INTO proxy_counter_totals(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    const tx = db.transaction((pairs) => { for (const [k, v] of pairs) up.run(k, v); });
    tx(STATS_KEYS.map(k => [k, stats[k] | 0]));
  } catch (e) { /* telemetry must not break the proxy */ }
}
loadStatsFromDisk();
setInterval(flushStatsToDisk, 30000).unref();
// Prune expired tool-response cache rows on a timer. sweepExpired() existed but
// was only called lazily inside lookup() — and since cache hits are rare, expired
// rows accumulated (14K+ / ~110MB observed) and bloated the shared state.db,
// slowing every substrate query that shares the handle. Sweep every 10 min so
// the cache self-prunes instead of growing unbounded.
setInterval(() => {
  try {
    const n = trothCache.getDefault().sweepExpired();
    if (n) log(`GEMCACHE-SWEEP | pruned ${n} expired tool-cache rows`);
  } catch (e) {}
}, 600000).unref();
//  consolidated SIGINT/SIGTERM handler. Flushes stats AND
// unlinks the PID file (proxy-{port}.pid) so bin/troth.js's
// cleanOrphanSiblings scan never sees stale state. Multiple handlers
// for the same signal fire all together, but the FIRST one to call
// process.exit() wins — keep this as the single registration to make
// sure the unlink happens before exit.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  flushStatsToDisk();
  try {
    const fsP = require('fs');
    const pathP = require('path');
    const HOME_P = process.env.HOME || require('os').homedir();
    fsP.unlinkSync(pathP.join(HOME_P, '.troth', 'proxy-' + listenPort + '.pid'));
  } catch (_) { /* missing file = nothing to clean */ }
  process.exit(0);
});

// Runtime routing override — 'auto' | 'fallback' | 'local' | 'smart' | 'anthropic'.
// Set by POST /api/routing. Controls which backend handles each request.
let routingMode = 'auto';

function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg) { console.log('[' + ts() + '] ' + msg); }

function jsonResponse(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return { host: 'localhost', port: PORT, backendHost: BACKEND_HOST, backendPort: BACKEND_PORT }; }
}

// Response pipeline. Each module is gated by isModuleEnabled() so the
// dashboard toggles actually skip the work, not just decorate the UI.
//
// Two lanes controlled by the `isLocal` flag:
//
//   LOCAL  (Gemma 4, local models) — runs the full pipeline.
//          cleaner -> verifier -> guardian -> pinning -> loopguard ->
//          compressor. Local models produce noisy text with
//          model-specific artifacts, broken code blocks, verbose
//          preambles. They benefit from every cleanup pass.
//
//   API    (Anthropic, fallback chain) — runs a SLIM safety pipeline.
//          guardian (dangerous-Bash blocking ONLY, NOT the Write
//          shadow-verify), pinning, loopguard. Skips cleaner/verifier/
//          compressor because API models don't produce the same
//          artifacts that local models do.
function processResponse(responseBody, isRemoteAPI) {
  const events = [];

  if (!isRemoteAPI && isModuleEnabled('cleaner')) {
    const cleaned = cleanResponse(responseBody);
    responseBody = cleaned.body;
    stats.cleaned += cleaned.cleaned;
    if (cleaned.cleaned) events.push('cleaned:' + cleaned.cleaned);
  }

  if (isModuleEnabled('guardian')) {
    // Guardian now only blocks dangerous Bash commands.
    // Shadow-verify removed (broken pattern: mutated assistant message).
    // Validator.js handles Write syntax checking properly.
    const guarded = guard(responseBody);
    responseBody = guarded.body;
    if (guarded.blocked) events.push('BLOCKED');
  }

  if (isModuleEnabled('pinning')) {
    const pinned = checkPinning(responseBody);
    responseBody = pinned.body;
    if (pinned.blocked) events.push('PIN-BLOCKED');
  }

  if (isModuleEnabled('loopguard')) {
    const loop = checkLoop(responseBody, { logOnly: false });
    responseBody = loop.body;
    if (loop.loopDetected) events.push('LOOP-BROKEN');
  }

  // Critic: post-response quality check. Stores feedback for injection
  // into the next request via the injector module.
  try {
    if (isModuleEnabled('critic')) {
      const { criticize } = require('./modules/critic');
      criticize(responseBody);
    }
  } catch (e) {}

  // structured-envelope decomposition. the entity design —
  // routes tagged sections (claim/action/refusal/question/meta) to the
  // right downstream consumer. Logged as decision rows so dashboard +
  // audit can see the structured shape without re-parsing the reply.
  try {
    const env = require('../shared-core/structured-envelope');
    const data = JSON.parse(responseBody);
    const replyText = (data && Array.isArray(data.content))
      ? data.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n')
      : '';
    if (replyText) {
      const parts = env.decompose(replyText);
      const counts = {
        claims:    parts.claims.length,
        actions:   parts.actions.length,
        refusals:  parts.refusals.length,
        questions: parts.questions.length,
        metas:     parts.metas.length
      };
      if (counts.refusals > 0 || counts.questions > 0 || counts.actions > 1) {
        try {
          const state = require('../shared-core/state');
          const ar = require('../shared-core/action-record');
          state.recordAction({
            id: ar.uuidv7(), timestamp: Date.now(),
            type: 'decision', agent_id: 'envelope-router',
            input: { kind: 'envelope_decomposed' },
            output: counts
          }, 'envelope_decomposed');
        } catch (_) {}
      }
    }
  } catch (e) {}

  // Reconciler — the entity design post-output verifier. Pulls
  // active commitments for the current cwd's agent_id and checks the LLM
  // reply against them. On 'block' (hard commitment violated): warns +
  // logs decision row; the next-turn injector picks up the alert. We don't
  // re-prompt synchronously here (would double API cost on every reply);
  // the alert path lets the model self-correct on the following turn.
  try {
    const { reconcile } = require('../shared-core/reconciler');
    const engram = require('../shared-core/engram');
    const data = JSON.parse(responseBody);
    const replyText = (data && Array.isArray(data.content))
      ? data.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n')
      : '';
    if (replyText) {
      //  read identity envelope by scope category, not by
      // agent_id (which is provenance only post-migration).
      const commitments = engram.listEngrams({
        scope: 'identity',
        limit: 50
      }) || [];
      // engram list is flat shape; reconciler expects {output:{commitment_type, statement}}
      const shaped = commitments.map(c => ({
        id: c.id,
        output: { commitment_type: 'anchor', statement: c.statement }
      }));
      const verdict = reconcile(replyText, shaped);
      if (verdict && !verdict.ok) {
        try {
          const state = require('../shared-core/state');
          const ar = require('../shared-core/action-record');
          state.recordAction({
            id: ar.uuidv7(), timestamp: Date.now(),
            type: 'decision', agent_id: 'reconciler',
            input: { kind: 'reconciliation_alert', severity: verdict.severity },
            output: {
              conflict_count: verdict.conflicts.length,
              first_commitment: verdict.conflicts[0] && verdict.conflicts[0].commitment_statement
            }
          }, 'reconciliation_alert');
        } catch (_) {}
      }
    }
  } catch (e) {}

  if (!isRemoteAPI && isModuleEnabled('compressor')) {
    const compressed = compressResponse(responseBody);
    responseBody = compressed.body;
    stats.compressed += compressed.compressed;
  }

  if (events.length) log('RES #' + stats.requests + ' | ' + events.join(' | '));
  return responseBody;
}

// Max wall-clock for any single HTTP request end-to-end. A stuck
// upstream or an infinite retry loop inside a module used to pin this
// process at 100% CPU for hours; the watchdog below kills the request
// and releases the socket. Configurable via env for long benchmarks.
const REQUEST_MAX_MS = parseInt(process.env.GF_REQUEST_MAX_MS || '600000'); // 10 min

const server = http.createServer((req, res) => {
  // Per-request watchdog — forces a 504 and destroys the socket if the
  // handler hasn't finished within REQUEST_MAX_MS. Cleared on finish/close.
  const watchdog = setTimeout(() => {
    if (res.writableEnded) return;
    console.error('[watchdog] ' + req.method + ' ' + req.url + ' exceeded ' + REQUEST_MAX_MS + 'ms — forcing 504');
    try {
      if (!res.headersSent) res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'request_timeout', timeoutMs: REQUEST_MAX_MS }));
    } catch (_) { /* swallow; socket may already be half-closed */ }
    try { req.destroy(); } catch (_) {}
  }, REQUEST_MAX_MS);
  const clearWatchdog = () => clearTimeout(watchdog);
  res.on('finish', clearWatchdog);
  res.on('close', clearWatchdog);
  // The maintenance worker drains ONLY while the operator is quiet — and
  // "quiet" means no WORK, not no polling. The dashboard breathes GETs
  // constantly (stats 5s, logs 3s, connection 10s, readiness 15s), so an
  // open tab would hold the worker hostage forever and the operator
  // WATCHING the frozen numbers would be the one freezing them — a
  // self-freezing gauge, the exact disease this worker cures. Every
  // mutating request (chat turns, imports, saves are POST/PUT/DELETE)
  // counts as foreground; GETs never do. Losing to a concurrent read is
  // a CPU nicety; losing to the gauge is the bug.
  try {
    if (global.__troth_maintenance && req.method !== 'GET') {
      global.__troth_maintenance.noteForegroundActivity();
    }
  } catch (_) {}

  let url = req.url.split('?')[0];
  const query = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : new URLSearchParams();

  // ===== Dashboard UI =====
  // Vendored D3 for the Code Map page (ISC, d3 v7.9.0). Served locally so
  // a local-first tool never needs a CDN to draw its own code map (the old
  // jsdelivr <script> left the page in an endless loading loop offline).
  if (req.method === 'GET' && url === '/ui/vendor/d3.v7.min.js') {
    try {
      const d3src = fs.readFileSync(path.join(__dirname, 'ui', 'vendor', 'd3.v7.min.js'));
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
      res.end(d3src);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('d3 vendor file missing');
    }
    return;
  }
  // /ui/engines, /ui/memory, … all serve the app; the client reads the path
  // and lands on that page. Deep links survive refresh and the back button.
  if (req.method === 'GET' && (url === '/ui' || url === '/ui/' || /^\/ui\/[a-z-]+\/?$/.test(url))) {
    try {
      dashboardHTML = fs.readFileSync(dashboardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(dashboardHTML), 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
      res.end(dashboardHTML);
    } catch (e) {
      res.writeHead(404);
      res.end('Dashboard not found. Create proxy/ui/dashboard.html');
    }
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(302, { 'Location': '/ui' });
    res.end();
    return;
  }

  // ===== PWA manifest + icons =====
  if (req.method === 'GET' && url === '/manifest.json') {
    try {
      const manifest = fs.readFileSync(path.join(__dirname, 'ui', 'manifest.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Content-Length': Buffer.byteLength(manifest) });
      res.end(manifest);
    } catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === 'GET' && (url === '/icon-192.png' || url === '/icon-512.png')) {
    // The PWA/tab icon. This used to read scripts/icon.iconset/icon_128x128.png,
    // a path that exists in no checkout of this repository, so every dashboard
    // visitor got a 404 for their tab icon. Drawn inline
    // instead: an SVG of the wordmark's chrome ring, served under the.png
    // names the manifest already asks for, since every browser that requests
    // these accepts image/svg+xml. Nothing to ship, nothing to go missing.
    // The mark is the wordmark's "t" in the chrome lockup — the same thing the
    // sidebar shows. A ring belonged to no product anyone could name. Drawn as
    // strokes rather than <text> so it does not depend on a font being present.
    const size = url === '/icon-512.png' ? 512 : 192;
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 100 100">'
      + '<rect width="100" height="100" rx="22" fill="#0B0D10"/>'
      + '<g fill="none" stroke="#A8B5C7" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M34 38h32"/><path d="M50 20v40a12 12 0 0 0 15 11"/>'
      + '</g></svg>';
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Length': Buffer.byteLength(icon),
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(icon);
    return;
  }

  // ===== Mode — which side (plugin / proxy) is active right now =====
  // Mirrors the standalone viewer's /api/mode so any dashboard can tell
  // whether proxy modules are skipping themselves because the plugin
  // took over. Cheap: two SQLite reads, no upstream probes.
  // Back-compat aliases. Earlier work referenced these names; keeping them
  // as redirects-by-handler avoids breaking external scripts/dashboards
  // that already point at the old paths.
  // ===== API: slash skill listing (composer "/" autocomplete) =====
  // Execution stays on the normal turn path (the entity intercepts
  // leading-slash user_input); this endpoint only feeds the popup.
  if (req.method === 'GET' && url === '/api/slash/skills') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const slashLoader = require('../shared-core/slash/loader.js');
      jsonResponse(res, 200, { skills: slashLoader.skillSummaries(process.cwd()) });
    } catch (e) {
      jsonResponse(res, 500, { error: String(e && e.message || e) });
    }
    return;
  }
  if (req.method === 'GET' && url === '/api/usage-mode') {
    url = '/api/mode';
  }
  if (req.method === 'GET' && url.startsWith('/api/savings')) {
    url = '/api/cache/ledger' + url.slice('/api/savings'.length);
  }

  if (req.method === 'GET' && url === '/api/mode') {
    try {
      var stateLib = require('../shared-core/state.js');
      var presence = stateLib.isPluginActive();
      var modePayload = {
        plugin: !!presence.active,
        proxy: true, // if you reached this endpoint, proxy is up
        last_seen: presence.last_seen_ts ? new Date(presence.last_seen_ts).toISOString() : null
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modePayload));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ===== Plugin state (unified SQLite, written to by plugin hooks) =====
  // Reads from ~/.troth/state.db so the dashboard can render plugin-origin
  // telemetry (hook activations, savings ledger, tool-output archive) even
  // though the hooks themselves run inside the Claude Code process, not here.
  if (req.method === 'GET' && url === '/api/state') {
    try {
      var state = require('../shared-core/state.js');
      var sinceMs = parseInt(query.get('since') || '0') || undefined;
      var payload = state.getStats(sinceMs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'state_unavailable', message: e.message }));
    }
    return;
  }

  // ===== troth Cache ledger (Phase E) =====
  // Time-bucketed aggregation of cache events from savings_ledger plus
  // current point-in-time cache + keepalive counters. Consumed by the
  // dashboard's troth Cache panel.
  if (req.method === 'GET' && url.startsWith('/api/cache/ledger')) {
    try {
      const _state = require('../shared-core/state.js');
      const sinceMs = parseInt(query.get('since') || '0') || (Date.now() - 24 * 60 * 60 * 1000);
      const rows = _state.db().prepare(`
        SELECT kind, COUNT(*) AS events, COALESCE(SUM(tokens), 0) AS tokens
        FROM savings_ledger
        WHERE ts >= ? AND kind LIKE 'gemcache:%'
        GROUP BY kind
        ORDER BY kind
      `).all(sinceMs);
      const recent = _state.db().prepare(`
        SELECT ts, kind, tokens, note
        FROM savings_ledger
        WHERE ts >= ? AND kind LIKE 'gemcache:%'
        ORDER BY ts DESC
        LIMIT 50
      `).all(sinceMs);
      let gemcacheStats = null, keepaliveStats = null;
      try { gemcacheStats = trothCache.getDefault().stats(); } catch (e) {}
      try { keepaliveStats = keepaliveMgr.stats(); } catch (e) {}
      jsonResponse(res, 200, {
        since: sinceMs,
        aggregates: rows,
        recent: recent,
        gemcache: gemcacheStats,
        keepalive: keepaliveStats,
      });
    } catch (e) {
      jsonResponse(res, 500, { error: 'cache_ledger_unavailable', message: e.message });
    }
    return;
  }

  // ===== Substrate (shared with standalone-ui) =====
  // Proxies the same read-only queries over action_records so the macOS
  // WKWebView app (which points at this server's /ui) can show the
  // substrate surface without running a second daemon on 9999.
  //
  // Substrate read endpoints share one canonical DB connection with the
  // CLI + plugin hooks via shared-core/state.js. That module resolves the
  // DB path to ~/.troth/state.db regardless of CLAUDE_PLUGIN_DATA, so
  // every writer (CLI, hooks running inside Claude Code, the proxy itself)
  // and every reader (this server) hits the same store. Earlier versions
  // of this block opened a separate read-only handle to a plugin-data DB
  // path, which produced split-brain reads when the CLI had populated the
  // canonical DB but the plugin-data path was empty.
  // Version and staleness. boot_hash is what this process is; disk_hash is
  // what a restart would be. They diverge the moment a pull lands under a
  // running proxy — exactly the skew that served new HTML on old routes.
  if (req.method === 'GET' && url === '/api/version') {
    try {
      const crypto = require('crypto');
      let diskHash = null;
      try { diskHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12); } catch (_) {}
      let pkgVersion = null;
      try { pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch (_) {}
      jsonResponse(res, 200, {
        version: pkgVersion,
        boot_hash: BOOT_SRC_HASH,
        disk_hash: diskHash,
        stale: !!(BOOT_SRC_HASH && diskHash && BOOT_SRC_HASH !== diskHash)
      });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // Login service: status + one-toggle install/uninstall. Same module as
  // `troth service`, so the dashboard switch and the CLI cannot disagree.
  if (url === '/api/service' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const svc = require('./modules/service.js');
      if (req.method === 'GET') { jsonResponse(res, 200, svc.status()); return; }
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          const b = JSON.parse(body || '{}');
          const r = b.enabled ? svc.install({ port: PORT }) : svc.uninstall();
          jsonResponse(res, r.ok ? 200 : 400, Object.assign({}, r, svc.status()));
        } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
      });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // Health vitals: the one-line state of this install.
  if (req.method === 'GET' && url === '/api/health/vitals') {
    try {
      const svc = require('./modules/service.js');
      let pkgVersion = null;
      try { pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch (_) {}
      const crypto = require('crypto');
      let diskHash = null;
      try { diskHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12); } catch (_) {}
      let dbBytes = null;
      try { dbBytes = fs.statSync(path.join(require('../shared-core/troth-home.js').trothDir(), 'state.db')).size; } catch (_) {}
      let lastBackup = null;
      try {
        const bdir = path.join(require('../shared-core/troth-home.js').trothDir(), 'backups');
        const ts = fs.readdirSync(bdir).filter(function (n) { return n.indexOf('substrate-') === 0; })
          .map(function (n) { return fs.statSync(path.join(bdir, n)).mtimeMs; });
        if (ts.length) lastBackup = Math.max.apply(null, ts);
      } catch (_) {}
      jsonResponse(res, 200, {
        version: pkgVersion,
        stale: !!(BOOT_SRC_HASH && diskHash && BOOT_SRC_HASH !== diskHash),
        uptime_s: Math.round(process.uptime()),
        port: PORT,
        db_bytes: dbBytes,
        last_backup_ts: lastBackup,
        service: svc.status()
      });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // Repairs. Each does one thing and reports what it did.
  // Stray troth proxies: siblings that bumped to another port and stayed.
  // dry:true only counts them.
  if (req.method === 'POST' && url === '/api/repair/reap') {
    let reapBody = '';
    req.on('data', function (c) { reapBody += c; });
    req.on('end', function () {
      try {
        const b = JSON.parse(reapBody || '{}');
        const { execFileSync } = require('child_process');
        const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
        const strays = [];
        out.split('\n').forEach(function (l) {
          const m = l.match(/^\s*(\d+)\s+(troth-proxy-\d+)/);
          if (m && parseInt(m[1], 10) !== process.pid) strays.push({ pid: parseInt(m[1], 10), name: m[2] });
        });
        if (b.dry || !strays.length) {
          jsonResponse(res, 200, { found: strays.length, closed: 0, strays: strays });
          return;
        }
        strays.forEach(function (s) { try { process.kill(s.pid, 'SIGTERM'); } catch (_) {} });
        // Old trees can ignore SIGTERM (stuck shutdown handler). Escalate to
        // SIGKILL for survivors, then report who is actually gone.
        setTimeout(function () {
          strays.forEach(function (s) {
            try { process.kill(s.pid, 0); process.kill(s.pid, 'SIGKILL'); } catch (_) { /* already gone */ }
          });
          setTimeout(function () {
            let gone = 0;
            strays.forEach(function (s) { try { process.kill(s.pid, 0); } catch (_) { gone++; } });
            jsonResponse(res, 200, { found: strays.length, closed: gone, strays: strays });
          }, 500);
        }, 2500);
      } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    });
    return;
  }

  // Substrate backup on demand: same bundle shape and keep-4 policy as the
  // weekly background task.
  if (req.method === 'POST' && url === '/api/repair/backup') {
    try {
      const backup = require('../shared-core/substrate-backup.js');
      const bdir = path.join(require('../shared-core/troth-home.js').trothDir(), 'backups');
      try { fs.mkdirSync(bdir, { recursive: true }); } catch (_) {}
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(bdir, 'substrate-' + stamp);
      const r = backup.exportArchive({ out_path: dest });
      try {
        const all = fs.readdirSync(bdir).filter(function (n) { return n.indexOf('substrate-') === 0; })
          .map(function (n) { return { n: n, ts: fs.statSync(path.join(bdir, n)).mtimeMs }; })
          .sort(function (a, b) { return b.ts - a.ts; });
        all.slice(4).forEach(function (o) { try { fs.rmSync(path.join(bdir, o.n), { recursive: true, force: true }); } catch (_) {} });
      } catch (_) {}
      jsonResponse(res, 200, { ok: true, path: dest, result: r || null });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // Restart from the dashboard: a detached helper waits for this process to
  // release the port, then starts a fresh proxy from disk. No port bump, no
  // stray sibling.
  if (req.method === 'POST' && url === '/api/repair/restart') {
    try {
      const { spawn } = require('child_process');
      const helper =
        'const{spawn}=require("child_process");const net=require("net");' +
        'const port=' + PORT + ';const server=' + JSON.stringify(__filename) + ';let tries=0;' +
        '(function poll(){const s=net.createConnection(port,"127.0.0.1");' +
        's.on("error",function(){start()});' +
        's.on("connect",function(){s.destroy();if(++tries>40){process.exit(1);}setTimeout(poll,250);});})();' +
        'function start(){const p=spawn(process.execPath,[server],{detached:true,stdio:"ignore",env:process.env});p.unref();process.exit(0);}';
      spawn(process.execPath, ['-e', helper], { detached: true, stdio: 'ignore', env: process.env }).unref();
      jsonResponse(res, 200, { ok: true, restarting: true });
      setTimeout(function () { process.exit(0); }, 400);
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // Become another mind, one click: validate the bundle, then a detached
  // helper waits for this process to release the port, swaps the substrate
  // in (importArchive, replace), and starts a fresh proxy — the same
  // stop-swap-start choreography the restart endpoint already trusts. The
  // live process never writes over its own open database.
  if (req.method === 'POST' && url === '/api/mind/import') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      try {
        const inPath = body && typeof body.path === 'string' ? body.path.trim() : null;
        if (!inPath) { jsonResponse(res, 400, { ok: false, error: 'path_required' }); return; }
        // A .trothmove is ADDITIVE — memories join through the shared atlas
        // road on the LIVE substrate, no stop-swap-start, nothing replaced.
        if (/\.trothmove$/i.test(inPath)) {
          const r = require('../shared-core/substrate-backup.js').importMoveFile({ in_path: inPath });
          jsonResponse(res, r.ok ? 200 : 400, Object.assign({ additive: true }, r));
          return;
        }
        if (!fs.existsSync(path.join(inPath, 'manifest.json'))) {
          jsonResponse(res, 400, { ok: false, error: 'not_a_mind_bundle', detail: 'no manifest.json at ' + inPath });
          return;
        }
        const { spawn } = require('child_process');
        const backupPath = path.join(__dirname, '..', 'shared-core', 'substrate-backup.js');
        const helper =
          'const{spawn}=require("child_process");const net=require("net");' +
          'const port=' + PORT + ';const server=' + JSON.stringify(__filename) + ';' +
          'const backup=require(' + JSON.stringify(backupPath) + ');' +
          'const inPath=' + JSON.stringify(inPath) + ';let tries=0;' +
          '(function poll(){const s=net.createConnection(port,"127.0.0.1");' +
          's.on("error",function(){go()});' +
          's.on("connect",function(){s.destroy();if(++tries>60){process.exit(1);}setTimeout(poll,250);});})();' +
          'function go(){try{const r=backup.importArchive({in_path:inPath,replace:true});if(!r.ok)process.exit(2);}catch(_){process.exit(2);}' +
          'const p=spawn(process.execPath,[server],{detached:true,stdio:"ignore",env:process.env});p.unref();process.exit(0);}';
        spawn(process.execPath, ['-e', helper], { detached: true, stdio: 'ignore', env: process.env }).unref();
        jsonResponse(res, 200, { ok: true, importing: true, restarting: true });
        setTimeout(function () { process.exit(0); }, 400);
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    });
    return;
  }

  // Check-up: live checks with a fix line per failure. ok is true/false, or
  // null for a check that does not apply on this install.
  if (req.method === 'POST' && url === '/api/doctor') {
    (async () => {
      const checks = [];
      const add = (name, ok, detail, fix) => checks.push({ name, ok, detail: detail || '', fix: fix || '' });
      try {
        const crypto = require('crypto');
        let diskHash = null;
        try { diskHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12); } catch (_) {}
        const stale = !!(BOOT_SRC_HASH && diskHash && BOOT_SRC_HASH !== diskHash);
        add('Proxy code', !stale, stale ? 'running older code than what is on disk' : 'running the code on disk',
          stale ? 'run: troth restart' : '');
      } catch (e) { add('Proxy code', false, String(e.message || e), 'run: troth restart'); }
      try {
        const st = require('../shared-core/state.js');
        st.db().pragma('user_version', { simple: true });
        add('Substrate', true, 'database opens and answers');
      } catch (e) { add('Substrate', false, String(e.message || e), 'check ~/.troth permissions, then troth restart'); }
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const provs = (cfg && cfg.providers) || {};
        const on = Object.keys(provs).filter(function (k) { return provs[k] && provs[k].enabled; });
        add('Engines', on.length > 0, on.length ? (on.length + ' enabled: ' + on.join(', ')) : 'none enabled',
          on.length ? '' : 'open Engines and link a plan or add a key');
      } catch (e) { add('Engines', false, String(e.message || e), 'open Engines'); }
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const lp = cfg && cfg.providers && cfg.providers.local;
        if (!lp || !lp.enabled) { add('Local engine', null, 'not enabled, skipped'); }
        else {
          const up = await new Promise(function (resolve) {
            const rq = http.get({ host: BACKEND_HOST, port: BACKEND_PORT, path: '/v1/models', timeout: 1200 },
              function (rs) { rs.resume(); resolve(rs.statusCode > 0); });
            rq.on('error', function () { resolve(false); });
            rq.on('timeout', function () { rq.destroy(); resolve(false); });
          });
          add('Local engine', up, up ? ('answering on ' + BACKEND_HOST + ':' + BACKEND_PORT) : ('enabled but nothing answers on ' + BACKEND_HOST + ':' + BACKEND_PORT),
            up ? '' : 'start your local server (llama.cpp, Ollama, LM Studio) or turn the lane off in Engines');
        }
      } catch (e) { add('Local engine', false, String(e.message || e), ''); }
      try {
        const st = require('../shared-core/state.js');
        const row = st.db().prepare('SELECT last_seen_ts FROM plugin_presence WHERE id = 1').get();
        const ageM = row ? (Date.now() - row.last_seen_ts) / 60000 : null;
        if (ageM === null) add('Claude Code plugin', false, 'never seen', 'run: troth install-plugin');
        else if (ageM < 30) add('Claude Code plugin', true, 'active ' + Math.round(ageM) + 'm ago');
        else add('Claude Code plugin', true, 'last active ' + (ageM < 1440 ? Math.round(ageM / 60) + 'h' : Math.round(ageM / 1440) + 'd') + ' ago');
      } catch (e) { add('Claude Code plugin', null, 'presence not readable, skipped'); }
      try {
        const a = require('../shared-core/analytics.js').getAnalytics({ window: 'today' });
        const errs = Object.keys((a.health && a.health.errors_by_module) || {}).length;
        add('Engine errors today', errs === 0, errs === 0 ? 'none' : (errs + ' engine(s) erroring'),
          errs === 0 ? '' : 'open Analytics for which engine and how often');
        const weak = ((a.health && a.health.degraded) || [])
          .filter((x) => /hit_rate$/.test(x.metric));
        if (weak.length) {
          add('Read caches', false,
            weak.map((x) => x.metric.split('.')[1].replace('cached_', '') + ' ' + Math.round(x.value * 100) + '%').join(' · '),
            'reads are not being served from cache — the same files are being re-read into the window');
        } else {
          add('Read caches', true, 'serving');
        }
      } catch (e) { add('Engine errors today', null, 'analytics not readable, skipped'); }
      try {
        const svc = require('./modules/service.js');
        const s = svc.status();
        if (!s.supported) add('Login service', null, 'not supported on ' + s.platform + ', skipped');
        else add('Login service', s.installed ? true : null, s.installed ? ('on, ' + s.kind) : 'off, proxy runs only while you start it',
          s.installed ? '' : 'flip Background on, on this page');
      } catch (e) { add('Login service', null, 'not readable, skipped'); }
      try {
        // The troth command as the OPERATOR'S terminal sees it: a login shell
        // reads their profile, so PATH matches reality — the launchd env here
        // does not.
        const sh = process.env.SHELL || '/bin/sh';
        let cliPath = '';
        try {
          cliPath = require('child_process').execFileSync(sh, ['-lc', 'command -v troth'], { encoding: 'utf8', timeout: 5000 }).trim();
        } catch (_) {}
        add('CLI', cliPath ? true : null, cliPath ? ('troth on your PATH — ' + cliPath) : 'troth is not on your shell PATH',
          cliPath ? '' : 'run it as: node ' + path.join(__dirname, '..', 'bin', 'troth.js') + ' — or link it: npm link');
      } catch (e) { add('CLI', null, 'not checkable, skipped'); }
      try {
        // Browser: which CDP door answers. A silent browser is not a
        // failure - the browse tool starts the private one on demand.
        const bd = require('../shared-core/perception/chromium-daemon.js');
        const bCand = [];
        const bEnv = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '', 10);
        if (bEnv) bCand.push(bEnv);
        if (bCand.indexOf(18222) === -1) bCand.push(18222);
        if (bCand.indexOf(9222) === -1) bCand.push(9222);
        let bLive = 0;
        for (const c of bCand) { if (await bd.aliveHost(c, 700)) { bLive = c; break; } }
        add('Browser', bLive ? true : null,
          bLive ? ('CDP answering on ' + bLive + (bLive === 9222 ? ', your own debug Chrome' : ', the troth browser')) : 'no browser running',
          bLive ? '' : 'nothing to do - the browse tool starts one on demand');
      } catch (e) { add('Browser', null, 'not checkable, skipped'); }
      try {
        // Ground walls: the doctor stands on unwalled ground, so it is the
        // one place that can APPLY a session wall and observe it. Probes are
        // exit-code-only workflow checks: the agent socket and keychain
        // still answer, the promoted read rules hold, the pinholes stay
        // open. Red here means sessions run wider or narrower than built.
        const wd = require('../shared-core/tools/wall-doctor.js').runProbes();
        if (wd.context !== 'unwalled') {
          add('Ground walls', null, 'not measurable from here (' + wd.context + '), skipped');
        } else {
          const v = wd.verdicts || {};
          const okAll = !!(v.controlsEngaged && v.agentSocketSurvives && v.credentialRoadOpen && v.carvesWork && v.promotionLive && v.jailHolds);
          const failed = (wd.probes || []).filter(function (p) { return !p.ok; }).map(function (p) { return p.name; });
          add('Ground walls', okAll,
            okAll ? ((wd.probes || []).length + ' probes: credential stores dark, agent socket and keychain answering')
                  : ('holding except: ' + failed.join('; ')),
            okAll ? '' : 'run: troth restart, then re-check; if it stays red, the wall builder changed behaviour');
        }
      } catch (e) { add('Ground walls', null, 'not checkable, skipped'); }
      const bad = checks.filter(function (c) { return c.ok === false; }).length;
      jsonResponse(res, 200, { checks: checks, findings: bad });
    })().catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }

  // Which CDP door a browsing agent would find: the exported port, the
  // private daemon (18222), the operator's own debug Chrome (9222).
  if (req.method === 'GET' && url === '/api/browser/status') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    (async () => {
      const bd = require('../shared-core/perception/chromium-daemon.js');
      const cand = [];
      const envP = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '', 10);
      if (envP) cand.push(envP);
      if (cand.indexOf(18222) === -1) cand.push(18222);
      if (cand.indexOf(9222) === -1) cand.push(9222);
      const ports = [];
      for (const c of cand) {
        const h = await bd.aliveHost(c, 700);
        ports.push({ port: c, alive: !!h, kind: c === 9222 ? 'operator' : 'daemon' });
      }
      jsonResponse(res, 200, {
        ports: ports,
        attached: ports.filter(function (p) { return p.alive; })[0] || null,
        profile: path.join(HOME, '.troth', 'chrome-profile'),
      });
    })().catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }

  // What troth is running on this machine and what it costs — the inventory
  // the idle reaper works from, made visible. Exists because "why is the
  // laptop hot" kept needing a shell and a diagnosis session to answer, and
  // the number a shell shows first (%CPU) is a lifetime average that points
  // at the wrong process. CPU time consumed and resident memory do not lie.
  if (url === '/api/system/load' && req.method === 'GET') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      jsonResponse(res, 200, require('../shared-core/system-load.js').snapshot());
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // ── The vault: named secrets the agent can use but never see ─────────
  // Values go in and never come back out; list and status expose metadata
  // only. The passphrase is the operator passphrase (same ceremony as
  // `troth init --seal`); on a machine without the seal, setup runs the
  // ceremony right here. Localhost-only like every other route.
  if (url === '/api/vault/status' && req.method === 'GET') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const vault = require('../shared-core/vault.js');
      let sealed = false;
      try { sealed = !!require('../shared-core/bootstrap.js').status().has_bootstrap_seal; } catch (_) {}
      const s = vault.status();
      jsonResponse(res, 200, { bootstrapped: sealed, exists: s.exists, unlocked: s.unlocked,
        entry_count: s.entry_count, session_expires_at: s.session_expires_at,
        pending_drops: s.pending_drops || 0 });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }
  if (url === '/api/vault/setup' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then(function (b) {
      const boot = require('../shared-core/bootstrap.js');
      if (boot.status().has_bootstrap_seal) { jsonResponse(res, 409, { error: 'already_bootstrapped' }); return; }
      const pass = b && b.passphrase;
      if (!pass || typeof pass !== 'string' || pass.length < 8) { jsonResponse(res, 400, { error: 'passphrase_min_8_chars' }); return; }
      const r = boot.runInit({ passphrase: pass, charter: (b && b.charter) || '' });
      if (!r.ok) { jsonResponse(res, 500, { error: r.error || 'bootstrap_failed' }); return; }
      jsonResponse(res, 200, { ok: true, public_key_id: r.public_key_id });
    }).catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }
  if (url === '/api/vault/unlock' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then(function (b) {
      const vault = require('../shared-core/vault.js');
      const pass = b && b.passphrase;
      if (!pass || typeof pass !== 'string') { jsonResponse(res, 400, { error: 'passphrase_required' }); return; }
      // First unlock CREATES the vault file with this passphrase, so when
      // the operator key exists, verify against it first: a typo here
      // must not mint a vault under a wrong passphrase.
      const opk = require('../shared-core/operator-key.js');
      if (!vault.status().exists && opk.exists()) {
        try { opk.unlock(pass).lock(); }
        catch (_) { jsonResponse(res, 403, { error: 'wrong_passphrase' }); return; }
      }
      try {
        const r = vault.unlock(pass);
        jsonResponse(res, 200, { ok: true, entry_count: r.entry_count, session_expires_at: r.session_expires_at });
      } catch (e) { jsonResponse(res, 403, { error: String(e && e.message || e) }); }
    }).catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }
  if (url === '/api/vault/change-passphrase' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then(function (b) {
      const opk = require('../shared-core/operator-key.js');
      const oldPass = b && b.old_passphrase;
      const newPass = b && b.new_passphrase;
      if (!oldPass || typeof oldPass !== 'string') { jsonResponse(res, 400, { error: 'old_passphrase_required' }); return; }
      if (!newPass || typeof newPass !== 'string' || newPass.length < 8) { jsonResponse(res, 400, { error: 'new_passphrase_min_8_chars' }); return; }
      if (oldPass === newPass) { jsonResponse(res, 400, { error: 'new_passphrase_identical' }); return; }
      if (!opk.exists()) { jsonResponse(res, 409, { error: 'no_operator_key' }); return; }
      try {
        // changePassphrase re-wraps the operator key AND the credential vault
        // in one operation, rolling the key back if the vault half fails.
        const r = opk.changePassphrase(oldPass, newPass);
        // The live session was derived from the old secret. Drop it so the
        // operator proves the new passphrase on the next unlock instead of
        // riding a session nobody re-authenticated.
        try { require('../shared-core/vault.js').lock(); } catch (_) {}
        jsonResponse(res, 200, { ok: true, public_key_id: r && r.public_key_id });
      } catch (e) {
        const m = String(e && e.message || e);
        const wrong = /decryption failed|wrong passphrase/i.test(m);
        jsonResponse(res, wrong ? 403 : 500, { error: wrong ? 'wrong_passphrase' : m });
      }
    }).catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }
  if (url === '/api/vault/lock' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try { require('../shared-core/vault.js').lock(); jsonResponse(res, 200, { ok: true }); }
    catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }
  if (url === '/api/vault/entries' && req.method === 'GET') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try { jsonResponse(res, 200, require('../shared-core/vault.js').listEntries()); }
    catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }
  if (url === '/api/vault/entry' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then(function (b) {
      const r = require('../shared-core/vault.js').writeEntry({
        key: b && b.key, value: b && b.value,
        capability_scope_glob: b && b.capability_scope_glob,
        injection: (b && b.injection) || undefined,
        description: (b && b.description) || null,
        // Replacing an existing key takes an explicit ask; the default is
        // a key_exists refusal so nothing is destroyed by accident.
        overwrite: !!(b && b.overwrite)
      });
      jsonResponse(res, r.ok ? 200 : 400, r);
    }).catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }
  if (url === '/api/vault/entry/remove' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then(function (b) {
      jsonResponse(res, 200, require('../shared-core/vault.js').removeEntry(b && b.key));
    }).catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }
  // Capture: take the login the operator just typed in their browser and
  // seal it here, so the agent can sign itself in later without ever being
  // told the password. The operator asks for this by pressing a button; the
  // proxy reads the field, writes it to the vault (or seals it to the
  // drop-box when the vault is locked), and answers with the host and
  // username only. The secret never enters an HTTP response, a page, or
  // a model context.
  if (url === '/api/vault/capture' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    (async function () {
      const vault = require('../shared-core/vault.js');
      const b = await readJsonBody(req) || {};
      const bd = require('../shared-core/perception/chromium-daemon.js');
      const cdp = require('../shared-core/perception/cdp-client.js');
      const want = parseInt(b.port, 10) || 0;
      // The agent's browser only. Capturing from the operator's own browser
      // (9222) would seal whatever their password manager just autofilled,
      // bank included, which nobody asked for. Reaching it takes an explicit
      // port and is a different decision entirely.
      const cand = want ? [want] : [18222];
      let hostAddr = null, port = 0;
      for (const c of cand) { const h = await bd.aliveHost(c, 700); if (h) { hostAddr = h; port = c; break; } }
      if (!port) { jsonResponse(res, 502, { error: 'no_browser_attached' }); return; }
      const targets = await cdp.listTargets(hostAddr, port);
      const pages = (targets || []).filter(function (t) { return t.type === 'page' && /^https?:/.test(t.url || ''); });
      const READ = '(function(){' +
        'var p=[].slice.call(document.querySelectorAll(\'input[type=password]\')).filter(function(i){return i.value});' +
        'if(!p.length)return JSON.stringify(null);' +
        'var pw=p[0];' +
        'var ins=[].slice.call(document.querySelectorAll(\'input\'));' +
        'var user="";' +
        'for(var i=ins.indexOf(pw)-1;i>=0;i--){var t=(ins[i].type||"").toLowerCase();' +
        'if((t==="text"||t==="email"||t==="tel")&&ins[i].value){user=ins[i].value;break;}}' +
        'return JSON.stringify({host:location.host,user:user,pass:pw.value});})()';
      let found = null;
      for (const t of pages) {
        let s = null;
        try {
          s = new cdp.CdpSession(t.webSocketDebuggerUrl);
          await s.open();
          await s.send('Runtime.enable', {});
          const r = await s.send('Runtime.evaluate', { expression: READ, returnByValue: true });
          const v = r && r.result && r.result.value;
          const parsed = v ? JSON.parse(v) : null;
          if (parsed && parsed.pass) { found = parsed; }
        } catch (_) { /* a tab we cannot read is simply not the one */ }
        try { if (s) s.close(); } catch (_) {}
        if (found) break;
      }
      if (!found) { jsonResponse(res, 404, { error: 'no_filled_login_form', detail: 'open the site, type the login, then press capture' }); return; }
      const bare = String(found.host).replace(/^www\./, '').split(':')[0];
      // The key must tell two accounts on the same site apart: keying by
      // host alone made the second capture silently destroy the first.
      // The username, when the form had one, becomes part of the key.
      const userSlug = found.user
        ? String(found.user).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
        : '';
      const key = (b.key && String(b.key).trim())
        || (bare.split('.').slice(-2)[0] + (userSlug ? '-' + userSlug : '') + '-login');
      const draft = {
        key: key,
        value: found.pass,
        capability_scope_glob: 'capability:browser:fill:*.' + bare,
        injection: { kind: 'raw' },
        description: found.user ? ('login for ' + found.user) : ('login on ' + bare)
      };
      if (!vault.status().unlocked) {
        // Locked is no longer a dead end: the drop-box takes the capture
        // and the entry appears at the next unlock.
        const sealed = vault.seal(draft);
        if (!sealed.ok) { jsonResponse(res, sealed.error === 'dropbox_not_initialized' ? 403 : 400, sealed); return; }
        jsonResponse(res, 200, { ok: true, key: key, host: bare, username: found.user || null, port: port,
          sealed_for_unlock: true, pending_drops: sealed.pending_drops });
        return;
      }
      // Same key now means same site + same username, so replacing is the
      // password-rotation path, not cross-account loss.
      const r2 = vault.writeEntry(Object.assign({ overwrite: true }, draft));
      if (!r2.ok) { jsonResponse(res, 400, r2); return; }
      jsonResponse(res, 200, { ok: true, key: key, host: bare, username: found.user || null, port: port });
    })().catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }
  // The first open consumer: fill a form field in the CDP browser FROM
  // this process. The value flows vault → proxy → page field; the HTTP
  // response never carries it, so nothing a model context can read does.
  // Scope gate: the entry's glob must cover capability:browser:fill:<host
  // of the page being filled>. Receipts land on the entry via _noteUse.
  if (url === '/api/browser/fill' && req.method === 'POST') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then(async function (b) {
      const vault = require('../shared-core/vault.js');
      const key = b && b.vault_key, sel = b && b.selector;
      if (!key || !sel) { jsonResponse(res, 400, { error: 'vault_key_and_selector_required' }); return; }
      if (!vault.status().unlocked) { jsonResponse(res, 403, { error: 'vault_locked' }); return; }
      const bd = require('../shared-core/perception/chromium-daemon.js');
      const want = parseInt(b && b.port, 10) || 0;
      // No silent fallback to 9222: if the agent's browser is down, say so
      // rather than quietly typing a secret into the operator's own session.
      const cand = want ? [want] : [18222];
      let host = null, p = 0;
      for (const c of cand) { const h = await bd.aliveHost(c, 700); if (h) { host = h; p = c; break; } }
      if (!p) { jsonResponse(res, 502, { error: 'no_browser_attached' }); return; }
      const cdp = require('../shared-core/perception/cdp-client.js');
      let page = null;
      try {
        page = await cdp.connectFirstPage(host, p);
        await page.send('Runtime.enable', {});
        const hostR = await page.send('Runtime.evaluate', { expression: 'location.host', returnByValue: true });
        const pageHost = (hostR && hostR.result && hostR.result.value) || '';
        const scope = 'capability:browser:fill:' + pageHost;
        const got = vault.getValueByKey(String(key), scope);
        if (!got) { try { page.close(); } catch (_) {} jsonResponse(res, 403, { error: 'no_entry_for_scope', scope: scope }); return; }
        const expr = '(function(){var el=document.querySelector(' + JSON.stringify(String(sel)) + ');'
          + 'if(!el)return "no_such_element";'
          + 'var d=Object.getOwnPropertyDescriptor(el.constructor.prototype,"value");'
          + 'if(d&&d.set)d.set.call(el,' + JSON.stringify(got.value) + ');else el.value=' + JSON.stringify(got.value) + ';'
          + 'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));'
          + 'return "filled";})()';
        const r2 = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        const out = r2 && r2.result && r2.result.value;
        try { page.close(); } catch (_) {}
        if (out !== 'filled') { jsonResponse(res, 404, { error: String(out || 'fill_failed') }); return; }
        jsonResponse(res, 200, { ok: true, filled: true, key: got.key, port: p });
      } catch (e) {
        try { if (page) page.close(); } catch (_) {}
        jsonResponse(res, 502, { error: String(e && e.message || e) });
      }
    }).catch(function (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); });
    return;
  }

  // The command surface, from the sources of truth themselves: slash skills
  // from the loader that executes them, subcommands parsed from bin/troth.js's
  // own table. Nothing here is retyped, so nothing here can lie.
  if (req.method === 'GET' && url === '/api/commands') {
    try {
      let slash = [];
      try {
        slash = (require('../shared-core/slash/loader.js').skillSummaries(WATCH_DIR) || [])
          .map(function (s) {
            // A reference row must end on a whole sentence, never mid-word.
            let d = String(s.description || '');
            if (d.length > 220) {
              const cut = d.slice(0, 220);
              const stop = cut.lastIndexOf('. ');
              d = stop > 60 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + '…';
            }
            return { name: s.name, description: d };
          });
      } catch (_) {}
      let cli = [];
      try {
        // The same DATA module the CLI dispatch builds its Set from.
        // Read from the module, never by regexing bin/troth.js SOURCE for
        // the literal: shipped bundles are minified, and a source regex
        // serves the reference page with zero CLI commands.
        cli = require('../shared-core/cli-commands.js').slice();
      } catch (_) {}
      jsonResponse(res, 200, { slash: slash, cli: cli });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  // Read-only window on action_records: class filter, text search, paging,
  // and the true total for the current filter. Deliberately NOT queryActions —
  // that call sits on the recall path with a 1000-row clamp tuned for prompt
  // latency, and a browser paging to row 100k must not widen it.
  // One record, whole: the Records page expands a row into a meaning panel
  // and needs the full parsed input/output/verification for just that id.
  if (req.method === 'GET' && url === '/api/substrate/record') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const rid = String((new URL(req.url, 'http://x')).searchParams.get('id') || '').slice(0, 80);
      const rState = require('../shared-core/state.js');
      const row = rState.db().prepare(
        'SELECT id, timestamp, type, agent_id, session_id, cwd, memory_class, audience, input, output, verification' +
        ' FROM action_records WHERE id = ?').get(rid);
      if (!row) { jsonResponse(res, 404, { error: 'not found' }); return; }
      const rParse = function (s) { try { return JSON.parse(s || 'null'); } catch (_) { return null; } };
      jsonResponse(res, 200, {
        id: row.id, ts: row.timestamp, type: row.type, agent: row.agent_id,
        session_id: row.session_id, cwd: row.cwd, memory_class: row.memory_class,
        audience: row.audience, input: rParse(row.input), output: rParse(row.output),
        verification: rParse(row.verification)
      });
    } catch (e) { jsonResponse(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/substrate/records')) {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const rq = (new URL(req.url, 'http://x')).searchParams;
      const rType = String(rq.get('type') || '').trim();
      const rQ = String(rq.get('q') || '').trim().slice(0, 200);
      const rLimit = Math.min(200, Math.max(1, parseInt(rq.get('limit') || '50', 10) || 50));
      const rOffset = Math.max(0, parseInt(rq.get('offset') || '0', 10) || 0);
      // Required here rather than borrowed from the substrate dispatcher below:
      // this route runs before it, and reaching into a variable that is only
      // assigned inside that block is how it returned a 500 for every request.
      const rState = require('../shared-core/state.js');
      const rdb = rState._dbForQuery && rState._dbForQuery();
      if (!rdb) { jsonResponse(res, 200, { items: [], total: 0, offset: rOffset, limit: rLimit }); return; }
      const rWhere = [], rBind = [];
      if (rType) { rWhere.push('type = ?'); rBind.push(rType); }
      const rCTypes = String(rq.get('ctype') || '').split(',')
        .map(function (x) { return x.trim(); })
        .filter(function (x) { return /^[a-z_]{1,32}$/.test(x); });
      if (rCTypes.length) {
        rWhere.push("json_extract(output,'$.commitment_type') IN (" +
          rCTypes.map(function () { return '?'; }).join(',') + ')');
        rCTypes.forEach(function (x) { rBind.push(x); });
      }
      if (rQ) { rWhere.push('(output LIKE ? OR input LIKE ?)'); rBind.push('%' + rQ + '%', '%' + rQ + '%'); }
      const rW = rWhere.length ? ' WHERE ' + rWhere.join(' AND ') : '';
      const rTotal = rdb.prepare('SELECT COUNT(*) AS n FROM action_records' + rW).get.apply(
        rdb.prepare('SELECT COUNT(*) AS n FROM action_records' + rW), rBind).n;
      const rStmt = rdb.prepare('SELECT id, timestamp, type, agent_id, cwd, memory_class, output, input' +
        ' FROM action_records' + rW + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?');
      const rRows = rStmt.all.apply(rStmt, rBind.concat([rLimit, rOffset]));
      jsonResponse(res, 200, {
        total: rTotal, offset: rOffset, limit: rLimit,
        items: rRows.map(function (r) {
          let out = null, inp = null;
          try { out = JSON.parse(r.output || 'null'); } catch (_) {}
          try { inp = JSON.parse(r.input || 'null'); } catch (_) {}
          // One readable line per record. Each class carries its meaning in a
          // different field, so the fallback chain ends at the raw JSON head
          // rather than an empty row that hides a record exists.
          // mind_snapshot first: its stored summary is built from
          // current_focus + active_projects, both of which hold steady for
          // weeks, so thousands of snapshots rendered as one repeated line
          // and the page looked broken. The field that moves every turn is
          // the request itself. Derived here rather than at write time so the
          // whole history reads as a timeline, not only new rows.
          let line = '';
          if (r.type === 'mind_snapshot' && out && out.mind_state) {
            const ms = out.mind_state;
            const what = ms.current_intent && ms.current_intent.what;
            const focus = String(ms.current_focus || '').split('·')[0].trim();
            line = what ? String(what) : (focus || '');
          }
          // avoided_path keeps its meaning in avoidance_text / suggest_instead,
          // which no branch below knew about, so those rows fell through to a
          // raw JSON head.
          // A tool call is only meaningful WITH its subject: 11,746 Read rows
          // that all say "Read" are a wall, the same rows saying which file
          // are a history. The salient argument differs per tool and the
          // record already holds it — nothing here was ever surfaced.
          if (!line && r.type === 'tool_call' && inp && inp.tool_name) {
            const a = inp.args || {};
            const subject = a.file_path || a.command || a.pattern || a.query ||
                            a.url || a.path || a.statement || a.user_text || '';
            const where = (a.pattern && a.path) ? ' in ' + String(a.path).split('/').slice(-2).join('/') : '';
            line = subject
              ? String(inp.tool_name) + ' · ' + String(subject).replace(/\s+/g, ' ').slice(0, 120) + where
              : String(inp.tool_name);
          }
          if (!line) {
            line = (out && (out.statement || out.summary || out.text || out.avoidance_text ||
                            out.suggest_instead || out.decision)) ||
                   (inp && (inp.tool_name || inp.query || inp.source)) || '';
          }
          if (!line) line = String(r.output || r.input || '').slice(0, 160);
          return {
            id: r.id, ts: r.timestamp, type: r.type,
            kind: (out && out.commitment_type) || (inp && inp.kind) || null,
            memory_class: r.memory_class || null,
            cwd: r.cwd || null,
            statement: String(line).slice(0, 400)
          };
        })
      });
    } catch (e) { jsonResponse(res, 500, { error: 'records_failed', detail: String(e && e.message || e) }); }
    return;
  }

  if (req.method === 'GET' && (url.startsWith('/api/substrate/') || url === '/api/embed/status' || url === '/api/localchat/status' || url === '/api/memory/readiness' || url === '/api/memory/recent' || url === '/api/memory/queue' || url === '/api/usage/plan-window' || url === '/api/config/coherence')) {
    // A4: these reads serve the partner's MEMORY. The dead
    // duplicate handlers further down all carried checkRemoteAuth, but this
    // live chain had none - any non-loopback caller could read the substrate
    // when the proxy was bound beyond 127.0.0.1. Same gate as /api/runs:
    // loopback (dashboard/app) passes, remote needs the bearer token.
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      var sharedState   = require('../shared-core/state.js');
      var sharedAR      = require('../shared-core/action-record.js');
      var sharedCaus    = require('../shared-core/causality.js');
      var sharedMarket  = require('../shared-core/market.js');
      var sharedCost    = require('../shared-core/cost.js');
      var out = null, status = 200;
      if (url === '/api/embed/status') {
        // "Getting your partner ready" setup UX: polling this BOTH kicks off
        // the one-time model download (non-blocking) AND reports progress, so
        // the welcome step needs no separate trigger. The download lands on
        // disk (~/.troth/models); the entity's embedder then loads it. Branded
        // as troth setup — the app never shows model names.
        try {
          var emb = require('../shared-core/local-embedder.js');
          var st = emb.status();
          if (!st.download_done && !st.downloading) {
            emb.prepareModel().catch(function () {});  // fire-and-forget
            st = emb.status();
          }
          // The reranker is NOT started from here. This poll runs every second
          // or two while the onboarding is open, and ensureServer() fetches a
          // ~610 MB GGUF when it is missing — so kicking it here downloaded it
          // for operators who had just answered "no" to the reranker offer.
          // Consent lives with the offer: POST /api/setup/local {part:'reranker'}
          // starts it, and the status below only reports what is there.
          try {
            var rr = require('../shared-core/local-reranker.js');
            if (rr && typeof rr.isAvailable === 'function') {
              st.reranker_ready = !!rr.isAvailable();
            }
          } catch (_) { /* reranker is an enhancement, never a blocker */ }
          // `verified` — recall proven by a real vector, not by a file landing
          // on disk. "download_done" is true even on machines where nothing
          // can run the model, and a setup that says
          // memory is on while recall is lexical is the failure nobody
          // notices. The awaited embed runs ONCE, in the background, and only
          // after the file exists: the first in-process load is ~30s on CPU,
          // so this poll never waits for it.
          if (st.download_done) {
            kickEmbedVerify();
            if (_embedVerified === true) st.verified = true;
          }
          out = st;
        } catch (e) { out = { unavailable: true, error: String(e && e.message || e) }; }
      } else if (url === '/api/memory/readiness') {
        // The memory pipeline's ONE truth (PLAN-COHERENCE law 5): engine →
        // imported → indexed → ready, with the reranker and the archive's
        // keyword-only chunks stated instead of implied away. Every surface
        // (app Memory page, dashboard card, REPL greeting) renders THIS,
        // so no two surfaces can disagree about whether memory is done.
        // Read-only by contract — the embed/status poll owns the download
        // kick; this never starts anything.
        try { out = require('../shared-core/memory-readiness.js').readiness(); }
        catch (e) { out = { stage: 'unavailable', error: String(e && e.message || e) }; }
      } else if (url === '/api/memory/recent') {
        // The memories a human can SEE — newest distilled/committed facts,
        // so "did the import actually produce memories?" has a visible
        // answer on the dashboard instead of a bare count.
        // Read-only; raw archive chunks and substrate
        // bookkeeping never appear here.
        try {
          out = { memories: sharedState.listRecentMemories(query.get('limit')) };
        } catch (e) { out = { memories: [], error: String(e && e.message || e) }; }
      } else if (url === '/api/memory/queue') {
        // What is still owed, by name. The readiness card can say "183 still
        // to read"; only this can say WHICH 183, and whether the one the
        // operator is waiting for is in there. Searchable on both the path
        // and the question that was in flight when the file was opened,
        // because an operator remembers one or the other, never reliably the
        // same one. Payloads are never returned — this feeds a list.
        try {
          out = sharedState.searchPendingKnowledge({ q: query.get('q'), limit: query.get('limit') });
        } catch (e) { out = { rows: [], total: 0, error: String(e && e.message || e) }; }
      } else if (url === '/api/usage/plan-window') {
        // Subscription consumption over a trailing window (?hours=5,
        // clamped 1..168). Ingest-on-read first: the tail is byte-
        // watermarked so an idle call is near-free, and app-only installs
        // have no other ingest driver (the troth-memory MCP server owns the
        // periodic tail only in CLI sessions — without this, the app's
        // line would show a ledger frozen at the last CLI session).
        // Consumption only, never a percent: no CLI states a reliable plan
        // limit, and a guessed denominator is a lie with a progress bar.
        try {
          const usage = require('../shared-core/claude-usage-ingest.js');
          try { usage.ingestOnce(); } catch (_) { /* tail is best-effort */ }
          out = usage.planWindow(query.get('hours'));
        } catch (e) { out = { hours: 5, families: {}, total: null, error: String(e && e.message || e) }; }
      } else if (url === '/api/config/coherence') {
        // Why the machine is shaped the way it is: the detected engines and
        // the derived shape WITH its reasons (derive-config.js). Surfaces
        // render provenance ("auto: Claude subscription is the only
        // engine" vs "your override") so two surfaces can never disagree
        // silently about where a value came from. Detection only — nothing
        // here writes, exactly like the derive itself.
        try {
          const dc = require('../shared-core/derive-config.js');
          const detected = dc.detectEngines();
          out = { detected: detected, derived: dc.deriveCoherentConfig(detected) };
        } catch (e) { out = { error: String(e && e.message || e) }; }
      } else if (url === '/api/localchat/status') {
        // In-process local CHAT model status (the "Automatic" local path).
        // Unlike embed, we do NOT lazily fire the download here — the chat
        // model is user-CHOSEN (POST /api/localchat/prepare starts it), so a
        // status poll must never kick off a multi-GB download nobody asked for.
        try {
          out = require('../shared-core/local-chat.js').status();
        } catch (e) { out = { unavailable: true, error: String(e && e.message || e) }; }
      } else if (url === '/api/substrate/counts') {
        var counts = { total: sharedState.countActions({}), by_type: {} };
        for (var i = 0; i < sharedAR.ALL_TYPES.length; i++) {
          var t = sharedAR.ALL_TYPES[i];
          counts.by_type[t] = sharedState.countActions({ type: t });
        }
        // A commitment WHERE-count is not "things learned": engram-gc writes
        // its eviction/duplicate markers as ordinary commitments
        // (commitment_type='engram_tombstoned'), and bench/test seeds live in
        // I've learned" and Activity's "memories") read by_type.commitment,
        // so the honest predicate lives here, once. The raw ledger count
        // stays available as by_type_raw_commitment for anyone auditing the
        // table itself.
        var COMMITMENT_HONEST_WHERE =
          " type='commitment'" +
          " AND COALESCE(json_extract(output,'$.commitment_type'),'') != 'engram_tombstoned'" +
          " AND COALESCE(json_extract(output,'$.scope'),'') NOT LIKE 'test:%'" +
          " AND COALESCE(json_extract(input,'$.source'),'') NOT LIKE 'test%'" +
          " AND agent_id NOT LIKE 'pe6%' AND agent_id NOT LIKE 'pe7%' AND agent_id NOT LIKE 'pe8%'" +
          " AND agent_id NOT LIKE 'bench%' AND agent_id NOT LIKE 'test%'";
        try {
          var db = sharedState._dbForQuery && sharedState._dbForQuery();
          if (db) {
            counts.by_type_raw_commitment = counts.by_type.commitment;
            counts.by_type.commitment = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE' + COMMITMENT_HONEST_WHERE).get().n;
            var h24 = Date.now() - 24 * 3600 * 1000;
            counts.last_24h = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ?').get(h24).n;
            // Knowledge the operator handed over: passages under a docs:
            // scope, minus the imported chat archive (that is conversation,
            // not something they gave). Counted here so the class carries a
            // number in the filter like every other class does — a filter
            // that is the only one without a count reads as second-class.
            counts.knowledge = db.prepare(
              "SELECT COUNT(*) AS n FROM action_records WHERE json_extract(output,'$.scope') LIKE 'docs:%'" +
              " AND json_extract(output,'$.scope') NOT LIKE 'docs:chats%'").get().n;
            // Consumer "things learned about you" hint: committed engrams in
            // the trailing week, same shape as last_24h — and the same honest
            // predicate, or "13,674 this week" is mostly GC markers again.
            var d7 = Date.now() - 7 * 24 * 3600 * 1000;
            counts.commitments_7d = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ? AND' + COMMITMENT_HONEST_WHERE).get(d7).n;
            // The substrate is a file the operator owns — its size on disk is
            // part of the story the Memory page tells.
            try {
              const dbp = path.join(require('../shared-core/troth-home.js').trothDir(), 'state.db');
              counts.db_bytes = fs.statSync(dbp).size;
            } catch (_) {}
            counts.parent_id_coverage = db.prepare("SELECT SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS r FROM action_records").get().r || 0;
            counts.precedent_hits_24h = db.prepare("SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ? AND type='decision' AND json_extract(input,'$.kind')='context_injection' AND CAST(json_extract(input,'$.precedent_count') AS INTEGER) > 0").get(h24).n;
            counts.verified_edits = db.prepare("SELECT COUNT(*) AS n FROM action_records WHERE type='edit' AND json_extract(verification,'$.ast.ok') = 1").get().n;
            counts.compacts_lifetime = db.prepare("SELECT COUNT(*) AS n FROM action_records WHERE type='compact'").get().n;
            // Embedding/recall index coverage — semantic recall only ranks
            // memories that have a vector; below full coverage it degrades to
            // lexical. Surfaced so the UI can show "memory still indexing"
            // instead of silently degrading (the recall backfill runs in the
            // background and drains this over idle time).
            //
            // The numerator is a JOIN, not a global embedding count: the old
            // global count included vectors for rows outside the recallable
            // predicate, so once totals crossed, Math.min clamped the ratio
            // to a permanent 1.0 and a 2.5-day backfill hole read as "fully
            // indexed". Embedded-recallable is a subset of recallable by
            // construction, so the ratio needs no clamp — and must not have
            // one, because a ratio above 1 would now mean a real bug worth
            // seeing.
            try {
              var RECALLABLE_WHERE = " memory_class IN ('episodic','semantic','identity','procedural') AND (audience IS NULL OR audience='model_visible')";
              var recallable = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE' + RECALLABLE_WHERE).get().n;
              var embedded = db.prepare('SELECT COUNT(*) AS n FROM engram_embeddings e JOIN action_records a ON a.id = e.engram_id WHERE' + RECALLABLE_WHERE.replace(/memory_class/g, 'a.memory_class').replace(/audience/g, 'a.audience')).get().n;
              counts.embedding_coverage = {
                embedded: embedded,
                recallable: recallable,
                ratio: recallable ? embedded / recallable : 1
              };
            } catch (_) {}
          }
        } catch (_) {}
        out = counts;
      } else if (url.startsWith('/api/substrate/actions')) {
        var u = new URL(req.url, 'http://localhost');
        var filter = {
          type:       u.searchParams.get('type')    || undefined,
          session_id: u.searchParams.get('session') || undefined,
          cwd:        u.searchParams.get('cwd')     || undefined,
          limit:      parseInt(u.searchParams.get('limit') || '50', 10)
        };
        var rows = (sharedState.queryActions(filter) || []).map(sharedAR.fromRow);
        out = { actions: rows };
      } else if (url.startsWith('/api/substrate/trace/')) {
        var id = decodeURIComponent(url.replace('/api/substrate/trace/', ''));
        out = {
          chain: sharedCaus.traceCausalChain(sharedState, id) || [],
          descendants: sharedCaus.getDescendants(sharedState, id, { maxNodes: 100 }) || []
        };
      } else if (url.startsWith('/api/substrate/mind')) {
        // Mind layer read-only viewer.
        //   /api/substrate/mind                     → list latest snapshots (any cwd)
        //   /api/substrate/mind?cwd=<path>          → list latest snapshots filtered by cwd
        //   /api/substrate/mind/show?cwd=<path>     → most-recent live snapshot's mind_state JSON
        //   /api/substrate/mind/focus?cwd=<path>    → formatOrientation text
        //   /api/substrate/mind/events?cwd=&limit=  → recent topic_shift / dmn_push / retrieval / distillation / archive events
        //   /api/substrate/mind/salience?cwd=&k=    → top-K live decisions with salience scores
        var sharedMind = require('../shared-core/mind-state.js');
        var muUrl = new URL(req.url, 'http://localhost');
        var mcwd = muUrl.searchParams.get('cwd') || undefined;
        if (url.startsWith('/api/substrate/mind/events')) {
          var evLimit = Math.min(parseInt(muUrl.searchParams.get('limit') || '40', 10), 200);
          var evSince = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d window
          var evRows = sharedState.queryActions({
            type: 'decision', cwd: mcwd, since: evSince, limit: 1000, order: 'desc'
          }) || [];
          var EV_KINDS = {
            topic_shift_detected: 1, mind_dmn_push: 1, mind_retrieval: 1,
            mind_distillation: 1, mind_archive: 1
          };
          var events = [];
          for (var i = 0; i < evRows.length && events.length < evLimit; i++) {
            var evRec = sharedAR.fromRow(evRows[i]);
            if (!evRec || !evRec.input) continue;
            var ek = evRec.input.kind;
            if (!EV_KINDS[ek]) continue;
            events.push({
              id: evRec.id,
              timestamp: evRec.timestamp,
              kind: ek,
              cwd: evRec.cwd,
              signals: evRec.input.signals || null,
              summary: evRec.input.summary || (evRec.output && evRec.output.summary) || ''
            });
          }
          out = { events: events };
        } else if (url.startsWith('/api/substrate/mind/salience')) {
          var skK = parseInt(muUrl.searchParams.get('k') || '20', 10);
          out = { decisions: sharedMind.getSalienceTopK(sharedState, { cwd: mcwd, k: skK }) };
        } else if (url.startsWith('/api/substrate/mind/show') ||
            url.startsWith('/api/substrate/mind/focus')) {
          var snapsM = sharedState.queryActions({
            type: 'mind_snapshot', cwd: mcwd, limit: 50, order: 'desc'
          }) || [];
          var archivedM = sharedMind.getArchivedSnapshotIds(sharedState, mcwd);
          var liveRowM = snapsM.find(function (r) { return !archivedM.has(r.id); });
          if (!liveRowM) {
            out = { is_empty: true, mind_state: sharedMind.emptyMindState('default') };
          } else {
            var recM = sharedAR.fromRow(liveRowM);
            var msM = recM && recM.output && recM.output.mind_state;
            if (url.startsWith('/api/substrate/mind/focus')) {
              out = { focus_text: msM ? sharedMind.formatOrientation(msM) : '' };
            } else {
              out = {
                is_empty: false,
                snapshot_id: recM.id,
                snapshot_at: msM && msM.snapshot_at,
                mind_state: msM
              };
            }
          }
        } else {
          // List form. Includes archive flag per row so the UI can grey
          // out archived snapshots.
          var listLimit = Math.min(parseInt(muUrl.searchParams.get('limit') || '20', 10), 200);
          var rowsM = sharedState.queryActions({
            type: 'mind_snapshot', cwd: mcwd, limit: listLimit, order: 'desc'
          }) || [];
          var archIds = sharedMind.getArchivedSnapshotIds(sharedState, mcwd);
          out = {
            snapshots: rowsM.map(function (r) {
              var recL = sharedAR.fromRow(r);
              var msL = recL && recL.output && recL.output.mind_state;
              return {
                snapshot_id: recL.id,
                timestamp:   recL.timestamp,
                cwd:         recL.cwd,
                trigger:     recL.input && recL.input.trigger,
                snapshot_at: msL && msL.snapshot_at,
                project_count: msL && Array.isArray(msL.active_projects) ? msL.active_projects.length : 0,
                current_focus: msL && msL.current_focus,
                archived: archIds.has(recL.id)
              };
            })
          };
        }
      } else if (url === '/api/substrate/dialogue') {
        // Dialogue browser — recent N user→assistant turns. Used by the
        // voice app's autonomous dialogue-recall path to answer "what
        // did we discuss today" without invoking the heavy claude CLI.
        // (A separate handler at the bottom of this file existed but
        // was unreachable because this 562 block returns first.)
        var dlU = new URL(req.url, 'http://localhost');
        // Substrate-as-mind: default to the unified partner brain (no
        // hard agent_id filter). ?agent_id=X scopes the view to one
        // provenance pool for operator audit; default sees everything.
        var dlAgent = dlU.searchParams.get('agent_id') || null;
        var dlCwd   = dlU.searchParams.get('cwd') || null;
        var dlLim   = parseInt(dlU.searchParams.get('limit') || '20', 10);
        var dm = require('../shared-core/dialogue-memory.js');
        var dlTurnsOpts = { cwd: dlCwd, limit: dlLim };
        if (dlAgent) dlTurnsOpts.agent_id = dlAgent;
        var dlTurns = dm.recentTurns(dlTurnsOpts);
        out = { agent_id: dlAgent, cwd: dlCwd, turns: dlTurns };
      } else if (url === '/api/substrate/watcher/status') {
        // G8/Property #3 — embedded Claude Code session watcher.
        // Singleton runtime; start/stop via POST endpoints below.
        var w = require('../tools/claude-session-watcher.js');
        if (!global.__troth_watcher_runtime) {
          global.__troth_watcher_runtime = w.makeRuntime({ agent_id: resolveAgentId() });
        }
        out = global.__troth_watcher_runtime.status();
      } else if (url === '/api/substrate/mcp-activity') {
        // G12 — per-host MCP tool activity. Group recent tool_call
        // records by agent_id + tool_name + count.
        var maU = new URL(req.url, 'http://localhost');
        var maSince = parseInt(maU.searchParams.get('since_hours') || '168', 10);
        var sinceTs = Date.now() - maSince * 3600 * 1000;
        var d3 = sharedState._dbForQuery && sharedState._dbForQuery();
        var rows = [];
        if (d3) {
          rows = d3.prepare(
            "SELECT agent_id, json_extract(input,'$.tool_name') AS tool, COUNT(*) AS n " +
            "FROM action_records " +
            "WHERE type='tool_call' AND timestamp >= ? " +
            "GROUP BY agent_id, tool ORDER BY n DESC LIMIT 200"
          ).all(sinceTs);
        }
        out = { since_hours: maSince, activity: rows };
      } else if (url === '/api/substrate/telemetry') {
        // G10 — telemetry status (POST toggle is below as separate handler).
        var tm = require('../shared-core/telemetry.js');
        out = tm.status();
      } else if (url === '/api/substrate/scopes') {
        // G13 — list chameleon scopes + their counts. Powers the Research
        // screen (which corpora exist, how big, how much is searchable)
        // and corpus deletion.
        //
        // agent_id is NOT applied by default. The brain identity at read
        // time is principal_id — agent_id only says which SURFACE wrote a
        // row. Hard-filtering on it hid 12 of this substrate's 30 research
        // corpora, because ingest ran from whichever surface happened to be
        // open that day. It stays available as an explicit audit filter
        // ("what did the voice surface write?") and nothing more.
        var scU = new URL(req.url, 'http://localhost');
        var scAgent = scU.searchParams.get('agent_id') || null;
        var scCwd   = scU.searchParams.get('cwd') || null;
        var scPrefix = scU.searchParams.get('prefix') || null;
        var chameleon = require('../shared-core/chameleon.js');
        out = {
          agent_id: scAgent || resolveAgentId(),
          filtered_by_agent: !!scAgent,
          scopes: chameleon.listScopes({ agent_id: scAgent, cwd: scCwd, prefix: scPrefix }) || []
        };
      } else if (url.startsWith('/api/substrate/scope?') || url === '/api/substrate/scope') {
        // Read ONE corpus, in ingest order. Recall answers "which chunk
        // matches these words"; it cannot answer "what is in here", which
        // is what an operator asks about research they ingested months ago.
        // Without this road the only way in was guessing the right technical
        // words — measured: a vague question about an ingested study returned
        // conversation ABOUT it and not one chunk OF it.
        var sgU = new URL(req.url, 'http://localhost');
        var sgName = sgU.searchParams.get('name') || sgU.searchParams.get('scope') || '';
        var stateMod2 = require('../shared-core/state.js');
        if (!sgName) { status = 400; out = { error: 'name required' }; }
        else {
          out = stateMod2.scopeChunks({
            scope:  sgName,
            limit:  parseInt(sgU.searchParams.get('limit')  || '50', 10),
            offset: parseInt(sgU.searchParams.get('offset') || '0', 10)
          });
        }
      } else if (url.startsWith('/api/substrate/rules')) {
        // The operator's own standing rules. They are type='lesson', so the
        // Rules card — which reads commitment sub-kinds (refusal/anchor/fact)
        // — could not see them at all: a rule could be written and never
        // appear on the surface named after it.
        var rlU = new URL(req.url, 'http://localhost');
        var lessonMod2 = require('../shared-core/lesson.js');
        var rlItems = lessonMod2.listRules({
          limit: parseInt(rlU.searchParams.get('limit') || '20', 10),
          cwd:   rlU.searchParams.get('cwd') || null
        });
        out = { count: rlItems.length, items: rlItems };
      } else if (url.startsWith('/api/substrate/query')) {
        // Search INSIDE one corpus. The general recall ranks a corpus against
        // everything else the mind holds, so a vague question loses to
        // conversation about the same topic. Scoped, the corpus competes only
        // with itself — which is what "find this in that study" means.
        var qsU = new URL(req.url, 'http://localhost');
        var qsScope = qsU.searchParams.get('scope') || '';
        var qsQ     = qsU.searchParams.get('q') || qsU.searchParams.get('query') || '';
        var qsK     = Math.max(1, Math.min(50, parseInt(qsU.searchParams.get('k') || '10', 10)));
        if (!qsScope || !qsQ) { status = 400; out = { error: 'scope and q required' }; }
        else {
          // The scoped search reaches the embedder, so it answers on its own
          // clock and writes its own response — the surrounding block is
          // synchronous and would otherwise reply with a null body first.
          var chameleonQ = require('../shared-core/chameleon.js');
          chameleonQ.queryScope({ scope: qsScope, query: qsQ, k: qsK }).then(function (qsR) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(qsR));
          }).catch(function (qsE) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: qsE && qsE.message }));
          });
          return;
        }
      } else if (url.startsWith('/api/substrate/anchor-suggestions')) {
        // Tier 1 / A — pattern detector for anchor suggestions.
        var asU = new URL(req.url, 'http://localhost');
        var asAgent  = asU.searchParams.get('agent_id') || resolveAgentId();
        var asStatus = asU.searchParams.get('status')   || 'pending';
        var asLimit  = parseInt(asU.searchParams.get('limit') || '50', 10);
        var anchorSuggester = require('../shared-core/anchor-suggester.js');
        var asItems = anchorSuggester.listSuggestions({ agent_id: asAgent, status: asStatus, limit: asLimit });
        out = { agent_id: asAgent, status: asStatus, count: asItems.length, items: asItems };
      } else if (url.startsWith('/api/substrate/insights')) {
        // G7 — proactive insights surfacing (delegated to insight-surfacer
        // module). Same pattern as the catchall's other delegations:
        // build `out`, status defaults 200, single res.end at bottom.
        var siU = new URL(req.url, 'http://localhost');
        var siAgent  = siU.searchParams.get('agent_id') || resolveAgentId();
        var siStatus = siU.searchParams.get('status')   || 'new';
        var siMin    = parseFloat(siU.searchParams.get('min_priority') || '0');
        var siLimit  = parseInt(siU.searchParams.get('limit') || '50', 10);
        var surfacer = require('../shared-core/insight-surfacer.js');
        var siItems  = surfacer.listInsights({ agent_id: siAgent, status: siStatus, min_priority: siMin, limit: siLimit });
        out = { agent_id: siAgent, status: siStatus, count: siItems.length, items: siItems };
      } else if (url.startsWith('/api/substrate/revisions')) {
        // G6 — commitment revision protocol (delegated to revision-protocol).
        var rvU = new URL(req.url, 'http://localhost');
        var rvAgent  = rvU.searchParams.get('agent_id') || resolveAgentId();
        var rvStatus = rvU.searchParams.get('status')   || 'all';
        var rvLimit  = parseInt(rvU.searchParams.get('limit') || '50', 10);
        var revProto = require('../shared-core/revision-protocol.js');
        var rvItems  = revProto.listProposedRevisions({ agent_id: rvAgent, status: rvStatus, limit: rvLimit });
        out = { agent_id: rvAgent, status: rvStatus, count: rvItems.length, items: rvItems };
      } else if (url === '/api/substrate/market') {
        out = { agents: sharedMarket.analyzeWinners(sharedState) || {} };
      } else if (url.startsWith('/api/substrate/cost-attribution')) {
        // P16.5 I2 — cost attribution. Two modes:
        //   ?intent_id=<uuid>  → attributeCost on a specific intent
        //   ?cwd=<path>&since=<ms> → costByIntent leaderboard
        // Falls back to lifetime cost-of-failure if neither given.
        var u2 = new URL(req.url, 'http://localhost');
        var intent_id = u2.searchParams.get('intent_id');
        var qcwd = u2.searchParams.get('cwd') || undefined;
        var qsess = u2.searchParams.get('session') || undefined;
        var qsince = u2.searchParams.get('since') ? parseInt(u2.searchParams.get('since'), 10) : undefined;
        if (intent_id) {
          out = sharedCost.attributeCost(sharedState, intent_id) || { error: 'no_data' };
        } else {
          out = {
            leaderboard: sharedCost.costByIntent(sharedState, { cwd: qcwd, session_id: qsess, since: qsince, limit: 50 }) || [],
            cost_of_failure: sharedCost.costOfFailure(sharedState, { cwd: qcwd, session_id: qsess, since: qsince })
          };
        }
      } else {
        status = 404;
        out = { error: 'unknown substrate endpoint' };
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ===== Health / Stats =====
  if (req.method === 'GET' && (url === '/health' || url === '/stats' || url === '/api/stats')) {
    var critic = null, workflow = null, cochange = null, checkpoint = null;
    var morph = null, buildgraph = null, abtest = null;
    try { critic = require('./modules/critic').getStats(); } catch (e) {}
    try { workflow = require('./modules/workflow').getState(); } catch (e) {}
    try { cochange = require('./modules/cochange').getStats(); } catch (e) {}
    try { checkpoint = require('../shared-core/tools/undo-shadow.js').getStats(); } catch (e) {}
    try { morph = require('./modules/morph').getStats(); } catch (e) {}
    try { buildgraph = require('./modules/buildgraph').getStats(); } catch (e) {}
    try { abtest = require('./modules/abtest').getStats(); } catch (e) {}
    var contextFilterData = null;
    try { contextFilterData = require('./modules/contextfilter').getStats(); } catch (e) {}

    var alibabaCapsData = null;
    try { alibabaCapsData = require('./modules/alibabaCaps').getStats(); } catch (e) {}
    var authModeData = null;
    try { authModeData = require('./modules/authmode').getStats(); } catch (e) {}
    var tokenCountData = null;
    try { tokenCountData = require('./modules/tokencount').getStats(); } catch (e) {}
    var compressionBufferData = null;
    try { compressionBufferData = require('./modules/compressionbuffer').getStats(); } catch (e) {}
    var visionValidatorData = null;
    try { visionValidatorData = require('./modules/visionvalidator').getStats(); } catch (e) {}
    var ultraReviewData = null;
    try { ultraReviewData = require('./modules/ultrareview').getStats(); } catch (e) {}
    var cacheRatioData = null;
    try { cacheRatioData = require('./modules/cacheratio').getStats(); } catch (e) {}
    var errortaxData = null;
    try { errortaxData = require('./modules/errortax').getStats(); } catch (e) {}
    var costData = null;
    try { costData = require('./modules/cost').getTotals(); } catch (e) {}
    var perflogData = null;
    try { perflogData = require('./modules/perflog').getDailyStats(); } catch (e) {}
    var gemcacheData = null;
    try { gemcacheData = trothCache.getDefault().stats(); } catch (e) {}
    // Disk-cache observability: the proxy's in-memory counters only see
    // hits served from THIS process. The MCP-server processes (cached_read,
    // cached_grep) run separately and accumulate their own counters that
    // never reach here. Read the shared SQLite cache table to surface
    // total hits across ALL processes — gives the dashboard a true
    // hit-rate signal regardless of which process served the call.
    var diskCacheData = null;
    try {
      var dbMod = require('../shared-core/state');
      var dbH = dbMod.db();
      var rows = dbH.prepare(
        "SELECT tool_name, COUNT(*) AS rows, COALESCE(SUM(hit_count),0) AS hits, " +
        "COALESCE(SUM(bytes),0) AS bytes FROM tool_response_cache GROUP BY tool_name"
      ).all();
      var total = { rows: 0, hits: 0, bytes: 0 };
      var byTool = {};
      for (var ii = 0; ii < rows.length; ii++) {
        var rr = rows[ii];
        byTool[rr.tool_name] = { rows: rr.rows, hits: rr.hits, bytes: rr.bytes };
        total.rows += rr.rows; total.hits += rr.hits; total.bytes += rr.bytes;
      }
      diskCacheData = { total: total, by_tool: byTool };
    } catch (e) { /* schema may not exist on first boot */ }
    var keepaliveData = null;
    try { keepaliveData = keepaliveMgr.stats(); } catch (e) {}
    // Persistent per-provider usage from usage_ledger (survives
    // proxy restarts, unlike router stats.tokens which is in-memory).
    // Dashboard merges this with live router stats — historical context
    // doesn't disappear when you restart the proxy.
    //
    // Two windows so the UI can show both "what's hot right now" and
    // "all my historical usage":
    //   recent_24h — last 24h rows
    //   all_time   — every usage_ledger row + the latest ts so
    //                the dashboard can surface staleness when needed.
    var persistentProviderUsage = null;
    try {
      var dbMod3 = require('../shared-core/state');
      var dbH3 = dbMod3.db();
      var since3 = Date.now() - 24 * 60 * 60 * 1000;
      var groupQuery =
        "SELECT actual_model, COUNT(*) AS calls, " +
        "       COALESCE(SUM(tokens_in), 0)  AS input_tokens, " +
        "       COALESCE(SUM(tokens_out), 0) AS output_tokens, " +
        "       COALESCE(SUM(actual_cost), 0) AS cost ";
      // usage_ledger, not baseline_cost_events: the baseline table went dead
      // on  (its two writers sit on lanes that stopped firing), so
      // the "persistent" fallback was showing 25-day-old history as truth.
      // usage_ledger is written by cost.recordUsage on EVERY completed
      // request in every lane (kimi_sub included), so it is the one place
      // that actually knows who answered. Cost is computed per model group
      // from the RATES table; flat-plan models legitimately cost $0.
      var costMod3 = require('./modules/cost');
      var ulQuery =
        "SELECT model AS actual_model, COUNT(*) AS calls, " +
        "       COALESCE(SUM(tokens_in), 0)  AS input_tokens, " +
        "       COALESCE(SUM(tokens_out), 0) AS output_tokens, " +
        "       COALESCE(SUM(cached_in), 0)  AS cached_tokens ";
      var _withCost = function (rows) {
        for (var ri = 0; ri < rows.length; ri++) {
          try {
            rows[ri].cost = costMod3.calculateCost(rows[ri].actual_model,
              rows[ri].input_tokens, rows[ri].output_tokens, rows[ri].cached_tokens).cost;
          } catch (_) { rows[ri].cost = 0; }
        }
        return rows;
      };
      var recentRows = _withCost(dbH3.prepare(
        ulQuery + "FROM usage_ledger WHERE ts >= ? " +
        "GROUP BY model ORDER BY calls DESC"
      ).all(since3));
      // The 5-hour window mirrors how subscription lanes actually meter:
      // plans rate-limit on a rolling ~5h window, so "what have I burned in
      // the CURRENT window" is the number an operator can act on — 24h and
      // all-time tell history, this one tells headroom.
      var since5 = Date.now() - 5 * 60 * 60 * 1000;
      var recent5Rows = _withCost(dbH3.prepare(
        ulQuery + "FROM usage_ledger WHERE ts >= ? " +
        "GROUP BY model ORDER BY calls DESC"
      ).all(since5));
      // peak_5h — the heaviest 5h window each model has EVER run, computed
      // over 30-minute buckets with a rolling 10-bucket sum. Providers do
      // not expose plan quotas, so "percent of limit" cannot exist honestly;
      // "percent of your own heaviest window" can — it is self-calibrating
      // and the ratio means something to the operator who lived that peak.
      try {
        var binRows = dbH3.prepare(
          "SELECT model, CAST(ts / 1800000 AS INTEGER) AS bin, " +
          "       SUM(tokens_in + tokens_out) AS tot " +
          "FROM usage_ledger GROUP BY model, bin ORDER BY model, bin"
        ).all();
        var peaks = {};
        var cur = null, buf = [];
        for (var bi = 0; bi <= binRows.length; bi++) {
          var br = binRows[bi];
          if (!br || br.model !== cur) {
            cur = br ? br.model : null; buf = [];
            if (!br) break;
          }
          buf.push({ bin: br.bin, tot: br.tot });
          while (buf.length && buf[0].bin < br.bin - 9) buf.shift();
          var sum = 0;
          for (var bj = 0; bj < buf.length; bj++) sum += buf[bj].tot;
          if (!peaks[br.model] || sum > peaks[br.model]) peaks[br.model] = sum;
        }
        for (var ri5 = 0; ri5 < recent5Rows.length; ri5++) {
          recent5Rows[ri5].peak_5h = peaks[recent5Rows[ri5].actual_model] || 0;
        }
      } catch (_) { /* the window still serves without its peak */ }
      var allRows = _withCost(dbH3.prepare(
        ulQuery + "FROM usage_ledger " +
        "GROUP BY model ORDER BY calls DESC"
      ).all());
      var meta = dbH3.prepare(
        "SELECT MAX(ts) AS latest_ts, COUNT(*) AS total_rows FROM usage_ledger"
      ).get();
      // The truthful "right now": the last request that actually completed.
      var lastServed = null;
      try {
        var lsRow = dbH3.prepare("SELECT model, ts FROM usage_ledger ORDER BY id DESC LIMIT 1").get();
        if (lsRow) lastServed = { model: lsRow.model, ts: lsRow.ts };
      } catch (_) {}
      persistentProviderUsage = {
        recent_5h:  { window_hours: 5,  by_model: recent5Rows },
        recent_24h: { window_hours: 24, by_model: recentRows },
        all_time:   { by_model: allRows, total_rows: (meta && meta.total_rows) || 0,
                      latest_ts: (meta && meta.latest_ts) || null },
        // Convenience: the dashboard prefers recent_24h when it has
        // data; falls back to all_time. by_model below is "use this".
        window_hours: recentRows.length ? 24 : null,
        by_model:     recentRows.length ? recentRows : allRows
      };
    } catch (e) { /* table absent on fresh substrate — leave null */ }
    // Flat top-level keys the desktop app's get_substrate_stats (Rust) reads
    // for the Activity panel ("tokens processed / today's spend / what you
    // stopped paying for"). They MUST come from PERSISTENT tables — the spread
    // `...stats` above is the in-memory router object that resets every proxy
    // restart, so the Activity panel showed all zeros. tokens_saved_estimate
    // counts ONLY genuine billable-token reductions (cache hits + context/bash
    // reduction) — no output_archive/populate inflation (matches analytics.js).
    var flatStats = { tokens_in: 0, tokens_out: 0, tokens_saved_estimate: 0, cost_usd_today: 0, requests_total: 0, usd_saved_total: 0 };
    try {
      var dbF = require('../shared-core/state').db();
      var dayAgoF = Date.now() - 24 * 60 * 60 * 1000;
      // usage_ledger, not baseline_cost_events: the
      // Activity panel froze on 25-day-old totals and cost_usd_today pinned
      // to 0. One ledger row per completed request in every lane.
      var bF = dbF.prepare("SELECT COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout, COUNT(*) AS reqs FROM usage_ledger").get();
      var svF = dbF.prepare("SELECT COALESCE(SUM(tokens),0) AS t FROM savings_ledger WHERE kind IN ('gemcache:hit','mcp_cache:hit','context_filter','bash_compression','hashline_edit_applied','compaction')").get();
      flatStats.tokens_in = bF.tin || 0;
      flatStats.tokens_out = bF.tout || 0;
      flatStats.requests_total = bF.reqs || 0;
      flatStats.cost_usd_today = +(ledgerSpendSince(dayAgoF).toFixed(4));
      flatStats.tokens_saved_estimate = svF.t || 0;
      // TOTAL accumulated $ saved (general, not just today) — the honest combined
      // figure: router arbitrage (baseline-vs-actual) + real cache/context token
      // savings valued at the baseline rate. Reuses analytics so the number
      // matches the dashboard and excludes the output_archive inflation.
      try {
        var anaAll = require('../shared-core/analytics.js').getAnalytics({ window: 'all' }).overview || {};
        flatStats.usd_saved_total = +(((anaAll.estimated_usd_saved || 0) + (anaAll.tokens_saved_usd_equiv || 0)).toFixed(4));
      } catch (_) {}
    } catch (e) { /* tables absent on fresh substrate — leave zeros */ }
    jsonResponse(res, 200, {
      version: VERSION, status: 'ok',
      // Build provenance for the app's staleness handshake:
      // a detached proxy survives app updates, silently serving old code.
      // pid + script + mtime let proxy_manager.rs reap a same-path proxy
      // whose file changed on disk since it booted. LOOPBACK ONLY: with
      // GF_BIND_HOST=0.0.0.0 (Tailscale/LAN opt-in) health is reachable
      // remotely, and absolute paths carry the username — the handshake
      // caller (proxy_manager.rs) always probes localhost, so remote
      // health answers stay provenance-free.
      ...(function () {
        var ra = (req.socket && req.socket.remoteAddress) || '';
        var loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
        return loop ? { pid: process.pid, script: __filename, build: PROXY_BUILD } : {};
      })(),
      // A1 context detection: the dashboard adapts per topology —
      // app installed → Observatory mode (read-only cards point at the app,
      // operator depths behind an explicit toggle); no app → full control
      // plane (the open-repo user's only GUI). core_source says which tree
      // THIS proxy runs from. Not sensitive: no paths/pids, safe for any caller.
      app_installed: (function () {
        // Structural + both standard dirs (see modules/app-detect.js) — the
        // old literal /Applications probe misdetected ~/Applications installs.
        try { return require('./modules/app-detect').detectAppInstalled(__filename); }
        catch (_) { return false; }
      })(),
      core_source: __filename.indexOf('/Contents/Resources/core/') !== -1 ? 'bundle'
        : (__filename.indexOf('node_modules') !== -1 ? 'npm' : 'dev'),
      ...stats, ...flatStats,
      guardian: guardianStats(), pinning: pinningStats(),
      loopguard: loopStats(), cache: cacheStats(),
      codelens: codeLensStats(), router: routerStats(),
      persistent_provider_usage: persistentProviderUsage,
      // The chain the router would ACTUALLY use right now (health-filtered,
      // cost/tier ordered) so the dashboard stops printing a static display
      // order that named unreachable lanes and buried the one in use.
      effective_chain: (function () {
        try { return require('./modules/router').getEffectiveChain(); } catch (_) { return null; }
      })(),
      last_served: (typeof lastServed !== 'undefined') ? lastServed : null,
      providers: getProviders(), routing: Object.assign({ mode: routingMode }, getRoutingPrefs()),
      critic: critic, workflow: workflow,
      cochange: cochange, checkpoint: checkpoint, morph: morph, buildgraph: buildgraph, abtest: abtest,
      contextfilter: contextFilterData,
      alibabaCaps: alibabaCapsData, authmode: authModeData,
      tokencount: tokenCountData, compressionbuffer: compressionBufferData,
      visionvalidator: visionValidatorData, ultrareview: ultraReviewData,
      cacheratio: cacheRatioData, errortax: errortaxData,
      cost: costData, perflog: perflogData,
      gemcache: gemcacheData, keepalive: keepaliveData,
      disk_cache: diskCacheData,
      process_started_at: PROCESS_STARTED_AT,
    });
    return;
  }

  // ===== API: Memory management =====
  // Clear workflow state
  if (req.method === 'DELETE' && url === '/api/memory/workflow') {
    try {
      require('./modules/workflow').clear();
      jsonResponse(res, 200, { ok: true });
    } catch (e) { jsonResponse(res, 500, { error: e.message }); }
    return;
  }

  // ===== API: Routing mode =====
  if (req.method === 'GET' && url === '/api/routing') {
    jsonResponse(res, 200, { mode: routingMode });
    return;
  }
  // Open MCP wire endpoints (dashboard Wire buttons + any local tool). Own
  // module, dispatched BEFORE the closed extension: these are core/sovereign
  // routes and must work identically on a public clone (A6 part 2).
  if (mcpRoutes.owns(url)) {
    mcpRoutes.handle(req, res, url, { jsonResponse, checkRemoteAuth });
    return;
  }
  // Closed-extension HTTP routes (private overlay; 404 on a public clone).
  if (_closedRoutes && _closedRoutes.owns(url)) {
    _closedRoutes.handle(req, res, url, { jsonResponse, checkRemoteAuth });
    return;
  }

  if (req.method === 'POST' && url === '/api/routing') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsedRouting = JSON.parse(body);
        const { mode } = parsedRouting;
        // Operator-declared engine order (array of provider names). Persisted
        // into config.routing.order, which loadProviders() reads back into
        // routingPrefs; the chain applies it as a reorder only.
        if (Array.isArray(parsedRouting.order)) {
          const cleanOrder = parsedRouting.order.filter(x => typeof x === 'string' && x).slice(0, 24);
          try {
            // Through the single-writer store, like every other config write.
            // This path had its own lenient read plus a raw writeFileSync: on
            // a torn or unreadable file it started from {} and wrote back a
            // config containing nothing but routing.order — providers, module
            // toggles, dispatch_prefer and the remote token all erased by one
            // click on "Save order". updateConfig re-reads strictly, merges,
            // and replaces atomically, so a corrupt file refuses the write
            // instead of becoming the new truth.
            configFileStore.updateConfig(function (current) {
              current.routing = Object.assign({}, current.routing, { order: cleanOrder });
              return current;
            });
            require('./modules/router').loadProviders();
            log('Routing order set to: ' + (cleanOrder.join(' > ') || '(cleared)'));
          } catch (e) {
            jsonResponse(res, 500, { error: 'could not persist order: ' + e.message });
            return;
          }
          if (typeof mode === 'undefined') {
            jsonResponse(res, 200, { ok: true, order: cleanOrder });
            return;
          }
        }
        if (!['auto', 'local', 'smart', 'anthropic', 'fallback'].includes(mode)) {
          jsonResponse(res, 400, { error: "mode must be 'auto', 'local', 'smart', 'anthropic', or 'fallback'" });
          return;
        }
        routingMode = mode;
        log('Routing mode set to: ' + mode);
        jsonResponse(res, 200, { ok: true, mode: routingMode });
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Persist the dispatch preference ('local' | 'hosted') into ~/.troth/config.json
  // the file loadProviders reads for routingPrefs.dispatch_prefer (preferLocal).
  // The desktop app also writes desktop-config.json (for the entity spawn env), but
  // the PROXY only reads config.json, so "Best quality first" never reached the
  // cloud-vs-local decision without this. Single writer: the proxy owns config.json;
  // the app POSTs here (mirrors the codex-login enable-flag pattern).
  if (req.method === 'POST' && url === '/api/routing/prefer') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { prefer } = JSON.parse(body);
        if (!['local', 'hosted'].includes(prefer)) {
          jsonResponse(res, 400, { error: "prefer must be 'local' or 'hosted'" });
          return;
        }
        // Single-writer path: strict read + atomic replace. A corrupt file
        // refuses the write (surfacing as a 400 below) instead of wiping
        // every field the lenient read used to lose.
        configFileStore.patchConfig({ dispatch_prefer: prefer });
        try { loadProviders(); } catch (_) {}
        log('Dispatch preference set to: ' + prefer);
        jsonResponse(res, 200, { ok: true, dispatch_prefer: prefer });
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
    });
    return;
  }

  // POST /api/routing/reload — re-read ~/.troth/config.json into the running
  // router (providers + routing.pin) WITHOUT a restart, so `/engine pin` can
  // flip the live engine mid-session: the slash handler writes config.routing.pin
  // then pokes this, and the next proxied turn uses the new engine. Benign
  // (re-reads local config, returns nothing sensitive), so it is intentionally
  // auth-free for the local slash handler to poke.
  if (req.method === 'POST' && url === '/api/routing/reload') {
    try {
      loadProviders();
      try { require('./modules/router').warmContextWindows(); } catch (_) {}
      log('Providers reloaded via /api/routing/reload');
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // ===== API: Substrate sync — the mind, reachable from paired devices =====
  //
  // POST /api/sync/event   apply one journal event (write ops)
  // POST /api/sync/query   run one allowlisted read op
  // GET  /api/sync/hello   protocol + op catalogue + latest gseq
  //
  // Namespaced /api/sync (NOT /api/substrate) — that prefix is the app's
  // legacy dashboard surface with its own catchall and its own GET /query,
  // and a shadowed route here would fail only at runtime.
  //
  // Auth is PER-DEVICE bearer tokens (sync_devices, paired via the CLI's
  // device add) — never the shared remote token, never IP trust: a tailnet
  // is not a trust boundary, and a lost device is one revoked row, not a
  // rotated secret on every machine. The op catalogue is an allowlist of
  // memory operations; nothing world-acting is reachable through here.
  //
  // Two operator-side routes ride the /api/config gate instead of device
  // auth: they answer the OPERATOR's dashboard about this install's own
  // sync posture, they move no memory.
  if (req.method === 'GET' && url === '/api/sync/status') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    (async () => {
      try {
        const rc = require('../shared-core/sync/remote-client.js');
        const st = rc.status();
        let hubState = null;
        let replica = null;
        if (st.active) {
          const h = await rc.hello();
          hubState = (h && h.ok)
            ? { reachable: true, latest_gseq: h.latest_gseq }
            : { reachable: false, revoked: !!(h && h.error === 'unknown_device') };
          try {
            replica = require('../shared-core/sync/replica.js').status();
            if (hubState.reachable) replica.behind = Math.max(0, (hubState.latest_gseq | 0) - (replica.applied_gseq | 0));
          } catch (_) {}
        }
        jsonResponse(res, 200, Object.assign(st, { hub: hubState, replica }));
      } catch (e) {
        jsonResponse(res, 500, { error: String(e && e.message || e).slice(0, 200) });
      }
    })();
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/disconnect') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      configFileStore.updateConfig((cfg) => { delete cfg.sync; return cfg; });
      jsonResponse(res, 200, { ok: true, mode: 'local' });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) });
    }
    return;
  }
  // Pairing, operator-side: mint / list / revoke device credentials from the
  // dashboard — the same primitives the CLI's device command drives. The
  // token appears exactly once, in the pair response; only its hash lives on.
  if (req.method === 'GET' && url === '/api/sync/devices') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      jsonResponse(res, 200, { ok: true, devices: require('../shared-core/sync/hub.js').listDevices() });
    } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/pair') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const name = body && typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
      if (!name) { jsonResponse(res, 400, { ok: false, error: 'name_required' }); return; }
      try {
        const d = require('../shared-core/sync/hub.js').addDevice(name);
        // The pairing CODE is the whole handshake in one string: every
        // address this machine answers on (found here — the operator
        // never hunts an IP), the minted identity, the one-time token.
        const pairing = require('../shared-core/sync/pairing.js');
        const code = pairing.encode({ hosts: pairing.candidateHosts(PORT), device_id: d.device_id, token: d.token });
        jsonResponse(res, 200, { ok: true, device_id: d.device_id, token: d.token, code, shown: 'once' });
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    });
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/revoke') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const id = body && typeof body.device_id === 'string' ? body.device_id : null;
      if (!id) { jsonResponse(res, 400, { ok: false, error: 'device_id_required' }); return; }
      try {
        const gone = require('../shared-core/sync/hub.js').revokeDevice(id);
        jsonResponse(res, gone ? 200 : 404, { ok: gone, device_id: id });
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    });
    return;
  }
  // Satellite-side one-paste pairing: decode the code, refuse self-pair,
  // probe the candidate addresses server-side (the browser could not —
  // cross-origin), write config only for an address that answered.
  if (req.method === 'POST' && url === '/api/sync/connect') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const code = body && typeof body.code === 'string' ? body.code.trim() : null;
      if (!code) { jsonResponse(res, 400, { ok: false, error: 'code_required' }); return; }
      require('../shared-core/sync/remote-client.js').connectWithCode(code).then((out) => {
        if (out.ok) { try { require('../shared-core/sync/replica.js').pull().catch(() => {}); } catch (_) {} }
        jsonResponse(res, out.ok ? 200 : 400, out);
      }).catch((e) => {
        jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) });
      });
    });
    return;
  }
  // ── Discovery + knock-to-pair on one network ──────────────────────────
  // Minds announce themselves (UDP beacon, name + port, never a secret);
  // a device ASKS to follow; the operator APPROVES on the mind machine;
  // the pairing code rides back to the asking address exactly once. The
  // knock endpoints are deliberately unauthenticated — that is what a
  // knock is — but browser-driven cross-origin calls are refused, pending
  // knocks are capped, and nothing is granted without the human click.
  if (req.method === 'GET' && url === '/api/sync/nearby') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try { jsonResponse(res, 200, { ok: true, minds: require('../shared-core/sync/discovery.js').nearby() }); }
    catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/request-pair') {
    if (isBrowserDrivenFromElsewhere(req)) { jsonResponse(res, 403, { ok: false, error: 'forbidden' }); return; }
    try {
      if (require('../shared-core/sync/remote-client.js').active()) {
        jsonResponse(res, 409, { ok: false, error: 'satellite_has_no_mind' });
        return;
      }
    } catch (_) {}
    readJsonBody(req).then((body) => {
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const r = require('../shared-core/sync/pair-requests.js').create(body && body.device_name, ip);
      if (r.error) { jsonResponse(res, 429, { ok: false, error: r.error }); return; }
      jsonResponse(res, 200, { ok: true, request_id: r.id });
    });
    return;
  }
  if (req.method === 'GET' && url.startsWith('/api/sync/request-status')) {
    if (isBrowserDrivenFromElsewhere(req)) { jsonResponse(res, 403, { ok: false, error: 'forbidden' }); return; }
    const rid = String((new URL(req.url, 'http://x')).searchParams.get('id') || '');
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    jsonResponse(res, 200, require('../shared-core/sync/pair-requests.js').statusFor(rid, ip));
    return;
  }
  if (req.method === 'GET' && url === '/api/sync/requests') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    jsonResponse(res, 200, { ok: true, requests: require('../shared-core/sync/pair-requests.js').listPending() });
    return;
  }
  if (req.method === 'POST' && (url === '/api/sync/approve' || url === '/api/sync/deny')) {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const rid = body && typeof body.request_id === 'string' ? body.request_id : null;
      if (!rid) { jsonResponse(res, 400, { ok: false, error: 'request_id_required' }); return; }
      const pr = require('../shared-core/sync/pair-requests.js');
      if (url === '/api/sync/deny') { jsonResponse(res, 200, pr.deny(rid)); return; }
      const out = pr.approve(rid, (name) => {
        const hub = require('../shared-core/sync/hub.js');
        const pairing = require('../shared-core/sync/pairing.js');
        const d = hub.addDevice(name);
        return { device_id: d.device_id, code: pairing.encode({ hosts: pairing.candidateHosts(PORT), device_id: d.device_id, token: d.token }) };
      });
      jsonResponse(res, out.error ? 404 : 200, out);
    });
    return;
  }
  // Satellite-side follow: knock on a discovered mind, wait for the human
  // there, connect the moment the code arrives. Server-side because the
  // browser cannot reach the other machine cross-origin.
  if (req.method === 'POST' && url === '/api/sync/follow') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const host = body && typeof body.host === 'string' ? body.host : null;
      const port = body && (body.port | 0);
      if (!host || !port) { jsonResponse(res, 400, { ok: false, error: 'host_and_port_required' }); return; }
      const deviceName = (body.device_name && String(body.device_name)) || require('os').hostname().replace(/\.local$/, '');
      _syncFollow = { state: 'knocking', mind: (body.name || host), host, port, started: Date.now(), error: null };
      _syncHttpJson(host, port, 'POST', '/api/sync/request-pair', { device_name: deviceName }, (r) => {
        if (!r || !r.ok || !r.request_id) {
          _syncFollow = { state: 'failed', mind: (body.name || host), error: (r && r.error) || 'no_answer' };
          return;
        }
        _syncFollow.state = 'waiting_approval';
        const rid = r.request_id;
        const t = setInterval(() => {
          if (Date.now() - _syncFollow.started > 10 * 60 * 1000) { clearInterval(t); _syncFollow = { state: 'failed', mind: _syncFollow.mind, error: 'timed_out' }; return; }
          _syncHttpJson(host, port, 'GET', '/api/sync/request-status?id=' + encodeURIComponent(rid), null, (s) => {
            if (!s) return; // transient — keep polling
            if (s.status === 'denied' || s.status === 'unknown') { clearInterval(t); _syncFollow = { state: 'denied', mind: _syncFollow.mind, error: null }; return; }
            if (s.status === 'approved' && s.code) {
              clearInterval(t);
              _syncFollow.state = 'connecting';
              require('../shared-core/sync/remote-client.js').connectWithCode(s.code).then((c) => {
                if (c && c.ok) { try { require('../shared-core/sync/replica.js').pull().catch(() => {}); } catch (_) {} }
                _syncFollow = c && c.ok
                  ? { state: 'connected', mind: _syncFollow.mind, host: c.host, error: null }
                  : { state: 'failed', mind: _syncFollow.mind, error: (c && c.error) || 'connect_failed' };
              });
            }
          });
        }, 3000);
        if (t.unref) t.unref();
      });
      jsonResponse(res, 200, { ok: true, state: 'knocking' });
    });
    return;
  }
  if (req.method === 'GET' && url === '/api/sync/follow-state') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    jsonResponse(res, 200, Object.assign({ ok: true }, _syncFollow || { state: 'idle' }));
    return;
  }
  // ── Invites — the mind knocks first ───────────────────────────────
  // The operator at the mind machine clicks Invite on a nearby device; the
  // device's operator clicks Join. The invite id carries the mind-side
  // approval, so redeeming it mints the credential in one step; it is
  // one-time, capped and it expires. Same doctrine as the knock: hearing
  // or holding an invite grants nothing without the second human click.
  if (req.method === 'POST' && url === '/api/sync/invite-create') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const dHost = body && typeof body.host === 'string' ? body.host : null;
      const dPort = body && (body.port | 0);
      if (!dHost || !dPort) { jsonResponse(res, 400, { ok: false, error: 'host_and_port_required' }); return; }
      const pr = require('../shared-core/sync/pair-requests.js');
      const inv = pr.createInvite();
      if (inv.error) { jsonResponse(res, 429, { ok: false, error: inv.error }); return; }
      const pairing = require('../shared-core/sync/pairing.js');
      _syncHttpJson(dHost, dPort, 'POST', '/api/sync/invite', {
        invite_id: inv.id,
        mind_name: require('os').hostname().replace(/\.local$/, ''),
        hosts: pairing.candidateHosts(PORT)
      }, (r) => {
        jsonResponse(res, r && r.ok ? 200 : 502, r && r.ok ? { ok: true, invited: true } : { ok: false, error: 'device_unreachable' });
      });
    });
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/invite') {
    if (isBrowserDrivenFromElsewhere(req)) { jsonResponse(res, 403, { ok: false, error: 'forbidden' }); return; }
    readJsonBody(req).then((body) => {
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const r = require('../shared-core/sync/pair-requests.js').noteInvite(body, ip);
      jsonResponse(res, r.ok ? 200 : 400, r);
    });
    return;
  }
  if (req.method === 'GET' && url === '/api/sync/invites') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    jsonResponse(res, 200, { ok: true, invites: require('../shared-core/sync/pair-requests.js').listInvites() });
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/invite-accept') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    readJsonBody(req).then((body) => {
      const pr = require('../shared-core/sync/pair-requests.js');
      const inv = pr.takeInvite(String(body && body.invite_id || ''));
      if (!inv) { jsonResponse(res, 404, { ok: false, error: 'no_such_invite' }); return; }
      const deviceName = require('os').hostname().replace(/\.local$/, '');
      const hosts = inv.hosts.slice();
      const tryNext = () => {
        const h = hosts.shift();
        if (!h) { jsonResponse(res, 502, { ok: false, error: 'mind_unreachable' }); return; }
        let u;
        try { u = new URL(h); } catch (_) { tryNext(); return; }
        _syncHttpJson(u.hostname, parseInt(u.port || '80', 10), 'POST', '/api/sync/redeem-invite', { invite_id: inv.invite_id, device_name: deviceName }, (r) => {
          if (!r || !r.ok || !r.code) { tryNext(); return; }
          require('../shared-core/sync/remote-client.js').connectWithCode(r.code).then((c) => {
            if (c && c.ok) { try { require('../shared-core/sync/replica.js').pull().catch(() => {}); } catch (_) {} }
            jsonResponse(res, c && c.ok ? 200 : 502, c);
          }).catch((e) => jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }));
        });
      };
      tryNext();
    });
    return;
  }
  if (req.method === 'POST' && url === '/api/sync/redeem-invite') {
    if (isBrowserDrivenFromElsewhere(req)) { jsonResponse(res, 403, { ok: false, error: 'forbidden' }); return; }
    readJsonBody(req).then((body) => {
      const pr = require('../shared-core/sync/pair-requests.js');
      const out = pr.redeemInvite(String(body && body.invite_id || ''), () => {
        const hub = require('../shared-core/sync/hub.js');
        const pairing = require('../shared-core/sync/pairing.js');
        const name = String(body && body.device_name || 'device').replace(/[^\w .-]/g, '').slice(0, 40) || 'device';
        const d = hub.addDevice(name);
        return { device_id: d.device_id, code: pairing.encode({ hosts: pairing.candidateHosts(PORT), device_id: d.device_id, token: d.token }) };
      });
      jsonResponse(res, out.error ? 404 : 200, out);
    });
    return;
  }
  if (req.method === 'GET' && url.startsWith('/api/mind/bundles')) {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const scope = String((new URL(req.url, 'http://x')).searchParams.get('scope') || 'backups');
      const backupLib = require('../shared-core/substrate-backup.js');
      let bundles;
      if (scope === 'transfers') {
        // Where a mind ARRIVES on a Mac: the AirDrop landing zone and the
        // desk. The backups home is deliberately not in this list — those
        // are this machine's own restore points, a different shelf.
        const home = process.env.HOME || require('os').homedir();
        bundles = backupLib.listBundles({ dirs: [path.join(home, 'Downloads'), path.join(home, 'Desktop')] });
      } else {
        bundles = backupLib.listBundles();
      }
      jsonResponse(res, 200, { ok: true, scope, bundles });
    } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    return;
  }
  if (url === '/api/sync/hello' || url === '/api/sync/event' || url === '/api/sync/query' || url.startsWith('/api/sync/events') || url === '/api/sync/baseline') {
    const hub = require('../shared-core/sync/hub.js');
    const _am = /^Bearer\s+(.+)$/i.exec(String(req.headers['authorization'] || ''));
    const device = _am ? hub.authDevice(_am[1]) : null;
    if (!device) {
      jsonResponse(res, 401, { ok: false, error: 'unknown_device' });
      return;
    }
    if (req.method === 'GET' && url === '/api/sync/hello') {
      jsonResponse(res, 200, hub.hello());
      return;
    }
    // The feed — the journal after a position, for a replica catching up.
    if (req.method === 'GET' && url.startsWith('/api/sync/events')) {
      try {
        const q = new URL(req.url, 'http://x').searchParams;
        jsonResponse(res, 200, { ok: true, events: hub.listEventsSince(parseInt(q.get('since') || '0', 10) || 0, parseInt(q.get('limit') || '200', 10) || 200) });
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
      return;
    }
    // The first breath — the whole mind as id-keyed atlas, stamped with the
    // journal position it was cut at. Big on purpose; it rides the LAN once.
    if (req.method === 'GET' && url === '/api/sync/baseline') {
      try { jsonResponse(res, 200, hub.baseline()); }
      catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 200) }); }
      return;
    }
    if (req.method === 'POST' && url === '/api/sync/event') {
      readJsonBody(req).then((body) => {
        if (!body || typeof body !== 'object') {
          jsonResponse(res, 400, { ok: false, error: 'bad_envelope' });
          return;
        }
        // The token IS the device — an envelope claiming another device_id
        // is refused before it can touch that device's watermark.
        if (body.device_id !== device.device_id) {
          jsonResponse(res, 403, { ok: false, error: 'device_id_mismatch' });
          return;
        }
        hub.applyEvent(body).then((out) => {
          const code =
            out.error === 'bad_envelope'          ? 400 :
            out.error === 'unknown_device'        ? 401 :
            out.error === 'sequence_gap'          ? 409 :
            out.error === 'version_not_supported' ? 426 : 200;
          jsonResponse(res, code, out);
        }).catch((e) => {
          jsonResponse(res, 500, { ok: false, error: 'apply_threw', detail: String(e && e.message || e).slice(0, 300) });
        });
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/sync/query') {
      readJsonBody(req).then((body) => {
        if (!body || typeof body.op !== 'string') {
          jsonResponse(res, 400, { ok: false, error: 'bad_query' });
          return;
        }
        const qctx = Object.assign({}, (body.ctx && typeof body.ctx === 'object') ? body.ctx : {}, { device_id: device.device_id });
        hub.runQuery(body.op, body.args || {}, qctx).then((out) => {
          jsonResponse(res, out.ok ? 200 : 400, out);
        }).catch((e) => {
          jsonResponse(res, 500, { ok: false, error: 'query_threw', detail: String(e && e.message || e).slice(0, 300) });
        });
      });
      return;
    }
    jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  // ===== API: v6.2 — Remote run dispatch =====
  //
  // POST /api/runs              start a new run
  // GET  /api/runs              list all runs
  // GET  /api/runs/<id>         get one run's metadata + state
  // GET  /api/runs/<id>/logs    get captured logs (optional ?tail=N bytes)
  // GET  /api/runs/<id>/diff    get the git diff vs parent branch
  // POST /api/runs/<id>/kill    stop a running container
  // DELETE /api/runs/<id>       remove the worktree and container
  //
  // All endpoints require Authorization: Bearer <token> matching the
  // daemon's REMOTE_TOKEN. Token is auto-generated on first daemon
  // startup and stored in ~/.troth/config.json. Print it from the
  // dashboard or read it from the config file to copy to the laptop.
  if (url === '/api/runs' || url.startsWith('/api/runs/')) {
    if (!checkRemoteAuth(req)) {
      jsonResponse(res, 401, { error: 'unauthorized — set Authorization: Bearer <remoteToken>' });
      return;
    }
    const runner = getRunner();
    if (!runner) {
      jsonResponse(res, 500, { error: 'runner not available on this host' });
      return;
    }

    // POST /api/runs — create
    if (req.method === 'POST' && url === '/api/runs') {
      readJsonBody(req).then((body) => {
        if (!body || !body.task) {
          jsonResponse(res, 400, { error: 'body must include { task: "<description>" }' });
          return;
        }
        try {
          const result = runner.apiCreateRun(body.task, body.options || {});
          if (result.ok) {
            log('[remote] new run: ' + result.runId + ' (' + body.task.slice(0, 60) + ')');
            jsonResponse(res, 201, result);
          } else {
            jsonResponse(res, 400, result);
          }
        } catch (e) {
          jsonResponse(res, 500, { error: 'runner threw: ' + (e.message || String(e)) });
        }
      });
      return;
    }

    // GET /api/runs — list
    if (req.method === 'GET' && url === '/api/runs') {
      try {
        const runs = runner.apiListRuns();
        jsonResponse(res, 200, { ok: true, runs: runs });
      } catch (e) {
        jsonResponse(res, 500, { error: e.message });
      }
      return;
    }

    // /api/runs/<id>... routes
    const tail = url.slice('/api/runs/'.length);
    const parts = tail.split('/');
    const runId = parts[0];
    const action = parts[1] || null;

    if (!runId || runId.length === 0) {
      jsonResponse(res, 400, { error: 'missing run id' });
      return;
    }

    // GET /api/runs/<id>
    if (req.method === 'GET' && action === null) {
      try {
        const r = runner.apiGetRun(runId);
        if (r.ok) jsonResponse(res, 200, r);
        else jsonResponse(res, 404, r);
      } catch (e) {
        jsonResponse(res, 500, { error: e.message });
      }
      return;
    }

    // GET /api/runs/<id>/logs
    if (req.method === 'GET' && action === 'logs') {
      try {
        const tailBytes = parseInt(query.get('tail') || '0', 10) || 0;
        const r = runner.apiGetRunLogs(runId, tailBytes);
        if (r.ok) jsonResponse(res, 200, r);
        else jsonResponse(res, 404, r);
      } catch (e) {
        jsonResponse(res, 500, { error: e.message });
      }
      return;
    }

    // GET /api/runs/<id>/diff
    if (req.method === 'GET' && action === 'diff') {
      try {
        const r = runner.apiGetRunDiff(runId);
        if (r.ok) jsonResponse(res, 200, r);
        else jsonResponse(res, 404, r);
      } catch (e) {
        jsonResponse(res, 500, { error: e.message });
      }
      return;
    }

    // POST /api/runs/<id>/kill
    if (req.method === 'POST' && action === 'kill') {
      try {
        const r = runner.apiKillRun(runId);
        if (r.ok) jsonResponse(res, 200, r);
        else jsonResponse(res, 404, r);
      } catch (e) {
        jsonResponse(res, 500, { error: e.message });
      }
      return;
    }

    // DELETE /api/runs/<id>
    if (req.method === 'DELETE' && action === null) {
      try {
        const r = runner.apiRemoveRun(runId);
        if (r.ok) jsonResponse(res, 200, r);
        else jsonResponse(res, 404, r);
      } catch (e) {
        jsonResponse(res, 500, { error: e.message });
      }
      return;
    }

    jsonResponse(res, 404, { error: 'unknown route ' + req.method + ' ' + url });
    return;
  }

  // ===== API: Schedules (v6.3) =====
  // A3: schedules dispatch Docker runs exactly like /api/runs,
  // so they carry the same token gate. Loopback bypass inside checkRemoteAuth
  // keeps the localhost dashboard working; remote callers need the bearer.
  if (url === '/api/schedules' || url.startsWith('/api/schedules/')) {
    if (!checkRemoteAuth(req)) {
      jsonResponse(res, 401, { error: 'unauthorized — set Authorization: Bearer <remoteToken>' });
      return;
    }
  }
  if (req.method === 'GET' && url === '/api/schedules') {
    // Whether the timer is running is part of the answer: a list of schedules
    // that cannot fire reads as a list of schedules that will.
    jsonResponse(res, 200, { ok: true, schedules: scheduler.listSchedules(),
      willFire: scheduler.schedulingEnabled() });
    return;
  }
  if (req.method === 'POST' && url === '/api/schedules') {
    readJsonBody(req).then(function(body) {
      if (!body || !body.cron || !body.task) {
        jsonResponse(res, 400, { error: 'body must include { cron, task, cwd? }' });
        return;
      }
      var r = scheduler.addSchedule(body.cron, body.task, body.cwd);
      jsonResponse(res, r.ok ? 201 : 400, r);
    });
    return;
  }
  if (req.method === 'DELETE' && url.startsWith('/api/schedules/')) {
    var schedId = url.slice('/api/schedules/'.length);
    var r = scheduler.removeSchedule(schedId);
    jsonResponse(res, r.ok ? 200 : 404, r);
    return;
  }

  // ===== API: Open run folder in Finder =====
  if (req.method === 'POST' && url.match(/^\/api\/runs\/[^/]+\/open$/)) {
    var openRunId = decodeURIComponent(url.split('/')[3]);
    var openRunner = getRunner();
    if (openRunner) {
      // The workspace comes from the runner's gate, not from the meta file:
      // whatever path is handed to `open` is launched.
      var openResult = openRunner.apiRunWorkspace(openRunId);
      if (openResult.ok) {
        try {
          require('child_process').spawn('open', [openResult.worktree], { detached: true, stdio: 'ignore' }).unref();
          jsonResponse(res, 200, { ok: true });
        } catch (e) {
          jsonResponse(res, 500, { error: e.message });
        }
      } else {
        jsonResponse(res, 404, { error: 'run not found' });
      }
    } else {
      jsonResponse(res, 500, { error: 'runner not available' });
    }
    return;
  }

  // ===== API: Print remote token (local-only, for showing in setup) =====
  // Only respond when bound to localhost — this prevents anyone over Tailscale
  // from grabbing the token without already knowing it.
  if (req.method === 'GET' && url === '/api/remote-token') {
    if (BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost') {
      jsonResponse(res, 403, { error: 'token endpoint disabled on non-loopback bind' });
      return;
    }
    jsonResponse(res, 200, { token: REMOTE_TOKEN });
    return;
  }

  // ===== API: Connection state =====
  // Powers the global "where am I" strip on the dashboard. Combines
  // plugin presence (substrate heartbeat) with proxy traffic signals
  // so the user can see at a glance: is the plugin running? is the
  // proxy receiving LLM requests? what's the env-var to wire up?
  if (req.method === 'GET' && url === '/api/connection-state') {
    try {
      var stateLib = require('../shared-core/state.js');
      var presence = stateLib.isPluginActive(10 * 60 * 1000);
      // Last 24h proxy request count from usage_ledger (one row per LLM
      // request that returned a usage block; baseline_cost_events is dead).
      var since = Date.now() - 24 * 60 * 60 * 1000;
      var bce = stateLib.db().prepare(
        'SELECT COUNT(*) AS n, MAX(ts) AS last_ts FROM usage_ledger WHERE ts >= ?'
      ).get(since);
      jsonResponse(res, 200, {
        plugin: {
          active: !!presence.active,
          session_id: presence.session_id || null,
          last_seen_ts: presence.last_seen_ts || null
        },
        proxy: {
          receiving: !!(bce.last_ts && (Date.now() - bce.last_ts) < 10 * 60 * 1000),
          last_request_ts: bce.last_ts || null,
          requests_24h: bce.n || 0,
          port: listenPort,
          env_command: 'ANTHROPIC_BASE_URL=http://localhost:' + listenPort + ' claude'
        }
      });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // ===== API: Analytics =====
  // Unified telemetry view across substrate + in-memory proxy modules.
  // Query params:
  //   window=session|today|7d|all   (default: today)
  //   session_id=<sid>              (optional, scopes to one session)
  if (req.method === 'GET' && url === '/api/analytics') {
    try {
      const a = require('../shared-core/analytics.js');
      const w = query.get('window') || 'today';
      const sid = query.get('session_id') || null;
      jsonResponse(res, 200, a.getAnalytics({ window: w, session_id: sid }));
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // ===== API: Config =====
  // Auth-gated + secret-redacted. Only loopback (the dashboard) passes
  // checkRemoteAuth without a token; every other caller must present the
  // bearer token. Response is run through secrets.redactObject
  // so apiKey / token / password fields are masked. The dashboard knows
  // the keys are masked and shows them as "set / unset"; explicit reveal
  // (for editing) requires the token via /api/config (POST won't be
  // necessary if the user is just viewing).
  if (req.method === 'GET' && url === '/api/config') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    jsonResponse(res, 200, secrets.redactObject(readConfig()));
    return;
  }

  // ===== API: model catalog =====
  // The ONE curated model list per provider (proxy/modules/catalog.js).
  // Dashboard cards and the first-run onboarding render their model
  // dropdowns from this, so there is a single place ids get maintained
  // instead of placeholders drifting per surface.
  if (req.method === 'GET' && url === '/api/catalog') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try { jsonResponse(res, 200, require('./modules/catalog').getCatalog()); }
    catch (e) { jsonResponse(res, 500, { error: 'catalog_failed', detail: String(e && e.message || e) }); }
    return;
  }

  // ===== API: which chat histories exist on this machine =====
  // The importer's own --detect walk, surfaced so the UI offers only sources
  // that are actually here. Offering "Import Codex chats" on a machine with
  // no Codex is an instruction to fail — an operator hit exactly that.
  // ── Memory manager: search what the partner remembers, forget what should
  // go. Read and retire both ride the substrate's own paths — retrieveRelevant
  // for search, and the /forget skill for retirement, so the dashboard can
  // never do more than the operator's own slash command (signed facts stay
  // protected, retirement is the same supersession pointer).
  if (req.method === 'GET' && url.startsWith('/api/memory/search')) {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    (async () => {
      try {
        const q = String((new URL(req.url, 'http://x')).searchParams.get('q') || '').trim();
        if (!q) { jsonResponse(res, 200, { items: [] }); return; }
        // The SAME recall the partner uses — hybrid lexical + dense over the
        // whole recallable corpus. This used to call the legacy
        // commitment-only path, whose candidate window is the newest 200
        // engrams scored on word overlap with no embeddings at all: on a
        // large substrate that is only the last week deep, so typing a
        // memory's own words verbatim cannot find anything older.
        // The search a human runs and the recall the partner runs
        // now answer from the same engine, or they teach the human that the
        // memory is broken when it is not.
        const recall = require('../shared-core/recall.js');
        const st = require('../shared-core/state.js');
        const hits = await recall.recall({ query: q, class: 'all', audience: 'model_visible', limit: 20, cwd: WATCH_DIR, rerank: true });
        // Retirement applies to commitment engrams only, and never to a signed
        // operator fact. Deciding that HERE lets the UI offer Forget only where
        // it can actually work, instead of showing a button that fails.
        const items = (hits || []).map(function (r) {
          let forgettable = false;
          try {
            const row = st.getAction(r.id);
            if (row && row.type === 'commitment') {
              const o = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {});
              forgettable = (o.commitment_type || 'engram') === 'engram'
                         && (o.source_authority || 'regex_extracted') !== 'operator_confirmed';
            }
          } catch (_) { forgettable = false; }
          return { id: r.id, statement: r.statement, ts: r.ts || r.timestamp || null, forgettable: forgettable };
        });
        jsonResponse(res, 200, { items: items });
      } catch (e) { jsonResponse(res, 200, { items: [], error: String(e && e.message || e) }); }
    })();
    return;
  }
  if (req.method === 'POST' && url === '/api/memory/forget') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let fb = '';
    req.on('data', (c) => { fb += c; });
    req.on('end', () => {
      (async () => {
        try {
          const body = JSON.parse(fb || '{}');
          // The row id when the caller listed the row (the dashboard always
          // has it), the statement only as the CLI-shaped fallback. Passing
          // text made /forget re-derive its own target through a lookup whose
          // window is the newest 200 engrams, which retired a DIFFERENT memory
          const targetId = String(body.id || '').trim();
          const stmt = String(body.statement || '').trim();
          if (!targetId && !stmt) { jsonResponse(res, 400, { ok: false, error: 'missing_statement' }); return; }
          const loader = require('../shared-core/slash/loader.js');
          const executor = require('../shared-core/slash/executor.js');
          const skill = loader.load('forget', { cwd: WATCH_DIR });
          if (!skill) { jsonResponse(res, 500, { ok: false, error: 'forget_unavailable' }); return; }
          const r = await executor.executeDeterministic(skill,
            { name: 'forget', raw_args: stmt, args_array: [stmt], target_id: targetId || null },
            { agent_id: null, cwd: WATCH_DIR, user_id: 'default', conversation_id: null });
          jsonResponse(res, 200, r || { ok: false, error: 'no_result' });
        } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e) }); }
      })();
    });
    return;
  }

  // Stop / start background upkeep. The embedding runs on this machine's own
  // CPU, so "my laptop is frying" is a legitimate and frequent reason to want
  // it to stop NOW — and before this the only answers were kill the proxy or
  // set an environment variable and restart. Neither is available to someone
  // who did not build this, and neither comes back on its own.
  //
  // Writes a file, not a process signal: the worker in THIS proxy, the one in
  // the entity daemon and the one-shot scheduler in the hooks are three
  // runners, and a pause only one of them honours is not a pause.
  if (req.method === 'POST' && url === '/api/memory/pause') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let pb = '';
    req.on('data', (c) => { pb += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(pb || '{}');
        const gate = require('../shared-core/maintenance-gate.js');
        const r = body.paused === false
          ? gate.resume()
          : gate.pause({ by: 'dashboard', reason: body.reason || null });
        // Take the pause immediately rather than at the next 30s tick: the
        // operator pressing this is watching the fans, not the clock.
        try {
          if (r.paused && global.__troth_maintenance && global.__troth_maintenance.noteForegroundActivity) {
            global.__troth_maintenance.noteForegroundActivity();
          }
        } catch (_) {}
        jsonResponse(res, 200, Object.assign({}, r, gate.isPaused()));
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }

  // Take one thing out of the reading queue. Seeing a queue you cannot act on
  // just relocates the frustration — the operator who finds a folder in there
  // that should not be there needs a way to say so.
  if (req.method === 'POST' && url === '/api/memory/queue/drop') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let db2 = '';
    req.on('data', (c) => { db2 += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(db2 || '{}');
        const ok = require('../shared-core/state.js').dropPendingKnowledge(parseInt(body.id, 10));
        jsonResponse(res, 200, { ok: !!ok });
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }

  // Read a batch NOW instead of waiting for the next idle window.
  //
  // The scheduled drain is deliberately gentle — 8 documents every 15 minutes,
  // so it never competes with the operator — which means a queue of 183 takes
  // most of a day. That is the right default and the wrong answer to someone
  // sitting in front of the machine asking why it has not finished. So: the
  // same drain, the same budget cap, on the operator's word.
  //
  // Bounded on purpose (25 documents, ~19s of embedder time). An unbounded
  // "do it all" button is a bulk run that heats the machine for an hour;
  // press it again for the next batch.
  if (req.method === 'POST' && url === '/api/memory/drain-now') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    // Nothing here reads the body, but it must still be drained: an unread
    // POST body stalls the NEXT request on a keep-alive connection, and this
    // handler holds the socket open for ~19 seconds while it embeds.
    req.resume();
    (async () => {
      try {
        const gate = require('../shared-core/maintenance-gate.js');
        // Refuses while paused rather than quietly overriding it: a button that
        // ignores the stop button next to it makes both untrustworthy.
        if (gate.isPaused().paused) { jsonResponse(res, 200, { ok: false, paused: true }); return; }
        const stateD = require('../shared-core/state.js');
        const r = await require('../shared-core/knowledge-drain.js').drainOnce(stateD, { budget: 25 });
        jsonResponse(res, 200, Object.assign({ ok: true }, r));
      } catch (e) { jsonResponse(res, 500, { ok: false, error: String(e && e.message || e) }); }
    })();
    return;
  }

  if (req.method === 'GET' && url === '/api/memory/import-sources') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      require('child_process').execFile(process.execPath,
        [path.join(__dirname, '..', 'bin', 'troth-import-chats.js'), '--detect'],
        { timeout: 20000, maxBuffer: 1024 * 1024 },
        function (err, stdout) {
          if (err) { jsonResponse(res, 200, { detected: [] }); return; }
          try { jsonResponse(res, 200, JSON.parse(String(stdout).trim() || '{"detected":[]}')); }
          catch (_) { jsonResponse(res, 200, { detected: [] }); }
        });
    } catch (e) {
      jsonResponse(res, 200, { detected: [] });
    }
    return;
  }

  // ===== API: the local stack, one component at a time =====
  // Setup used to ask "turn on memory?" and then only nudge the embedder,
  // leaving the reranker and the local chat model to be discovered by someone
  // who already knew they existed. Everything the open core offers locally is
  // named here, each with its own offer, its own progress and its own proof —
  // and where a platform cannot do it, the exact command that can.
  //
  //   GET  /api/setup/local          what exists, what is missing, what blocks
  //   POST /api/setup/local {part}   start that one part (binary|embedder|reranker|chat)
  if (req.method === 'GET' && url === '/api/setup/local') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const os3 = require('os');
      const home3 = process.env.HOME || os3.homedir();
      const binPath = process.env.TROTH_LLAMA_SERVER_BIN ||
        path.join(home3, '.troth', 'bin', 'llama-server');
      const binPresent = fs.existsSync(binPath);
      // Which platforms the vendored binary auto-fetches for. This must match
      // shared-core/local-server.js's asset picker exactly — it briefly said
      // "Apple Silicon only" while ensureBinary() was already fetching
      // ubuntu-x64/arm64 and macos-x64, so the dashboard hid Install buttons
      // for downloads the wizard was performing successfully on the same
      // machine. Windows ships .zip, which the tar-based path cannot unpack.
      const binAuto = (process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64')) ||
                      (process.platform === 'linux'  && (process.arch === 'arm64' || process.arch === 'x64'));
      let inProc = false;
      try { require.resolve('node-llama-cpp'); inProc = true; } catch (_) {}

      let emb = {}; try { emb = require('../shared-core/local-embedder.js').status() || {}; } catch (_) {}
      // Reports `verified` below, so it starts the self-test too.
      if (emb.download_done) kickEmbedVerify();
      let chat = {}; try { chat = require('../shared-core/local-chat.js').status() || {}; } catch (_) {}
      const modelsDir = process.env.TROTH_EMBED_DIR || path.join(home3, '.troth', 'models');
      let files = []; try { files = fs.readdirSync(modelsDir); } catch (_) {}
      const rerankOnDisk = files.some(function (f) { return /reranker/i.test(f) && /\.gguf$/i.test(f); });
      let rerankServing = false;
      try { rerankServing = !!require('../shared-core/local-reranker.js').isAvailable(); } catch (_) {}

      jsonResponse(res, 200, {
        platform: process.platform + '/' + process.arch,
        parts: {
          // The engine that serves the two models over HTTP.
          binary: {
            label: 'Memory engine (llama.cpp)',
            size: '~20 MB',
            present: binPresent,
            can_install: binAuto,
            blocked: binPresent || binAuto ? null :
              'not auto-installed on ' + process.platform + '/' + process.arch +
              ' — build llama.cpp yourself (b9957+) and set TROTH_LLAMA_SERVER_BIN to it',
            note: binPresent ? 'ready' : (binAuto ? 'downloads on request' : 'needed only for reranking and the bundled local chat')
          },
          // Semantic recall. Works without the binary through node-llama-cpp.
          embedder: {
            label: 'Semantic recall (EmbeddingGemma 300M)',
            size: '~333 MB',
            present: !!emb.download_done,
            progress: typeof emb.download_progress === 'number' ? emb.download_progress : 0,
            // `downloading` latches true for the process lifetime when the
            // node-llama-cpp import fails (the first catch returns without
            // clearing the promise), so a machine that installed without
            // optional dependencies would show "Downloading… 0%" forever —
            // exactly the machine the doctor rewrite exists to be honest
            // about. An unavailable runtime is never downloading.
            downloading: !!emb.downloading && !emb.unavailable,
            verified: _embedVerified === true,
            can_install: binPresent || inProc,
            blocked: (binPresent || inProc) ? null :
              'nothing can run it here: no llama-server binary and node-llama-cpp is not installed (npm install restores it)'
          },
          // Final ordering of recall results. Server-only — no in-process path.
          reranker: {
            label: 'Result ranking (bge-reranker v2)',
            size: '~610 MB',
            present: rerankOnDisk,
            serving: rerankServing,
            can_install: binPresent || binAuto,
            blocked: (binPresent || binAuto) ? null :
              'needs the llama.cpp server above; recall works without it, just less sharply ordered'
          },
          // Answers on your own hardware, no account at all.
          chat: {
            label: 'local chat model (' + (chat.model_id || 'device-picked') + ')',
            size: 'several GB, chosen for this machine’s RAM',
            present: !!chat.download_done,
            progress: typeof chat.download_progress === 'number' ? chat.download_progress : 0,
            // Same latch as the embedder: report progress only while the
            // runtime is actually usable.
            downloading: !!chat.downloading && !chat.unavailable,
            can_install: binPresent || binAuto,
            blocked: (binPresent || binAuto) ? null :
              'needs the llama.cpp server above — or point troth at Ollama / LM Studio instead, which is the easier path here'
          }
        }
      });
    } catch (e) {
      jsonResponse(res, 500, { error: 'local_status_failed', detail: String(e && e.message || e) });
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/setup/local') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let lbody = '';
    req.on('data', c => lbody += c);
    req.on('end', () => {
      let part = '';
      try { part = String(JSON.parse(lbody || '{}').part || ''); } catch (_) {}
      // Fire-and-forget every time: these are multi-hundred-megabyte fetches
      // and an HTTP response held open for one is a request that times out.
      // The GET above is the progress channel.
      try {
        if (part === 'binary') {
          require('../shared-core/local-server.js').ensureBinary().catch(function () {});
        } else if (part === 'embedder') {
          require('../shared-core/local-embedder.js').prepareModel().catch(function () {});
        } else if (part === 'reranker') {
          // ensureServer fetches the GGUF once the binary exists, then serves it.
          Promise.resolve(require('../shared-core/local-reranker.js').ensureServer()).catch(function () {});
        } else if (part === 'chat') {
          require('../shared-core/local-chat.js').prepareModel().catch(function () {});
        } else {
          jsonResponse(res, 400, { error: 'unknown_part', allowed: ['binary', 'embedder', 'reranker', 'chat'] });
          return;
        }
        jsonResponse(res, 200, { started: true, part: part });
      } catch (e) {
        jsonResponse(res, 500, { error: 'start_failed', part: part, detail: String(e && e.message || e) });
      }
    });
    return;
  }

  // ===== API: how far the running import has got =====
  // The importer already writes {"progress":{done,total,...}} per session and
  // a final {"result":{...}} into ~/.troth/import-chats.log; nothing read it,
  // so the UI could only say "started" and then go quiet for the length of a
  // months-deep walk. Tail the log rather than hold an HTTP connection open.
  if (req.method === 'GET' && url === '/api/memory/import-status') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const logPath = path.join(require('os').homedir(), '.troth', 'import-chats.log');
      let tail = '';
      try {
        const fd = fs.openSync(logPath, 'r');
        const size = fs.fstatSync(fd).size;
        const want = Math.min(size, 64 * 1024);       // last 64K is plenty
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        fs.closeSync(fd);
        tail = buf.toString('utf8');
      } catch (_) { jsonResponse(res, 200, { running: false, progress: null, result: null }); return; }
      let progress = null, result = null;
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l || l[0] !== '{') continue;
        let j; try { j = JSON.parse(l); } catch (_) { continue; }
        if (!result && j.result) result = j.result;
        if (!progress && j.progress) progress = j.progress;
        if (result && progress) break;
      }
      // A result line AFTER the last progress line means the run finished.
      const finished = !!result && (!progress || (progress.done >= progress.total));
      jsonResponse(res, 200, {
        running: !!progress && !finished,
        progress: progress,
        result: finished ? result : null
      });
    } catch (e) {
      jsonResponse(res, 500, { error: 'import_status_failed', detail: String(e && e.message || e) });
    }
    return;
  }

  // ===== API: import existing chats into memory =====
  // Fires bin/troth-import-chats.js DETACHED (it walks months of history and
  // must not hold an HTTP response open); output goes to a log the response
  // names. Source is validated against the two local readers — nothing from
  // the request reaches a command line. The onboarding overlay and the
  // terminal wizard both call this, so "import my chats" is one behavior.
  if (req.method === 'POST' && url === '/api/memory/import-chats') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let ibody = '';
    req.on('data', c => ibody += c);
    req.on('end', () => {
      try {
        let src = 'claude-cli';
        try { src = (JSON.parse(ibody || '{}').source || 'claude-cli'); } catch (_) {}
        if (src !== 'claude-cli' && src !== 'codex') {
          jsonResponse(res, 400, { error: 'bad_source', allowed: ['claude-cli', 'codex'] }); return;
        }
        const os2 = require('os');
        const logPath = path.join(os2.homedir(), '.troth', 'import-chats.log');
        const fd = fs.openSync(logPath, 'a');
        const child = require('child_process').spawn(process.execPath,
          // --full: both halves (raw archive + distilled facts), the same
          // contract the app's Rust import sends. The dashboard used to
          // spawn bare (raw-only), so an open-repo user's import built the
          // archive but never the recallable facts — the two surfaces
          // disagreeing about what "import" MEANS is the same two-truths
          // disease as the config mirrors. The distill half calls THIS
          // proxy for its gentle per-session inference, which is up by
          // definition here.
          [path.join(__dirname, '..', 'bin', 'troth-import-chats.js'), '--source', src, '--full'],
          { detached: true, stdio: ['ignore', fd, fd] });
        child.unref();
        try { fs.closeSync(fd); } catch (_) {}
        jsonResponse(res, 200, { started: true, source: src, log: logPath });
      } catch (e) {
        jsonResponse(res, 500, { error: 'import_failed', detail: String(e && e.message || e) });
      }
    });
    return;
  }

  // ===== API: Orchestration groups (sub-agent live view) =====
  // GET /api/orchestration/groups returns the list of orchestration groups
  // visible in substrate, with per-role status pulled from agent-supervisor.
  // Workers write engrams under agent_id='role-<name>-<groupId>'; we walk
  // listAgentsWithEngrams() to discover group ids cheaply, then call
  // mergeResults(groupId) which does the per-role aggregation +
  // disagreement classification.
  if (req.method === 'GET' && url === '/api/orchestration/groups') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const eng        = require('../shared-core/engram.js');
      const supervisor = require('../shared-core/agent-supervisor.js');
      const agents = eng.listAgentsWithEngrams({ limit: 100 }) || [];
      // Pattern: agent_id='role-<roleName>-orch-<groupTail>'. Extract
      // groupId = 'orch-<tail>'. Dedupe.
      const groupSet = new Set();
      for (const a of agents) {
        const m = /^role-[^-]+-(orch-[a-z0-9-]+)$/i.exec(a.agent_id || '');
        if (m) groupSet.add(m[1]);
      }
      const groups = [];
      for (const gid of Array.from(groupSet).slice(0, 25)) {
        try { groups.push(supervisor.mergeResults(gid, {})); }
        catch (_) { groups.push({ group_id: gid, status: 'merge_failed' }); }
      }
      // Newest first by group_id (orch-<timestamp36>-…).
      groups.sort((a, b) => (b.group_id || '').localeCompare(a.group_id || ''));
      jsonResponse(res, 200, { groups, group_count: groups.length });
    } catch (e) {
      jsonResponse(res, 500, { error: 'orchestration_load_failed', detail: String(e && e.message || e) });
    }
    return;
  }

  // ===== API: Slash skills inventory =====
  // GET returns shared-core/slash/loader.loadAll() data so the
  // dashboard can list every bundled + user-installed skill (name,
  // description, kind, source_path, allowed_tools, auto_persist).
  // Read-only and local-only — no auth gate beyond local bind.
  if (req.method === 'GET' && url === '/api/skills') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const slashLoader = require('../shared-core/slash/loader.js');
      const map = slashLoader.loadAll({ cwd: process.cwd() });
      const skills = [];
      for (const [name, rec] of map) {
        skills.push({
          name,
          description:  rec.description,
          kind:         rec.kind,
          source_layer: rec.source_layer,
          source_path:  rec.source_path,
          allowed_tools: rec.allowed_tools,
          auto_persist: rec.auto_persist,
          argument_hint: rec.argument_hint
        });
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
      jsonResponse(res, 200, { skills, count: skills.length });
    } catch (e) {
      jsonResponse(res, 500, { error: 'skills_load_failed', detail: String(e && e.message || e) });
    }
    return;
  }

  // ===== API: Transport endpoints config (substrate-as-entity) =====
  // GET returns the snapshot of every transport endpoint with its
  // resolved value + source (env/file/default). POST persists a
  // partial override to ~/.troth/config.json. Same auth as
  // /api/config — local-only by default.
  if (req.method === 'GET' && url === '/api/transport-config') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const tcfg = require('../shared-core/transport-config.js');
      jsonResponse(res, 200, {
        snapshot: tcfg.snapshot(),
        defaults: tcfg.BUILT_IN_DEFAULTS,
        env_keys: tcfg.ENV_KEYS,
        config_path: tcfg.CONFIG_PATH
      });
    } catch (e) {
      jsonResponse(res, 500, { error: 'transport-config unavailable', detail: e && e.message });
    }
    return;
  }
  // ===== API: Substrate identity (refusals + anchors) =====
  // Lists active substrate commitments from L1. The dashboard renders
  // these in the Substrate panel. Write path is POST below — caller
  // sends {refusals:[], anchors:[]}, server replaces the agent's
  // active set (deletes prior, records new). Local-only by default.
  if (req.method === 'GET' && url === '/api/substrate/identity') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const state = require('../shared-core/state.js');
      const ar    = require('../shared-core/action-record.js');
      const agent_id = query.get('agent_id') || resolveAgentId();
      const cwd      = query.get('cwd') || null;
      const rows = state.queryActions({ type: 'commitment', agent_id, cwd, limit: 500, order: 'desc' }) || [];
      const refusals = [], anchors = [];
      for (const row of rows) {
        const rec = ar.fromRow(row);
        if (!rec || !rec.output) continue;
        const ct = rec.output.commitment_type;
        if (ct === 'refusal') refusals.push({ id: rec.id, statement: rec.output.statement, ts: rec.timestamp });
        else if (ct === 'anchor') anchors.push({ id: rec.id, statement: rec.output.statement, ts: rec.timestamp });
      }
      jsonResponse(res, 200, { agent_id, cwd, refusals, anchors });
    } catch (e) { jsonResponse(res, 500, { error: 'identity read failed', detail: e && e.message }); }
    return;
  }
  if (req.method === 'POST' && url === '/api/substrate/identity') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(buf || '{}'); }
      catch (_) { jsonResponse(res, 400, { error: 'bad_json' }); return; }
      try {
        const state = require('../shared-core/state.js');
        const ar    = require('../shared-core/action-record.js');
        const agent_id = body.agent_id || resolveAgentId();
        const cwd      = body.cwd      || null;
        const user_id  = body.user_id  || 'default';
        const refusals = Array.isArray(body.refusals) ? body.refusals : [];
        const anchors  = Array.isArray(body.anchors)  ? body.anchors  : [];
        const written = [];
        function record(stmt, kind) {
          const id = ar.uuidv7();
          const rec = {
            id, timestamp: Date.now(), type: 'commitment',
            agent_id, cwd, user_id, parent_id: null,
            input:  { source: 'ui_dashboard' },
            output: { statement: String(stmt), commitment_type: kind, salience: 1.0 }
          };
          const v = ar.validate(rec);
          if (v.ok) { state.recordAction(rec, ar.toSearchText(rec)); written.push({ id, kind, statement: rec.output.statement }); }
        }
        for (const r of refusals) if (r && String(r).trim()) record(String(r).trim(), 'refusal');
        for (const a of anchors)  if (a && String(a).trim()) record(String(a).trim(), 'anchor');
        jsonResponse(res, 200, { ok: true, written: written.length, items: written });
      } catch (e) { jsonResponse(res, 500, { error: 'identity write failed', detail: e && e.message }); }
    });
    return;
  }

  // ===== API: G6 commitment revision protocol =====
  // List proposed revisions (with resolution status), and accept/reject
  // pending ones. Reads + writes go through shared-core/revision-protocol.js
  // so the dashboard, MCP, and any future CLI front-end share one path.
  // The exact-match GET handler that lived here was
  // UNREACHABLE: the read-only GET /api/substrate/* chain near the top of
  // this dispatcher intercepts every substrate GET first and returns.

  // POST /api/substrate/scopes/delete — G13 corpus management
  if (req.method === 'POST' && url === '/api/substrate/scopes/delete') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = ''; req.on('data', c => buf += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
      try {
        const stateMod = require('../shared-core/state.js');
        const arMod = require('../shared-core/action-record.js');
        const agent_id = body.agent_id || resolveAgentId();
        const scope = body.scope;
        if (!scope) { jsonResponse(res, 400, { error: 'scope required' }); return; }
        const d = stateMod._dbForQuery && stateMod._dbForQuery();
        if (!d) { jsonResponse(res, 500, { error: 'db unavailable' }); return; }
        // Tombstone via separate audit record then remove the engrams
        // rows whose output.scope matches. Hard delete is acceptable
        // for chameleon corpora — they were ingested from external
        // documents that can be re-ingested.
        const result = d.prepare(
          "DELETE FROM action_records WHERE agent_id = ? AND type = 'commitment' AND json_extract(output, '$.scope') = ?"
        ).run(agent_id, scope);
        const audit = {
          id: arMod.uuidv7(), timestamp: Date.now(), type: 'decision',
          agent_id, cwd: body.cwd || null, user_id: body.user_id || 'default',
          parent_id: null,
          input:  { kind: 'corpus_deleted', signals: { scope, removed_count: result.changes } },
          output: { decision: 'deleted', reason: body.reason || 'operator_request' }
        };
        if (arMod.validate(audit).ok) stateMod.recordAction(audit, arMod.toSearchText(audit));
        jsonResponse(res, 200, { ok: true, scope, removed: result.changes });
      } catch (e) { jsonResponse(res, 500, { error: 'scope delete failed', detail: e && e.message }); }
    });
    return;
  }

  // POST /api/substrate/server/compose — G15 server-lifecycle helper
  // Returns the canonical llama-server command for current substrate
  // artefacts. Operator pastes into shell or pipes through SSH.
  if (req.method === 'POST' && url === '/api/substrate/server/compose') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = ''; req.on('data', c => buf += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
      try {
        const sl = require('../shared-core/server-lifecycle.js');
        const r = sl.composeCommand({
          model_path: body.model_path,
          port: body.port || 11436,
          ngl: body.ngl,
          control_vector_path: body.control_vector_path,
          control_vector_scale: body.control_vector_scale,
          lora_path: body.lora_path,
          slot_save_path: body.slot_save_path
        });
        jsonResponse(res, 200, r);
      } catch (e) { jsonResponse(res, 500, { error: 'compose failed', detail: e && e.message }); }
    });
    return;
  }

  // GET/POST /api/substrate/telemetry — G10 telemetry status + toggle
  if (req.method === 'GET' && url === '/api/substrate/telemetry') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const tm = require('../shared-core/telemetry.js');
      jsonResponse(res, 200, tm.status());
    } catch (e) { jsonResponse(res, 500, { error: 'telemetry status failed' }); }
    return;
  }
  if (req.method === 'POST' && url === '/api/substrate/telemetry') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = ''; req.on('data', c => buf += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
      try {
        const tm = require('../shared-core/telemetry.js');
        const s = tm.setEnabled(!!body.enabled, body.endpoint);
        jsonResponse(res, 200, s);
      } catch (e) { jsonResponse(res, 500, { error: 'telemetry toggle failed', detail: e && e.message }); }
    });
    return;
  }

  // POST /api/substrate/engrams/<uuid>/feedback — Tier 1 / Item B
  // Operator marks engram useful or wrong. Stored as a `decision`
  // record (input.kind=`engram_feedback`) parented to the engram.
  // Auto-judge can later down-weight sources that produce many
  // 'wrong'-marked engrams.
  {
    const m = url.match(/^\/api\/substrate\/engrams\/([0-9a-f-]{36})\/feedback$/);
    if (req.method === 'POST' && m) {
      if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      const engId = m[1];
      let buf = ''; req.on('data', c => buf += c);
      req.on('end', () => {
        let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
        try {
          const stateMod = require('../shared-core/state.js');
          const arMod = require('../shared-core/action-record.js');
          const eng = stateMod.getAction(engId);
          if (!eng || eng.type !== 'commitment') { jsonResponse(res, 404, { error: 'engram not found' }); return; }
          if (body.feedback !== 'useful' && body.feedback !== 'wrong') { jsonResponse(res, 400, { error: 'feedback must be useful|wrong' }); return; }
          const id = arMod.uuidv7();
          const rec = {
            id, timestamp: Date.now(), type: 'decision',
            agent_id: body.agent_id || eng.agent_id,
            cwd: eng.cwd, user_id: eng.user_id || 'default',
            parent_id: engId,
            input:  { kind: 'engram_feedback', signals: { engram_id: engId, feedback: body.feedback } },
            output: { decision: body.feedback, reason: body.reason || 'operator_review' }
          };
          if (arMod.validate(rec).ok) stateMod.recordAction(rec, arMod.toSearchText(rec));
          jsonResponse(res, 200, { ok: true, feedback_id: id });
        } catch (e) { jsonResponse(res, 500, { error: 'feedback failed', detail: e && e.message }); }
      });
      return;
    }
  }

  // POST /api/substrate/anchor-suggestions/<uuid>/(accept|ignore)
  {
    const m = url.match(/^\/api\/substrate\/anchor-suggestions\/([0-9a-f-]{36})\/(accept|ignore)$/);
    if (req.method === 'POST' && m) {
      if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      const sugId = m[1];
      const action = m[2];
      let buf = ''; req.on('data', c => buf += c);
      req.on('end', () => {
        let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
        try {
          const mod = require('../shared-core/anchor-suggester.js');
          const r = mod.resolveSuggestion({
            agent_id: body.agent_id || resolveAgentId(),
            suggestion_id: sugId,
            decision: action === 'accept' ? 'accepted' : 'ignored',
            confirmed_statement: body.confirmed_statement,
            reason: body.reason
          });
          jsonResponse(res, r.ok ? 200 : 400, r);
        } catch (e) { jsonResponse(res, 500, { error: action + ' failed', detail: e && e.message }); }
      });
      return;
    }
  }

  // POST /api/substrate/watcher/start | stop — embedded session watcher
  if (req.method === 'POST' && (url === '/api/substrate/watcher/start' || url === '/api/substrate/watcher/stop')) {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      const w = require('../tools/claude-session-watcher.js');
      if (!global.__troth_watcher_runtime) {
        global.__troth_watcher_runtime = w.makeRuntime({ agent_id: resolveAgentId() });
      }
      const r = url.endsWith('/start')
        ? global.__troth_watcher_runtime.start()
        : global.__troth_watcher_runtime.stop();
      jsonResponse(res, 200, r);
    } catch (e) { jsonResponse(res, 500, { error: 'watcher control failed', detail: e && e.message }); }
    return;
  }

  // POST /api/substrate/revisions/propose
  if (req.method === 'POST' && url === '/api/substrate/revisions/propose') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = ''; req.on('data', c => buf += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(buf || '{}'); } catch (_) { jsonResponse(res, 400, { error: 'bad_json' }); return; }
      try {
        const rp = require('../shared-core/revision-protocol.js');
        const agent_id = body.agent_id || resolveAgentId();
        const r = rp.proposeRevision({
          agent_id,
          cwd: body.cwd, user_id: body.user_id,
          old_commitment_id: body.old_commitment_id,
          proposed_statement: body.proposed_statement,
          proposed_commitment_type: body.proposed_commitment_type,
          evidence: body.evidence,
          evidence_source: body.evidence_source,
          confidence: body.confidence
        });
        jsonResponse(res, r.ok ? 200 : 400, r);
      } catch (e) { jsonResponse(res, 500, { error: 'propose failed', detail: e && e.message }); }
    });
    return;
  }
  // POST /api/substrate/revisions/:id/accept|reject — single-path matcher.
  {
    const m = url.match(/^\/api\/substrate\/revisions\/([0-9a-f-]{36})\/(accept|reject)$/);
    if (req.method === 'POST' && m) {
      if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      const proposalId = m[1];
      const action     = m[2];
      let buf = ''; req.on('data', c => buf += c);
      req.on('end', () => {
        let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
        try {
          const rp = require('../shared-core/revision-protocol.js');
          const agent_id = body.agent_id || resolveAgentId();
          const r = action === 'accept'
            ? rp.acceptRevision({ agent_id, proposal_id: proposalId,
                                  confirmed_statement: body.confirmed_statement,
                                  reason: body.reason, confirmed_by: body.confirmed_by })
            : rp.rejectRevision({ agent_id, proposal_id: proposalId,
                                  counter_evidence: body.counter_evidence,
                                  reason: body.reason, rejected_by: body.rejected_by });
          jsonResponse(res, r.ok ? 200 : 400, r);
        } catch (e) { jsonResponse(res, 500, { error: action + ' failed', detail: e && e.message }); }
      });
      return;
    }
  }

  // ===== API: G7 proactive insights =====
  // Surfaced insights — what the substrate noticed during idle ticks.
  // GET lists by status (new / useful / ignore / all); POST marks
  // operator feedback so future surfacing weights can self-tune.
  // The exact-match GET handler that lived here was
  // UNREACHABLE: the read-only GET /api/substrate/* chain near the top of
  // this dispatcher intercepts every substrate GET first and returns.
  {
    const m = url.match(/^\/api\/substrate\/insights\/([0-9a-f-]{36})\/feedback$/);
    if (req.method === 'POST' && m) {
      if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      const insightId = m[1];
      let buf = ''; req.on('data', c => buf += c);
      req.on('end', () => {
        let body; try { body = JSON.parse(buf || '{}'); } catch (_) { body = {}; }
        try {
          const surfacer = require('../shared-core/insight-surfacer.js');
          const agent_id = body.agent_id || resolveAgentId();
          const r = surfacer.markFeedback({
            agent_id, insight_id: insightId,
            feedback: body.feedback,
            reason: body.reason
          });
          jsonResponse(res, r.ok ? 200 : 400, r);
        } catch (e) { jsonResponse(res, 500, { error: 'feedback failed', detail: e && e.message }); }
      });
      return;
    }
  }

  // ===== API: Substrate event stream (SSE) =====
  // Polls L1 every 2s for new substrate-related actions (background
  // worker, learning loop, watcher, dialogue turns, engram writes)
  // and pushes them to the connected dashboard. Long-lived connection
  // until client disconnects.
  if (req.method === 'GET' && url === '/api/substrate/events') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': substrate event stream open\n\n');
    let cursor = Date.now();
    let alive = true;
    const state = require('../shared-core/state.js');
    const ar    = require('../shared-core/action-record.js');
    const agent_id = query.get('agent_id') || resolveAgentId();
    const interval = setInterval(() => {
      if (!alive) return;
      try {
        const rows = state.queryActions({ agent_id, limit: 50, order: 'desc', since_ts: cursor }) || [];
        // queryActions may not honor since_ts depending on impl; filter again JS-side.
        const fresh = rows.filter(r => (r.ts || 0) > cursor).reverse();
        for (const row of fresh) {
          const rec = ar.fromRow(row);
          if (!rec) continue;
          // Surface substrate-relevant kinds only (skip every action)
          const isSubstrate =
            (rec.input && rec.input.tool_name && /^(background_worker|learning_|ingest_watcher|dialogue|intent_module)/.test(rec.input.tool_name)) ||
            rec.type === 'commitment';
          if (!isSubstrate) continue;
          const ev = {
            ts: rec.timestamp,
            type: rec.type,
            tool: rec.input && rec.input.tool_name || null,
            commitment_type: rec.output && rec.output.commitment_type || null,
            statement: rec.output && rec.output.statement || null,
            id: rec.id
          };
          res.write('data: ' + JSON.stringify(ev) + '\n\n');
          if ((row.ts || 0) > cursor) cursor = row.ts;
        }
      } catch (_) { /* best-effort */ }
      // Keepalive comment so proxies don't time out idle connections.
      res.write(': keepalive ' + Date.now() + '\n\n');
    }, 2000);
    req.on('close', () => { alive = false; clearInterval(interval); try { res.end(); } catch (_) {} });
    return;
  }

  // The exact-match GET handler that lived here was
  // UNREACHABLE: the read-only GET /api/substrate/* chain near the top of
  // this dispatcher intercepts every substrate GET first and returns.

  // The exact-match GET handler that lived here was
  // UNREACHABLE: the read-only GET /api/substrate/* chain near the top of
  // this dispatcher intercepts every substrate GET first and returns.

  // ===== API: Substrate dialogue record-turn =====
  // POST /api/substrate/dialogue/record-turn
  // Body: { conv_id, role, content, ts?, session_id?, agent_id?, cwd? }
  // Used by the troth-app desktop voice loop so dialogue turns persisted
  // to ~/.troth/desktop/conversations/*.json ALSO land in the substrate.
  // Without this, voice conversations bypass cross-session identity injection
  // and federation sync (Bug 2 in.
  //
  // dialogueMemory.recordTurn pairs user_text + assistant_text per record,
  // but voice append_message fires once per role. We map role→user_text
  // OR assistant_text, leaving the other side empty. recentTurns skips
  // entries where both are blank, so this still renders cleanly.
  if (req.method === 'POST' && url === '/api/substrate/dialogue/record-turn') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = ''; req.on('data', c => buf += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(buf || '{}'); } catch (_) { jsonResponse(res, 400, { error: 'bad_json' }); return; }
      try {
        const dm = require('../shared-core/dialogue-memory.js');
        // ONE mind, one dialogue stream. Voice was previously partitioned
        // under 'troth-desktop-voice' which session-start.mjs never saw —
        // V-2 "I have no context" was structural. Defaulting to the
        // env-resolved collaborator id unifies the streams across surfaces.
        const agent_id = body.agent_id || resolveAgentId();
        const role = String(body.role || '').toLowerCase();
        const content = String(body.content || '');
        if (!body.conv_id) { jsonResponse(res, 400, { error: 'conv_id required' }); return; }
        if (role !== 'user' && role !== 'assistant') {
          // System/tool roles are recorded but flagged so they don't pollute
          // the user/assistant transcript surface.
        }
        const ok = dm.recordTurn({
          agent_id,
          user_id: 'default',
          cwd: body.cwd || null,
          // Attention scope: stamps the row's session_id column so scoped
          // reads (cockpit panes) see only their thread. fragments below
          // keeps the legacy round-trip copy.
          conversation_id: body.conv_id || null,
          user_text:      role === 'user'      ? content : '',
          assistant_text: role === 'assistant' ? content : '',
          faculty: 'desktop-voice',
          // Stuff conv_id + session_id + role + ts under fragments so they
          // round-trip alongside the turn in substrate.output without
          // requiring a recordTurn signature change.
          fragments: {
            conv_id:    body.conv_id,
            session_id: body.session_id || null,
            role:       body.role || null,
            ts:         body.ts || Date.now()
          }
        });
        jsonResponse(res, ok ? 200 : 500, { ok });
      } catch (e) { jsonResponse(res, 500, { error: 'record-turn failed', detail: e && e.message }); }
    });
    return;
  }

  // ===== API: Substrate squad (engram-driven worker visibility) =====
  // GET /api/substrate/squad?group_id=<id>&cwd=<path>
  // Returns [{role, status, started_at}] derived from the substrate engrams
  // that agent-supervisor.js writes:
  //   · scope=role:<role>:group:<id>          → worker is running
  //   · scope=complete:role:<role>:group:<id> → worker is done
  // Replaces the brittle tool_use.name=="Task" heuristic in the desktop
  // SquadOverlay (Bug 3 in.
  if (req.method === 'GET' && url.startsWith('/api/substrate/squad')) {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    try {
      let groupId = query.get('group_id');
      const cwd   = query.get('cwd') || null;
      const supervisor = require('../shared-core/agent-supervisor.js');
      // No group_id supplied → discover the most recent group from the
      // `role_worker_spawned` decisions the supervisor writes when it
      // launches a role. Lets the desktop SquadOverlay show "whatever's
      // running right now" without having to be threaded the group_id.
      if (!groupId) {
        try {
          const stateMod = require('../shared-core/state.js');
          const rows = stateMod.queryActions({
            type: 'decision',
            kind: 'role_worker_spawned',
            limit: 20,
            order: 'desc'
          }) || [];
          for (const r of rows) {
            try {
              const inp = typeof r.input === 'string' ? JSON.parse(r.input) : r.input;
              if (inp && inp.group_id) { groupId = inp.group_id; break; }
            } catch (_) {}
          }
        } catch (_) {}
        if (!groupId) {
          jsonResponse(res, 200, { group_id: null, cwd, workers: [] });
          return;
        }
      }
      const polled = supervisor.pollResults(groupId, { cwd });
      const out = [];
      for (const role of Object.keys(polled || {})) {
        const items = polled[role] || [];
        if (!items.length) continue;
        // listEngrams sorts desc — last item is oldest (start), first is newest.
        let started_at = items[items.length - 1].ts;
        let status = 'running';
        for (const e of items) {
          if (typeof e.scope === 'string' && e.scope.indexOf('complete:role:') === 0) {
            status = 'done';
          }
        }
        out.push({ role, status, started_at });
      }
      jsonResponse(res, 200, { group_id: groupId, cwd, workers: out });
    } catch (e) { jsonResponse(res, 500, { error: 'squad list failed', detail: e && e.message }); }
    return;
  }

  // ===== API: Substrate apply state to server (compose command) =====
  // Returns the composed llama-server command for the operator to run.
  // Optionally (when body.spawn=true and we are local) actually
  // restarts a local llama-server.
  if (req.method === 'POST' && url === '/api/substrate/apply') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(buf || '{}'); } catch (_) { jsonResponse(res, 400, { error: 'bad_json' }); return; }
      try {
        const sl = require('../shared-core/server-lifecycle.js');
        const opts = { ...body };
        if (body.control_vector_path && body.control_vector_scale != null) {
          opts.control_vector_scaled = { path: body.control_vector_path, scale: body.control_vector_scale };
          delete opts.control_vector_path;
        }
        const cmd = sl.composeCommand(opts);
        if (body.spawn === true) {
          sl.restartLocal(opts).then(r => jsonResponse(res, 200, { command: cmd.command_string, restart: r }))
                               .catch(e => jsonResponse(res, 500, { command: cmd.command_string, error: String(e && e.message || e) }));
          return;
        }
        jsonResponse(res, 200, { command: cmd.command_string, args: cmd.args });
      } catch (e) { jsonResponse(res, 500, { error: 'apply failed', detail: e && e.message }); }
    });
    return;
  }

  // The exact-match GET handler that lived here was
  // UNREACHABLE: the read-only GET /api/substrate/* chain near the top of
  // this dispatcher intercepts every substrate GET first and returns.

  if (req.method === 'POST' && url === '/api/transport-config') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(buf || '{}'); }
      catch (_) { jsonResponse(res, 400, { error: 'bad_json' }); return; }
      try {
        const tcfg = require('../shared-core/transport-config.js');
        const ok = tcfg.writePatch(body || {});
        if (!ok) { jsonResponse(res, 400, { error: 'write_failed' }); return; }
        jsonResponse(res, 200, { ok: true, snapshot: tcfg.snapshot() });
      } catch (e) {
        jsonResponse(res, 500, { error: 'transport-config write failed', detail: e && e.message });
      }
    });
    return;
  }

  // ===== API: Shutdown =====
  // Graceful shutdown so `troth restart` can kill the existing proxy
  // and re-spawn it with a fresh cwd (for CodeLens re-indexing of a
  // different project). Only bound to 127.0.0.1 by default, so only
  // local CLIs can invoke it.
  if (req.method === 'POST' && url === '/api/shutdown') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    jsonResponse(res, 200, { ok: true, message: 'shutting down' });
    log('Shutdown requested via API');
    setTimeout(() => {
      // unlinkPidFile defined at end of file alongside SIGTERM handler;
      // safe to call ahead of close so a fast next-spawn doesn't see a
      // stale file pointing at our soon-to-die PID.
      try { unlinkPidFile(); } catch (_) {}
      server.close(() => process.exit(0));
      // Fallback: if server.close hangs on an open connection, force exit.
      setTimeout(() => process.exit(0), 1500).unref();
    }, 50);
    return;
  }

  // ===== API: Mindset prompt preview =====
  // Returns the raw markdown of proxy/prompts/mindset.md so the dashboard
  // can show the user exactly what is being injected when the mindset
  // toggle is on. Read fresh each time so edits show up without a restart.
  if (req.method === 'GET' && url === '/api/prompts/mindset') {
    try {
      const mindsetPath = path.join(__dirname, 'prompts', 'mindset.md');
      const body = fs.readFileSync(mindsetPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('mindset.md not found');
    }
    return;
  }

  // ===== API: Logs =====
  // Returns recent in-memory ring buffer + the proxy's process_started_at
  // so the dashboard JS can detect a restart (started_at changed → reset
  // its `lastTs` cursor). Without this, after a proxy restart any cached
  // `lastTs` in the dashboard is greater than every entry in the new
  // process's empty buffer and the filter returns [] forever.
  if (req.method === 'GET' && url === '/api/logs') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    const since = parseInt(query.get('since') || '0');
    const lines = since ? logBuffer.filter(l => l.ts > since) : logBuffer;
    jsonResponse(res, 200, {
      lines: lines,
      process_started_at: PROCESS_STARTED_AT,
      buffer_max: MAX_LOG_LINES
    });
    return;
  }

  // Tail the proxy's stdout log file. Useful for retrieving log lines from
  // BEFORE the current process started (the in-memory buffer obviously
  // can't show pre-restart history). Path is configurable via env so
  // operators with custom redirection can wire it up.
  if (req.method === 'GET' && url.startsWith('/api/logs/file')) {
    const reqLines = Math.min(parseInt(query.get('lines') || '200'), 2000);
    const logFile = process.env.TROTH_LOG_FILE || '';
    if (!logFile) {
      jsonResponse(res, 200, { lines: [], note: 'set TROTH_LOG_FILE=/path/to/proxy.log to enable file tailing' });
      return;
    }
    try {
      const fileBuf = fs.readFileSync(logFile, 'utf8');
      const allLines = fileBuf.split('\n').filter(Boolean);
      jsonResponse(res, 200, { lines: allLines.slice(-reqLines), file: logFile, total: allLines.length });
    } catch (e) {
      jsonResponse(res, 200, { lines: [], error: 'read_failed', detail: secrets.redact(String(e.message || e)) });
    }
    return;
  }

  // ===== API: CodeLens Graph =====
  if (req.method === 'GET' && url === '/api/codelens/graph') {
    try {
      const codelens = require('./modules/codelens');
      const store = codelens._store;
      if (!store) { jsonResponse(res, 200, { nodes: [], edges: [], stats: {} }); return; }

      // Scratch, vendor and minified files are not the codebase's story.
      const JUNK = /node_modules|\/dist\/|\.min\.js$|\/_[^\/]*$/;

      // Importance = connections in the call graph, both directions, over
      // EVERY edge, not a sample.
      const degree = {};
      const allEdges = store.db.prepare('SELECT source_id s, target_id t FROM edges').all();
      for (const e of allEdges) {
        degree[e.s] = (degree[e.s] || 0) + 1;
        degree[e.t] = (degree[e.t] || 0) + 1;
      }

      const entTotal = store.db.prepare('SELECT COUNT(*) n FROM entities').get().n;
      const entities = store.db.prepare(
        "SELECT id, type, name, file_path, line_number FROM entities WHERE type != 'import'"
      ).all().filter(function (e) { return e.file_path && !JUNK.test(e.file_path); });
      entities.forEach(function (e) { e.deg = degree[e.id] || 0; });
      entities.sort(function (a2, b2) { return b2.deg - a2.deg; });

      // The memory layer first: what the substrate remembers doing to each
      // file. It also earns entities their place on the map, so the
      // lived-in parts of the codebase are always in the picture.
      const mem = {};
      const relOf = {}; // entity abs path → repo-relative path, for suffix matching + the UI
      try {
        const sdb = require('../shared-core/state.js').db();
        // The repo has moved homes over its life, so historical records carry
        // old absolute paths. Match by repo-relative suffix instead of exact
        // string: the story of a file survives every move of its home.
        const nodePath = require('path');
        const byBase = {};
        (function () {
          const paths = Array.from(new Set(entities.map(function (e2) { return e2.file_path; })));
          if (!paths.length) return;
          let root = nodePath.dirname(paths[0]);
          for (const p of paths) {
            while (root && p.indexOf(root + '/') !== 0) {
              const up = nodePath.dirname(root);
              if (up === root) { root = ''; break; }
              root = up;
            }
          }
          for (const p of paths) {
            relOf[p] = root ? p.slice(root.length + 1) : nodePath.basename(p);
            (byBase[nodePath.basename(p)] = byBase[nodePath.basename(p)] || []).push(p);
          }
        })();
        function bucket(f) {
          const cands = byBase[nodePath.basename(f)];
          if (!cands) return null;
          for (const a of cands) { if (f === a || f.endsWith('/' + relOf[a])) return a; }
          return null;
        }
        const eRows = sdb.prepare(
          "SELECT json_extract(input, '$.file_path') f, COUNT(*) e, MAX(timestamp) last, " +
          "COUNT(DISTINCT session_id) s FROM action_records WHERE type = 'edit' GROUP BY f"
        ).all();
        for (const r of eRows) {
          if (!r.f) continue;
          const key = bucket(r.f);
          if (!key) continue;
          const m = mem[key] || (mem[key] = { e: 0, r: 0, last: 0, s: 0 });
          m.e += r.e; m.s += r.s; if (r.last > m.last) m.last = r.last;
        }
        // Reads are knowledge too: a file the partner has read is known,
        // even when it was never edited.
        const rRows = sdb.prepare(
          "SELECT json_extract(input, '$.file_path') f, COUNT(*) n, MAX(timestamp) last " +
          "FROM action_records WHERE type = 'read' GROUP BY f"
        ).all();
        for (const r of rRows) {
          if (!r.f) continue;
          const key = bucket(r.f);
          if (!key) continue;
          const m = mem[key] || (mem[key] = { e: 0, r: 0, last: 0, s: 0 });
          m.r += r.n; if (r.last > m.last) m.last = r.last;
        }
      } catch (_) {}

      const chosen = entities.slice(0, 100);
      const inSet = new Set(chosen.map(function (e) { return e.id; }));
      const bestByFile = {};
      for (const e of entities) {
        const b = bestByFile[e.file_path];
        if (!b || e.deg > b.deg) bestByFile[e.file_path] = e;
      }
      const editedFiles = Object.keys(mem).sort(function (x, y) { return ((mem[y].e||0)*1000+(mem[y].r||0)) - ((mem[x].e||0)*1000+(mem[x].r||0)); });
      for (const f of editedFiles) {
        if (chosen.length >= 150) break;
        const best = bestByFile[f];
        if (best && !inSet.has(best.id)) { chosen.push(best); inSet.add(best.id); }
      }
      // Every node brings its connections: an edge budget per node instead
      // of first-come-first-served, which starved the memory nodes.
      const edges = [];
      const perNode = {};
      for (const e of allEdges) {
        if (!inSet.has(e.s) || !inSet.has(e.t) || e.s === e.t) continue;
        const cs = perNode[e.s] || 0, ct = perNode[e.t] || 0;
        if (cs >= 8 && ct >= 8) continue;
        perNode[e.s] = cs + 1; perNode[e.t] = ct + 1;
        edges.push({ from: e.s, to: e.t });
        if (edges.length >= 700) break;
      }

      // Real neighbors from the FULL graph, so discovery never dead-ends:
      // marked onMap when drawn, capped to the eight best-connected.
      const entById = {};
      for (const e of entities) entById[e.id] = e;
      const nearIds = {};
      for (const e of allEdges) {
        if (inSet.has(e.s) && entById[e.t]) (nearIds[e.s] = nearIds[e.s] || new Set()).add(e.t);
        if (inSet.has(e.t) && entById[e.s]) (nearIds[e.t] = nearIds[e.t] || new Set()).add(e.s);
      }
      const nodes = chosen.map(function (e) {
        const near = Array.from(nearIds[e.id] || [])
          .map(function (id) { return entById[id]; })
          .filter(Boolean)
          .sort(function (x, y) { return (y.deg || 0) - (x.deg || 0); })
          .slice(0, 8)
          .map(function (nb) {
            return { id: nb.id, label: nb.name, file: nb.file_path, onMap: inSet.has(nb.id) };
          });
        return { id: e.id, label: e.name, type: e.type, file: e.file_path, line: e.line_number,
                 rel: relOf[e.file_path] || null,
                 deg: e.deg, mem: mem[e.file_path] || null, near: near };
      });
      jsonResponse(res, 200, {
        nodes: nodes, edges: edges,
        stats: {
          entities_total: entTotal,
          edges_total: allEdges.length,
          shown: nodes.length,
          with_memory: nodes.filter(function (n) { return n.mem; }).length
        }
      });
    } catch (e) { jsonResponse(res, 200, { nodes: [], edges: [], error: e.message }); }
    return;
  }

  // ===== API: Anthropic Auth Status =====
  if (req.method === 'GET' && url === '/api/anthropic-status') {
    // subscription was never set here, so the panel said "No subscription
    // detected" to everyone — including an operator who had just chosen Claude
    // in setup and was signed in. Same detector the onboarding overlay uses.
    var status = { apiKey: false, subscription: false, plan: "Claude Code" };
    try {
      status.subscription = require("../shared-core/claude-subscription.js").claudeSubscriptionActive();
    } catch (e) {}
    // Check for API key in providers
    try {
      var provs = getProviders();
      if (provs.anthropic && provs.anthropic.enabled && provs.anthropic.apiKey && provs.anthropic.apiKey.length > 10) {
        status.apiKey = true;
      }
    } catch (e) {}
    jsonResponse(res, 200, status);
    return;
  }

  // ===== API: Test Backend =====
  if (req.method === 'GET' && url === '/api/test-backend') {
    const start = Date.now();
    const testReq = http.request({ hostname: BACKEND_HOST, port: BACKEND_PORT, path: '/health', timeout: 5000 }, (testRes) => {
      let body = '';
      testRes.on('data', d => body += d);
      testRes.on('end', () => jsonResponse(res, 200, { ok: true, latencyMs: Date.now() - start, status: testRes.statusCode }));
    });
    testReq.on('error', () => jsonResponse(res, 200, { ok: false, latencyMs: Date.now() - start }));
    testReq.on('timeout', () => { testReq.destroy(); jsonResponse(res, 200, { ok: false, latencyMs: Date.now() - start }); });
    testReq.end();
    return;
  }

  // ===== API: POST Config =====
  if (req.method === 'POST' && url === '/api/config') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const newConfig = JSON.parse(body);
        // Strip [REDACTED] sentinels recursively before merging — the
        // GET endpoint masks secrets to '[REDACTED]', the dashboard
        // round-trips that string back into the input field, and on
        // Save without edit it would be POSTed as the literal new
        // value, clobbering the real key. Skip those fields so the
        // existing on-disk value is preserved.
        const stripRedacted = (obj) => {
          if (!obj || typeof obj !== 'object') return obj;
          if (Array.isArray(obj)) return obj.map(stripRedacted).filter(v => v !== undefined);
          const out = {};
          for (const [k, v] of Object.entries(obj)) {
            if (v === '[REDACTED]') continue;
            if (typeof v === 'object') {
              const cleaned = stripRedacted(v);
              if (cleaned !== undefined && Object.keys(cleaned).length > 0) out[k] = cleaned;
            } else {
              out[k] = v;
            }
          }
          return out;
        };
        const safeNewConfig = stripRedacted(newConfig);
        // Strip API keys out of the JSON write path — they belong in
        // ~/.troth/.env (0600 perms, gitignored), NOT in the broadly-
        // backed-up config.json. Each apiKey field encountered is
        // routed to envFile.writeKey() under its canonical env name.
        // Other provider fields (enabled, model, endpoint) stay in JSON.
        const ENV_KEY_MAP = {
          anthropic:  'ANTHROPIC_API_KEY',
          openrouter: 'OPENROUTER_API_KEY',
          deepseek:   'DEEPSEEK_API_KEY',
          deepinfra:  'DEEPINFRA_API_KEY',
          nvidia:     'NVIDIA_API_KEY',
          alibaba:    'ALIBABA_API_KEY',
          zai:        'ZAI_API_KEY',
          // Custom (OpenAI-compatible): key is OPTIONAL, but when the operator
          // does supply one it rides the env file like every other secret
          // (never config.json). base_url + model stay in JSON.
          custom_openai: 'CUSTOM_OPENAI_API_KEY',
          // Kimi Code membership: the router reads this lane's key ONLY from
          // TROTH_KIMI_SUB_KEY (deliberate subscription opt-in signal), so a
          // key typed in the dashboard or the first-run onboarding must land
          // there — writing it to config.json would configure nothing.
          kimi_sub: 'TROTH_KIMI_SUB_KEY',
          // moonshot and xai were absent from THIS copy of the map while the
          // router and doctor both carried them, so their keys were written to
          // config.json in plaintext and an emptied field could never revoke
          // them — the env backfill handed the lane its old credential back on
          // the next load. Same two lanes, three maps: keep them in step.
          moonshot: 'MOONSHOT_API_KEY',
          xai: 'XAI_API_KEY'
        };
        let envWrites = 0;
        if (safeNewConfig.providers && typeof safeNewConfig.providers === 'object') {
          const envFile = require('../shared-core/env-file.js');
          for (const [pk, pv] of Object.entries(safeNewConfig.providers)) {
            if (!(pv && typeof pv === 'object' && typeof pv.apiKey === 'string' && ENV_KEY_MAP[pk])) continue;
            if (pv.apiKey.length > 10) {
              try {
                envFile.writeKey(ENV_KEY_MAP[pk], pv.apiKey);
                envWrites++;
                delete pv.apiKey; // never lands in config.json
              } catch (_) { /* fall through — apiKey will be written to JSON as fallback */ }
            } else if (pv.apiKey === '') {
              // An emptied field means REVOKE. Only long values used to reach
              // this block, so clearing a key changed nothing: the env file
              // kept it, loadProviders backfilled it on the next load, and the
              // lane went on answering with a credential the operator had
              // deleted — through restarts, with no way to take it back.
              try {
                if (envFile.removeKey && envFile.removeKey(ENV_KEY_MAP[pk])) envWrites++;
              } catch (_) {}
              delete pv.apiKey;   // and do not persist '' into config.json
            }
          }
        }
        // Single-writer path: fresh strict read + atomic replace. A corrupt
        // config.json now REFUSES the write (400 via the catch below)
        // instead of readConfig() silently defaulting and the merge erasing
        // every field the default did not carry.
        const merged = configFileStore.updateConfig((current) => {
          // Deep-merge providers so partial updates (e.g. just enabling
          // a flag) don't drop other fields. Object.assign is shallow.
          // After the env-key strip above, surviving provider fields are
          // enable/model/endpoint, safe to merge into config.json.
          const next = Object.assign({}, current, safeNewConfig);
          // Deep-merge features too (same reason as providers): a partial POST like
          // {features:{fidelity:true}} must not clobber other flags (how_rails).
          if (safeNewConfig.features && current.features) {
            next.features = Object.assign({}, current.features, safeNewConfig.features);
          }
          // Deep-merge routing for the same reason: the app posts
          // {routing:{pin}} and the dashboard posts {routing:{order}}. A
          // shallow assign let whichever wrote last erase the other's field.
          if (safeNewConfig.routing && current.routing) {
            next.routing = Object.assign({}, current.routing, safeNewConfig.routing);
          }
          // Same treatment for every other nested object the operator edits a
          // field at a time. `modules` was missing, and because a module
          // absent from the map counts as ENABLED, a save carrying one toggle
          // erased the rest and switched them all back on — an explicit off
          // undone by an unrelated click.
          // `sync` rides the same list: the dashboard re-saves host/deviceId
          // without the token (redaction never round-trips it), and a shallow
          // assign would drop the stored deviceToken on every such save.
          for (const _k of ['modules', 'modelLimits', 'keepalive', 'mcp', 'sync']) {
            if (safeNewConfig[_k] && current[_k] &&
                typeof safeNewConfig[_k] === 'object' && !Array.isArray(safeNewConfig[_k])) {
              next[_k] = Object.assign({}, current[_k], safeNewConfig[_k]);
            }
          }
          if (safeNewConfig.providers && current.providers) {
            next.providers = Object.assign({}, current.providers);
            for (const [pk, pv] of Object.entries(safeNewConfig.providers)) {
              next.providers[pk] = Object.assign({}, current.providers[pk] || {}, pv);
              // '' is the revoke for config-stored lanes too (env-mapped ones
              // were already handled above): the field is deleted, never
              // persisted as an empty string that redaction dresses up as a
              // living credential.
              if (next.providers[pk] && next.providers[pk].apiKey === '') {
                delete next.providers[pk].apiKey;
              }
              // Drop legacy plaintext apiKey if it lingers in the merged
              // shape (env is authoritative for that field now).
              if (next.providers[pk] && next.providers[pk].apiKey && ENV_KEY_MAP[pk]) {
                delete next.providers[pk].apiKey;
              }
            }
          }
          return next;
        });
        // Reload providers in the router so changes take effect immediately
        try { loadProviders(); } catch (e) {}
        // Echo the redacted version, never the raw merged config.
        jsonResponse(res, 200, { ok: true, config: secrets.redactObject(merged) });
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ===== API: Reveal one secret value =====
  // Auth-gated single-field reveal so the dashboard can let the user EDIT
  // an existing key without the GET endpoint dumping the whole config in
  // plaintext. Body: { path: "providers.alibaba.apiKey" }. Logged so an
  // audit trail exists for any reveal action.
  if (req.method === 'POST' && url === '/api/config/reveal') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: fieldPath } = JSON.parse(body);
        if (typeof fieldPath !== 'string' || !fieldPath) {
          jsonResponse(res, 400, { error: 'path required (e.g. "providers.alibaba.apiKey")' });
          return;
        }
        // Only allow paths that look like secret fields (apiKey, token,
        // secret, password) — refuses to reveal random non-secret fields
        // through this endpoint, which would defeat the redacted GET.
        if (!/(apiKey|api_key|token|secret|password|bearer)$/i.test(fieldPath)) {
          jsonResponse(res, 400, { error: 'reveal endpoint is for secret fields only' });
          return;
        }
        const cfg = readConfig();
        const parts = fieldPath.split('.');
        let cur = cfg;
        for (const p of parts) {
          if (!cur || typeof cur !== 'object') { cur = undefined; break; }
          cur = cur[p];
        }
        log('REVEAL | field=' + fieldPath + ' | found=' + (typeof cur === 'string' && cur.length > 0));
        jsonResponse(res, 200, { path: fieldPath, value: (typeof cur === 'string') ? cur : null });
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ===== API: ChatGPT subscription (Codex OAuth) =====
  // Mirrors the provider-card surface for anthropic/openrouter — except
  // auth is OAuth (PKCE → browser → token persist), not an API key
  // textbox. Wraps shared-core/codex-auth.js + codex-token-store.js
  // (the modules the entity transport already uses, so a single source
  // of truth for the saved token). Lazy-require so a fresh install
  // doesn't load codex modules at boot.
  if (req.method === 'GET' && url === '/api/providers/codex/status') {
    try {
      const tokenStore = require('../shared-core/codex-token-store.js');
      // `configured` is separate from `signed_in`: the OAuth client identity
      // is operator-supplied and unbundled, so a UI that offers a sign-in
      // button without it is offering a button that cannot work.
      const configured = !!require('../shared-core/codex-auth.js').clientId();
      // Whether a linked plan also buys image generation is a property of this
      // build, not of the plan: the tool ships with the app. Probed, so the UI
      // never advertises a capability the install does not carry.
      let images = false;
      try { require.resolve('../shared-core/tools/image-gen.js'); images = true; } catch (_) {}
      const t = tokenStore.load();
      if (!t) {
        jsonResponse(res, 200, { signed_in: false, configured, images });
      } else {
        const expired = tokenStore.isExpired(t);
        const expires_in = Math.max(0, Math.round((t.expires_at - Date.now()) / 1000));
        jsonResponse(res, 200, {
          signed_in: true,
          configured,
          images,
          account_id: t.account_id || null,
          scope:      t.scope || null,
          expires_in,
          expired,
          token_path: tokenStore.tokenPath()
        });
      }
    } catch (e) {
      jsonResponse(res, 500, { error: 'codex_status_failed', detail: String(e && e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && url === '/api/providers/codex/login') {
    // Long-running: opens browser, waits up to 5 min for callback. Browser
    // open happens on the SERVER's machine — appropriate for the local-
    // only single-user troth cli use case (the proxy runs on the same
    // box as the operator). Rebroadcasting the flow to other users is NOT
    // a supported mode — this endpoint is auth-gated to
    // localhost via checkRemoteAuth on the standard /api/* path.
    try {
      const codexAuth = require('../shared-core/codex-auth.js');
      // Respond the moment the callback server is listening, WITH the auth
      // URL, so the PAGE opens the browser instead of this process: the old
      // shape held the HTTP response for up to five minutes and opened the
      // browser on the proxy's own machine — on a box without xdg-open the
      // operator clicked into silence while the flow "ran". The URL cannot
      // be rebuilt by the caller: its state + PKCE live inside this attempt.
      let responded = false;
      codexAuth.login({
        onUrl: (u) => {
          if (responded || res.headersSent) return;
          responded = true;
          jsonResponse(res, 200, { ok: true, started: true, auth_url: u });
        }
      }).then((tok) => {
        // Persist enabled:true so routing actually picks ChatGPT. The token
        // alone isn't enough — activeByok() skips any provider without
        // enabled:true, so a pinned openai_sub silently fell back to the
        // auto chain (→ local). The apiKey providers get enabled on key-save;
        // the OAuth path used to forget this. Preserve the chosen model.
        try {
          configFileStore.updateConfig((current) => {
            current.providers = Object.assign({}, current.providers);
            // No model is seeded here on purpose. This line used to write
            // 'gpt-5.2-codex', which codex-oauth.js documents as a 400 from
            // this endpoint ("not supported with a ChatGPT account"), so a
            // successful sign-in persisted a value guaranteed to fail. The
            // providers default already carries the working model, and a
            // fourth copy of that constant is how the first three drifted.
            current.providers.openai_sub = Object.assign(
              {},
              current.providers.openai_sub || {},
              { enabled: true }
            );
            return current;
          });
          try { loadProviders(); } catch (_) {}
        } catch (_) { /* token saved; enable-flag is best-effort */ }
        // The completion signal for the page is /api/providers/codex/status
        // flipping signed_in — the overlay polls it already. Only answer
        // here when onUrl never fired (a same-tick failure).
        if (!responded && !res.headersSent) {
          responded = true;
          jsonResponse(res, 200, { ok: true, account_id: tok.account_id || null });
        }
      }).catch((e) => {
        if (!responded && !res.headersSent) {
          responded = true;
          jsonResponse(res, 500, { ok: false, error: String(e && e.message || e) });
        }
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: 'codex_login_unavailable: ' + String(e && e.message || e) });
    }
    return;
  }

  // ===== Local CHAT model download (the "Automatic" local path) =====
  // POST {modelUri} → fire the in-process node-llama-cpp model download
  // (non-blocking) and return current status. The Automatic tab then polls
  // GET /api/localchat/status for the progress bar. Separate from embed
  // because the chat model is user-chosen (never auto-fire on a status poll).
  if (req.method === 'POST' && url === '/api/localchat/prepare') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const chat = require('../shared-core/local-chat.js');
        let modelUri;
        try { modelUri = JSON.parse(body || '{}').modelUri; } catch (_) {}
        chat.prepareModel(modelUri || undefined).catch(() => {}); // fire-and-forget
        jsonResponse(res, 200, chat.status());
      } catch (e) {
        jsonResponse(res, 200, { unavailable: true, error: String(e && e.message || e) });
      }
    });
    return;
  }
  if (req.method === 'POST' && url === '/api/localchat/cancel') {
    // AWAIT the cancel before reporting status — the old fire-and-forget read
    // status mid-cancel, so the response could still say "downloading" and the
    // UI's poll would revive the bar (cancel looked dead).
    (async () => {
      try {
        const chat = require('../shared-core/local-chat.js');
        await chat.cancelDownload();
        jsonResponse(res, 200, chat.status());
      } catch (e) {
        jsonResponse(res, 200, { unavailable: true, error: String(e && e.message || e) });
      }
    })();
    return;
  }
  if (req.method === 'POST' && url === '/api/providers/codex/logout') {
    try {
      const tokenStore = require('../shared-core/codex-token-store.js');
      tokenStore.clear();
      // Mirror login: drop enabled so a tokenless openai_sub doesn't linger
      // as "ready" in the UI / pin resolver after sign-out.
      try {
        configFileStore.updateConfig((current) => {
          if (current.providers && current.providers.openai_sub) {
            current.providers = Object.assign({}, current.providers);
            current.providers.openai_sub = Object.assign(
              {}, current.providers.openai_sub, { enabled: false });
          }
          return current;
        });
        try { loadProviders(); } catch (_) {}
      } catch (_) { /* token cleared; enable-flag is best-effort */ }
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  // ===== Targeted forgetting =====
  // POST /api/substrate/forget {query} → retires the closest-matching
  // commitment-engram. Same semantics as the /forget slash skill: history
  // and intents are immutable; only learned facts can be forgotten, and the
  // original stays for forensics — retrieval hides it.
  //
  // This endpoint is what the Tauri app calls, and it used to write a
  // free-standing scope:'system:tombstone' engram — which NOTHING filters,
  // so the "forgotten" fact keeps surfacing, and a sanctioned path that
  // does not work invites raw sqlite against state.db.
  // It retires exactly the way the slash path does: a successor engram
  // written through the blessed reconsolidation primitive, with
  // lifetime.supersedes pointing at the original (every recall path hides
  // it) at tier='flagged' (the successor itself never surfaces). The wire
  // shape keeps `tombstoned` so existing app builds read it unchanged.
  if (req.method === 'POST' && url === '/api/substrate/forget') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const query = (JSON.parse(body || '{}').query || '').trim();
        if (!query) { jsonResponse(res, 400, { error: 'missing_query' }); return; }
        const engram = require('../shared-core/engram.js');
        const fState = require('../shared-core/state.js');
        const lability = require('../shared-core/lability-reconsolidation.js');
        const matches = await engram.retrieveRelevant({
          cwd: null, query, k: 1, commitment_only: true
        });
        if (!matches.length) {
          jsonResponse(res, 200, { ok: true, tombstoned: false, detail: 'nothing matches' });
          return;
        }
        const target = matches[0];
        // The RAW action_records row: reconsolidate inherits the prior's
        // audience + memory_class + scope so the superseder lands in the
        // SAME recall pool as the original — the only place the
        // supersession pointer is actually seen.
        let raw = null;
        try { raw = fState.getAction(target.id); } catch (_) { raw = null; }
        if (!raw) {
          jsonResponse(res, 200, { ok: false, tombstoned: false, detail: 'could not load the matched engram to retire it' });
          return;
        }
        let rawOut; try { rawOut = typeof raw.output === 'string' ? JSON.parse(raw.output) : (raw.output || {}); } catch (_) { rawOut = {}; }
        // Signed operator facts are the crypto-anchored floor — a casual
        // forget must not retire them. Same rule as the slash path.
        if ((rawOut.source_authority || 'regex_extracted') === 'operator_confirmed') {
          jsonResponse(res, 200, {
            ok: false, tombstoned: false, protected: true,
            detail: 'that is a signed operator fact; forgetting it needs a signed operation'
          });
          return;
        }
        const id = lability.reconsolidate({
          state: fState,
          prior_engram: raw,
          new_statement: 'FORGOTTEN: ' + (rawOut.statement || target.statement),
          tier: 'flagged',
          reason: 'operator_forget',
          agent_id: 'consumer-app',
          cwd: raw.cwd || null,
          user_id: raw.user_id || 'default',
          trigger_text: query
        });
        jsonResponse(res, 200, {
          ok: !!id,
          tombstoned: !!id,
          superseded_id: id ? target.id : null,
          statement: String(target.statement).slice(0, 160)
        });
      } catch (e) {
        jsonResponse(res, 500, { error: 'forget_failed', detail: String(e && e.message || e) });
      }
    });
    return;
  }

  {
    const mCtxWin = req.method === 'GET' && url === '/api/context-window';
    if (mCtxWin) {
      if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      const q = new URL(req.url, 'http://localhost').searchParams;
      const model = (q.get('model') || '').trim();
      if (!model) { jsonResponse(res, 400, { error: 'model required' }); return; }
      try {
        const r = require('./modules/router').resolveContextWindow(model);
        jsonResponse(res, 200, { model, window: r.window, source: r.source });
      } catch (e) {
        jsonResponse(res, 500, { error: String(e && e.message || e) });
      }
      return;
    }
  }

  // GET /api/providers/openrouter/models → {models:[{id,name}]} — live list for
  // the Settings dropdown (the operator "adds a key but sees no models" bug:
  // nothing ever fetched OpenRouter's catalog). The /models endpoint is public +
  // zero-token; we pass the saved key when present. FAIL-CLOSED: any error returns
  // {models:[]} so the UI falls back to its static list (never an empty dropdown).
  // Catalog fallback: lanes without a public live endpoint (kimi_sub,
  // openai_sub, anthropic…) still deserve a datalist — the shipped catalog
  // is the same source the app trusts.
  function catalogModelsFor(name) {
    try {
      const cat = require('./modules/catalog.js');
      const table = typeof cat.getCatalog === 'function' ? cat.getCatalog() : (cat.CATALOG || cat);
      const entry = table && table[name];
      const list = entry && entry.models;
      if (Array.isArray(list) && list.length) {
        return list.map(function (m) { return { id: m.id, name: m.label + (m.note ? ' · ' + m.note : '') }; });
      }
    } catch (_) {}
    return [];
  }
  // GET /api/providers/<name>/models → {models:[{id,name}]} — LIVE model list
  // for EVERY cloud provider (operator requirement: 'new models must appear
  // without shipping an app update'). Same key resolution + endpoints as the
  // verify probes below; per-provider response shapes normalized here.
  // FAIL-CLOSED: any error returns {models:[]} so the UI falls back to its
  // static list (never an empty dropdown).
  {
    const mMods = req.method === 'GET' && url.match(/^\/api\/providers\/([a-z_]+)\/models$/);
    if (mMods) {
      if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      const provName = mMods[1];
      (async () => {
        try {
          const cfgNow = readConfig();
          const prov = (cfgNow.providers || {})[provName] || {};
          const ENV_KEY_MAP = {
            anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY', deepinfra: 'DEEPINFRA_API_KEY',
            nvidia: 'NVIDIA_API_KEY', alibaba: 'ALIBABA_API_KEY',
            zai: 'ZAI_API_KEY', moonshot: 'MOONSHOT_API_KEY', xai: 'XAI_API_KEY',
            custom_openai: 'CUSTOM_OPENAI_API_KEY'
          };
          const key = ((prov.apiKey || '') || (ENV_KEY_MAP[provName] && process.env[ENV_KEY_MAP[provName]]) || '').trim();
          // Custom (OpenAI-compatible): the model-list URL is NOT a constant.
          // it is derived from the operator's configured base_url ROOT (e.g.
          // https://integrate.api.nvidia.com/v1) by appending /models, matching
          // how the router derives /chat/completions from the same root. Key is
          // OPTIONAL (self-hosted may need none): send Bearer only when present,
          // and needsKey:false so a keyless server still gets probed.
          const customBase = (prov.base_url || '').trim().replace(/\/+$/, '');
          const LIST = {
            openrouter: { url: 'https://openrouter.ai/api/v1/models',
                          headers: key ? { Authorization: 'Bearer ' + key } : {}, shape: 'openai' },
            anthropic:  { url: 'https://api.anthropic.com/v1/models?limit=100',
                          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, shape: 'openai', needsKey: true },
            deepseek:   { url: 'https://api.deepseek.com/models',
                          headers: { Authorization: 'Bearer ' + key }, shape: 'openai', needsKey: true },
            alibaba:    { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
                          headers: { Authorization: 'Bearer ' + key }, shape: 'openai', needsKey: true },
            deepinfra:  { url: 'https://api.deepinfra.com/v1/openai/models',
                          headers: { Authorization: 'Bearer ' + key }, shape: 'openai', needsKey: true },
            nvidia:     { url: 'https://integrate.api.nvidia.com/v1/models',
                          headers: { Authorization: 'Bearer ' + key }, shape: 'openai', needsKey: true },
            google_ai:  { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=' + encodeURIComponent(key),
                          headers: {}, shape: 'google', needsKey: true },
            // BYOK, OpenAI-compatible GET /v1/models (Bearer key). Moonshot returns
            // only chat ids; xAI also returns grok-imagine media ids, left as the
            // provider returns them (no media-filter idiom exists for other providers here).
            moonshot:   { url: 'https://api.moonshot.ai/v1/models',
                          headers: { Authorization: 'Bearer ' + key }, shape: 'openai', needsKey: true },
            xai:        { url: 'https://api.x.ai/v1/models',
                          headers: { Authorization: 'Bearer ' + key }, shape: 'openai', needsKey: true },
            custom_openai: { url: customBase ? customBase + '/models' : '',
                          headers: key ? { Authorization: 'Bearer ' + key } : {}, shape: 'openai', needsBase: true },
          };
          const spec = LIST[provName];
          if (!spec) { jsonResponse(res, 200, { models: catalogModelsFor(provName) }); return; }
          // custom_openai has no fetchable list until base_url is set; fail
          // closed to the static single-entry fallback, don't fetch ''.
          if (spec.needsBase && !customBase) { jsonResponse(res, 200, { models: [], reason: 'no_base_url' }); return; }
          if (spec.needsKey && !key) { jsonResponse(res, 200, { models: catalogModelsFor(provName), reason: 'no_key' }); return; }
          const r = await fetch(spec.url, { headers: spec.headers, signal: AbortSignal.timeout(8000) });
          if (!r.ok) { jsonResponse(res, 200, { models: [], http: r.status }); return; }
          const data = await r.json().catch(() => ({}));
          let models = [];
          if (spec.shape === 'google') {
            const list = Array.isArray(data && data.models) ? data.models : [];
            models = list
              .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
              .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: String(m.displayName || m.name || '') }));
          } else {
            const list = Array.isArray(data && data.data) ? data.data : [];
            models = list.map((m) => ({
              id: String((m && m.id) || ''),
              name: String((m && (m.name || m.display_name || m.id)) || '')
            }));
          }
          models = models.filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
          jsonResponse(res, 200, { models });
        } catch (_) {
          jsonResponse(res, 200, { models: [] });
        }
      })();
      return;
    }
  }

  // ===== Provider key verification =====
  // POST /api/providers/verify {name} → {status: "valid"|"invalid"|"unreachable"|"no_key"}
  // Cheap, zero-token probes: each provider's models-list (or key-info)
  // endpoint answers 200 for a working key and 401/403 for a bad one. The
  // key is read from the on-disk config server-side — it never round-trips
  // through the caller, so the UI can verify without ever holding secrets.
  if (req.method === 'POST' && url === '/api/providers/verify') {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: 'unauthorized' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const name = (JSON.parse(body || '{}').name || '').trim();
        const cfgNow = readConfig();
        const prov = (cfgNow.providers || {})[name];
        if (!prov) { jsonResponse(res, 404, { error: 'unknown_provider', name }); return; }
        // Key lookup must match where ROUTING reads it: config.json no longer
        // stores apiKey (env-file routes it to ~/.troth/.env at save time), so
        // fall back to the env-mapped key. Without this, verify reports
        // 'no_key' for a provider that routes fine — the exact split-brain the
        // app's verify chip is supposed to catch, but inverted.
        // Mirror router.js ENV_KEY_MAP exactly — google_ai keeps its key in
        // config (not env-routed), so it's intentionally absent here.
        const ENV_KEY_MAP = {
          anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
          deepseek: 'DEEPSEEK_API_KEY', deepinfra: 'DEEPINFRA_API_KEY',
          nvidia: 'NVIDIA_API_KEY', alibaba: 'ALIBABA_API_KEY',
          zai: 'ZAI_API_KEY', custom_openai: 'CUSTOM_OPENAI_API_KEY'
        };
        const key = ((prov.apiKey || '') || (ENV_KEY_MAP[name] && process.env[ENV_KEY_MAP[name]]) || '').trim();
        // Probe table: URL + auth-header shape per provider. All endpoints
        // are list/metadata calls — no tokens billed.
        const PROBES = {
          anthropic:  { url: 'https://api.anthropic.com/v1/models',
                        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
          deepseek:   { url: 'https://api.deepseek.com/models',
                        headers: { Authorization: 'Bearer ' + key } },
          openrouter: { url: 'https://openrouter.ai/api/v1/key',
                        headers: { Authorization: 'Bearer ' + key } },
          alibaba:    { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
                        headers: { Authorization: 'Bearer ' + key } },
          google_ai:  { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
                        headers: {} },
          deepinfra:  { url: 'https://api.deepinfra.com/v1/openai/models',
                        headers: { Authorization: 'Bearer ' + key } },
          nvidia:     { url: 'https://integrate.api.nvidia.com/v1/models',
                        headers: { Authorization: 'Bearer ' + key } },
        };
        if (name === 'local') {
          const host = prov.host || '127.0.0.1';
          const port = prov.port || 1234;
          try {
            const r = await fetch('http://' + host + ':' + port + '/v1/models', { signal: AbortSignal.timeout(4000) });
            jsonResponse(res, 200, { status: r.ok ? 'valid' : 'unreachable' });
          } catch (_) {
            jsonResponse(res, 200, { status: 'unreachable' });
          }
          return;
        }
        // Custom (OpenAI-compatible): key-OPTIONAL, base_url-driven. Probe
        // <base_url>/models directly (its own branch, because the generic path
        // below returns 'no_key' when no key is set, wrong for a keyless
        // self-hosted server). Send Bearer only when a key is present.
        if (name === 'custom_openai') {
          const base = (prov.base_url || '').trim().replace(/\/+$/, '');
          if (!base) { jsonResponse(res, 200, { status: 'no_base_url' }); return; }
          try {
            const headers = key ? { Authorization: 'Bearer ' + key } : {};
            const r = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(8000) });
            const status = r.ok ? 'valid'
              : (r.status === 401 || r.status === 403) ? 'invalid'
              : 'unreachable';
            jsonResponse(res, 200, { status, http: r.status });
          } catch (_) {
            jsonResponse(res, 200, { status: 'unreachable' });
          }
          return;
        }
        const probe = PROBES[name];
        if (!probe) { jsonResponse(res, 200, { status: 'unknown_provider_no_probe' }); return; }
        if (!key) { jsonResponse(res, 200, { status: 'no_key' }); return; }
        try {
          const r = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(8000) });
          const status = r.ok ? 'valid'
            : (r.status === 401 || r.status === 403) ? 'invalid'
            : 'unreachable';
          jsonResponse(res, 200, { status, http: r.status });
        } catch (_) {
          jsonResponse(res, 200, { status: 'unreachable' });
        }
      } catch (e) {
        jsonResponse(res, 400, { error: 'bad_request', detail: String(e && e.message || e) });
      }
    });
    return;
  }

  // ===== Unknown /api/* → 404, never fall through to the LLM pipeline =====
  // Without this guard, a typo'd dashboard fetch (e.g. /api/healh) would be
  // treated as a /v1/messages call, get the warmup payload, and silently
  // mask routing bugs. JSON 404 keeps the contract honest.
  if (url.startsWith('/api/')) {
    jsonResponse(res, 404, { error: 'unknown_api_route', path: url, method: req.method });
    return;
  }

  // ===== Pre-flight enrichment (subscription-safe path) =====
  // Voice / desktop callers in subscription mode send the API call DIRECTLY
  // to api.anthropic.com (Anthropic killed proxy passthrough  —
  // routing OAuth-backed calls through any proxy is a ban risk). This
  // endpoint lets them still get troth's middleware value: the caller
  // POSTs the user's raw prompt + workspace, we run it through the same
  // `inject()` scaffolding pipeline used for /v1/messages, and return the
  // enriched prompt as plain text. The caller then prepends it to their
  // CLI invocation. No upstream API call made here, no credentials
  // touched, no proxy passthrough — pure local enrichment.
  if (req.method === 'POST' && url === '/v1/enrich') {
    let enrichBody = '';
    req.on('data', c => enrichBody += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(enrichBody || '{}');
        const userPrompt = String(parsed.prompt || '').trim();
        if (!userPrompt) {
          return jsonResponse(res, 400, { error: 'missing_prompt' });
        }
        // Wrap in a minimal Anthropic-shaped body so the existing injector
        // works without re-implementing scaffolding selection.
        const fakeBody = JSON.stringify({
          model: parsed.model || 'claude-sonnet-4-6',
          system: '',
          messages: [{ role: 'user', content: userPrompt }],
        });
        const result = inject(fakeBody, null);
        let scaffolding = '';
        try {
          const enriched = JSON.parse(result.body);
          if (Array.isArray(enriched.system)) {
            scaffolding = enriched.system
              .map(b => (b && typeof b.text === 'string') ? b.text : '')
              .filter(s => s.trim().length > 0)
              .join('\n\n')
              .trim();
          } else if (typeof enriched.system === 'string') {
            scaffolding = enriched.system.trim();
          }
        } catch (_) {}
        const enrichedPrompt = scaffolding
          ? scaffolding + '\n\n---\n\n' + userPrompt
          : userPrompt;
        log('ENRICH | bytes=' + scaffolding.length + ' | type=' + (result.projectType || '?') + ' | mode=' + (result.mode || '?'));
        jsonResponse(res, 200, {
          enriched_prompt: enrichedPrompt,
          scaffolding_bytes: scaffolding.length,
          project_type: result.projectType || 'unknown',
          mode: result.mode || 'unknown',
        });
      } catch (e) {
        log('ENRICH ERR: ' + e.message);
        jsonResponse(res, 500, { error: 'enrich_failed', message: e.message });
      }
    });
    return;
  }

  // ===== LLM Proxy Pipeline =====
  let body = '';
  req.on('data', c => body += c);

  req.on('end', async () => {
    stats.requests++;
    const reqStartMs = Date.now();
    const requestId = stats.requests;

    // ── Early warmup/empty request detection ──
    // Claude Code sends empty or minimal requests on startup. Don't route
    // to cloud providers — they'll fail and mark providers unhealthy.
    if (!body || body.length < 20) {
      log('REQ #' + stats.requests + ' | WARMUP (empty body) — returning OK');
      const warmupResp = JSON.stringify({
        id: 'msg_warmup_' + Date.now(), type: 'message', role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(warmupResp) });
      res.end(warmupResp);
      return;
    }
    try {
      const earlyParsed = JSON.parse(body);
      if (!earlyParsed.messages || !earlyParsed.messages.length) {
        log('REQ #' + stats.requests + ' | WARMUP (no messages) — returning OK');
        const warmupResp = JSON.stringify({
          id: 'msg_warmup_' + Date.now(), type: 'message', role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: earlyParsed.model || 'claude-sonnet-4-20250514', stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(warmupResp) });
        res.end(warmupResp);
        return;
      }
    } catch (e) {}

    // ── Tool-result secret redaction ──
    // Walk the request body and scrub credentials out of tool_result text
    // blocks BEFORE forwarding upstream. Without this, when Claude Code
    // executes a Read on `~/.troth/config.json`, `.env`, `.aws/credentials`
    // etc., the file contents arrive as a tool_result on the next turn and
    // the upstream model (and its provider's logs / cache) sees the raw
    // secrets. We redact at the proxy boundary so secrets never leave this
    // process. Re-stringify back into `body` so the rest of the pipeline
    // (which re-parses `body`) sees the redacted version.
    try {
      const parsedForRedact = JSON.parse(body);
      const { body: redactedBody, redactions } = secrets.redactToolResults(parsedForRedact);
      if (redactions > 0) {
        body = JSON.stringify(redactedBody);
        log('REQ #' + stats.requests + ' | SECRETS | redacted ' + redactions + ' tool_result block(s)');
      }
    } catch (e) {
      // Non-JSON or unexpected shape — leave body untouched. Downstream
      // parse will still error in the same way it would have before.
    }

    // ── Auth-mode detection (P0.5) ──
    // Track whether the inbound request carries x-api-key (BYOK) or OAuth Bearer.
    // Informational only — callAnthropic substitutes auth with providers.anthropic.apiKey,
    // so OAuth traffic doesn't pass through under its original token, avoiding the
    // cch attestation trap documented for OAuth + modified-body.
    try {
      const authmode = require('./modules/authmode');
      const mode = authmode.detect(req.headers);
      authmode.record(mode);
    } catch (e) {}

    // ── Standard processing (API key or third-party models) ──
    const rawBodyKB = (Buffer.byteLength(body) / 1024).toFixed(1);
    // Break down raw Claude Code request
    try {
      const rawParsed = JSON.parse(body);
      const rawSysSize = rawParsed.system ? Buffer.byteLength(typeof rawParsed.system === 'string' ? rawParsed.system : JSON.stringify(rawParsed.system)) : 0;
      const rawToolsSize = rawParsed.tools ? Buffer.byteLength(JSON.stringify(rawParsed.tools)) : 0;
      const rawToolCount = rawParsed.tools ? rawParsed.tools.length : 0;
      const rawMsgsSize = rawParsed.messages ? Buffer.byteLength(JSON.stringify(rawParsed.messages)) : 0;
      const rawMcpTools = rawParsed.tools ? rawParsed.tools.filter(t => t.name && t.name.startsWith('mcp__')).length : 0;
      log('PAYLOAD BREAKDOWN | raw: ' + rawBodyKB + ' KB | system: ' + (rawSysSize/1024).toFixed(1) + ' KB | tools: ' + (rawToolsSize/1024).toFixed(1) + ' KB (' + rawToolCount + ', ' + rawMcpTools + ' MCP) | msgs: ' + (rawMsgsSize/1024).toFixed(1) + ' KB');
      // Optional payload capture for debugging the converter / system-prompt
      // size. Default OFF — earlier code wrote to mode-644 /tmp files containing
      // the raw system prompt (which can include CLAUDE.md credentials) and
      // every tool schema unguarded. Now requires TROTH_DEBUG_PAYLOAD=1 and
      // writes mode-600 to a per-pid file so a co-tenant can't read it.
      if (process.env.TROTH_DEBUG_PAYLOAD === '1'
          && !global._trothPayloadCaptured && rawToolCount > 5) {
        global._trothPayloadCaptured = true;
        try {
          const coreTools = (rawParsed.tools || []).filter(t => !t.name.startsWith('mcp__'));
          const toolSummary = coreTools.map(t => t.name + ' (' + Buffer.byteLength(JSON.stringify(t)) + ' bytes)').join('\n');
          const sysDump = typeof rawParsed.system === 'string' ? rawParsed.system : JSON.stringify(rawParsed.system, null, 2);
          const fs2 = require('fs');
          const toolsPath = '/tmp/troth-payload-tools-' + process.pid + '.txt';
          const sysPath   = '/tmp/troth-payload-system-' + process.pid + '.txt';
          fs2.writeFileSync(toolsPath, 'CORE TOOLS (' + coreTools.length + '):\n' + toolSummary + '\n\nFULL TOOL SCHEMAS:\n' + JSON.stringify(coreTools, null, 2), { mode: 0o600 });
          fs2.writeFileSync(sysPath,   'SYSTEM PROMPT:\n\n' + sysDump, { mode: 0o600 });
          fs2.chmodSync(toolsPath, 0o600);
          fs2.chmodSync(sysPath,   0o600);
        } catch (e) {}
      }
    } catch (e) {}

    // trivial-query gate for the DYNAMIC codelens path (mirror of
    // injector.js gate on the STATIC arch overview). queryContext(body) walks
    // the persistent code graph and returns ~2-5 KB of related code chunks
    // even for "hi" / "reply ok" because the seed extraction tokenizes
    // every word in the prompt. With cloud Anthropic + prompt caching the
    // cost is amortized; with local llama-server (no cache) every turn
    // pays the full prefill — and these injections poison short chat
    // prompts. Skip codelens whenever the latest user message is short
    // (< 80 chars trimmed). Real code work has longer prompts (paths,
    // error messages, multi-line snippets) and falls through.
    let _latestUserForCl = '';
    try {
      const _p = JSON.parse(body);
      const _msgs = _p.messages || [];
      for (let _i = _msgs.length - 1; _i >= 0; _i--) {
        if (_msgs[_i].role === 'user') {
          const _c = _msgs[_i].content;
          if (typeof _c === 'string') _latestUserForCl = _c;
          else if (Array.isArray(_c)) {
            _latestUserForCl = _c
              .filter((b) => b && b.type === 'text' && b.text)
              .map((b) => b.text)
              .join(' ');
          }
          break;
        }
      }
    } catch (_) {}
    // Detect "is this a trivial chat prompt" based ONLY on the latest user
    // message (NOT the whole conversation), so casual chat is recognized as
    // trivial even when the desktop app ships 200+ KB of MCP tool defs +
    // system reminders alongside a 3-char user "hi". Skip codelens for those.
    const _trim = _latestUserForCl.trim();
    const _hasCodeKw =
      /\b(?:fix|refactor|implement|debug|bug|error|exception|stack\s*trace|crash|hang|leak|test|build|deploy|migration|schema|api|endpoint|route|handler|controller|model|component|hook|reducer|selector|service|class\s+\w|function\s+\w|def\s+\w|import\s+\w|from\s+['"][^'"]+|await\s+|async\s+|Promise\b|=>|console\.|require\(|\.tsx?\b|\.jsx?\b|\.py\b|\.go\b|\.rs\b|\.java\b|\.rb\b|\.kt\b|\.swift\b|\.cpp\b|\.h\b|package\.json|tsconfig|cargo\.toml|requirements\.txt|Dockerfile)\b/i.test(_trim);
    const _isTrivialPrompt = _trim.length < 80 && !_hasCodeKw;
    const repoMap = (isModuleEnabled('codelens') && !_isTrivialPrompt) ? queryContext(body) : '';
    let projectType = 'unknown';
    let mode = 'unknown';
    if (isModuleEnabled('injector')) {
      const injection = inject(body, repoMap);
      body = injection.body;
      projectType = injection.projectType;
      mode = injection.mode;
      if (projectType !== 'unknown') stats.injected++;
    }

    const afterInjectKB = (Buffer.byteLength(body) / 1024).toFixed(1);
    log('PAYLOAD AFTER INJECT | ' + afterInjectKB + ' KB (added ' + (afterInjectKB - rawBodyKB).toFixed(1) + ' KB) | type: ' + projectType + '/' + mode);



    // Predictive AST prefetch: warm cache for likely-next files (async, non-blocking)
    try { if (isModuleEnabled('prefetch')) require('./modules/prefetch').predictAndPrefetch(); } catch (e) {}

    // Read-tracking: scan history for Read tool_uses to enable read-before-edit checks
    try { require('./modules/validator').trackReadsFromHistory(body); } catch (e) {}

    // Compressor: dedup Read tool_results for unchanged files, drop empty Bash output, truncate old turns
    if (isModuleEnabled('compressor')) {
      const beforeKB = (Buffer.byteLength(body) / 1024).toFixed(1);
      const compressed = compressRequest(body);
      body = compressed.body;
      if (compressed.stats.elided || compressed.stats.truncated || compressed.stats.droppedEmptyBash) {
        const afterKB = (Buffer.byteLength(body) / 1024).toFixed(1);
        log(`COMPRESSOR | ${beforeKB}KB → ${afterKB}KB | elided:${compressed.stats.elided} truncated:${compressed.stats.truncated} dropped:${compressed.stats.droppedEmptyBash}`);
      }
    }

    // Skimmer: SWE-Pruner Goal Hint pruning of Bash/Read/Grep tool_results
    if (isModuleEnabled('compressor')) {
      try {
        const { skimRequest } = require('./modules/skimmer');
        const beforeKB2 = (Buffer.byteLength(body) / 1024).toFixed(1);
        const skimmed = skimRequest(body);
        body = skimmed.body;
        if (skimmed.stats.skimmed > 0) {
          const afterKB2 = (Buffer.byteLength(body) / 1024).toFixed(1);
          log(`SKIMMER | ${beforeKB2}KB → ${afterKB2}KB | skimmed:${skimmed.stats.skimmed}`);
        }
      } catch (e) {}
    }

    // Context filter: drop short stale assistant narration ("I'll read the file…")
    // from OLD turns. Cheapest broad token cut — research in-module: ~39% of
    // multi-turn prompts carry droppable narration. It was fully built WITH a
    // savings-ledger hook but was never called on the request path (orphaned —
    // only getStats() was wired into the dashboard). Self-guards: keeps the last
    // 2 assistant msgs intact, only strips <150-char text blocks, no-ops under 6
    // messages. Saves input tokens on EVERY provider (runs pre-conversion).
    if (isModuleEnabled('contextfilter')) {
      try {
        const cf = require('./modules/contextfilter').filterContext(body);
        if (cf && cf.body) {
          if (cf.bytesSaved > 0) log(`CONTEXTFILTER | -${(cf.bytesSaved / 1024).toFixed(1)}KB | textBlocks:${cf.textBlocksRemoved} msgs:${cf.messagesRemoved}`);
          body = cf.body;
        }
      } catch (e) {}
    }

    // ── Learn from failures in incoming request ──
    try { if (isModuleEnabled('critic')) require('./modules/critic').learnFromRequest(body); } catch (e) {}

    // ── Preprocess: strip thinking blocks, handle compaction blocks, extract metadata ──
    const preprocessed = preprocessAnthropicBody(body);
    body = preprocessed.bodyStr;
    // Mutable so the voice-triage fast-model branch can also update what
    // downstream Opus-4.7-only handlers see (adaptive thinking, effort,
    // vision validator). Without this they fire against the original
    // model name even after we route to haiku, adding unnecessary
    // overhead and sending Opus-only request fields to a model that
    // does not understand them.
    let requestedModel = preprocessed.requestedModel || 'claude-sonnet-4-20250514';

    // ── Cache-stable pass ──
    // Byte-stable prefix layout so provider prompt caches (Anthropic
    // cache_control, Ollama implicit byte-match, vLLM APC) actually hit
    // instead of getting silently invalidated by MCP schema drift or
    // volatile telemetry in the system prompt. Safe to always run: tools
    // canonicalisation + system sanitise are universal wins; cache_control
    // breakpoints are silently ignored by backends that don't implement
    // the Anthropic beta surface. See proxy/modules/cachestable.js header.
    try {
      const parsedForCache = JSON.parse(body);
      const csResult = cachestable.apply(parsedForCache, { model: requestedModel });
      body = JSON.stringify(csResult.body);
      if (csResult.stats.breakpointsPlaced || csResult.stats.systemStripped) {
        log('REQ #' + stats.requests + ' | CACHESTABLE | bp=' + csResult.stats.breakpointsPlaced +
            ' stripped=' + csResult.stats.systemStripped +
            ' tools=' + csResult.stats.toolsCanonicalized);
      }
    } catch (e) { /* non-fatal: bad JSON or threshold-skip, proxy continues */ }

    // ── Budget enforcement (opt-in spend cap) ──
    // budget.js was fully built but never wired onto the request path, so the
    // per-session / per-day cost cap in ~/.troth/config.json {budget:{...}} was
    // never enforced. It's a NO-OP unless the operator sets a cap (loadBudget
    // returns {} → limits = Infinity), so the consumer default and the operator's own
    // dev sessions are unaffected. When a configured cap is exceeded we stop
    // the request with a clear 429 instead of silently burning past the limit;
    // warnings (≥80% by default) are logged. Wrapped so a budget-module fault
    // can never take down the proxy.
    try {
      const budget = require('./modules/budget');
      const sessionUSD = (require('./modules/cost').getTotals().grandTotalUSD) || 0;
      // Daily spend from usage_ledger priced at read time (the old
      // baseline_cost_events read pinned this to 0 — dead table — so the
      // perDayUSD cap silently never engaged).
      const dailyUSD = ledgerSpendSince(Date.now() - 24 * 60 * 60 * 1000);
      const bchk = budget.checkBudget(sessionUSD, dailyUSD);
      if (bchk.warnings && bchk.warnings.length) {
        bchk.warnings.forEach((w) => log('REQ #' + stats.requests + ' | BUDGET | ' + w));
      }
      if (bchk.blocked) {
        log('REQ #' + stats.requests + ' | BUDGET BLOCKED | ' + (bchk.suggestion || 'cap-exceeded'));
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'budget_exceeded',
          message: bchk.warnings.join(' ') + ' — Troth spend cap reached. Raise budget.perDayUSD / budget.perSessionUSD in ~/.troth/config.json, or switch to a local/free provider.' } }));
        return;
      }
    } catch (e) { /* budget must never block the proxy on its own failure */ }

    // ── troth Cache INVALIDATE → POPULATE (Phases B+C) ──
    // Two-pass walk of the incoming message history:
    //   1. invalidate: for every Edit/Write/MultiEdit/NotebookEdit and every
    //      bulk-trigger Bash (git checkout, npm install, …), purge cache
    //      entries that would have gone stale. Runs FIRST so a subsequent
    //      populate in the same request can't re-admit pre-mutation data.
    //   2. populate: walk (tool_use, tool_result) pairs and cache the
    //      cacheable ones. File-hash keying keeps freshness correct even
    //      without invalidation — this is belt-and-braces.
    // Both are pure reads of the body; no mutation. See troth-cache.js
    // header + design §2 / §5 for key schema and invalidation rules.
    try {
      const parsedForCache = JSON.parse(body);
      const gc = trothCache.getDefault();
      const inv = gc.invalidateFromRequestBody(parsedForCache, { cwd: process.cwd() });
      if (inv.evicted > 0 || inv.bulk > 0) {
        log('REQ #' + stats.requests + ' | GEMCACHE invalidate | mutations=' + inv.mutations +
            ' bulk=' + inv.bulk + ' evicted=' + inv.evicted);
      }
      const pop = gc.populateFromRequestBody(parsedForCache, { cwd: process.cwd() });
      if (pop.stored > 0) {
        log('REQ #' + stats.requests + ' | GEMCACHE populate | scanned=' + pop.scanned +
            ' stored=' + pop.stored + ' skipped=' + pop.skipped);
      }

      // ── Keepalive track (Phase D) ──
      // Refresh the session's idle timer so that if the user goes quiet for
      // >4.5 min we can send a 1-token ping keeping the backend's ephemeral
      // prefix cache warm. Disabled unless TROTH_KEEPALIVE=1. Only Anthropic
      // (direct or via OpenRouter's Anthropic endpoint) has the prefix cache
      // we're refreshing — Ollama/local have no cache to warm, so tracking
      // those sessions would just burn retries for nothing. We gate on the
      // auth signal in the request: sk-ant-* = direct Anthropic, sk-or-* =
      // OpenRouter (whose Anthropic endpoint honours cache_control).
      if (keepaliveMgr.cfg && keepaliveMgr.cfg.enabled) {
        try {
          const apiKey = req.headers['x-api-key'] || '';
          const authHdr = req.headers['authorization'] || '';
          let backendUrl = null;
          if (/^sk-ant-/.test(apiKey)) {
            backendUrl = 'https://api.anthropic.com/v1/messages';
          } else if (/^Bearer\s+sk-or-/i.test(authHdr)) {
            backendUrl = 'https://openrouter.ai/api/v1/messages';
          }
          if (backendUrl) {
            const sessionKey = keepalive.deriveSessionKey(parsedForCache, req);
            if (sessionKey) {
              const headers = {};
              if (apiKey)  headers['x-api-key'] = apiKey;
              if (authHdr) headers['authorization'] = authHdr;
              if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
              if (req.headers['anthropic-beta'])    headers['anthropic-beta']    = req.headers['anthropic-beta'];
              const estTokens = Math.ceil(Buffer.byteLength(body) / 4);
              keepaliveMgr.track(sessionKey, {
                model: parsedForCache.model || requestedModel,
                system: parsedForCache.system,
                tools: parsedForCache.tools,
                backend_url: backendUrl,
                headers,
                estimatedTokens: estTokens,
              });
            }
          }
        } catch (e) { /* keepalive must never break a real request */ }
      }
    } catch (e) { /* non-fatal */ }

    // ── Context compaction intercept ──
    // Claude Code sends context_management with compact_20260112 when
    // auto-compaction triggers. Anthropic's API handles this natively;
    // through our proxy we need to intercept and handle it ourselves
    // using the fallback chain for summarization.
    // NOTE: contextManagement was extracted from the body by preprocessAnthropicBody
    // (the preprocessor deletes it from body since backends don't understand it).
    const contextManagement = preprocessed.contextManagement;
    if (contextManagement) {
      try {
        const cm = contextManagement;
        const compact = cm.compact_20260112
          || (cm.edits && cm.edits.find(e => e.type === 'compact_20260112'))
          || (cm.type === 'compact_20260112' ? cm : null);

        if (compact) {
          const triggerTokens = (compact.trigger && (compact.trigger.input_tokens || compact.trigger.value)) || 150000;
          const estimatedTokens = Math.ceil(Buffer.byteLength(body) / 4);

          if (estimatedTokens >= triggerTokens) {
            log('REQ #' + stats.requests + ' | COMPACTION | ' + estimatedTokens + ' est tokens >= ' + triggerTokens + ' trigger');
            const parsed = JSON.parse(body);
            const compactionOk = await handleCompaction(parsed, res, requestedModel);
            if (compactionOk) return;
            log('Compaction failed — falling through to normal request');
          }
        }
      } catch (e) {}
    }

    // ── Voice triage ──
    // When the request comes from a voice session, classify the latest user
    // text into one of {quick_ack, brief_factual, deep_work, show_text} and
    // inject a per-route persona prompt that caps reply length and forbids
    // markdown/lists/code. Voice detection is dual-source:
    //   1. X-troth-Mode: voice header (set by voice-quality bench runner)
    //   2. [troth/voice] marker in the system prompt (injected by the
    //      troth plugin's session-start hook when TROTH_VOICE_MODE=1
    //      is in the claude CLI subprocess env)
    // Either signal flips voice mode on. Detection is read-only here;
    // routing changes (small fast model for quick_ack/brief_factual) are
    // a Phase 1b follow-up — for now we ride the existing chain and just
    // shape the prompt.
    let voiceRoute = null;
    let voiceForceAnthropic = false;
    try {
      const headerMode = String(req.headers['x-troth-mode'] || '').toLowerCase();
      let isVoice = headerMode === 'voice';
      let parsedV = JSON.parse(body);
      if (!isVoice) {
        const sys = parsedV.system;
        const sysText = typeof sys === 'string'
          ? sys
          : (Array.isArray(sys) ? sys.map((b) => b && b.text || '').join('\n') : '');
        if (sysText.includes('[troth/voice]')) isVoice = true;
      }
      if (isVoice) {
        const voiceTriage = require('./modules/voice-triage');
        // Latest user text — concatenate text blocks of the last user message.
        let userText = '';
        const msgs = parsedV.messages || [];
        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          if (msgs[mi].role !== 'user') continue;
          const c = msgs[mi].content;
          if (typeof c === 'string') { userText = c; break; }
          if (Array.isArray(c)) {
            userText = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join(' ');
            break;
          }
        }
        const t = voiceTriage.triage(userText);
        voiceRoute = t.route;
        // Phase 1c — fast-model override for the two short-answer routes.
        // quick_ack and brief_factual benefit most from a smaller faster
        // model; deep_work needs the heavy chain (correctness > speed),
        // show_text barely speaks at all (6-word ack), so the latency of
        // its model choice doesn't matter. Override is opt-in via
        // transport-config.voice_fast_model — null preserves behavior.
        try {
          const tcfg = require('../shared-core/transport-config');
          const fastModel = tcfg.get('voice_fast_model');
          if (fastModel && (t.route === 'quick_ack' || t.route === 'brief_factual')) {
            const originalModel = parsedV.model;
            parsedV.model = fastModel;
            requestedModel = fastModel;       // keep downstream handlers in sync
            // Anthropic-named fast models (claude-haiku-4-5,
            // claude-sonnet-4-5, etc.) need the Anthropic backend to
            // resolve. Local-named ones (gemma3:4b, qwen3:1.7b) ride
            // the existing fallback/local path. Detect by prefix.
            if (/^claude-/i.test(fastModel)) {
              const provs = getProviders();
              if (provs.anthropic && provs.anthropic.enabled && provs.anthropic.apiKey) {
                voiceForceAnthropic = true;
              }
            }
            log('REQ #' + stats.requests + ' | VOICE FAST-MODEL | ' +
                originalModel + ' → ' + fastModel + ' (' + t.route +
                (voiceForceAnthropic ? ', anthropic' : ', fallback') + ')');
          }
        } catch (_) { /* config read failure — keep original model */ }
        // Per substrate-as-mind invariant: no parallel prompt source.
        // Voice-triage stays as a routing classifier (drives fast-model
        // selection above + downstream UI hints via voiceRoute), but the
        // system prompt is owned by the substrate (troth-entity prefix
        // provider). Removing the persona-block append closes the second
        // prompt path that was steering replies independently of substrate
        // identity. Length/format contracts now live with substrate's
        // identity engrams (audio-mode anchors) and the entity's
        // system-prompt builder, not in proxy regex routes.
        log('REQ #' + stats.requests + ' | VOICE TRIAGE | route=' + t.route +
            ' max_words=' + t.max_words + ' words=' + t.signals.word_count +
            ' reason="' + t.reason + '"');
        try { res.setHeader('X-troth-Voice-Route', t.route); } catch (_) {}
      }
    } catch (e) {
      log('REQ #' + stats.requests + ' | VOICE TRIAGE skipped — ' + e.message);
    }

    // Routing decision — honours the runtime mode override set via POST /api/routing.
    // 'smart' mode: human instructions → Anthropic API (if configured) or fallback,
    // mid-loop tool-result digestion → fallback chain (cheaper/faster).
    let routeTarget; // 'anthropic', 'fallback', 'local'
    if (voiceForceAnthropic) {
      // Phase 1c — voice fast-model selected an Anthropic-named target
      // (e.g. claude-haiku-4-5). Force the Anthropic backend regardless
      // of routingMode so the override actually changes the latency
      // profile, not just the model name in the body.
      routeTarget = 'anthropic';
      log('REQ #' + stats.requests + ' | VOICE FAST-MODEL → ANTHROPIC');
    } else if (routingMode === 'anthropic') {
      routeTarget = 'anthropic';
      log('REQ #' + stats.requests + ' | ANTHROPIC API');
    } else if (routingMode === 'local') {
      routeTarget = 'local';
      log('REQ #' + stats.requests + ' | LOCAL');
    } else if (routingMode === 'smart') {
      // Smart routing: human instructions → best available (Anthropic API if configured, else fallback)
      // Mid-loop tool results → fallback chain (cheaper/faster)
      try {
        const parsed = JSON.parse(body);
        const msgs = parsed.messages || [];
        let isSimple = false;
        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          if (msgs[mi].role === 'user') {
            const content = msgs[mi].content;
            if (Array.isArray(content)) {
              const hasText = content.some(b => b.type === 'text' && b.text && b.text.trim().length > 0);
              const hasToolResult = content.some(b => b.type === 'tool_result');
              isSimple = hasToolResult && !hasText;
            }
            break;
          }
        }
        if (isSimple) {
          routeTarget = 'fallback';
          log('REQ #' + stats.requests + ' | SMART → FALLBACK (mid-loop)');
        } else {
          const provs = getProviders();
          if (provs.anthropic && provs.anthropic.enabled && provs.anthropic.apiKey) {
            routeTarget = 'anthropic';
            log('REQ #' + stats.requests + ' | SMART → ANTHROPIC API (planning)');
          } else {
            routeTarget = 'fallback';
            log('REQ #' + stats.requests + ' | SMART → FALLBACK (planning)');
          }
        }
      } catch (e) { routeTarget = 'fallback'; }
    } else {
      // 'auto' or 'gemini' (legacy) or 'fallback' or anything else → fallback chain
      routeTarget = 'fallback';
      log('REQ #' + stats.requests + ' | FALLBACK');
    }

    // ── RouteLLM complexity scoring (informational, drives Architect decision) ──
    let complexityScore = null;
    try {
      const { recommendRoute } = require('./modules/routelm');
      const rec = recommendRoute(body);
      complexityScore = rec.score;
      if (rec.tier === 'strong' || rec.score >= 7) {
        log('REQ #' + stats.requests + ' | COMPLEXITY ' + rec.score + '/10 → ' + rec.tier);
      }
    } catch (e) {}

    // ── Architect/Editor split ──
    // For COMPLEX NEW tasks (human instruction, not mid-loop), run an
    // architect pass on a strong model first to produce a structured plan,
    // then inject the plan into the system prompt for the executor model.
    // Aider research: 85% edit accuracy with this pattern.
    // Skip if routing to local (local backend often is the planning model anyway).
    if (routeTarget !== 'local' && isModuleEnabled('injector')) {
      try {
        const parsed2 = JSON.parse(body);
        const msgs2 = parsed2.messages || [];
        let userText = '';
        let isMidLoop = false;
        for (let mi = msgs2.length - 1; mi >= 0; mi--) {
          if (msgs2[mi].role === 'user') {
            const c = msgs2[mi].content;
            if (typeof c === 'string') userText = c;
            else if (Array.isArray(c)) {
              const txt = c.filter(b => b.type === 'text' && b.text);
              if (!txt.length) { isMidLoop = true; break; }
              // Score the operator's words, not the envelope around them.
              // Substrate recall, goals and harness reminders ride in the same
              // message as separate blocks, so joining everything scores a
              // two-word turn as a large task. Dropped for scoring only — the
              // request itself is untouched.
              const own = txt.filter(b => !/^\s*(\[troth\/|<system-reminder>)/.test(b.text));
              userText = (own.length ? own : txt).map(b => b.text).join(' ');
            }
            break;
          }
        }
        const isNewTask = !isMidLoop && msgs2.length <= 4;
        const isComplex = userText.length > 120 && /\b(build|create|implement|refactor|migrate|redesign|add.*feature|add.*endpoint|fix.*bug|all.*tests|dashboard|multiple|api.*route|full.*app|build.*project)\b/i.test(userText);
        if (isNewTask && isComplex) {
          const archStart = Date.now();
          const plan = await generatePlan(userText);
          if (plan && plan.length > 50) {
            body = injectPlan(body, plan);
            log('ARCHITECT | plan generated in ' + (Date.now() - archStart) + 'ms (' + plan.length + ' chars)');
            // Start workflow state machine to track progress across turns
            try { if (isModuleEnabled('workflow')) require('./modules/workflow').startTask(userText, plan); } catch (e) {}
          }
        }
      } catch (e) {
        log('Architect step failed: ' + (e.message || e));
      }
    }

    // Vision augmentation (uses fallback chain for multimodal analysis)
    if (routeTarget !== 'local' && isModuleEnabled('vision')) {
      try {
        body = await augmentToolResults(body);
      } catch (e) {
        log('vision augmentation failed: ' + (e.message || e));
      }
    }

    // P6: recall forcing. A fresh memory-shaped question on a request that
    // carries a troth recall tool gets tool_choice forced to it — the one
    // hard-enforcement mechanism the proxy lane has for agents without our
    // hooks. Every guard (manual thinking, client choice, mid-loop, the
    // hook lane having spoken) lives in the module. The explicit-local mode
    // is skipped outright; on the fallback chain the force binds only on
    // lanes that carry MCP tools (Anthropic, Responses) — the OpenAI-compat
    // chat conversion strips them and drops tool_choice with them, so there
    // it evaporates harmlessly. preprocessAnthropicBody stripped `thinking`
    // back at the top of the pipeline, so the original type rides in as an
    // opt — the manual-thinking guard would otherwise never see it.
    if (routeTarget !== 'local' && isModuleEnabled('recallforce')) {
      try {
        const rf = require('./modules/recallforce').apply(body, {
          thinkingType: preprocessed.thinkingConfig && preprocessed.thinkingConfig.thinkingType
        });
        if (rf.forced) {
          body = rf.body;
          log('RECALLFORCE | ' + rf.reason + ' — memory-shaped prompt, recall is no longer optional');
        }
      } catch (e) {}
    }

    if (routeTarget === 'anthropic') {
      // P3.5: /ultrareview replication. If the latest user message triggers
      // the pattern, inject a 4-pass audit system block and force effort=max.
      // Works on any Anthropic model, but sharpest on Opus 4.7.
      try {
        const ultrareview = require('./modules/ultrareview');
        const ur = ultrareview.apply(body);
        if (ur.triggered) {
          body = ur.body;
          log('ULTRAREVIEW | triggered — effort=max, 4-pass audit injected');
        }
      } catch (e) {}
      // P3.3: Vision size validation — warn on images exceeding Opus 4.7's
      // 2,576px long-edge per-image limit. Anthropic will server-side
      // downsample, degrading visual fidelity. This is observation-only;
      // auto-downscale requires an image-processing dep we don't ship.
      if (requestedModel.indexOf('claude-opus-4-7') === 0) {
        try {
          const findings = require('./modules/visionvalidator').scanBody(body);
          const oversized = findings.filter(f => !f.result.valid);
          if (oversized.length > 0) {
            const sample = oversized[0].result;
            log('[vision] ' + oversized.length + ' image(s) exceed 2576px long-edge (sample: ' +
              sample.width + 'x' + sample.height + '). Server will downsample.');
          }
        } catch (e) {}
      }
      // Re-inject adaptive thinking for Opus 4.7 (P0.3).
      // 4.7 default for thinking.display changed from "summarized" to omitted,
      // which returns empty thinking blocks. Force explicit display when caller
      // had asked for reasoning. [Opus-4.7 research, surprise finding #2]
      if (requestedModel.indexOf('claude-opus-4-7') === 0 && preprocessed.thinkingConfig) {
        try {
          const bodyObj = JSON.parse(body);
          bodyObj.thinking = {
            type: 'adaptive',
            display: preprocessed.thinkingConfig.thinkingDisplay || 'summarized'
          };
          body = JSON.stringify(bodyObj);
        } catch (e) {}
      }
      // P2.2/P2.3: Task Budgets + effort (Opus 4.7 public beta + xhigh support).
      // Anthropic recommends xhigh (not high) as the starting point for coding on 4.7.
      // task_budget is advisory; max_tokens remains the hard cap.
      let callHeaders = req.headers;
      if (requestedModel.indexOf('claude-opus-4-7') === 0) {
        try {
          // Ensure effort is set. Default xhigh for coding-like modes, high otherwise.
          // [research: Opus-4.7 recommends xhigh for coding; §Effort Control]
          const bodyObj = JSON.parse(body);
          if (!bodyObj.output_config) bodyObj.output_config = {};
          if (!bodyObj.output_config.effort) {
            const codingModes = { feature: 1, debugging: 1, refactoring: 1, testing: 1, performance: 1, security: 1 };
            bodyObj.output_config.effort = codingModes[mode] ? 'xhigh' : 'high';
          }
          // Carry caller's effort forward if the original request had one
          if (preprocessed.thinkingConfig && preprocessed.thinkingConfig.effort && !bodyObj.output_config.effort) {
            bodyObj.output_config.effort = preprocessed.thinkingConfig.effort;
          }
          body = JSON.stringify(bodyObj);

          const { applyTaskBudget } = require('./modules/taskbudgets');
          const existingBeta = (req.headers && req.headers['anthropic-beta']) || '';
          const tb = applyTaskBudget(body, existingBeta);
          body = tb.body;
          if (tb.beta !== existingBeta) {
            callHeaders = Object.assign({}, req.headers, { 'anthropic-beta': tb.beta });
          }
        } catch (e) {}
      }
      log('REQ #' + stats.requests + ' | ANTHROPIC API | ' + projectType + '/' + mode);
      // P3.1: record our char-based estimate of the outbound body so we can
      // compare against the actual input_tokens Anthropic reports.
      let estimatedInputTokens = 0;
      try {
        const tokenestimate = require('./modules/tokenestimate');
        estimatedInputTokens = tokenestimate.estimateBodyTokens(body, requestedModel);
      } catch (e) {}
      const anthropicResult = await callAnthropic(body, callHeaders);
      if (anthropicResult && anthropicResult.success) {
        let responseBody = processResponse(anthropicResult.response, true);
        // Scale tokens for correct compaction timing + log estimator drift.
        try {
          const p = JSON.parse(responseBody);
          const servedModel = p.model || requestedModel;
          if (p.usage && requestedModel) {
            // P3.1: drift telemetry — our estimate vs Anthropic's real count.
            if (estimatedInputTokens > 0) {
              try {
                require('./modules/tokencount').logActualVsEstimated(
                  requestedModel, estimatedInputTokens, p.usage.input_tokens
                );
              } catch (e) {}
            }
            scaleUsage(p.usage, servedModel, believedContextWindow(requestedModel, req.headers));
          }
          if (p.model && requestedModel) p.model = requestedModel;
          responseBody = JSON.stringify(p);
        } catch (e) {}
        // SSE streaming wrapper (same as fallback chain)
        let wantsStream = false;
        try { wantsStream = JSON.parse(body).stream === true; } catch (e) {}
        if (wantsStream) {
          try {
            const respObj = JSON.parse(responseBody);
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
            const emit = (event, data) => { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
            emit('message_start', { type: 'message_start', message: { id: respObj.id || ('msg_' + Date.now()), type: 'message', role: 'assistant', content: [], model: respObj.model || requestedModel, stop_reason: null, stop_sequence: null, usage: respObj.usage || { input_tokens: 0, output_tokens: 0 } } });
            const content = Array.isArray(respObj.content) ? respObj.content : [];
            for (let ci = 0; ci < content.length; ci++) {
              const block = content[ci];
              if (block.type === 'text') {
                emit('content_block_start', { type: 'content_block_start', index: ci, content_block: { type: 'text', text: '' } });
                // B9: iterate by codepoint (Array.from) not UTF-16 unit so
                // we don't split surrogate pairs (emoji, CJK astral plane)
                // mid-character — that produces invalid UTF-8 in the SSE
                // payload and breaks the client-side tokenizer.
                const cps = Array.from(block.text || '');
                for (let p = 0; p < cps.length; p += 50) { emit('content_block_delta', { type: 'content_block_delta', index: ci, delta: { type: 'text_delta', text: cps.slice(p, p + 50).join('') } }); }
                emit('content_block_stop', { type: 'content_block_stop', index: ci });
              } else if (block.type === 'tool_use') {
                emit('content_block_start', { type: 'content_block_start', index: ci, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
                emit('content_block_delta', { type: 'content_block_delta', index: ci, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
                emit('content_block_stop', { type: 'content_block_stop', index: ci });
              }
            }
            emit('message_delta', { type: 'message_delta', delta: { stop_reason: respObj.stop_reason || 'end_turn', stop_sequence: null }, usage: { output_tokens: (respObj.usage && respObj.usage.output_tokens) || 0 } });
            emit('message_stop', { type: 'message_stop' });
            res.end();
            return;
          } catch (e) { log('SSE wrapping failed for Anthropic path: ' + e.message); }
        }
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
        res.end(responseBody);
        return;
      }
      // Anthropic failed — try fallback chain
      log('Anthropic API failed — trying fallback chain');
      // Out-param: callFallbackChain fills.pinFailure when a routing pin is
      // set and the pinned engine could not serve (excluded or its own call
      // 429/401'd). Fresh object per request so concurrent turns never share.
      const fbOpts = { pinFailure: null };
      const fbResult = await callFallbackChain(body, fbOpts);
      if (fbResult && typeof fbResult === 'string') {
        let responseBody = processResponse(fbResult, false);
        try {
          const p = JSON.parse(responseBody);
          const servedModel = p.model || requestedModel;
          if (p.model && requestedModel) p.model = requestedModel;
          if (p.usage) scaleUsage(p.usage, servedModel, believedContextWindow(requestedModel, req.headers));
          responseBody = JSON.stringify(p);
        } catch (e) {}
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
        res.end(responseBody);
        return;
      }
      // Pinned engine failed closed: return the DISTINCT fail-fast 400 that
      // names the pin + reason. 400 is deliberate: upstream CLIs treat it as
      // fatal and surface it immediately, whereas 502/503/429 trigger their
      // exponential-backoff retry storm.
      if (writePinFailure(res, fbOpts)) return;
      stats.errors++;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'All providers failed (Anthropic API + fallback chain)' } }));
      return;
    }

    if (routeTarget === 'fallback') {
      // callFallbackChain returns a single non-streaming JSON body. When
      // Claude Code requests stream:true we synthesize the SSE event stream
      // (message_start → content_block_start/delta/stop per block →
      // message_delta → message_stop) below — see "Streaming wrapper". CC
      // gets the same shape it would from a native streaming provider; the
      // tradeoff is timing (single deferred burst, not token-by-token).
      log('REQ #' + stats.requests + ' | FALLBACK CHAIN | ' + projectType + '/' + mode);
      // Out-param: filled with a pin-failure descriptor when a routing pin is
      // set and the pinned engine could not serve. Read after the chain
      // resolves; a fresh object per request keeps concurrent turns isolated.
      const fbOpts = { pinFailure: null };
      let fbResult = await callFallbackChain(body, fbOpts);
      // Aider infinite-output prefilling — if response was truncated at max_tokens, continue
      if (fbResult && typeof fbResult === 'string') {
        try { fbResult = await continueIfTruncated(body, fbResult); } catch (e) {}
      }
      if (fbResult && typeof fbResult === 'string') {
        let responseBody = processResponse(fbResult, true);

        // Streaming wrapper: if Claude Code requested stream:true, convert
        // the complete Anthropic response into SSE event chunks.
        let wantsStream = false;
        try { wantsStream = JSON.parse(body).stream === true; } catch (e) {}
        if (wantsStream) {
          try {
            const respObj = JSON.parse(responseBody);
            const servedModel = respObj.model || requestedModel;
            // Mask model identity + scale tokens for compaction
            if (requestedModel && respObj.model) respObj.model = requestedModel;
            if (respObj.usage && requestedModel) {
              scaleUsage(respObj.usage, servedModel, believedContextWindow(requestedModel, req.headers));
            }
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive'
            });
            const emit = (event, data) => {
              res.write('event: ' + event + '\n');
              res.write('data: ' + JSON.stringify(data) + '\n\n');
            };
            // message_start
            emit('message_start', {
              type: 'message_start',
              message: {
                id: respObj.id || ('msg_' + Date.now()),
                type: 'message',
                role: 'assistant',
                content: [],
                model: respObj.model || requestedModel,
                stop_reason: null,
                stop_sequence: null,
                usage: respObj.usage || { input_tokens: 0, output_tokens: 0 }
              }
            });
            const content = Array.isArray(respObj.content) ? respObj.content : [];
            for (let ci = 0; ci < content.length; ci++) {
              const block = content[ci];
              if (block.type === 'text') {
                emit('content_block_start', {
                  type: 'content_block_start', index: ci,
                  content_block: { type: 'text', text: '' }
                });
                // B9: codepoint-aware chunking (Array.from) avoids splitting
                // surrogate pairs (emoji / CJK astral plane) which produces
                // invalid UTF-8 in the SSE delta payload.
                const cps = Array.from(block.text || '');
                const chunkSize = 50;
                for (let p = 0; p < cps.length; p += chunkSize) {
                  emit('content_block_delta', {
                    type: 'content_block_delta', index: ci,
                    delta: { type: 'text_delta', text: cps.slice(p, p + chunkSize).join('') }
                  });
                }
                emit('content_block_stop', { type: 'content_block_stop', index: ci });
              } else if (block.type === 'tool_use') {
                emit('content_block_start', {
                  type: 'content_block_start', index: ci,
                  content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
                });
                emit('content_block_delta', {
                  type: 'content_block_delta', index: ci,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) }
                });
                emit('content_block_stop', { type: 'content_block_stop', index: ci });
              }
            }
            emit('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: respObj.stop_reason || 'end_turn', stop_sequence: null },
              usage: { output_tokens: (respObj.usage && respObj.usage.output_tokens) || 0 }
            });
            emit('message_stop', { type: 'message_stop' });
            res.end();
            // Perflog — the streaming lane must record here too: Claude
            // Code turns are always stream:true, and a streaming lane that
            // ends without recording leaves no per-request rows at all.
            // Mirror of the
            // non-streaming record further down; the catch keeps a scope or
            // shape surprise from ever touching the served response.
            try {
              require('./modules/perflog').record({
                requestId, provider: 'fallback',
                model: respObj.model || requestedModel,
                latencyMs: Date.now() - reqStartMs,
                inputTokens: (respObj.usage && respObj.usage.input_tokens) || 0,
                outputTokens: (respObj.usage && respObj.usage.output_tokens) || 0,
                mode, projectType,
              });
            } catch (e) {}
            return;
          } catch (e) {
            log('SSE wrapping failed, falling back to non-streaming: ' + e.message);
            // Class-level safety net: if the upstream ALREADY returned a valid
            // Anthropic SSE stream (event: message_start...) it is the exact
            // wire shape Claude Code expects — pass it straight through instead
            // of shipping it under content-type application/json, which makes CC
            // cancel the turn. Covers ANY Anthropic-passthrough provider that
            // streams despite stream:false (kimi_sub, anthropic, future ones).
            // Model identity stays masked via a textual replace so the served
            // model never leaks.
            if (!res.headersSent && /^\s*event:\s*message/.test(responseBody)) {
              let sse = responseBody;
              const sseServed = (sse.match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || requestedModel;
              sse = scaleUsageInSSE(sse, sseServed, believedContextWindow(requestedModel, req.headers));
              if (requestedModel) sse = sse.replace(/"model"\s*:\s*"[^"]+"/g, '"model":"' + requestedModel + '"');
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
              res.end(sse);
              return;
            }
          }
        }

        // Flash quality gate: if response has a large Write, ask Flash to verify
        try {
          const parsed = JSON.parse(responseBody);
          const writes = (parsed.content || []).filter(b => b.type === 'tool_use' && (b.name === 'Write' || b.name === 'write') && b.input && b.input.content);
          const bigWrite = writes.find(w => w.input.content.split('\n').length > 80);
          if (bigWrite) {
            const { callFlash } = require('./modules/router');
            const review = await callFlash(
              'Quick review — is this code COMPLETE? Check for: empty function bodies, placeholder comments, missing imports, unclosed brackets. File: ' +
              bigWrite.input.file_path + '\n```\n' + bigWrite.input.content.slice(0, 15000) + '\n```\n\nRespond LGTM if complete, or list critical issues only.'
            );
            if (review && !review.startsWith('LGTM') && review.length > 10) {
              log('Flash gate: issues found in ' + bigWrite.input.file_path);
              // Don't block — send response but inject feedback for next turn
              try { require('./modules/critic').setPendingFeedback('## Flash Quality Gate\n' + review + '\n\nFix these before proceeding.'); } catch(e) {}
            }
          }
        } catch (e) {}

        // Validate edit tool calls (fuzzy matching auto-corrects)
        try {
          const { findFirstInvalidToolUse } = require('./modules/validator');
          const invalid = findFirstInvalidToolUse(responseBody);
          if (invalid) {
            log('FALLBACK edit validation failed: ' + invalid.error);
            // Let it through — Claude Code will handle the error and retry
          }
        } catch (e) {}

        try {
          const p = JSON.parse(responseBody);
          const servedModel = p.model || requestedModel;
          if (p.model && requestedModel) p.model = requestedModel;
          // Scale tokens for correct compaction timing on non-200K models
          if (p.usage && requestedModel) {
            scaleUsage(p.usage, servedModel, believedContextWindow(requestedModel, req.headers));
          }
          responseBody = JSON.stringify(p);
        } catch (e) {}
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
        res.end(responseBody);
        // Perflog
        try {
          const p = JSON.parse(responseBody);
          require('./modules/perflog').record({
            requestId, provider: 'fallback',
            model: p.model || requestedModel,
            latencyMs: Date.now() - reqStartMs,
            inputTokens: p.usage?.input_tokens || 0,
            outputTokens: p.usage?.output_tokens || 0,
            mode, projectType,
          });
        } catch (e) {}
        return;
      }
      // Pinned engine failed closed: return the DISTINCT fail-fast 400 that
      // names the pin + reason, and NEVER fall through to local (the operator
      // pinned one engine; answering from another is exactly the leak we are
      // closing). 400 is deliberate so upstream CLIs surface it immediately
      // instead of retrying 5xx/429 into ~128s of silence.
      if (writePinFailure(res, fbOpts)) return;
      // Fallback chain failed — only fall through to local if the local
      // backend is actually reachable. Without this guard the proxy used
      // to ECONNREFUSED to a dead host (e.g. a remote LLM box on a
      // private network that's offline, or a local Ollama that was
      // never started) and CC sat in a 1.2M ms retry loop. Cleaner:
      // surface the failure immediately.
      try {
        var routerMod = require('./modules/router');
        if (routerMod.isLocalAvailable && !routerMod.isLocalAvailable()) {
          log('Fallback chain failed — local backend unavailable; returning 503 to client');
          stats.errors++;
          if (!res.headersSent) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'all_providers_unavailable', message: 'No cloud provider answered and the local backend is unreachable. Check provider API keys, quotas, or start the local backend.' }));
          }
          return;
        }
      } catch (e) { /* probe failed — fall through to legacy local path */ }
      log('Fallback chain failed — falling through to local');
    }

    // Local backend
    log('REQ #' + stats.requests + ' | LOCAL | ' + projectType + '/' + mode);

    try {
      const cfg = readConfig();
      const result = await forwardToLocal(req, body, BACKEND_HOST, BACKEND_PORT, { model: cfg.model, apiKey: cfg.apiKey });
      let responseBody = processResponse(result.body, /* isRemoteAPI */ false);
      // Mask model identity — local backend returns "gemma-4-31B" etc.
      // Works for both JSON (non-streaming) and SSE (streaming) responses.
      // Also wires per-provider token counters for the local path —
      // forwardToLocal now translates response shape to Anthropic, so
      // input_tokens / output_tokens are the right keys to read. Without
      // this the dashboard always shows local: { input: 0, output: 0 }
      // even on heavy traffic.
      let parsedForUsage = null;
      if (requestedModel) {
        try {
          parsedForUsage = JSON.parse(responseBody);
          const servedLocal = parsedForUsage.model || cfg.model || '';
          if (parsedForUsage.usage) {
            scaleUsage(parsedForUsage.usage, servedLocal, believedContextWindow(requestedModel, req.headers));
          }
          if (parsedForUsage.model) parsedForUsage.model = requestedModel;
          responseBody = JSON.stringify(parsedForUsage);
        } catch (e) {
          // SSE/streaming response — string replace model name
          responseBody = responseBody.replace(/"model"\s*:\s*"[^"]+"/g, '"model":"' + requestedModel + '"');
        }
      } else {
        try { parsedForUsage = JSON.parse(responseBody); } catch (_) {}
      }
      try {
        const u = parsedForUsage && parsedForUsage.usage;
        if (u) {
          // Prefer Anthropic-shape (post-conversion) but fall back to OpenAI-shape.
          const inT  = (typeof u.input_tokens  === 'number') ? u.input_tokens  : (u.prompt_tokens     || 0);
          const outT = (typeof u.output_tokens === 'number') ? u.output_tokens : (u.completion_tokens || 0);
          const rs = routerStats();
          if (rs && rs.tokens && rs.tokens.local) {
            rs.tokens.local.input  = (rs.tokens.local.input  || 0) + inT;
            rs.tokens.local.output = (rs.tokens.local.output || 0) + outT;
          }
        }
      } catch (_) {}
      const headers = {};
      for (const [k, v] of Object.entries(result.headers)) {
        if (k === 'transfer-encoding' || k === 'content-length') continue;
        headers[k] = v;
      }
      headers['content-length'] = Buffer.byteLength(responseBody);
      res.writeHead(result.statusCode, headers);
      res.end(responseBody);
    } catch (err) {
      stats.errors++;
      log('ERR: ' + err.message);
      // Don't leak BACKEND_HOST:BACKEND_PORT in the response body — when
      // bound on 0.0.0.0 (Tailscale) any peer hitting the proxy with a
      // malformed request would otherwise learn the internal Ollama
      // address. Operator can see the host/port in the local proxy log.
      // Unified with the 503 above: a forwardToLocal throw means every
      // provider in the chain (cloud + local) failed for this request, so
      // surface as `all_providers_unavailable`, not a misleading "check
      // your local model server" hint that confuses cloud-only users.
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'all_providers_unavailable', message: 'No provider answered (cloud chain exhausted and local backend errored). Enable a working provider in the dashboard.' }));
      }
    }
  });
});

//  PID file unlinker, shared between the SIGINT/SIGTERM
// handler at file top and the /api/shutdown HTTP path. The signal
// handlers exit immediately so this needs to be a fast inline unlink
// (no extra IO besides the unlink). Best-effort: a crash without
// SIGTERM leaves the file behind, which the next cleanOrphanSiblings
// scan in bin/troth.js reconciles by checking PID liveness.
function unlinkPidFile() {
  try {
    const fsP = require('fs');
    const pathP = require('path');
    const HOME_P = process.env.HOME || require('os').homedir();
    fsP.unlinkSync(pathP.join(HOME_P, '.troth', 'proxy-' + listenPort + '.pid'));
  } catch (_) { /* missing file = nothing to do */ }
}
// Prevent unhandled errors from killing the proxy. Log them and keep running.
process.on('uncaughtException', (err) => { console.error('[FATAL] uncaught exception (proxy stays alive):', err.message || err); });
process.on('unhandledRejection', (err) => { console.error('[FATAL] unhandled rejection (proxy stays alive):', err && err.message || err); });
// Handle both SIGINT (Ctrl-C) and SIGTERM (plain `kill <pid>`). Without
// the SIGTERM handler, the default Node behaviour used to ignore the
// signal on this process because a listener existed for 'SIGINT' only —
// leaving SIGKILL as the only way out.
function gracefulShutdown(signal) {
  log('Shutting down (' + signal + ')');
  try { keepaliveMgr.stopAll(); } catch (e) {}
  const forceExit = setTimeout(() => process.exit(1), 5000).unref();
  server.close(() => { clearTimeout(forceExit); process.exit(0); });
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (listenPort - PORT < 10) {
      listenPort += 1;
      console.error('[troth] Port ' + (listenPort - 1) + ' busy, trying ' + listenPort + '…');
      setTimeout(() => server.listen(listenPort, BIND_HOST), 50);
      return;
    }
    console.error('[troth] Ports ' + PORT + '–' + listenPort + ' all busy. Set GF_PORT=<free port> and retry.');
    process.exit(1);
  }
  throw err;
});

// Socket-level safety nets. headersTimeout and requestTimeout are the
// Node-native defence against slowloris-style stuck-socket exhaustion;
// server.timeout is the idle-socket reaper. Paired with the per-request
// watchdog above, a stuck handler can no longer run forever.
server.headersTimeout = 60 * 1000;            // 60s to receive headers
server.requestTimeout = REQUEST_MAX_MS;        // match end-to-end cap
server.timeout        = REQUEST_MAX_MS + 30000; // idle socket reaper (watchdog fires first)

// One-shot scan for other troth-proxy-* instances at boot. The CLI launcher
// already cleans orphans (bin/troth.js cleanOrphanSiblings), but launchd and
// /api/repair/restart start server.js directly and used to only WARN — so a
// stray survived boots for hours, silently heating the laptop. Now boot
// closes them itself with the /api/repair/reap discipline: SIGTERM, 2.5s,
// SIGKILL survivors. TROTH_KEEP_SIBLINGS=1 keeps the old warn-only behavior
// for CI / deliberate multi-instance setups.
function cleanSiblingsAtBoot() {
  try {
    const { execFileSync } = require('child_process');
    // Anchored on the COMMAND column starting with the retitled process name.
    // A loose /troth-proxy-/ contains-match once killed the operator's own
    // shell because its command LINE mentioned the string. Only a process
    // that IS troth-proxy-<port> qualifies — same discipline as /api/repair/reap.
    const out = execFileSync('ps', ['-axo', 'pid=,pcpu=,etime=,command='], { encoding: 'utf8' });
    const siblings = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+troth-proxy-(\d+)/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (!pid || pid === process.pid) continue;
      siblings.push({ pid, cpu: parseFloat(m[2]), etime: m[3], port: parseInt(m[4], 10) });
    }
    if (!siblings.length) return;
    if (process.env.TROTH_KEEP_SIBLINGS === '1') {
      log('⚠  Detected ' + siblings.length + ' other troth-proxy process(es) (kept: TROTH_KEEP_SIBLINGS=1):');
      for (const s of siblings) {
        log('   pid=' + s.pid + ' port=' + s.port + ' cpu=' + s.cpu.toFixed(1) + '% up=' + s.etime);
      }
      return;
    }
    log('Closing ' + siblings.length + ' stray troth-proxy process(es) (TROTH_KEEP_SIBLINGS=1 to keep them):');
    for (const s of siblings) {
      log('   pid=' + s.pid + ' port=' + s.port + ' cpu=' + s.cpu.toFixed(1) + '% up=' + s.etime);
      try { process.kill(s.pid, 'SIGTERM'); } catch (_) {}
    }
    setTimeout(function () {
      let killed = 0;
      for (const s of siblings) {
        try { process.kill(s.pid, 0); process.kill(s.pid, 'SIGKILL'); killed++; } catch (_) { /* already gone */ }
      }
      if (killed) log('   ' + killed + ' ignored SIGTERM and got SIGKILL.');
    }, 2500);
  } catch (e) { /* ps unavailable — skip silently */ }
}

server.listen(listenPort, BIND_HOST, () => {
  process.title = 'troth-proxy-' + listenPort;
  //  write PID file so the CLI's cleanOrphanSiblings scan
  // (bin/troth.js) can reliably distinguish a live primary from a
  // dead-zombie orphan. Best-effort; survives both fresh-bind and
  // EADDRINUSE-auto-bumped paths since this runs in the listen callback.
  try {
    const fsP = require('fs');
    const pathP = require('path');
    const HOME_P = process.env.HOME || require('os').homedir();
    const dataDir = pathP.join(HOME_P, '.troth');
    if (!fsP.existsSync(dataDir)) fsP.mkdirSync(dataDir, { recursive: true });
    fsP.writeFileSync(pathP.join(dataDir, 'proxy-' + listenPort + '.pid'), String(process.pid));
  } catch (_) { /* non-fatal */ }
  // One measurement run of the ground walls when a request marker asks for
  // it — the proxy is the one process here that stands on unwalled ground,
  // so it is the only place a wall profile can be applied and observed.
  try { require('../shared-core/tools/wall-doctor.js').maybeRunFromBoot(); } catch (_) { /* non-fatal */ }
  log('troth Proxy v' + VERSION);
  log('Local LLM server: ' + BACKEND_HOST + ':' + BACKEND_PORT);

  try { require('./modules/router').warmContextWindows(); } catch (_) {}

  // B2 uninstall self-reaper - mirrors bin/troth-entity.js.
  // A proxy whose server.js vanished serves deleted code forever after an
  // uninstall (nothing respawns to trigger the staleness reap). Exit
  // gracefully; a live install's spawner brings up a fresh proxy.
  (function selfReaper() {
    const REAP_PATH = process.env.TROTH_SELF_REAP_PATH || __filename;
    const REAP_MS = Math.max(parseInt(process.env.TROTH_SELF_REAP_MS || '60000', 10) || 60000, 50);
    const REAP_GRACE_MS = Math.max(parseInt(process.env.TROTH_SELF_REAP_GRACE_MS || '10000', 10) || 10000, 50);
    let reaping = false;
    const t = setInterval(() => {
      if (reaping) return;
      let gone = false;
      try { gone = !fs.existsSync(REAP_PATH); } catch (_) { gone = false; }
      if (!gone) return;
      reaping = true;
      setTimeout(() => {
        try { if (fs.existsSync(REAP_PATH)) { reaping = false; return; } } catch (_) {}
        try { log('[troth] self-reap: ' + REAP_PATH + ' vanished (uninstall/update) - exiting'); } catch (_) {}
        process.exit(0);
      }, REAP_GRACE_MS);
    }, REAP_MS);
    if (t.unref) t.unref();
  })();

  // Satellite flusher — on an install whose mind lives on another machine,
  // ship queued mind-writes to the hub on a slow pulse. Each queueWrite
  // already nudges an immediate flush; this pulse is the retry lane that
  // drains the outbox after an offline stretch without waiting for the
  // next write. Inert (active() false) on hub installs.
  try {
    const _rcFlush = require('../shared-core/sync/remote-client.js');
    if (_rcFlush.active()) {
      const _repl = require('../shared-core/sync/replica.js');
      const tF = setInterval(() => {
        _rcFlush.flush().then(() => _repl.pull()).catch(() => {});
      }, 15000);
      if (tF.unref) tF.unref();
      setTimeout(() => { _repl.pull().catch(() => {}); }, 2500);
      log('[sync] following mode: mind at ' + (_rcFlush.status().host || '?') + ', outbox + replica feed on');
    }
  } catch (_) { /* sync module absent — nothing to flush */ }
  // Mind discovery — announce when this machine keeps a mind AND has a
  // reachable door (a loopback bind has nothing to announce); always
  // listen, so the Network card can show minds near you either way.
  try {
    const disco = require('../shared-core/sync/discovery.js');
    const rcD = require('../shared-core/sync/remote-client.js');
    disco.start({
      name: require('os').hostname().replace(/\.local$/, ''),
      port: listenPort,
      // Every reachable install announces — minds so devices can Follow,
      // devices so minds can Invite. Loopback-bound installs stay silent:
      // they have no door anyone could reach.
      shouldBeacon: () => BIND_HOST !== '127.0.0.1',
      role: () => (rcD.active() ? 'device' : 'mind')
    });
  } catch (_) { /* discovery is best-effort */ }
  log('Listening on ' + BIND_HOST + ':' + listenPort + (listenPort === PORT ? '' : ' (auto-bumped from ' + PORT + ')'));
  // Orphan guard. The desktop app spawns us DETACHED so we outlive a closed
  // window, and reaps us when it quits gracefully. A crash or a force-kill
  // never runs that reaper, so we would keep the port forever and every later
  // launch would bump to a new one, piling up proxies the operator has to see
  // swept on each `troth classic`. When the app hands us its pid,
  // outlive the window but not the app: check periodically, leave when it is
  // gone. Nothing is set by the CLI, so CLI proxies keep their old lifetime.
  // ── idle local-model reaper ───────────────────────────────────────────
  // The embedding and reranking llama-servers are spawned detached + unref'd
  // on purpose (they must outlive a proxy restart; reloading a model costs
  // seconds) but nothing ever stopped them: no exit handler anywhere, so once
  // started they held RAM and a Metal context until reboot. The operator
  // found the reranker resident after 14 hours for work that takes seconds
  //. Each server stamps ~/.troth/lastuse-<port>.txt on
  // every real call; this reaps one that has not been asked anything for
  // TROTH_MODEL_IDLE_MIN minutes (default 30, set 0 to disable). Killing is
  // safe: ensureServer() respawns on the next call.
  var _idleMin = parseInt(process.env.TROTH_MODEL_IDLE_MIN || '30', 10);
  if (_idleMin > 0) {
    setInterval(function () {
      try {
        var _fs = require('fs'), _os = require('os'), _pathI = require('path');
        var _cp = require('child_process');
        // The agent's own browser directory, from the daemon that creates it,
        // so the reaper and the launcher can never disagree about which
        // browser belongs to troth.
        var _AGENT_PROFILE = '';
        try { _AGENT_PROFILE = require('../shared-core/perception/chromium-daemon.js').defaultProfileDir(); } catch (_) {}
        var _LEGACY_PROFILE = '';
        try { _LEGACY_PROFILE = require('../shared-core/perception/chromium-daemon.js').legacyProfileDir(); } catch (_) {}
        // EVERY long-lived child the product can leave behind, not just the
        // two the operator happened to catch. A customer cannot diagnose a
        // hung daemon and has no reason to know these exist, so nothing may
        // outlive its usefulness on their machine.
        [
          { port: parseInt(process.env.TROTH_EMBED_PORT  || '11437', 10), what: 'embedder',   pat: 'llama-server' },
          { port: parseInt(process.env.TROTH_RERANK_PORT || '11438', 10), what: 'reranker',   pat: 'llama-server' },
          // The local CHAT model: same family, far more RAM. Idle-reaped on a
          // longer leash because reloading a chat model is the slowest respawn.
          { port: parseInt(process.env.TROTH_LOCAL_PORT  || '11436', 10), what: 'local chat', pat: 'llama-server', mult: 2 },
          // A real browser for browsing — headed on purpose, since search
          // pages block a headless CDP session. Holds a full process tree; a
          // longer leash than a model server because a page an agent opened
          // may still be on the operator's screen.
          { port: parseInt(process.env.TROTH_BROWSER_CDP_PORT || '18222', 10), what: 'browser', pat: 'remote-debugging-port', mult: 4 }
        ].forEach(function (t) {
          var alive = '';
          var needle = t.pat === 'remote-debugging-port'
            ? 'remote-debugging-port=' + t.port
            : 'llama-server.*--port ' + t.port;
          try { alive = _cp.execSync('pgrep -f "' + needle + '" || true', { encoding: 'utf8' }).trim(); } catch (_) { return; }
          if (!alive) return;
          var last = 0;
          try { last = parseInt(_fs.readFileSync(_pathI.join(_os.homedir(), '.troth', 'lastuse-' + t.port + '.txt'), 'utf8'), 10) || 0; } catch (_) { last = 0; }
          if (t.what === 'browser') {
            // The rules, and why the third one changed, are in browser-reap.js.
            // They live there rather than here because they are the part worth
            // testing and this is a setInterval nobody can call.
            var _lines = [];
            try {
              _lines = _cp.execSync('pgrep -fl "' + needle + '" || true', { encoding: 'utf8' })
                .split('\n').filter(function (l) { return !!l; });
            } catch (_) { _lines = []; }
            var _verdict = require('../shared-core/browser-reap.js').mayReapBrowser({
              port: t.port,
              lastUse: last,
              now: Date.now(),
              idleMs: _idleMin * 60000 * (t.mult || 1),
              procLines: _lines,
              agentProfile: _AGENT_PROFILE,
              legacyProfile: _LEGACY_PROFILE
            });
            if (!_verdict.reap) return;
          } else {
            // No stamp on a llama-server means it has not served a single
            // call since stamping shipped: the strongest idle signal there is.
          }
          var idleMs = Date.now() - (last || 0);
          if (idleMs < _idleMin * 60000 * (t.mult || 1)) return;
          try {
            // Ask first, insist after. A browser given SIGTERM flushes its
            // cookie store on the way out; one given SIGKILL loses whatever
            // had not hit disk yet, which is how a fresh login can vanish.
            if (t.what === 'browser') {
              _cp.execSync('pkill -TERM -f "' + needle + '" || true', { stdio: 'ignore' });
              setTimeout(function () {
                try { _cp.execSync('pkill -KILL -f "' + needle + '" || true', { stdio: 'ignore' }); } catch (_) {}
              }, 4000).unref();
            } else {
              _cp.execSync('pkill -f "' + needle + '" || true', { stdio: 'ignore' });
            }
            log('reaped idle ' + t.what + ' on :' + t.port + ' (idle ' + Math.round(idleMs / 60000) + 'm) — respawns on next use');
          } catch (_) {}
        });

        // Orphan sweep — a browser wearing OUR profile directory on a port the
        // lane above does not watch. Two ways one exists: a pre-hardening
        // install left its shared-profile browser on 9222 (measured: nine days
        // resident, catching every link the system opened), or the operator
        // changed TROTH_BROWSER_CDP_PORT and the old daemon stayed behind.
        // First sighting writes a discovery stamp, so "no stamp is never a
        // reap" holds: collection happens a full browser-leash later.
        try {
          var _cfgPort = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '18222', 10);
          var _wearsOurs = function (l) {
            return (!!_AGENT_PROFILE && l.indexOf('--user-data-dir=' + _AGENT_PROFILE) !== -1) ||
                   (!!_LEGACY_PROFILE && l.indexOf('--user-data-dir=' + _LEGACY_PROFILE) !== -1);
          };
          var _orphans = {};
          _cp.execSync('pgrep -fl "remote-debugging-port=" || true', { encoding: 'utf8' })
            .split('\n').filter(function (l) { return !!l && _wearsOurs(l); })
            .forEach(function (l) {
              var m = /remote-debugging-port=(\d+)/.exec(l);
              var p = m ? parseInt(m[1], 10) : 0;
              if (!p || p === _cfgPort) return;
              (_orphans[p] = _orphans[p] || []).push(l);
            });
          Object.keys(_orphans).forEach(function (pk) {
            var p = parseInt(pk, 10);
            var stamp = _pathI.join(_os.homedir(), '.troth', 'lastuse-' + p + '.txt');
            var lastO = 0;
            try { lastO = parseInt(_fs.readFileSync(stamp, 'utf8'), 10) || 0; } catch (_) { lastO = 0; }
            if (!lastO) { try { _fs.writeFileSync(stamp, String(Date.now())); } catch (_) {} return; }
            var v = require('../shared-core/browser-reap.js').mayReapBrowser({
              port: p, lastUse: lastO, now: Date.now(),
              idleMs: _idleMin * 60000 * 4,
              procLines: _orphans[pk],
              agentProfile: _AGENT_PROFILE,
              legacyProfile: _LEGACY_PROFILE
            });
            if (!v.reap) return;
            _orphans[pk].forEach(function (l) {
              var pid = parseInt(l, 10);
              if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
            });
            setTimeout(function () {
              try {
                _cp.execSync('pgrep -fl "remote-debugging-port=' + p + '" || true', { encoding: 'utf8' })
                  .split('\n').filter(function (l) { return !!l && _wearsOurs(l); })
                  .forEach(function (l) { var pid = parseInt(l, 10); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} } });
              } catch (_) {}
            }, 4000).unref();
            log('reaped orphan troth browser on :' + p + ' (' + v.reason + ') — legacy; nothing respawns it');
          });
        } catch (_) { /* orphan sweep is housekeeping, never a request blocker */ }
      } catch (_) { /* reaping is housekeeping, never a request blocker */ }
    }, 5 * 60 * 1000).unref();
  }

  var _parentPid = parseInt(process.env.TROTH_PARENT_PID || '', 10);
  if (_parentPid > 1) {
    setInterval(function () {
      try {
        process.kill(_parentPid, 0);   // signal 0 = liveness probe only
      } catch (e) {
        if (e && e.code === 'ESRCH') {
          log('parent ' + _parentPid + ' is gone — exiting so the port is not orphaned');
          process.exit(0);
        }
      }
    }, 30000).unref();
  }
  if (BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost') {
    log('⚠  Exposed on ' + BIND_HOST + ' — reachable from other machines on the network');
  }
  log('Dashboard: http://localhost:' + listenPort + '/ui');
  log('Modules: injector | critic | guardian | pinning | loopguard | codelens | router | compressor | validator | workflow');
  // The port is open and accepting; NOW walk the project. setImmediate so this
  // callback returns to the loop first — a request that arrives during the walk
  // is answered with an empty repo map rather than waiting for one.
  setImmediate(startProjectIndexing);
  cleanSiblingsAtBoot();
  scheduler.start();
  // Auto-start the embedded Claude Code session watcher unless
  // explicitly disabled. Without this, every proxy restart leaves
  // substrate blind to live conversations until someone hits the
  // dashboard Start button. start_at_eof=true (default) ensures
  // we don't re-ingest historical sessions.
  if (process.env.TROTH_AUTOSTART_WATCHER !== '0') {
    try {
      const w = require('../tools/claude-session-watcher.js');
      if (!global.__troth_watcher_runtime) {
        global.__troth_watcher_runtime = w.makeRuntime({ agent_id: resolveAgentId() });
      }
      const r = global.__troth_watcher_runtime.start();
      log('Watcher: ' + (r.started || r.already_running ? 'started (' + resolveAgentId() + ', 10s poll)' : 'failed to start'));
    } catch (e) {
      log('Watcher autostart failed: ' + (e && e.message || e));
    }
  }
  // ── Maintenance worker ────────────────────────────────────────
  // The memory pipeline's upkeep (embedding drain, import delta-sync) has
  // to live where EVERY topology keeps a process alive — and that is this
  // proxy: a dashboard-only Linux install (`troth start` + browser) has no
  // entity daemon — without this block nothing there drains the index and
  // the readiness numbers freeze forever.
  // The entity daemon still runs the full task set when it is
  // up; the background_task_run ledger acts as a cross-process lease so
  // the two never double-work one queue. TROTH_MAINTENANCE=0 disables.
  if (process.env.TROTH_MAINTENANCE !== '0') {
    try {
      const bw = require('../shared-core/background-worker.js');
      const stM = require('../shared-core/state.js');
      const arM = require('../shared-core/action-record.js');
      global.__troth_maintenance = bw.startWorker({
        // Upkeep only, never cognition: the drain, the import flow, the
        // weekly backup, the (opt-in) WAL replica and the ledger's own
        // hygiene — the things a substrate silently loses when no entity
        // daemon exists. The thinking tasks stay the entity's alone.
        // knowledgeDrain and outcomeFold belong here for the reason the whole
        // block does: this is the ONLY process alive in a Claude Code + proxy
        // install. Both were registered in DEFAULT_TASKS — the entity daemon's
        // list — so on this machine the document queue had no reader at all
        // and the operator watched "183 still to read" never move.
        tasks: [bw.tasks.embeddingBackfill, bw.tasks.knowledgeDrain, bw.tasks.outcomeFold, bw.tasks.importSync, bw.tasks.backup, bw.tasks.walReplicate, bw.tasks.ledgerPrune, bw.tasks.carriedFreeze],
        cross_process_lease: true,
        idle_threshold_ms: Math.max(parseInt(process.env.TROTH_MAINT_IDLE_MS || '60000', 10) || 60000, 0),
        tick_ms: Math.max(parseInt(process.env.TROTH_MAINT_TICK_MS || '30000', 10) || 30000, 250),
        submit: (ev) => {
          // Thin persistence shim: the proxy has no cognitive runtime; the
          // ledger row (and only that) must still land so readiness gets a
          // heartbeat and the lease binds across processes. operational/
          // substrate_internal keeps these OUT of every recall pool.
          try {
            if (!ev || ev.type !== 'decision') return;
            const rec = {
              id: arM.uuidv7(), timestamp: Date.now(), type: 'decision',
              agent_id: 'maintenance', user_id: 'default', cwd: null,
              memory_class: 'operational', audience: 'substrate_internal',
              input: ev.input || {}, output: ev.output || {}
            };
            const v = arM.validate(rec);
            if (v && v.ok) stM.recordAction(rec, 'background task run');
          } catch (_) { /* best-effort */ }
        },
        getView: () => ({}),
        notify: (n) => { try { log('[maintenance] ' + n.task + ': ' + (n.notes || []).join(' | ')); } catch (_) {} }
      });
      log('Maintenance: embedding drain + import sync (idle-gated, cross-process lease)');
    } catch (e) {
      log('Maintenance worker failed to start: ' + (e && e.message || e));
    }
  }
});
