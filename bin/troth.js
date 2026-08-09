#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");

const IS_WIN = process.platform === "win32";

// Cross-platform synchronous sleep (no subprocess).
function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}

const HOME = process.env.HOME || require("os").homedir();
const CONFIG_DIR = path.join(HOME, ".troth");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
// Single source of truth — whatever is in the npm package's own
// package.json. Previously this was hardcoded and drifted from
// package.json silently (caught by the v5.5.0 dockerized test).
const VERSION = require("../package.json").version;
const { resolveAgentId } = require("../shared-core/agent-id");

// Default configuration
const DEFAULTS = {
  host: "localhost",
  port: 8000,
  backendHost: "127.0.0.1",
  backendPort: 1234,
  // No brand-locked default model. Downstream consumers use `cfg.model || "any"`
  // so an unset model resolves to "any" (router picks based on enabled providers).
  // User pins a specific model in ~/.troth/config.json or via the dashboard.
  model: "",
  // which command `troth` (no args) and `troth -a` resolve to.
  //   "cli"     → drop into the troth substrate-native REPL (the default —
  //               the substrate IS the backend; any LLM is swappable faculty)
  //   "classic" → launch Claude Code through the proxy (opt-in power-user
  //               mode: use troth's scaffolding + multi-provider routing as a
  //               proxy in front of Claude Code). Requires Claude Code CLI.
  // Flip via `troth config set default_command classic`.
  default_command: "cli"
};

const configFileStore = require("../shared-core/config-file.js");

function loadConfig() {
  try {
    var cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return Object.assign({}, DEFAULTS, cfg);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function saveConfig(cfg) {
  // Single-writer discipline (shared-core/config-file): merge over a FRESH
  // strict read + atomic temp/rename replace. The old whole-object write
  // meant that when loadConfig() had leniently fallen back to DEFAULTS
  // (torn file, transient error), the next save erased every field it did
  // not know about. providers deep-merges so a cfg built from DEFAULTS
  // (the setup flow does this) cannot drop providers configured elsewhere.
  configFileStore.updateConfig(function (current) {
    var next = Object.assign({}, cfg);
    if (next && typeof next.providers === "object") {
      next.providers = Object.assign({}, current.providers, next.providers);
    }
    return Object.assign(current, next);
  });
}

function checkHealth(host, port) {
  // Cross-platform: use Node's built-in http module (no curl dependency).
  return new Promise((resolve) => {
    const req = http.request(
      { host: host, port: port, path: "/health", method: "GET", timeout: 2500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Best-effort synchronous probe, run in a child so it can sit inside a sync
// loop. Two strictnesses: the default asks only "is something answering",
// which is what the LOCAL MODEL check needs, since Ollama and llama.cpp
// answer /health with their own shape and owe us nothing. `opts.troth` also
// requires the body to identify itself, which is what a port SWEEP needs:
// a bare 200 there would adopt any dev server on a neighbouring port.
//
// Every exit path is explicit. An earlier version destroyed the request on an
// oversized body and let the child fall off the end of the event loop, which
// exits 0 — reporting the exact impostor it meant to reject — and a response
// that dripped bytes slower than the idle timeout never ended at all, hanging
// the parent forever with no execFileSync timeout to stop it.
function checkHealthSync(host, port, opts) {
  var wantTroth = !!(opts && opts.troth);
  try {
    const script =
      'const h=require("http");' +
      'let r;' +
      'const done=(c)=>{try{if(r)r.destroy()}catch(_){}process.exit(c)};' +
      // Nothing below may outlive this, whatever the peer does.
      'const guard=setTimeout(()=>done(1),4000); guard.unref&&guard.unref();' +
      'r=h.request({host:"' + host + '",port:' + port + ',path:"/health",timeout:2000},(res)=>{' +
        'if(res.statusCode!==200){res.resume();return done(1);}' +
        'if(!' + (wantTroth ? 'true' : 'false') + '){res.resume();return done(0);}' +
        'let b="";' +
        'res.on("data",(c)=>{b+=c;if(b.length>65536)return done(1);});' +
        'res.on("end",()=>{try{const j=JSON.parse(b);' +
          // version + status are in every /health answer; pid/script/build are
          // withheld from non-loopback callers on purpose, so requiring them
          // would make a remote proxy invisible to its own CLI.
          'done(j&&typeof j.version==="string"&&typeof j.status==="string"?0:1);' +
        '}catch(_){done(1);}});' +
        'res.on("error",()=>done(1));' +
        'res.on("aborted",()=>done(1));' +
      '});' +
      'r.on("error",()=>done(1));' +
      'r.on("timeout",()=>done(1));' +
      'r.end();';
    execFileSync(process.execPath, ["-e", script], { stdio: "pipe", timeout: 6000 });
    return true;
  } catch (e) { return false; }
}

//  clean orphan troth-proxy-* siblings on every ensureProxy
// invocation. Background: ensureProxy spawns the proxy as detached + unref'd
// (so the dashboard outlives the CLI). Combined with the proxy's EADDRINUSE
// auto-bump (8000 busy → 8001 → 8002...) every prior CLI session whose
// proxy is still alive can push the next session onto a new port. Result:
// 8 orphans observed in the wild, all idle at 0% CPU but holding memory +
// FDs, warming the laptop. cleanOrphanSiblings sends SIGTERM to any
// troth-proxy-* whose port differs from the active primary, gives them
// 1.5s to gracefully shut down (their SIGTERM handler unlinks PID file +
// closes the http server), then proceeds. Override via
// TROTH_KEEP_SIBLINGS=1 for CI / multi-tenant.
function cleanOrphanSiblings(primaryPort) {
  if (process.env.TROTH_KEEP_SIBLINGS === "1") return;
  try {
    var out = execFileSync("ps", ["-eo", "pid,etime,args"], { encoding: "utf8" });
    var toKill = [];
    var lines = out.split("\n").slice(1);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!/troth-proxy-/.test(line)) continue;
      // Take the longest port match — ps may truncate "troth-proxy-8000"
      // to "troth-proxy-80" in the comm column; the args column has the
      // full string, so prefer the wider match.
      var ports = (line.match(/troth-proxy-(\d+)/g) || [])
        .map(function (s) { return parseInt(s.split("-").pop(), 10); })
        .sort(function (a, b) { return b - a; });
      var port = ports[0];
      if (!port || port === primaryPort) continue;
      var pid = parseInt((line.trim().split(/\s+/)[0] || "0"), 10);
      if (!pid || pid === process.pid) continue;
      // Only reap proxies that belong to THIS install. The scan is
      // machine-wide, so a second troth (another project, another user,
      // another HOME) had its live proxy SIGTERMed by anyone who happened
      // to run a command, with no prompt and no way to know why the other
      // session died. A proxy
      // whose HOME differs from ours is not ours to end.
      // On macOS a DETACHED process reports no environment at all — and
      // detached is exactly how ensureProxy spawns every proxy — so `ps -E`
      // came back with just the process title, the HOME match found nothing,
      // and the guard fell through to kill. Measured: a `troth` command in one
      // account terminated eight proxies belonging to other HOMEs. Unknown
      // ownership is now a reason to LEAVE IT, not to end it; a proxy this
      // HOME started is recognised by its own pid file instead.
      var _oursByPidFile = false;
      try {
        var _pdir = path.join(process.env.HOME || require("os").homedir(), ".troth");
        _oursByPidFile = fs.readdirSync(_pdir).some(function (f) {
          if (!/^proxy-\d+\.pid$/.test(f)) return false;
          try { return parseInt(fs.readFileSync(path.join(_pdir, f), "utf8").trim(), 10) === pid; }
          catch (_) { return false; }
        });
      } catch (_) { _oursByPidFile = false; }
      if (!_oursByPidFile) {
        try {
          var envOut = execFileSync("ps", ["-E", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
          var m = /(?:^|\s)HOME=(\S+)/.exec(envOut);
          // No readable HOME, or a different one: not ours to end.
          if (!m || !m[1] || m[1] !== (process.env.HOME || "")) continue;
        } catch (_) { continue; }
      }
      // The desktop app spawns its OWN proxy (bundle core) on a bumped port
      // while the CLI dev proxy holds the primary. That sibling is NOT an
      // orphan — killing it breaks the live studio session mid-chat
      //. Skip
      // any candidate whose parent process is the troth desktop app.
      try {
        var ppidOut = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
        var ppid = parseInt(ppidOut.trim(), 10);
        if (ppid > 1) {
          var pcomm = execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8" }).trim();
          if (/troth[-_ ]?app|troth\.app/i.test(pcomm)) continue;
        }
      } catch (_) { /* parent lookup failed — treat as orphan, legacy behavior */ }
      // A candidate that ANSWERS as a troth proxy is a live server — the
      // stuck-zombie reaper has no business with it. This is what stood
      // between one bad config value and a healthy proxy being shot.
      try { if (checkHealthSync("localhost", port, { troth: true })) continue; } catch (_) {}
      toKill.push({ pid: pid, port: port });
    }
    if (!toKill.length) return;
    console.log("Cleaning " + toKill.length + " orphan troth-proxy process(es) " +
                "(TROTH_KEEP_SIBLINGS=1 to disable):");
    for (var ki = 0; ki < toKill.length; ki++) {
      var t = toKill[ki];
      try {
        process.kill(t.pid, "SIGTERM");
        console.log("  killed pid=" + t.pid + " port=" + t.port);
      } catch (e) {
        console.error("  failed pid=" + t.pid + ": " + (e && e.message || e));
      }
    }
    sleepMs(1500);
  } catch (_) { /* ps unavailable (Windows etc) — skip silently */ }
}

// The proxy answers EADDRINUSE by taking the next port, up to ten above the
// one it was asked for (proxy/server.js). Everything here used to look only
// at the configured port, so a busy 8000 meant a healthy proxy on 8001 was
// invisible: the wait below timed out, the CLI exited, and a first-time user
// on a machine with anything else on 8000 could not reach the dashboard at
// all. Probe the same range the proxy can occupy and report where it is.
var PORT_BUMP_LIMIT = 10;
function findLiveProxyPort(host, port) {
  // Only a proxy WE start can have moved, and we only start local ones. On a
  // remote host the configured port is the answer or there is no answer, and
  // sweeping eleven ports across a network that drops packets rather than
  // refusing them would stall every command for eleven timeouts in a row.
  var local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local) return checkHealthSync(host, port, { troth: true }) ? port : 0;
  for (var i = 0; i <= PORT_BUMP_LIMIT; i++) {
    if (checkHealthSync(host, port + i, { troth: true })) return port + i;
  }
  return 0;
}

function ensureProxy(cfg) {
  // Always clean orphans first — even if we end up reusing a live primary,
  // the SIBLINGS on bumped ports should still get reaped. Cheap (one ps).
  cleanOrphanSiblings(cfg.port);
  var live = findLiveProxyPort(cfg.host, cfg.port);
  if (live) { cfg.port = live; return live; } // already running (possibly bumped)
  // Only auto-start if proxy is local
  if (cfg.host !== "localhost" && cfg.host !== "127.0.0.1") {
    console.error("troth proxy not reachable at " + cfg.host + ":" + cfg.port);
    process.exit(1);
  }
  var serverPath = path.join(__dirname, "..", "proxy", "server.js");
  var env = Object.assign({}, process.env, {
    GF_PORT: String(cfg.port),
    GF_BACKEND_HOST: cfg.backendHost,
    GF_BACKEND_PORT: String(cfg.backendPort),
    // Pin CodeLens to the user's current dir so the index reflects the
    // actual project they're working in, not /, /root, or whatever cwd
    // the spawned detached process happened to inherit.
    GF_WATCH_DIR: process.cwd()
  });
  console.log("Starting troth proxy...");
  // Capture the detached proxy's output. stdio:"ignore" left NO log at all on
  // this path, so the old failure text ("Check logs.") pointed at nothing
  // a first-run crash (port taken, native module build)
  // was undiagnosable for the user.
  var bootLogPath = path.join(require("os").homedir(), ".troth", "proxy-boot.log");
  var bootStdio = "ignore";
  try {
    require("fs").mkdirSync(path.dirname(bootLogPath), { recursive: true });
    var bootFd = require("fs").openSync(bootLogPath, "a");
    bootStdio = ["ignore", bootFd, bootFd];
  } catch (_) { /* log capture is best-effort — never blocks the spawn */ }
  // Use process.execPath so we always use the same Node that's running the CLI.
  spawn(process.execPath, [serverPath], { env: env, detached: true, stdio: bootStdio }).unref();
  // On a FIRST run the proxy indexes the working directory before it binds,
  // and on a large repository that took longer than the old 8s budget: the
  // very first command a new user ran printed a failure while the proxy was
  // seconds from being ready, and blamed a port conflict or a broken native
  // build, neither of which was true (stranger's first-contact run,
  //). The budget is now 45s, and the wait says what it is waiting
  // for rather than sitting silent.
  var WAIT_MS = 45000, STEP_MS = 500, waited = 0, announced = false;
  while (waited < WAIT_MS) {
    sleepMs(STEP_MS);
    waited += STEP_MS;
    var found = findLiveProxyPort(cfg.host, cfg.port);
    if (found) {
      // Adopt the port for the rest of this run. It is deliberately not saved:
      // the bump is a property of what else is running right now, not a setting.
      if (found !== cfg.port) {
        console.log("Port " + cfg.port + " was busy; the proxy took " + found + ".");
        cfg.port = found;
      }
      // The one address that configures everything, said at the only moment
      // the user is certainly watching the terminal.
      console.log("Proxy ready. Dashboard: http://" + cfg.host + ":" + found + "/ui");
      return found;
    }
    if (!announced && waited >= 6000) {
      announced = true;
      console.log("Still starting (first run indexes this directory; this is the slow one)...");
    }
  }
  console.error("Proxy did not answer on " + cfg.host + ":" + cfg.port +
    "-" + (cfg.port + PORT_BUMP_LIMIT) + " within " + (WAIT_MS / 1000) + "s.");
  console.error("Boot log: " + bootLogPath);
  console.error("Look in that log first: it says whether the proxy exited, bumped to another port, or is still indexing. A native dependency that failed to load (better-sqlite3) shows there too; rerun npm install if so.");
  process.exit(1);
}

// The CLI reads config.entity_faculties (comma list) and passes it to the
// entity as TROTH_ENTITY_LLM_FACULTIES; the app writes it when a faculty is
// linked. Adding one here is what makes `troth` itself able to answer.
function addEntityFaculty(cfg, name) {
  var have = String(cfg.entity_faculties || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  if (have.indexOf(name) === -1) have.push(name);
  cfg.entity_faculties = have.join(",");
  return cfg;
}

function findClaude() {
  try {
    // `where` on Windows, `which` on POSIX.
    execFileSync(IS_WIN ? "where" : "which", ["claude"], { stdio: "pipe" });
    return true;
  } catch (e) { /* not on PATH — probe the known install locations */ }
  // The native installer puts it at ~/.claude/local/claude, which is on the
  // PATH of an interactive shell and not necessarily on this process's.
  var _fc = require("fs"), _pc = require("path"), _oc = require("os");
  var _home = process.env.HOME || _oc.homedir();
  return [
    _pc.join(_home, ".claude", "local", "claude"),
    _pc.join(_home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ].some(function (p) { try { return _fc.existsSync(p); } catch (_) { return false; } });
}

// Yes/no prompt that works across three input sources uniformly:
//   TTY         → user types, normal interactive behavior
//   piped stdin → reads one line from the pipe (e.g. `printf "y\n" | troth reset`)
//   closed/empty stdin (/dev/null) → resolves to defaultYes without hanging
// Callers that want to refuse piped input entirely (e.g. ensureClaudeInstalled
// in CI) gate on process.stdin.isTTY themselves BEFORE calling this.
function promptYesNoSync(question, defaultYes) {
  return new Promise(function(resolve) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    var decided = false;
    function finish(v) {
      if (decided) return;
      decided = true;
      try { rl.close(); } catch (e) {}
      resolve(v);
    }
    rl.on("close", function() { finish(defaultYes); });
    rl.question(question, function(ans) {
      var a = (ans || "").trim().toLowerCase();
      if (a === "") return finish(defaultYes);
      finish(a === "y" || a === "yes");
    });
  });
}

// Ensure @anthropic-ai/claude-code is installed. If missing, prompt ONCE
// and install globally via npm. Non-interactive stdin => fall back to the
// old "install it yourself" error so CI pipelines don't hang.
async function ensureClaudeInstalled() {
  if (findClaude()) return true;

  if (!process.stdin.isTTY) {
    console.error("Claude Code CLI not found. Install it first:");
    console.error("  npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  console.log("\n  Claude Code CLI is not installed.");
  var yes = await promptYesNoSync("  Install @anthropic-ai/claude-code globally now? [Y/n] ", true);
  if (!yes) {
    console.error("\n  Install it manually and re-run troth:");
    console.error("    npm install -g @anthropic-ai/claude-code\n");
    process.exit(1);
  }

  console.log("  Installing Claude Code CLI... (this takes ~15s)");
  try {
    // npm on Windows is npm.cmd; execFileSync needs the exact file name.
    var npmBin = IS_WIN ? "npm.cmd" : "npm";
    execFileSync(npmBin, ["install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit" });
  } catch (e) {
    console.error("\n  Install failed. Run manually:");
    console.error("    npm install -g @anthropic-ai/claude-code\n");
    process.exit(1);
  }

  if (!findClaude()) {
    console.error("\n  Install finished but 'claude' is not in PATH.");
    console.error("  You may need to restart your shell, or check your npm global bin");
    console.error("  (run: npm config get prefix) is on PATH.\n");
    process.exit(1);
  }

  console.log("  \x1b[32m+\x1b[0m Claude Code CLI installed.\n");
  return true;
}

// Parse CLI arguments
var args = process.argv.slice(2);
var command = null;
var useGemini = false;
var autoMode = false;
var smartMode = false;
var foreground = false;
var cleanAll = false;
var cleanStuck = false;
var cleanDaemons = false;
var cleanStuckKill = false;
var showAdvanced = false;
var passthrough = [];

// Run-lifecycle commands take their argument as the next positional
// (the run id or task description). We parse them positionally below
// so that `troth run "long task with spaces"` works without quoting
// gymnastics from the user.
// One-click MCP deferral. Given mcp-audit's results, move every
// server flagged "HEAVY — consider deferring" out of ~/.claude/settings.
// json's mcpServers and into ~/.troth/router.json. Back up the
// settings first. Idempotent: re-running only migrates newly-heavy
// servers (what's already in router.json is skipped).
function migrateHeavyMcps() {
  var fsL = require("fs");
  var pL  = require("path");
  var osL = require("os");
  var HOMEL = osL.homedir();
  var settingsPath = pL.join(HOMEL, ".claude", "settings.json");
  var routerPath   = pL.join(HOMEL, ".troth", "router.json");

  if (!fsL.existsSync(settingsPath)) {
    return { migrated: [], error: "~/.claude/settings.json not found" };
  }

  var audit;
  try { audit = require("./mcp-audit"); }
  catch (e) { return { migrated: [], error: "mcp-audit module missing: " + e.message }; }

  // audit.main() is async + prints to console. We need the data, so
  // call the internal probe path directly. Re-implement the subset we
  // need here rather than refactor mcp-audit exports.
  var spawnSync = require("child_process").spawnSync;

  var settings;
  try { settings = JSON.parse(fsL.readFileSync(settingsPath, "utf8")); }
  catch (e) { return { migrated: [], error: "settings.json parse error: " + e.message }; }

  var mcps = settings.mcpServers || {};
  if (!Object.keys(mcps).length) {
    return { migrated: [], error: "no mcpServers configured" };
  }

  // Pragmatic heuristic: move any server with a `.local/bin/` or absolute
  // path launcher (these are typically the heavy enterprise MCPs —
  // analytics, supabase wrappers, playwright wrappers). Leave lightweight
  // npx / stdio shims in place. This avoids the full audit roundtrip.
  // Users with finer-grained needs can edit router.json manually.
  var toMove = [];
  Object.keys(mcps).forEach(function (name) {
    if (name === "troth-bash" || name === "troth-router" ||
        name === "troth-archive" || name === "codebase-memory") return;
    var spec = mcps[name];
    if (!spec || !spec.command) return;
    // Skip if it's a short "npx" wrapper — those are usually light.
    if (spec.command === "npx" && (!spec.env || !Object.keys(spec.env).length)) return;
    toMove.push(name);
  });

  if (!toMove.length) return { migrated: [] };

  // Ensure ~/.troth exists + load/merge router.json
  var gemDir = pL.join(HOMEL, ".troth");
  if (!fsL.existsSync(gemDir)) fsL.mkdirSync(gemDir, { recursive: true });
  var router = { mcpServers: {} };
  if (fsL.existsSync(routerPath)) {
    try { router = JSON.parse(fsL.readFileSync(routerPath, "utf8")); router.mcpServers = router.mcpServers || {}; }
    catch (e) { /* start fresh */ }
  }

  // Backup settings.json with timestamp.
  var backupPath = settingsPath + ".bak-" + Date.now();
  fsL.writeFileSync(backupPath, fsL.readFileSync(settingsPath, "utf8"));

  toMove.forEach(function (name) {
    router.mcpServers[name] = mcps[name];
    delete mcps[name];
  });
  settings.mcpServers = mcps;

  fsL.writeFileSync(routerPath, JSON.stringify(router, null, 2) + "\n");
  fsL.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { migrated: toMove, backup: backupPath };
}

// P0.1 — Add "Bash" to permissions.deny in ~/.claude/settings.json so
// Claude Code routes shell work through mcp__troth-bash__run instead
// of the native Bash tool. Without this, the plugin's bash-compression
// MCP exists but the model never picks it (preferring the native tool),
// and bash output flows raw into context. Idempotent + backed-up.
//
// Returns: { applied, alreadySet, error, backup }
function applyBashDenyDefault() {
  var pL = require("path");
  var fsL = require("fs");
  var osL = require("os");
  var settingsPath = pL.join(osL.homedir(), ".claude", "settings.json");

  var settings = {};
  if (fsL.existsSync(settingsPath)) {
    try { settings = JSON.parse(fsL.readFileSync(settingsPath, "utf8")); }
    catch (e) { return { applied: false, error: "settings.json parse error: " + e.message }; }
  } else {
    // Ensure parent dir exists; create empty settings.
    fsL.mkdirSync(pL.dirname(settingsPath), { recursive: true });
  }

  settings.permissions = settings.permissions || {};
  var denyList = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];

  if (denyList.indexOf("Bash") !== -1) {
    return { applied: false, alreadySet: true };
  }

  // Backup before mutation so the user can revert with one copy.
  var backupPath = settingsPath + ".bak-bash-deny-" + Date.now();
  if (fsL.existsSync(settingsPath)) {
    fsL.writeFileSync(backupPath, fsL.readFileSync(settingsPath, "utf8"));
  }

  denyList.push("Bash");
  settings.permissions.deny = denyList;
  fsL.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { applied: true, backup: backupPath };
}

// The command surface lives in shared-core/cli-commands.js as DATA - one
// list feeding this dispatch Set AND the dashboard reference endpoint.
// It moved out of this file because the reference used to regex THIS
// file's source for the literal, and shipped bundles are minified: every
// published build answered the reference page with zero CLI commands.
var SUBCOMMANDS = new Set(require(__dirname + "/../shared-core/cli-commands.js"));

for (var i = 0; i < args.length; i++) {
  var arg = args[i];
  if (SUBCOMMANDS.has(arg) && command === null) {
    command = arg;
  } else if (arg === "-g" || arg === "--proxy") {
    useGemini = true;
  } else if (arg === "-a" || arg === "--auto") {
    autoMode = true;
  } else if (arg === "-s" || arg === "--smart") {
    smartMode = true; useGemini = true;
  } else if (arg === "-f" || arg === "--fg" || arg === "--foreground") {
    foreground = true;
  } else if (arg === "--advanced") {
    showAdvanced = true;
  } else if (arg === "--all") {
    cleanAll = true;
  } else if (arg === "--stuck") {
    cleanStuck = true;
  } else if (arg === "--kill") {
    cleanStuckKill = true;
  } else if (arg === "--daemons") {
    cleanDaemons = true;
  } else if (arg === "-v" || arg === "--version") {
    command = "version";
  } else if (arg === "-h" || arg === "--help") {
    command = "help";
  } else {
    passthrough.push(arg);
  }
}

// Lazy-getter context for extracted command modules (bin/commands/*).
// Getters resolve at call time, so mutable state (cfg, flags) and helpers
// declared later in this file behave exactly as they did inline.
const __cliCtx = {};
for (const [__n, __g] of Object.entries({
  CONFIG_DIR: () => CONFIG_DIR,
  CONFIG_FILE: () => CONFIG_FILE,
  HOME: () => HOME,
  VERSION: () => VERSION,
  _flagL4: () => _flagL4,
  _getOperatorSigner: () => _getOperatorSigner,
  _hasFlagL4: () => _hasFlagL4,
  _parseJsonOrNull: () => _parseJsonOrNull,
  _readPassphraseSync: () => _readPassphraseSync,
  applyBashDenyDefault: () => applyBashDenyDefault,
  args: () => args,
  command: () => command,
  deferHeavy: () => deferHeavy,
  execFileSync: () => execFileSync,
  fetchProxyJson: () => fetchProxyJson,
  fs: () => fs,
  http: () => http,
  loadConfig: () => loadConfig,
  migrateHeavyMcps: () => migrateHeavyMcps,
  passthrough: () => passthrough,
  path: () => path,
  readline: () => readline,
  resolveAgentId: () => resolveAgentId,
  showAdvanced: () => showAdvanced
})) Object.defineProperty(__cliCtx, __n, { get: __g });

// ===== COMMANDS =====

if (command === "version") {
  console.log("troth v" + VERSION);
  process.exit(0);
}

// `troth help` / -h / --help — print usage and EXIT. Before this guard an
// unknown "help" fell through to the default launcher, which silently
// booted the proxy + a full session.
if (command === "help" || args.indexOf("-h") !== -1 || args.indexOf("--help") !== -1) {
  console.log([
    "troth v" + VERSION + " — persistent AI partner. The substrate is the mind; any LLM is a faculty.",
    "",
    // Setup already had a line, thirty rows down under "Setup & health", which
    // is no use to the one reader who needs it most: someone who has just
    // cloned this and has nothing configured. It gets the first line instead.
    (fs.existsSync(CONFIG_FILE)
      ? "First time here?          troth setup   guided: pick an engine, paste a key"
      : "Start here:               troth setup   guided: pick an engine, paste a key"),
    "",
    "Sessions",
    "  troth                     talk to your partner — substrate REPL (default)",
    "  troth cli                 same REPL, explicit    troth classic   claude against the proxy",
    "  troth body                REPL into the autonomous runtime (signed control channel)",
    "  troth ui                  open the dashboard        (the desktop app is a separate download)",
    "",
    "Autonomous runs (sandboxed workers)",
    "  troth run \"task\"          start a run    troth status           list runs",
    "  troth logs <id> [-f]      captured log   troth diff <id>        diff vs parent branch",
    "  troth merge <id>          merge a run    troth kill <id>        stop a container",
    "  troth clean               remove finished runs      troth race-result <group>",
    "",
    "Safety & identity (operator-signed)",
    "  troth init                first-time bootstrap (operator keypair + seal)",
    "  troth pause [reason]      GLOBAL kill-switch on — halts dispatch AND in-flight steps",
    "  troth resume [reason]     kill-switch off        troth status   bootstrap + pause state",
    "  troth confirm <id>        promote a memory to operator-confirmed (signed)",
    "  troth unlock / lock       cache / wipe the session signer",
    "  troth audit verify        walk the tamper-evident signed-audit chain",
    "",
    "Setup & health",
    "  troth setup               guided setup   troth doctor           environment checks",
    "  troth codex login         sign in with your own ChatGPT subscription",
    "  troth start / restart     proxy control  troth tail             follow proxy logs",
    "  troth service [install]   start at login (launchd on macOS, systemd on Linux)",
    "",
    "More: config, mcp, schedule, memory-clear, atlas, mind, knowledge, chameleon,",
    "      tenant, orchestrate, incognito, vault, voice, inheritance, presence,",
    "      replicate-wal, seal, cap, project, partner, graduate, drafts,",
    "      activity, kv-state, replay, record-intent, schema, stats, telemetry,",
    "      checkpoint, rollback, reflect, dream, plan, accounts, reset.",
    "",
    "  A command with wrong/missing args prints that command's usage.",
  ].join("\n"));
  process.exit(0);
}

// ───────────────────────────────────────────────────────────────────────
// design: operator cryptographic surface.
//
// `troth init`             — first-time substrate bootstrap (integration point root).
// `troth status`           — show bootstrap + pause state (handled below).
// `troth confirm <id>`     — promote an llm_inferred engram to operator_confirmed.
// `troth pause [reason]`   — global kill-switch on.
// `troth resume [reason]`  — global kill-switch off.
//
// All four require operator passphrase. Read it from stdin (TTY) or
// from env TROTH_OPERATOR_PASSPHRASE for headless / CI use.
// Addendum Part 3 session-cache aware unlock. Tries cached session first,
// falls back to passphrase prompt + fresh unlock. Used by CLI commands
// migrated to the session pattern; callers that opt out (e.g. high-stakes
// seals demanding fresh passphrase) call opKey.unlock() directly.
function _getOperatorSigner(prompt) {
  var opKey = require("../shared-core/operator-key.js");
  // Try session first — silent miss falls through to passphrase prompt.
  try {
    var s = opKey.unlockFromSession();
    if (s) return { signer: s, from_session: true };
  } catch (_) { /* corrupt session → wipe handled inside unlockFromSession */ }
  var pass = _readPassphraseSync(prompt || "Operator passphrase");
  var signer;
  try { signer = opKey.unlock(pass); }
  catch (e) { throw new Error("Unlock failed: " + e.message); }
  return { signer: signer, from_session: false };
}

function _readPassphraseSync(prompt) {
  if (process.env.TROTH_OPERATOR_PASSPHRASE) {
    return process.env.TROTH_OPERATOR_PASSPHRASE;
  }
  // Best-effort hidden read. tty.ReadStream doesn't expose a sync
  // password mode in core Node — we fall back to a visible prompt with
  // a warning so the operator knows to clear their scrollback.
  process.stdout.write(prompt + ' (visible — clear scrollback after): ');
  var buf = Buffer.alloc(1024);
  var len = 0;
  try {
    var fd = process.stdin.fd;
    while (true) {
      var n = fs.readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (buf.indexOf(0x0a, len - n) >= 0) break;
      if (len >= buf.length - 1) break;
    }
  } catch (e) {
    console.error('failed to read passphrase: ' + e.message);
    process.exit(2);
  }
  return buf.slice(0, len).toString('utf8').replace(/\r?\n$/, '');
}

require('./cmd-init.js')(__cliCtx);

require('./cmd-confirm.js')(__cliCtx);

require('./cmd-recover.js')(__cliCtx);

require('./cmd-replicate-wal.js')(__cliCtx);

require('./cmd-inheritance.js')(__cliCtx);

require('./cmd-voice.js')(__cliCtx);

require('./cmd-vault.js')(__cliCtx);

require('./cmd-seal.js')(__cliCtx);

// design: operator-self CLIs.
//
// `troth cap mint <scope> [--max low|medium|high|sealed_only]
//                           [--expiry-ms <n>] [--budget-usd <n>]
//                           [--budget-window-ms <n>] [--allow-eval]`
// `troth schedule add <name> --scope <intent_scope>
//                              --interval-ms <n> [--payload <json>]
//                              [--cap <cap_id>] [--grounded-in <eng_id>]`
// `troth reactor add <name>  --source <source_glob>
//                              [--content <regex>]
//                              --scope <intent_scope> [--cap <cap_id>]
//                              [--payload <json>] [--grounded-in <eng_id>]`
// `troth project add <short_name> --purpose "<text>"
//                                   [--scope-pattern <glob>]
//                                   [--budget-usd <n>] [--budget-window-ms <n>]
//                                   [--expected-completion-ms <n>]`
//
// Each requires operator key (init must have run). Each prompts for the
// passphrase (or reads TROTH_OPERATOR_PASSPHRASE env), unlocks the
// signer, writes a signed engram via the appropriate primitive, prints
// the resulting engram id, locks the signer.

function _flagL4(name) {
  var idx = args.indexOf(name);
  return (idx >= 0 && args[idx + 1]) ? args[idx + 1] : null;
}
function _hasFlagL4(name) { return args.indexOf(name) >= 0; }
function _parseJsonOrNull(s) {
  if (!s) return null;
  try { return JSON.parse(s); }
  catch (e) { console.error('Bad JSON in --payload: ' + e.message); process.exit(2); }
}

require('./cmd-cap.js')(__cliCtx);

try { require('./cmd-schedule.js')(__cliCtx); } catch (_) { /* optional command module; not present in every build */ }

try { require('./cmd-reactor.js')(__cliCtx); } catch (_) { /* optional command module; not present in every build */ }

require('./cmd-project.js')(__cliCtx);

require('./cmd-unlock.js')(__cliCtx);

if (command === "lock") {
  var opKeyL = require("../shared-core/operator-key.js");
  var stBefore = opKeyL.sessionStatus();
  opKeyL.lockSession();
  if (stBefore && stBefore.unlocked) {
    console.log("Operator session locked (cached signer wiped).");
  } else {
    console.log("No active session — nothing to wipe.");
  }
  process.exit(0);
}

require('./cmd-drafts.js')(__cliCtx);

require('./cmd-activity.js')(__cliCtx);

try { require('./cmd-graduate.js')(__cliCtx); } catch (_) { /* optional command module; not present in every build */ }

require('./cmd-partner.js')(__cliCtx);

require('./cmd-presence.js')(__cliCtx);

require('./cmd-pause-resume.js')(__cliCtx);

// ───────────────────────────────────────────────────────────────────────
// `troth config l4 <subcommand>` — autonomous mode operator surface.
// Lets the operator inspect/toggle L4 features without editing JSON by hand.
// The dashboard surfaces the same knobs; this is the headless equivalent
// for ops/CI and the audit channel for documenting changes via shell.
require('./cmd-config.js')(__cliCtx);

// `troth config credential <list|add|remove>` — L4 credential vault.
// Plaintext file at ~/.troth/credentials.json (0600). Values never
// leave substrate-side; LLM only sees names + scope via credential_list.
require('./cmd-config-2.js')(__cliCtx);

// `troth l4 inbox <list|resolve|dismiss>` — operator-request inbox.
// Shows the asks the autonomous partner has surfaced (allowlist additions
// the fetcher needed, credentials it's missing, money it wants you to
// move, plans it needs you to approve). The dashboard shows the same.
require('./cmd-config-3.js')(__cliCtx);

// `troth config web allowlist <list|add|remove|reset>` — L4 fetcher
// allowlist surface. Lives next to `config l4` so all operator-deliberate
// L4 knobs share one mental location.
require('./cmd-config-4.js')(__cliCtx);

// `troth config (list|get|set)` — the plain settings surface the help text has
// always pointed at. Last in the config chain so the four specific subcommands
// above claim their words first.
require('./cmd-config-5.js')(__cliCtx);

// ───────────────────────────────────────────────────────────────────────
// `troth codex (login|logout|status)` — ChatGPT subscription auth for
// the Codex OAuth transport (Step 8a). Single-user, own-creds, local-
// only; the client identity it needs is operator-supplied and not shipped
// (see shared-core/codex-auth.js). Token persisted to
// ~/.troth/codex-token.json (mode 0600). Once logged in, the entity
// transport routes through chatgpt.com/backend-api/codex/responses
// against the user's flat-rate Plus / Pro quota — no per-token billing.
require('./cmd-codex.js')(__cliCtx);
// `status` and `logout` exit synchronously inside that module, so they never
// reach here. `login` cannot: it awaits a browser round-trip and returns to
// this file with the OAuth callback server still listening. Without this
// return, control ran on to the "no handler" guard near the bottom, which
// printed a false error and exit(127) — killing the callback server seconds
// after opening the user's browser, which is worse than the dead door this
// command was just rescued from. Its own .then/.catch owns the exit.
if (command === "codex") return;

// ───────────────────────────────────────────────────────────────────────
// `troth chat` — human-facing REPL backed by troth-entity.
// Same daemon, same tools, same substrate the voice app uses. Bypasses
// `claude` entirely so users on this path get the troth skills surface
// (/goal, /remember, /recall, etc.) without involving Claude Code at all.
if (command === "cli" || command === "chat") {
  // troth-cli.start() takes over stdin/stdout via readline; this process
  // stays alive on the REPL's event loop until the user exits. Both `cli`
  // (canonical) and `chat` (back-compat) route here.
  require("./troth-chat.js").start();
}

// ───────────────────────────────────────────────────────────────────────
// `troth body` — REPL into the autonomous runtime.
//
// Same partner you reach from the desktop app + voice. This is the
// operator's terminal path. Each line becomes a signed `control:chat`
// engram POSTed to the body's vsock-bridged control channel. NOT a
// different entity — one Gem, multiple surfaces.
//
// The VM body is NOT shipped: not in this tree, and not in the app you can buy
// today either — README's feature matrix says so and means it. This entry point
// exists because the boundary is already built into the code; it resolves to a
// clear message rather than a missing-file crash.
if (command === "body") {
  const bodyBin = path.join(__dirname, 'troth-body.js');
  if (!fs.existsSync(bodyBin)) {
    console.error("`troth body` needs the sandboxed VM body, which is not shipped yet:");
    console.error("  not in this tree, and not in the app either. See the feature matrix in README.md.");
    process.exit(1);
  }
  const { spawn } = require('child_process');
  const child = spawn(process.execPath,
    [bodyBin, ...process.argv.slice(3)],
    { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
  return;
}

// ───────────────────────────────────────────────────────────────────────
// `troth incognito on|off|toggle|status` — substrate write-mute switch.
//
// What incognito does:
//   Substrate READS still work (model can reference past identity, codelens,
//     lessons — context for THIS turn).
//   Substrate WRITES are silently dropped: no engrams, no lessons, no goals,
//     no dialogue mirror, no critic feedback persisted. The session leaves
//     no footprint on long-term memory.
//
// Why: prevents cross-pollution between unrelated parallel agents (e.g. dev
// session + financial-research session) and lets you run "experimental"
// prompts without contaminating identity. Maps to the brain's analog: not
// every thought consolidates to long-term memory.
//
// State lives at ~/.troth/incognito.json so plugin hooks (which live in
// a different process) can read it.
require('./cmd-incognito.js')(__cliCtx);

if (command === "audit") {
  // troth audit verify — walks l4_signed_audit_chain end-to-end via
  // shared-core/signed-audit.js (multi-key verifier, C7 v2). Exits 0 if
  // chain intact, 1 on first tamper, 2 on bad invocation. This is the
  // acceptance hook the design spec calls 'troth audit verify
  // returns ok:true over a session.'
  var auditSub = (args[1] || "").toLowerCase();
  if (auditSub === "verify") {
    var r = require("child_process").spawnSync(process.execPath,
      [require("path").join(__dirname, "audit-verify.js")].concat(args.slice(2)),
      { stdio: "inherit" });
    process.exit(r.status == null ? 2 : r.status);
  }
  console.error("Usage: troth audit verify");
  process.exit(2);
}

// bin/cmd-help.js used to be required here. The help block higher up in this
// file answers and exits first, so it never ran once — proven by instrumenting
// it across help, --help, -h and help --advanced. It carried a second copy of
// the help text that had drifted, still pointing at localhost:8000.

// ===== v6.0 — Autonomous run lifecycle =====
//
// All these dispatch into bin/runner.js which owns the actual Docker
// orchestration, git worktree management, and lifecycle state.

if (command === "run") {
  var runner = require("./runner");
  // The task is everything left in passthrough joined with spaces.
  var task = passthrough.join(" ");
  process.exit(runner.cmdRun(task, { foreground: foreground }));
}

require('./cmd-race.js')(__cliCtx);

if (command === "race-result") {
  var runnerRR = require("./runner");
  var groupId = passthrough[0];
  if (!groupId) {
    console.error("Usage: troth race-result <group-id>");
    process.exit(1);
  }
  process.exit(runnerRR.cmdRaceResult(groupId));
}

// `troth atlas export|import|inspect` — KnowledgeAtlas CLI surface.
// Product gap 4: substrate portability has the shared-core/atlas.js
// library but no user-facing CLI. Without this, exports require hand-
// written scripts. This wires the 3 operations into the main CLI.
require('./cmd-atlas.js')(__cliCtx);

// Mind layer CLI surface.
//   troth mind list   [--cwd <path>] [--limit N]   # list recent snapshots
//   troth mind show   [--cwd <path>] [--id <uuid>] # pretty-print one snapshot
//   troth mind focus  [--cwd <path>]               # show formatOrientation output
require('./cmd-mind.js')(__cliCtx);

// Counterfactual replay subcommand.
//   troth replay --intent <id>                       # list candidate alternatives
//   troth replay --intent <id> --use <N>             # create candidate branch for alt N
//   troth replay --intent <id> --use <N> --estimate  # show baseline + cost estimate, no agent
//   troth replay --branch <id> --diff                # show cost+verification diff vs baseline
//   troth replay --branch <id> --discard             # mark branch discarded
//   troth replay --list                              # list all branches
require('./cmd-replay.js')(__cliCtx);

// Companion to replay: explicit intent recording with alternatives.
// The auto-extractor (intent-extract.js) only populates alternatives_considered
// when the prompt uses "or / instead of / either" patterns. For decisions made
// outside that natural-language flow (research-driven choices, architecture
// review notes, etc.), record the intent manually so `troth replay` has data
// to diff against later.
//   troth record-intent --goal "<text>" --consider A,B,C --chose A --cwd <p>
//                         [--rationale-A "..."] [--rationale-B "..."]
require('./cmd-record-intent.js')(__cliCtx);

// Knowledge import — curriculum tier. Auto-discovers research-shaped
// content (Markdown / text / JSON) under one or more paths and writes
// each chunk as a lesson ActionRecord. Idempotent (fingerprint dedup).
//
// Goal: turn folders of past research, design docs, planning notes,
// transcripts into queryable substrate so the agent can call
// troth_search_actions / troth_query_actions and find prior work
// instead of asking the user to paste it again.
//
//   troth knowledge import <path> [<path>...]    # recursive, auto-filter
//   troth knowledge import <path> --dry-run       # show what would land, write nothing
//   troth knowledge import <path> --max-chunk 2000  # bytes per chunk (default 2000)
//   troth knowledge stats                          # how many chunks indexed, by source
//   troth knowledge search "<query>" [--limit N]   # FTS5 search over imported lessons
require('./cmd-knowledge.js')(__cliCtx);

// ============================================================
// `troth chameleon` — Chameleon Protocol adapter management.
// ============================================================
//
// Drives the substrate-side runtime engine (`shared-core/chameleon-runtime.js`).
// Adapters are registered by operator → list / run / unregister via this CLI
// or the matching MCP tools (troth_chameleon_register_adapter etc.).
//
//   troth chameleon list
//   troth chameleon register <name> <cmd> [arg...] [--source-id ID] [--default-scope SCOPE]
//   troth chameleon unregister <name>
//   troth chameleon run <name> [--scope SCOPE]
//   troth chameleon import <path> [--scope SCOPE]   # convenience: register+run filesystem adapter
require('./cmd-chameleon.js')(__cliCtx);

// Wire-format schema reflector CLI.
//   troth schema list                              # list profiles
//   troth schema show <id>                         # show profile JSON
//   troth schema activate <id>                     # promote candidate → active
//   troth schema discard <id>                      # mark discarded
//   troth schema active --signature <sig>          # show active for domain
//
// (Reflector run requires an LLM driver; not exposed via CLI yet —
// programmatic only via require('shared-core/schema-reflector').)
require('./cmd-schema.js')(__cliCtx);

if (command === "status") {
  // `troth status l4` — autonomous mode snapshot (D.3). Same shape
  // the dashboard / app / voice surfaces consume via /api/l4/status.
  if (passthrough[0] === "l4") {
    // The fallback defined `status`, but the call below is `getSnapshot`, so on
    // a public clone this printed a TypeError stack instead of an answer.
    var l4status = (function () {
      try { return require('../shared-core/l4-status.js'); }
      catch (e) {
        return { present: false, getSnapshot: function () { return { present: false, enabled: false }; } };
      }
    }());
    if (l4status.present === false) {
      console.error('note: the autonomous (L4) layer is not part of this build.');
    }
    var snap = l4status.getSnapshot({});
    console.log(JSON.stringify(snap, null, 2));
    process.exit(0);
  }
  var runner = require("./runner");
  // status takes an optional run id (or no args = list all)
  var statusId = passthrough[0] || null;
  process.exit(runner.cmdStatus(statusId));
}

if (command === "logs") {
  var runner = require("./runner");
  var logsId = passthrough[0];
  if (!logsId) {
    console.error("Usage: troth logs <run-id> [-f]");
    process.exit(1);
  }
  process.exit(runner.cmdLogs(logsId, foreground));
}

if (command === "diff") {
  var runner = require("./runner");
  var diffId = passthrough[0];
  if (!diffId) {
    console.error("Usage: troth diff <run-id>");
    process.exit(1);
  }
  process.exit(runner.cmdDiff(diffId));
}

if (command === "merge") {
  var runner = require("./runner");
  var mergeId = passthrough[0];
  if (!mergeId) {
    console.error("Usage: troth merge <run-id>");
    process.exit(1);
  }
  process.exit(runner.cmdMerge(mergeId));
}

if (command === "kill") {
  var runner = require("./runner");
  var killId = passthrough[0];
  if (!killId) {
    console.error("Usage: troth kill <run-id>");
    process.exit(1);
  }
  process.exit(runner.cmdKill(killId));
}

if (command === "clean") {
  var runner = require("./runner");
  if (cleanDaemons) {
    // Stop every background model/browser daemon now. They respawn on the next
    // call that needs them, so this is always safe to run.
    var _cpC = require("child_process");
    var pats = [
      'llama-server.*--port ' + (process.env.TROTH_EMBED_PORT  || '11437'),
      'llama-server.*--port ' + (process.env.TROTH_RERANK_PORT || '11438'),
      'llama-server.*--port ' + (process.env.TROTH_LOCAL_PORT  || '11436'),
      'remote-debugging-port=' + (process.env.TROTH_BROWSER_CDP_PORT || '18222')
    ];
    var stopped = 0;
    for (var pi = 0; pi < pats.length; pi++) {
      try {
        // stderr is discarded on purpose: a slim Linux image has no pgrep, and
        // the shell's "not found" was inherited straight onto the user's
        // terminal, four times, in the middle of a diagnostic.
        var found = _cpC.execSync('pgrep -f "' + pats[pi] + '" || true',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (found) { _cpC.execSync('pkill -f "' + pats[pi] + '" || true', { stdio: 'ignore' }); stopped += found.split('\n').length; }
      } catch (_) {}
    }
    console.log(stopped ? ('troth: stopped ' + stopped + ' background daemon(s). They restart on demand.')
                        : 'troth: no background daemons were running.');
    process.exit(0);
  }
  if (cleanStuck) {
    process.exit(runner.cmdCleanStuck(cleanStuckKill));
  }
  var cleanId = passthrough[0] || null;
  process.exit(runner.cmdClean(cleanId, cleanAll));
}

if (command === "mcp-audit") {
  var audit = require("./mcp-audit");
  audit.main().then(
    () => process.exit(0),
    (e) => { console.error('mcp-audit failed:', e.message); process.exit(1); }
  );
  return;
}

// --defer-heavy: run mcp-audit, identify HEAVY servers, move them from
// ~/.claude/settings.json into ~/.troth/router.json, back up the
// original settings, and restart so CC picks up the new config.
// Turns "47K tokens/turn saved" from opt-in diagnostic into one flag.
var deferHeavy = (passthrough.indexOf("--defer-heavy") !== -1);

require('./cmd-install-plugin-uninstall-plugin.js')(__cliCtx);

// ===== v6.3 — Schedule management =====
require('./cmd-schedule-2.js')(__cliCtx);

// ===== v6.2 — MCP server (stdio JSON-RPC for AI chat agents) =====
//
// Started by Claude Code (or any MCP-aware client) via mcp.json:
//
//   { "mcpServers": { "troth": { "command": "troth", "args": ["mcp"] } } }
//
// The server hand-rolls the MCP wire format over stdio, exposing the
// run lifecycle (troth_run, troth_list, troth_status, troth_logs,
// troth_diff, troth_kill, troth_clean) as native tools the agent
// can call alongside Read/Write/Edit/Bash/etc. Lets the agent dispatch
// background workers without dropping to a shell.
if (command === "mcp") {
  // `troth mcp install [host]` / `troth mcp hosts` — one-command wiring of
  // the troth MCP servers into a host's config (Claude Code, Cursor).
  // Handled BEFORE the server starts: these subcommands print to stdout,
  // which the MCP stdio transport must never share.
  if (passthrough[0] === "install" || passthrough[0] === "hosts") {
    require("./cmd-mcp-install.js")(__cliCtx);
    return;
  }
  // `troth mcp approve|pending|reject <name>` - operator side of the
  // conversational registration flow (partner stages via
  // mcp_register_request, operator approves ONCE here; approve moves the
  // entry pending -> active and seals capability:mcp:<name>). Also handled
  // BEFORE the server starts: these print to stdout, which the MCP stdio
  // transport must never share.
  if (passthrough[0] === "approve" || passthrough[0] === "pending" || passthrough[0] === "reject") {
    require("./cmd-mcp.js")(__cliCtx);
    return;
  }
  // Load and run the MCP server inline. Stdin/stdout are owned by the
  // MCP transport — we MUST NOT write to stdout from this point on
  // (the server file enforces this for itself).
  require("./mcp-server.js");
  // The server keeps the process alive via its readline interface.
  return;
}

// tenant CLI — `troth tenant {add|list|use|remove|current}`.
// Tenant data lives at ~/.troth/tenants/<name>/state.db and gets bound
// to workers via STATE_DB_PATH env (read by shared-core/state.js).
// Active tenant cursor at ~/.troth/.active-tenant (read by orchestrator).
require('./cmd-tenant.js')(__cliCtx);

// orchestrate CLI — `troth orchestrate "<task>" --roles backend,frontend,qa`.
// Spawns one worker per role per the role registry, scopes engrams per
// role, returns a group_id for follow-up reads. Implementation lives in
// bin/orchestrator.js to keep this dispatcher thin.
if (command === "orchestrate") {
  var orch = require("./orchestrator");
  var rolesArg = null, tenantArg = null, noPlanArg = false, maxParallelArg = 0;
  var taskParts = [];
  for (var oi = 0; oi < passthrough.length; oi++) {
    if (passthrough[oi] === '--roles' && oi + 1 < passthrough.length) {
      rolesArg = passthrough[oi + 1].split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      oi++;
    } else if (passthrough[oi] === '--tenant' && oi + 1 < passthrough.length) {
      tenantArg = passthrough[oi + 1];
      oi++;
    } else if (passthrough[oi] === '--no-plan') {
      noPlanArg = true;
    } else if (passthrough[oi] === '--max-parallel' && oi + 1 < passthrough.length) {
      maxParallelArg = parseInt(passthrough[oi + 1], 10) || 0;
      oi++;
    } else {
      taskParts.push(passthrough[oi]);
    }
  }
  process.exit(orch.cmdOrchestrate(taskParts.join(" "), { roles: rolesArg, tenant: tenantArg, noPlan: noPlanArg, maxParallel: maxParallelArg }));
}

// Companion to `orchestrate` — poll a previously-launched group's progress.
// Calls supervisor.mergeResults via orchestrator.cmdOrchestrateStatus and
// renders by-role engram counts + cross-role conflict detection.
if (command === "orchestrate-status") {
  var orchS = require("./orchestrator");
  var groupArg = passthrough[0];
  process.exit(orchS.cmdOrchestrateStatus(groupArg));
}

if (command === "ui") {
  // Three paths:
  //   1. --standalone flag          → spawn the tiny plugin-only server
  //                                    on:9999 and open its dashboard.
  //   2. proxy already on:8000     → open the full proxy dashboard.
  //   3. neither of the above       → ensureProxy spins it up and opens
  //                                    the full dashboard (legacy behaviour).
  var standalone = passthrough.indexOf("--standalone") !== -1 ||
                   passthrough.indexOf("--plugin-only") !== -1;

  if (standalone) {
    var standaloneScript = path.join(__dirname, "standalone-ui.js");
    var child = spawn(process.execPath, [standaloneScript], {
      detached: false,
      stdio: "inherit"
    });
    child.on("error", function (e) {
      console.error("Failed to start standalone viewer: " + e.message);
      process.exit(1);
    });
    child.on("exit", function (code) { process.exit(code || 0); });
    // Also open the browser once the child has had a moment to bind.
    setTimeout(function () {
      var viewerUrl = "http://127.0.0.1:" + (process.env.GF_STANDALONE_PORT || 9999) + "/";
      var openCmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start" : "xdg-open";
      try { spawn(openCmd, [viewerUrl], { detached: true, stdio: "ignore" }).unref(); }
      catch (e) { console.log("Open manually: " + viewerUrl); }
    }, 500);
    return;
  }

  var cfg = loadConfig();
  ensureProxy(cfg);
  var url = "http://" + cfg.host + ":" + cfg.port + "/ui";

  // Find Chrome/Chromium and open in app mode (no address bar, looks like native app)
  var browsers = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      ]
    : process.platform === "win32"
    ? [
        process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env.PROGRAMFILES + " (x86)\\Google\\Chrome\\Application\\chrome.exe"
      ]
    : ["google-chrome", "chromium-browser", "chromium", "brave-browser"];

  // Safe spawn helper: attaches a no-op 'error' listener so async spawn
  // failures (missing binary, ENOENT) don't crash the process. Returns
  // a Promise that resolves true if the child started, false on error.
  function trySpawnBrowser(cmd, args) {
    return new Promise(function(resolve) {
      var child;
      try { child = spawn(cmd, args, { detached: true, stdio: "ignore" }); }
      catch (e) { resolve(false); return; }
      var done = false;
      child.on("error", function() { if (!done) { done = true; resolve(false); } });
      // If no error fires in 120ms, assume the child started successfully.
      setTimeout(function() { if (!done) { done = true; child.unref(); resolve(true); } }, 120);
    });
  }

  (async function() {
    // Open in default browser. Chrome's --app mode on macOS is broken:
    // clicking the dock icon to refocus opens an extra empty window
    // every time. A regular browser tab just works.
    var openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    if (await trySpawnBrowser(openCmd, [url])) {
      console.log("troth UI opened at " + url);
    } else {
      console.log("Open manually: " + url);
    }
    setTimeout(function() { process.exit(0); }, 500);
  })();
  return;
}

if (command === "app") {
  if (process.platform !== "darwin") {
    console.error("troth app is only supported on macOS.");
    process.exit(1);
  }
  // The desktop app is built from a separate checkout that is not part of
  // this repository, so there is nothing here to build. This used to point
  // at scripts/build-app.sh and print "not found" with a path nobody could
  // act on, for a command the help text advertised.
  console.error("`troth app` builds the macOS desktop app, which is not part of this repository.");
  console.error("The engine you have runs headless: `troth` for chat, `troth ui` for the dashboard.");
  console.error("The packaged app is at https://troth.one");
  process.exit(1);
}

if (command === "tail") {
  // Live stream the proxy's in-memory log ring buffer to this terminal.
  // Works for both local and remote proxies (HTTP GET only). Polls
  // /api/logs every second with a `since` timestamp so we only receive
  // new lines. The `inFlight` guard prevents overlapping requests when
  // the proxy is slow to respond. Ctrl-C exits.
  var cfg = loadConfig();
  if (!checkHealthSync(cfg.host, cfg.port)) {
    console.error("Proxy not reachable at " + cfg.host + ":" + cfg.port);
    console.error("Local proxy? Run:  troth start");
    console.error("Remote proxy?     Check that the machine is up and the port is reachable.");
    process.exit(1);
  }
  console.log("Tailing " + cfg.host + ":" + cfg.port + " — Ctrl-C to stop\n");
  var tailLastTs = 0;
  var tailInFlight = false;
  function tailPoll() {
    if (tailInFlight) return;
    tailInFlight = true;
    var tailReq = http.request({
      host: cfg.host, port: cfg.port, path: "/api/logs?since=" + tailLastTs, timeout: 5000
    }, function(tailRes) {
      var buf = "";
      tailRes.on("data", function(d) { buf += d; });
      tailRes.on("end", function() {
        tailInFlight = false;
        try {
          var data = JSON.parse(buf);
          var lines = data.lines || [];
          for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (!l.ts || l.ts <= tailLastTs) continue;
            tailLastTs = l.ts;
            var t = new Date(l.ts).toTimeString().slice(0, 8);
            var color = l.type === 'error' ? '\x1b[31m' : '\x1b[90m';
            process.stdout.write(color + '[' + t + ']\x1b[0m ' + l.msg + '\n');
          }
        } catch (e) { /* bad json — skip this cycle */ }
      });
    });
    tailReq.on("error", function() { tailInFlight = false; });
    tailReq.on("timeout", function() { tailInFlight = false; tailReq.destroy(); });
    tailReq.end();
  }
  tailPoll();
  setInterval(tailPoll, 1000);
  // Keep the process alive until Ctrl-C. The setInterval above does that.
  return;
}

if (command === "reset") {
  // Factory reset: stop local proxy, remove config, strip troth hooks
  // from ~/.claude/settings.json, optionally remove Google account tokens.
  // User hooks, permissions, mcpServers, and every other settings.json
  // key are left strictly alone — we only touch the two hook entries we
  // wrote during `troth setup`.
  //
  // Input model: reset asks TWO sequential y/n questions. readline on a
  // pipe pre-buffers everything in one flush — the second `question()`
  // call never sees its line, because readline has already emitted both
  // 'line' events and 'close' before we got a chance to register for
  // the second one. Instead:
  //   Non-TTY (piped): drain stdin synchronously with fs.readFileSync(0)
  //     into a line array upfront, then serve prompts from the array.
  //     Echoes the prompt + line so the transcript stays readable.
  //   TTY (interactive): normal readline.question loop.
  var resetIsTTY = process.stdin.isTTY;
  var resetLines = [];
  if (!resetIsTTY) {
    try { resetLines = fs.readFileSync(0, "utf8").split(/\r?\n/); }
    catch (e) { resetLines = []; }
  }
  var resetRl = resetIsTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  function resetAsk(q, defaultYes) {
    return new Promise(function(resolve) {
      if (!resetIsTTY) {
        // Piped / redirected: shift the next buffered line. Echo the
        // question + answer so the captured transcript makes sense.
        var line = resetLines.length ? resetLines.shift() : "";
        process.stdout.write(q + line + "\n");
        var a = (line || "").trim().toLowerCase();
        if (a === "") return resolve(defaultYes);
        return resolve(a === "y" || a === "yes");
      }
      resetRl.question(q, function(ans) {
        var a = (ans || "").trim().toLowerCase();
        if (a === "") return resolve(defaultYes);
        resolve(a === "y" || a === "yes");
      });
    });
  }
  (async function() {
    console.log("\n  troth reset — factory defaults\n");
    console.log("  This will:");
    console.log("    - Stop the local proxy (if running on this machine)");
    console.log("    - Remove " + CONFIG_FILE);
    console.log("    - Remove only troth's verify-file / verify-project hooks from");
    console.log("      ~/.claude/settings.json (your other hooks, permissions, MCP");
    console.log("      servers, and all other settings are preserved)");
    console.log("    - Ask separately about deleting Google account tokens\n");

    var cont = await resetAsk("  Continue? [y/N] ", false);
    if (!cont) { console.log("\n  Cancelled.\n"); if (resetRl) resetRl.close(); process.exit(0); }

    // 1. Stop the local proxy (best-effort).
    var cfg = loadConfig();
    var isLocalProxy = !cfg.host || cfg.host === "localhost" || cfg.host === "127.0.0.1";
    if (isLocalProxy && checkHealthSync(cfg.host, cfg.port)) {
      try {
        var shutScript =
          'const h=require("http");' +
          'const r=h.request({host:"' + cfg.host + '",port:' + cfg.port + ',path:"/api/shutdown",method:"POST",timeout:2000},' +
          '(res)=>{res.resume();process.exit(0)});' +
          'r.on("error",()=>process.exit(0));' +
          'r.on("timeout",()=>{r.destroy();process.exit(0)});' +
          'r.end();';
        execFileSync(process.execPath, ["-e", shutScript], { stdio: "pipe" });
        // Wait for the port to release.
        for (var w = 0; w < 12; w++) {
          sleepMs(250);
          if (!checkHealthSync(cfg.host, cfg.port)) break;
        }
        console.log("  \x1b[32m+\x1b[0m Stopped local proxy");
      } catch (e) { console.log("  \x1b[33m~\x1b[0m Could not cleanly stop proxy: " + e.message); }
    }

    // 2. Remove config file.
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
        console.log("  \x1b[32m+\x1b[0m Removed " + CONFIG_FILE);
      } else {
        console.log("  \x1b[33m~\x1b[0m No config file to remove");
      }
    } catch (e) {
      console.log("  \x1b[31m-\x1b[0m Could not remove config: " + e.message);
    }

    // 3. Strip troth hooks from settings.json, preserve everything else.
    try {
      var settingsPath = path.join(HOME, ".claude", "settings.json");
      if (fs.existsSync(settingsPath)) {
        var settingsRaw = fs.readFileSync(settingsPath, "utf8");
        var settings;
        try { settings = JSON.parse(settingsRaw); } catch (pe) {
          console.log("  \x1b[31m-\x1b[0m settings.json is not valid JSON; skipping hook cleanup");
          settings = null;
        }
        if (settings) {
          var removedCount = 0;
          if (settings.hooks && typeof settings.hooks === "object") {
            // PostToolUse — remove entries whose command contains verify-file
            if (Array.isArray(settings.hooks.PostToolUse)) {
              for (var g = 0; g < settings.hooks.PostToolUse.length; g++) {
                var grp = settings.hooks.PostToolUse[g];
                if (grp && Array.isArray(grp.hooks)) {
                  var bef = grp.hooks.length;
                  grp.hooks = grp.hooks.filter(function(h) {
                    return !(h && typeof h.command === "string" && h.command.indexOf("verify-file") !== -1);
                  });
                  removedCount += bef - grp.hooks.length;
                }
              }
              settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(function(g) {
                return g && Array.isArray(g.hooks) && g.hooks.length > 0;
              });
            }
            // Stop — remove entries whose command contains verify-project
            if (Array.isArray(settings.hooks.Stop)) {
              for (var s = 0; s < settings.hooks.Stop.length; s++) {
                var grp2 = settings.hooks.Stop[s];
                if (grp2 && Array.isArray(grp2.hooks)) {
                  var bef2 = grp2.hooks.length;
                  grp2.hooks = grp2.hooks.filter(function(h) {
                    return !(h && typeof h.command === "string" && h.command.indexOf("verify-project") !== -1);
                  });
                  removedCount += bef2 - grp2.hooks.length;
                }
              }
              settings.hooks.Stop = settings.hooks.Stop.filter(function(g) {
                return g && Array.isArray(g.hooks) && g.hooks.length > 0;
              });
            }
          }
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log("  \x1b[32m+\x1b[0m Removed " + removedCount + " troth hook entry/entries from " + settingsPath);
        }
      } else {
        console.log("  \x1b[33m~\x1b[0m No ~/.claude/settings.json to clean");
      }
    } catch (e) {
      console.log("  \x1b[31m-\x1b[0m Could not clean settings.json: " + e.message);
    }

    // 4. Google account tokens — historical reset step removed.
    // the legacy OAuth transport was removed in an earlier major version. Stale ~/.gemini/
    // accounts/ files are no longer read by any active code path; reset
    // no longer prompts to delete them. Users who want them gone can
    // remove the directory manually.

    console.log("\n  Reset complete. Run 'troth' to start fresh.\n");
    if (resetRl) resetRl.close();
    process.exit(0);
  })();
  return;
}

// ── v8.1 scaffolding introspection commands ──

function fetchProxyJson(path) {
  var cfg = loadConfig();
  // Allow GF_PORT env override for dev/test (mirrors proxy/server.js).
  var port = parseInt(process.env.GF_PORT || cfg.port);
  var host = process.env.GF_HOST || cfg.host;
  try {
    var script =
      'const h=require("http");' +
      'const r=h.request({host:"' + host + '",port:' + port + ',path:"' + path + '",timeout:3000},' +
      '(res)=>{let b="";res.on("data",d=>b+=d);res.on("end",()=>{process.stdout.write(b);process.exit(0)})});' +
      'r.on("error",()=>process.exit(1));' +
      'r.on("timeout",()=>{r.destroy();process.exit(1)});' +
      'r.end();';
    var out = execFileSync(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return JSON.parse(out);
  } catch (e) { return null; }
}

require('./cmd-stats.js')(__cliCtx);

require('./cmd-telemetry.js')(__cliCtx);

if (command === "checkpoint") {
  // Manually create a checkpoint
  try {
    var checkpoint = require('../proxy/modules/checkpoint');
    var msg = passthrough.join(' ') || 'manual';
    var id = checkpoint.checkpoint(process.cwd(), msg, []);
    if (id) console.log('Checkpoint created: ' + id);
    else console.log('No checkpoint needed (no changes or not a git repo)');
    process.exit(0);
  } catch (e) { console.error('Checkpoint failed:', e.message); process.exit(1); }
}

if (command === "rollback") {
  try {
    var checkpoint = require('../proxy/modules/checkpoint');
    var ok = checkpoint.rollback(process.cwd(), 1);
    if (ok) console.log('Rolled back to last checkpoint.');
    else console.log('Rollback failed (no checkpoints or not a git repo).');
    process.exit(ok ? 0 : 1);
  } catch (e) { console.error('Rollback failed:', e.message); process.exit(1); }
}

require('./cmd-reflect.js')(__cliCtx);

if (command === "dream") {
  // Manually trigger AutoDream memory consolidation
  try {
    var autodream = require(path.join(__dirname, '..', 'proxy', 'modules', 'autodream.js'));
    var r = autodream.consolidate();
    if (r.error) { console.error('Dream failed:', r.error); process.exit(1); }
    if (r.skipped) { console.log('Dream skipped: ' + r.skipped); process.exit(0); }
    console.log('=== AutoDream consolidation ===');
    console.log('Merged (dupes):  ' + (r.merged || 0));
    console.log('Pruned (stale):  ' + (r.pruned || 0));
    process.exit(0);
  } catch (e) { console.error('Dream failed:', e.message); process.exit(1); }
}

require('./cmd-memory-clear.js')(__cliCtx);

require('./cmd-plan.js')(__cliCtx);

if (command === "service") {
  var svcMod = require(path.join(__dirname, "..", "proxy", "modules", "service.js"));
  var svcSub = args[1] || "status";
  if (svcSub === "install") {
    var svcCfg = loadConfig();
    var ri = svcMod.install({ port: svcCfg.port || 8000 });
    console.log(ri.ok
      ? "troth service installed (" + ri.kind + "). The proxy now starts at login.\n  unit: " + ri.unit
      : "install failed: " + ri.error);
    process.exit(ri.ok ? 0 : 1);
  }
  if (svcSub === "uninstall") {
    var ru = svcMod.uninstall();
    console.log(ru.ok ? "troth service removed. The proxy runs only when you start it." : "uninstall failed: " + ru.error);
    process.exit(ru.ok ? 0 : 1);
  }
  var svcSt = svcMod.status();
  if (!svcSt.supported) { console.log("login service: not supported on " + svcSt.platform); process.exit(0); }
  console.log("login service (" + svcSt.kind + "): " + (svcSt.installed ? "installed" + (svcSt.loaded ? ", loaded" : ", not loaded") : "not installed"));
  console.log("  " + (svcSt.installed ? "remove with: troth service uninstall" : "install with: troth service install"));
  process.exit(0);
}

if (command === "restart") {
  // Gracefully shut down any running proxy, then spawn a fresh one.
  // Useful when the user changes project directories and wants CodeLens
  // to re-index against the new cwd. Only works for local proxies —
  // remote proxies (Tailscale/LAN) cannot be restarted from the client.
  var cfg = loadConfig();
  if (cfg.host !== "localhost" && cfg.host !== "127.0.0.1") {
    console.error("troth restart only works on local proxies.");
    console.error("Your config points at " + cfg.host + ":" + cfg.port + " — restart that machine manually.");
    process.exit(1);
  }
  // If the background service owns this proxy, cycle it through its own
  // manager. Shutting it down and spawning a loose child here would evict
  // the supervised instance, and the operator who switched the service on
  // would be left with a proxy nobody restarts.
  try {
    var svcMod = require("../proxy/modules/service.js");
    if (svcMod.status().loaded) {
      var cycled = svcMod.restart();
      if (cycled.ok) {
        for (var w = 0; w < 40; w++) {
          sleepMs(250);
          if (checkHealthSync(cfg.host, cfg.port)) break;
        }
        console.log("troth proxy restarted through the background service.");
        process.exit(0);
      }
      console.error("Could not cycle the background service (" + cycled.error + "), falling back to a direct restart.");
    }
  } catch (_) { /* no service module or no service: plain restart below */ }
  // Best-effort shutdown of whatever is currently on cfg.host:cfg.port.
  if (checkHealthSync(cfg.host, cfg.port)) {
    try {
      var shutdownScript =
        'const h=require("http");' +
        'const r=h.request({host:"' + cfg.host + '",port:' + cfg.port + ',path:"/api/shutdown",method:"POST",timeout:2000},' +
        '(res)=>{res.resume();process.exit(0)});' +
        'r.on("error",()=>process.exit(0));' +
        'r.on("timeout",()=>{r.destroy();process.exit(0)});' +
        'r.end();';
      execFileSync(process.execPath, ["-e", shutdownScript], { stdio: "pipe" });
    } catch (e) { /* non-fatal — the new proxy will fail to bind if old is alive */ }
    // Wait for the old proxy to actually release the port.
    for (var r = 0; r < 20; r++) {
      sleepMs(250);
      if (!checkHealthSync(cfg.host, cfg.port)) break;
    }
  }
  // Now spawn a fresh one with the user's current cwd.
  ensureProxy(cfg);
  console.log("troth proxy restarted (cwd: " + process.cwd() + ")");
  process.exit(0);
}

if (command === "start") {
  var cfg = loadConfig();
  var serverPath = path.join(__dirname, "..", "proxy", "server.js");
  console.log("Starting troth proxy on :" + cfg.port + "...");
  var env = Object.assign({}, process.env, {
    GF_PORT: String(cfg.port),
    GF_BACKEND_HOST: cfg.backendHost,
    GF_BACKEND_PORT: String(cfg.backendPort),
    // Pin CodeLens to the user's current dir (their project root),
    // not wherever server.js happens to run from.
    GF_WATCH_DIR: process.cwd()
  });
  // Use process.execPath (the node binary currently running the CLI)
  // instead of the literal "node" string — avoids surprises if the
  // user's PATH has a different node than the one troth was
  // installed against.
  var child = spawn(process.execPath, [serverPath], { env: env, stdio: "inherit" });
  child.on("exit", function(code) { process.exit(code || 0); });
  return;
}

// troth kv-state — diagnose the local llama-server's KV slot capability.
// EXPERIMENTAL decode-cache optimization (see shared-core/kv-state.js
// header for the  honest demote). Useful for measuring whether
// llama-server was started with --slot-save-path <dir>; without it, every
// kv save/restore call returns 404. This command does NOT verify any
// substrate-continuity property — substrate continuity lives in
// engram/dialogue/identity reads, not in the model's attention cache.
// Pure read — no mutations.
require('./cmd-kv-state.js')(__cliCtx);

if (command === "doctor") {
  var cfg = loadConfig();
  console.log("\n  troth Doctor v" + VERSION + "\n");
  var checks = [];

  // Node.js version
  var nodeVer = parseInt(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js >= 22", ok: nodeVer >= 22, detail: "v" + process.versions.node });

  // Memory hooks runtime. Claude Code launches the plugin's recall hooks
  // with bare `node` from PATH, and those hooks load native better-sqlite3;
  // on a node whose ABI mismatches the built binding they FAIL OPEN — no
  // auto-recall, no orientation, no error anywhere — and the model falls
  // back to grepping files for memory questions (the Linux friend-install
  // find, 2026-08-09). Probe with the exact resolution a hook gets: bare
  // `node` + this tree's node_modules.
  try {
    var _hp = require("child_process").spawnSync("node",
      ["-e", "require('better-sqlite3'); console.log('ok')"],
      { cwd: require("path").join(__dirname, ".."), encoding: "utf8", timeout: 15000 });
    var _hooksOk = _hp.status === 0 && /ok/.test(String(_hp.stdout || ""));
    checks.push({ name: "Memory hooks runtime", ok: _hooksOk, detail: _hooksOk
      ? "better-sqlite3 loads under `node` on PATH — recall hooks live"
      : "better-sqlite3 does NOT load under `node` on PATH — the Claude Code recall hooks fail open (no memory injection). Fix: `npm rebuild better-sqlite3` here, or put a Node >= 22 first on PATH." });
  } catch (_e) {
    checks.push({ name: "Memory hooks runtime", ok: false, detail: "could not probe `node` on PATH — recall hooks likely fail open in Claude Code" });
  }

  // Claude Code (OPTIONAL — only needed for the classic proxy mode;
  // the substrate-native default does not require it).
  var claudeOk = findClaude();
  checks.push({ name: "Claude Code CLI (optional)", ok: claudeOk, detail: claudeOk ? "installed" : "not installed — only needed for `default_command classic` proxy mode" });

  // Config file
  var cfgExists = fs.existsSync(CONFIG_FILE);
  checks.push({ name: "Config file", ok: cfgExists, detail: cfgExists ? CONFIG_FILE : CONFIG_FILE + " — run: troth setup" });

  // Background daemons a user can be left holding. These are spawned detached
  // (they must survive a proxy restart) and have no exit path of their own, so
  // a stranded one burns RAM and a GPU context invisibly. The proxy reaps them
  // when idle, but a CLI-only user may have no proxy running, and NOBODY can
  // diagnose what they cannot see. Doctor names them
  // and tells you the one command that clears them.
  try {
    var _cpD = require("child_process");
    var daemons = [
      { name: "Embedding server",  needle: "llama-server.*--port " + (process.env.TROTH_EMBED_PORT  || "11437") },
      { name: "Reranking server",  needle: "llama-server.*--port " + (process.env.TROTH_RERANK_PORT || "11438") },
      { name: "Local chat server", needle: "llama-server.*--port " + (process.env.TROTH_LOCAL_PORT  || "11436") },
      { name: "Headless browser",  needle: "remote-debugging-port=" + (process.env.TROTH_BROWSER_CDP_PORT || "18222") }
    ];
    var running = [];
    for (var di = 0; di < daemons.length; di++) {
      var out = "";
      try {
        // execFile, not execSync: a shelled-out `pgrep -f "<pattern>"` makes
        // the `sh -c` wrapper's own command line CONTAIN the pattern, and
        // Linux procps happily matches that wrapper — so doctor reported four
        // background servers on a machine running none, with tell-tale pids
        // two apart (the shell, then pgrep itself). BSD pgrep on macOS does
        // not match the wrapper, which is why this only ever lied on Linux.
        // No shell, no wrapper, nothing else carries the pattern.
        out = _cpD.execFileSync("pgrep", ["-f", daemons[di].needle],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch (_) { out = ""; }   // exit 1 = no match, which is not an error
      if (out) running.push(daemons[di].name + " (pid " + out.split("\n")[0] + ")");
    }
    checks.push({
      name: "Background model servers",
      ok: true,
      detail: running.length
        ? running.join(", ") + " — idle ones stop by themselves; force now: troth clean --daemons"
        : "none running"
    });
  } catch (_) {}

  // Recall mode. The product's headline claim is memory, and memory degrades
  // to plain word matching whenever the embedding model is absent — by
  // design, quietly, "degraded, never broken". Nothing told the operator
  // which of the two they were living in, so a partner that had stopped
  // understanding meaning looked exactly like one that had not.
  //
  // The check is the FILE on disk, not the module's `available`, which only
  // reports whether THIS process has loaded it. Doctor is a fresh process and
  // loads nothing, so asking the module would tell every healthy install that
  // it has no model.
  try {
    var _mdlDir = process.env.TROTH_EMBED_DIR ||
      path.join(process.env.HOME || require("os").homedir(), ".troth", "models");
    var _files = [];
    try { _files = fs.readdirSync(_mdlDir); } catch (_) { _files = []; }
    var _hasEmbed  = _files.some(function (f) { return /embeddinggemma/i.test(f) && /\.gguf$/i.test(f); });
    var _hasRerank = _files.some(function (f) { return /reranker/i.test(f) && /\.gguf$/i.test(f); });

    // A model file on disk is not a working embedder. Two runtimes can serve
    // it — the spawned llama-server binary, or the in-process node-llama-cpp
    // optional dependency — and with NEITHER present the file is inert while
    // this check used to answer "semantic". That is the lie that matters:
    // `npm install --omit=optional`, a failed native build, or any platform
    // the binary does not auto-install on all produce it.
    var _binPath = process.env.TROTH_LLAMA_SERVER_BIN ||
      path.join(process.env.HOME || require("os").homedir(), ".troth", "bin", "llama-server");
    var _hasBin = false;
    try { _hasBin = fs.existsSync(_binPath); } catch (_) {}
    var _hasInProc = false;
    try { require.resolve("node-llama-cpp"); _hasInProc = true; } catch (_) {}
    var _canServe = _hasBin || _hasInProc;

    // The binary only AUTO-installs on Apple Silicon. Everywhere else it is
    // one env var away, not impossible — saying "not supported" would be as
    // false as promising a download that never starts. Kept in step with
    // shared-core/local-server.js's asset picker: it fetches for darwin and
    // linux on arm64/x64, and this line claimed Apple Silicon only, so on
    // Linux doctor told people to build llama.cpp while troth was already
    // downloading it for them.
    var _binAutoInstalls =
      (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) ||
      (process.platform === "linux"  && (process.arch === "arm64" || process.arch === "x64"));
    var _rerankNote = _hasBin
      ? ""
      : _binAutoInstalls
        ? " — the reranker (~610 MB) is not downloaded yet"
        : " — reranking needs the llama-server binary, which is not auto-installed on " +
          process.platform + "/" + process.arch + "; point TROTH_LLAMA_SERVER_BIN at your own llama.cpp build to enable it";

    var _detail, _ok;
    if (!_canServe) {
      _detail = "WORD MATCHING ONLY — nothing can run the embedding model here: " +
        "no llama-server binary at " + _binPath + " and node-llama-cpp is not installed " +
        "(it is an optional dependency; `npm install` restores it). " +
        (_hasEmbed ? "The model file is on disk but inert." : "");
      _ok = false;
    } else if (_hasEmbed && _hasRerank && _hasBin) {
      _detail = "semantic — embedding and reranking models present in " + _mdlDir;
      _ok = true;
    } else if (_hasEmbed) {
      _detail = "semantic" + (_hasBin ? " (llama-server)" : " (in-process; first call warms up, ~30s)") +
        ", without reranking" + _rerankNote;
      _ok = true;
    } else {
      _detail = "WORD MATCHING ONLY — no embedding model in " + _mdlDir + ". " +
        "It downloads (~333 MB) the first time your partner stores or recalls " +
        "something. Set TROTH_NO_MODEL_FETCH=1 to keep it this way." + _rerankNote;
      _ok = false;
    }
    checks.push({ name: "Recall", ok: _ok, detail: _detail });
  } catch (_) { /* never let a diagnostic break the diagnostic */ }

  // better-sqlite3 (required for CodeLens)
  try {
    require("better-sqlite3");
    checks.push({ name: "CodeLens (better-sqlite3)", ok: true, detail: "loaded" });
  } catch (e) {
    checks.push({ name: "CodeLens (better-sqlite3)", ok: false, detail: "not installed — run: npm install" });
  }

  // Proxy reachable. It moves up a port when the configured one is taken, so
  // asking only about that one called a healthy install dead and sent the
  // user to `troth start`, which would not have helped.
  var livePort = findLiveProxyPort(cfg.host, cfg.port);
  checks.push({
    name: "Proxy reachable",
    ok: !!livePort,
    detail: livePort
      ? cfg.host + ":" + livePort +
        (livePort !== cfg.port ? " (not the configured " + cfg.port + "; that one was taken at startup)" : "")
      : cfg.host + ":" + cfg.port + " — run: troth start"
  });

  // Where the dashboard is. Nothing said this after the very first run, so a
  // user who changed the port, or whose proxy had to move, was left with no
  // way to find the one page that configures everything.
  checks.push({
    name: "Dashboard",
    ok: !!livePort,
    detail: livePort
      ? "http://" + cfg.host + ":" + livePort + "/ui   (or run: troth ui)"
      : "not serving yet — start the proxy, then: troth ui"
  });

  // Local backend reachable. Only a FAILURE for someone who asked for a local
  // engine: a cloud-only operator was shown a red "start Ollama / LM Studio /
  // llama.cpp" for a tier they deliberately never configured, which reads as
  // a broken install on an install that is fine.
  var _localCfg = (cfg.providers && cfg.providers.local) || {};
  var _localWanted = !!_localCfg.enabled;
  // Probe the address the OPERATOR configured. This read the top-level
  // backendHost/backendPort, which still carry the 127.0.0.1:1234 default
  // even when the wizard was pointed somewhere else — so doctor printed a red
  // "not answering" for port 1234 while the lane on the chosen port was live
  // and serving. Reporting a port nobody configured is the same class of
  // claim this check was rewritten to end.
  var _lhost = _localCfg.host || cfg.backendHost;
  var _lport = _localCfg.port || cfg.backendPort;
  var backendOk = (_lhost && _lport) ? checkHealthSync(_lhost, _lport) : false;
  checks.push({
    name: "Local backend",
    ok: backendOk || !_localWanted,
    detail: backendOk
      ? _lhost + ":" + _lport + " (" + (_localCfg.model || cfg.model || "model not set") + ")"
      : _localWanted
        ? _lhost + ":" + _lport + " — enabled but not answering; start Ollama / LM Studio / llama.cpp"
        : "not configured (cloud engines only) — nothing to start",
  });

  // Scaffolding memory stores
  var reflPath = path.join(HOME, ".troth", "reflexion.db");
  checks.push({
    name: "Reflexion (lessons)",
    ok: true,
    detail: fs.existsSync(reflPath) ? "DB exists — has past failure lessons" : "no lessons yet (created on first failure)",
  });
  var trajPath = path.join(HOME, ".troth", "trajectories.db");
  checks.push({
    name: "Trajectory (success patterns)",
    ok: true,
    detail: fs.existsSync(trajPath) ? "DB exists — has successful task patterns" : "no patterns yet (created on first success)",
  });
  var wfPath = path.join(process.cwd(), ".troth", "workflow.json");
  checks.push({
    name: "Workflow state",
    ok: true,
    detail: fs.existsSync(wfPath) ? "active task in this directory" : "no active task (clean slate)",
  });

  // Providers. "Enabled" is not "can answer": a lane toggled on with no key
  // is a rung the chain will never fire, and listing it read as "engines you
  // have" when it was "engines you once toggled". Same lane-aware rules the
  // router itself uses to build the chain — kimi_sub takes its key from the
  // TROTH_KIMI_SUB_KEY env, openai_sub from the saved OAuth token, and
  // custom_openai needs a base_url rather than a key.
  // Load ~/.troth/.env first: the wizard writes TROTH_KIMI_SUB_KEY there and
  // only the proxy reads that file at startup, so doctor — which the wizard
  // spawns as its closing proof — declared the Kimi lane credential-less
  // moments after configuring it, while the proxy served it happily.
  try { require("../shared-core/env-file.js").load(); } catch (_) {}
  var provs = cfg.providers || {};
  // The router's own env map. Keys migrate OUT of config.json into
  // ~/.troth/.env when saved from the dashboard, so checking p.apiKey alone
  // called every properly-saved lane credential-less — doctor printed "none
  // can answer" in red while the proxy was serving on that exact lane.
  var _DOCTOR_ENV_KEYS = {
    anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY", deepinfra: "DEEPINFRA_API_KEY",
    nvidia: "NVIDIA_API_KEY", alibaba: "ALIBABA_API_KEY",
    zai: "ZAI_API_KEY", moonshot: "MOONSHOT_API_KEY",
    xai: "XAI_API_KEY", custom_openai: "CUSTOM_OPENAI_API_KEY",
    kimi_sub: "TROTH_KIMI_SUB_KEY"
  };
  function _laneReady(k, p) {
    if (!p || !p.enabled) return false;
    if (k === "local") return true;                       // reachability is its own check
    if (k === "openai_sub") {
      try { return !!require("../shared-core/codex-token-store.js").load(); } catch (_) { return false; }
    }
    if (k === "custom_openai") return !!(p.base_url);
    var envName = _DOCTOR_ENV_KEYS[k];
    return !!(p.apiKey || (envName && process.env[envName]));
  }
  var _readyProvs = [], _halfProvs = [];
  Object.keys(provs).forEach(function (k) {
    if (!provs[k] || !provs[k].enabled) return;
    if (_laneReady(k, provs[k])) _readyProvs.push(k); else _halfProvs.push(k);
  });
  checks.push({
    name: "Providers",
    ok: _readyProvs.length > 0,
    detail: _readyProvs.length
      ? _readyProvs.join(", ") +
        (_halfProvs.length ? "  ·  enabled but no credential (will never answer): " + _halfProvs.join(", ") : "")
      : _halfProvs.length
        ? "none can answer — " + _halfProvs.join(", ") + " enabled without a credential. Run: troth setup"
        : "none configured — run: troth setup"
  });

  // Operator key / vault. The machinery is here — signed operator-tier memory,
  // an encrypted credential store — and nothing in the product ever mentions
  // it, so no open-repo user has ever known it exists. Deliberately NOT a
  // setup step: it protects the signing key and the vault, NOT the API keys
  // (those live in config.json 0600 and ~/.troth/.env), the bootstrap seal is
  // irrevocable, there is no keychain here to remember the passphrase, and
  // recovery needs a pubkey declared at init time. So: name it, say what it
  // is for, and leave the choice with the operator.
  try {
    // Ask the module, not a guessed path: the key lives at
    // ~/.troth/operator-keys/active.key.enc and honours its own dir override.
    var _sealed = false;
    try { _sealed = !!require("../shared-core/operator-key.js").exists(); } catch (_) {}
    checks.push({
      name: "Operator key (optional)",
      ok: true,
      detail: _sealed
        ? "present — signed operator-tier memory and the credential vault are available"
        : "none — optional. `troth init --seal` creates a signing key for " +
          "operator-confirmed memories and an encrypted vault. It does NOT protect " +
          "your API keys, and the passphrase cannot be recovered. Chat and memory " +
          "work fully without it."
    });
  } catch (_) {}

  // Anthropic subscription
  try {
    var credsPath = path.join(HOME, ".claude", ".credentials.json");
    var hasSub = fs.existsSync(credsPath);
    checks.push({
      name: "Anthropic subscription",
      ok: true,
      detail: hasSub ? "credentials found" : "not detected — run: claude login (optional)"
    });
  } catch (e) {}

  // CodeLens persistence
  var clDir = path.join(HOME, ".troth", "codelens");
  var clDbs = [];
  try { clDbs = fs.readdirSync(clDir).filter(function(f) { return f.endsWith(".db"); }); } catch (e) {}
  checks.push({
    name: "CodeLens (brain)",
    ok: true,
    detail: clDbs.length ? clDbs.length + " project DB(s) in " + clDir : "no databases yet — starts indexing on first run"
  });

  // bindHost safety note
  var bind = cfg.bindHost || "127.0.0.1";
  var bindSafe = (bind === "127.0.0.1" || bind === "localhost");
  checks.push({
    name: "bindHost",
    ok: true, // informational only
    detail: bind + (bindSafe ? " (local only — secure default)" : " (exposed on this interface)"),
  });

  // L4 agentic layer status. Reports whether the
  // L4 primitives are loaded + seeded + actively enforcing on this
  // substrate. Reads are best-effort; any failure surfaces as informational
  // notice instead of blocking doctor exit.
  try {
    var l4state = require("../shared-core/state.js");
    var l4sm = require("../shared-core/state-machine.js");
    var l4ld = require("../shared-core/loop-detector.js");
    var schemaV = (typeof l4state.getSchemaVersion === "function") ? l4state.getSchemaVersion() : 1;
    checks.push({
      name: "Substrate schema",
      ok: schemaV >= 2,
      detail: "version=" + schemaV + (schemaV >= 2 ? " (expected schema tables present)" : " — outdated, run: troth migrate")
    });
    var invs = l4sm.listInvariants({});
    var seeds = invs.filter(function (i) { return /^seed:/.test(i.id); });
    var errs  = invs.filter(function (i) { return i.severity === "error"; });
    var warns = invs.filter(function (i) { return i.severity === "warn"; });
    checks.push({
      name: "Substrate invariants",
      ok: seeds.length >= 2,
      detail: invs.length + " total · " + errs.length + " error · " + warns.length + " warn · " + seeds.length + " seeded"
    });
    var loopDetect = (l4ld && typeof l4ld.detectInMemory === "function");
    checks.push({
      name: "Loop detector",
      ok: loopDetect,
      detail: loopDetect ? "loaded · default window=" + l4ld.DEFAULT_CONFIG.window_size + " threshold=" + l4ld.DEFAULT_CONFIG.repeat_threshold : "module not found"
    });
    // STVC bypass status — visible so operators know if the safety floor
    // is currently disabled (e.g., emergency operator override).
    var bypassed = process.env.TROTH_STVC_BYPASS === "1";
    checks.push({
      name: "Substrate enforcement",
      ok: !bypassed,
      detail: bypassed ? "BYPASSED via TROTH_STVC_BYPASS=1 (operator override)" : "active (validates every recordAction)"
    });
    // Recent rejections — show count over the last 24h so operators can
    // spot misbehaving writers without leaving the doctor command.
    try {
      var sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      var recentRejs = l4state.queryActions({
        type: "rejected_transition", since: sinceMs, limit: 200
      }) || [];
      checks.push({
        name: "Recent rejections (24h)",
        ok: true,
        detail: recentRejs.length + " transition" + (recentRejs.length === 1 ? "" : "s") + " rejected by STVC"
      });
    } catch (_) { /* skip if table missing */ }
    // autonomous-mode config (C.0). Operator sees enable state + active
    // surfaces + which goal classes have per-class overrides at a glance.
    try {
      var l4Cfg = (function(){try{return require('../shared-core/l4-config.js')}catch(e){return {isEnabled:()=>false,DEFAULTS:{}}}}());
      var l4 = l4Cfg.getL4Config();
      var ver = l4Cfg.verifyCanEnable();
      checks.push({
        name: "autonomous mode",
        ok: l4.enabled || !ver.ok, // ok=true when disabled (default) OR enabled with providers ready
        detail: l4.enabled
          ? "ENABLED · transparency=" + l4.transparency_level + " · idle_pursuit=" + l4.idle_pursuit + " · " + ver.usable_providers + " provider(s)"
          : "disabled (run: troth config l4 enable)"
      });
      if (l4.enabled) {
        var activeSurfaces = l4Cfg.getActiveSurfaces();
        checks.push({
          name: "L4 surfaces",
          ok: activeSurfaces.length > 0,
          detail: activeSurfaces.length ? activeSurfaces.join(", ") : "none — no briefings will surface!"
        });
        var overrideClasses = Object.keys(l4.per_class_overrides || {});
        if (overrideClasses.length) {
          checks.push({
            name: "L4 per-class overrides",
            ok: true,
            detail: overrideClasses.length + " class(es): " + overrideClasses.join(", ")
          });
        }
      }
    } catch (_) { /* skip if module fails */ }

    // SLICE-B.5 — Goal-class status. Reports seeded classes + empirical
    // track record (top 5 by attempts). Operator sees what troth is
    // "becoming good at" without leaving the doctor command.
    try {
      var registry   = require("../shared-core/goal-class-registry.js");
      var calibrator = require("../shared-core/confidence-calibrator.js");
      var classes = registry.listClasses();
      checks.push({
        name: "Goal classes seeded",
        ok: classes.length >= 3,
        detail: classes.length + " class" + (classes.length === 1 ? "" : "es") + ": " + classes.join(", ")
      });
      var topStats = calibrator.listAll({ minAttempts: 1 }).slice(0, 5);
      if (topStats.length) {
        var lines = topStats.map(function (s) {
          var pct = (s.confidence * 100).toFixed(0) + "%";
          var age = s.days_since_last_run != null
            ? " (last run " + s.days_since_last_run.toFixed(1) + "d ago)"
            : "";
          return s.goal_class + " " + s.attempt_count + "× · " + pct + age;
        });
        checks.push({
          name: "Goal-class stats (top 5)",
          ok: true,
          detail: lines.join("; ")
        });
      } else {
        checks.push({
          name: "Goal-class stats",
          ok: true,
          detail: "no goals attempted yet — try /goal \"<your goal>\" in troth cli"
        });
      }
    } catch (_) { /* skip if module fails to load */ }
  } catch (e) {
    checks.push({
      name: "Autonomous layer",
      ok: true,
      detail: "not enabled (available in the paid app)"
    });
  }

  for (var c = 0; c < checks.length; c++) {
    var icon = checks[c].ok ? "\x1b[32m+\x1b[0m" : "\x1b[31m-\x1b[0m";
    console.log("  " + icon + " " + checks[c].name + ": " + checks[c].detail);
  }
  console.log("");
  // Doctor is informational — only exit non-zero if Node/Claude/sqlite are broken.
  var critical = checks.filter(function(c) {
    return ["Node.js >= 22", "Claude Code CLI", "CodeLens (better-sqlite3)"].indexOf(c.name) >= 0;
  });
  process.exit(critical.every(function(c) { return c.ok; }) ? 0 : 1);
}

if (command === "accounts") {
  // Google OAuth against a consumer account is not a supported path here:
  // their terms do not permit a third-party client to use it, so troth asks
  // for an API key you issue yourself instead.
  // Show provider config instead.
  var cfg = loadConfig();
  console.log("\n  troth Providers\n");
  var provs = cfg.providers || {};
  var keys = Object.keys(provs);
  if (!keys.length) {
    console.log("  No providers configured. Run: troth ui → Providers tab");
  } else {
    for (var pk = 0; pk < keys.length; pk++) {
      var p = provs[keys[pk]];
      var icon = (p.enabled && (p.apiKey || keys[pk] === 'local')) ? "\x1b[32m+\x1b[0m" : "\x1b[2m-\x1b[0m";
      var detail = p.enabled ? "enabled" : "disabled";
      if (p.model) detail += " · " + p.model;
      if (p.apiKey) detail += " · key set";
      console.log("  " + icon + " " + keys[pk] + ": " + detail);
    }
  }
  console.log("");
  console.log("  Note: Google is BYOK only \u2014 an API key you issue at aistudio.google.com.");
  console.log("  Use Alibaba Coding Plan, DeepInfra, OpenRouter, or BYOK Anthropic API key.");
  console.log("");
  process.exit(0);
}

// `troth init` — substrate-as-mind onboarding wizard. Distinct from
// `troth setup` (which configures provider API keys for the proxy).
// `init` focuses on getting the substrate running:
//   1. Detect Claude Code install (~/.claude exists)
//   2. Ensure ~/.troth dir + L1 SQLite initialized
//   3. Ensure ~/.troth/.env exists with placeholders for API keys
//   4. Wire the substrate MCP plugin to Claude Code
//   5. Detect local LLM backends (llama-server / Ollama) for embeddings
//   6. Optionally: backfill existing Claude Code sessions into substrate
//   7. Optionally: start the live session watcher
//   8. Print next steps
require('./cmd-init-2.js')(__cliCtx);

if (command === "setup") {
  // Setup lives in the dashboard, because that is the only surface that can
  // finish the job. The terminal wizard could set one provider and a port; the
  // embedder, the reranker, and the engine preference — the setting that
  // decides what every turn costs — were never mentioned, so someone who ran
  // `troth setup` to completion still had a half-configured product and no way
  // to learn it. The terminal path stays for machines with no browser, and for
  // anyone who would rather type.
  var wantTerminal = passthrough.indexOf("--terminal") !== -1 ||
                     passthrough.indexOf("--cli") !== -1;
  if (!wantTerminal) {
    var scfg = loadConfig();
    var sport = ensureProxy(scfg);
    var surl = "http://" + scfg.host + ":" + sport + "/ui?onboarding=1";
    var sOpen = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? 'start ""' : "xdg-open";
    require("child_process").exec(sOpen + ' "' + surl + '"', function () {});
    console.log("\n  Setup is here: " + surl);
    console.log("  It asks for an engine, turns on memory, and shows where your turns go.");
    console.log("\n  No browser on this machine?   troth setup --terminal\n");
    return;
  }

  (async function() {
    console.log("\n  troth Setup v" + VERSION + "\n");

    // Claude Code is OPTIONAL — doctor calls it optional, the engine list has
    // eight other ways in, and the plugin/subscription steps below offer it
    // properly. This used to call ensureClaudeInstalled(), which exits 1 when
    // it is absent and stdin is not a TTY, and exits 1 again if a TTY user
    // declines the install: `troth setup` was unusable on any machine without
    // Claude Code, before asking a single question. Detect it, say so, move on.
    var _claudeSubSeen = false;
    if (findClaude()) {
      console.log("  \x1b[32m+\x1b[0m Claude Code CLI detected");
      // A live claude.ai login means the subscription route is real for this
      // operator, so the menu can say so instead of describing a possibility.
      try {
        if (process.platform === "darwin") {
          execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" });
          _claudeSubSeen = true;
        } else {
          _claudeSubSeen = fs.existsSync(path.join(HOME, ".claude", ".credentials.json"));
        }
      } catch (_) { _claudeSubSeen = false; }
    } else {
      console.log("  · Claude Code CLI not installed — optional; every other engine works without it.");
    }

    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // readline has no SIGINT listener by default, so Ctrl-C CLOSES the
    // interface instead of ending the process. The wizard then kept running
    // on a dead interface and the next question threw ERR_USE_AFTER_CLOSE —
    // as a raw stack, and after a ChatGPT sign-in had already written a token
    // to disk but before the provider was enabled.
    rl.on("SIGINT", function () {
      console.error("\n  Cancelled — nothing was configured.\n");
      process.exit(130);
    });

    function ask(q) {
      return new Promise(function (resolve) {
        var settled = false;
        function onClose() {
          if (settled) return;
          settled = true;
          // On EOF readline resolves nothing: it emits 'close', the pending
          // question is dropped, the event loop drains and the process leaves
          // with status 0 in the middle of the wizard. `troth setup </dev/null`
          // in a script therefore read as success while configuring nothing —
          // the same lie this rewrite removed from the interactive path,
          // wearing a green exit code.
          console.error("\n  Input ended before setup finished — nothing was configured.");
          console.error("  Run `troth setup` in a terminal, or set troth up in the dashboard.\n");
          process.exit(1);
        }
        rl.once("close", onClose);
        rl.question(q, function (answer) {
          if (settled) return;
          settled = true;
          rl.removeListener("close", onClose);
          resolve(answer);
        });
      });
    }

    // Secret-safe prompt: same contract as ask(), but the typed characters
    // never reach the terminal. A pasted API key used to sit in scrollback,
    // in tmux history and in any screen recording of the setup — and every
    // key this wizard takes is a live credential. Falls back to the plain
    // prompt when stdin is not a TTY (piped drivers, CI) because raw mode is
    // not available there and a hidden prompt would simply hang.
    function askSecret(q) {
      if (!process.stdin.isTTY) return ask(q);
      return new Promise(function (resolve) {
        var muted = false;
        var settled = false;
        var origWrite = rl.output.write.bind(rl.output);
        function restore() { rl.output.write = origWrite; muted = false; }
        rl.output.write = function (chunk) {
          if (!muted) return origWrite(chunk);
          // readline redraws the WHOLE line on backspace, Ctrl-U, Ctrl-W and
          // terminal resize: one chunk carrying prompt + everything typed so
          // far. Passing that chunk through because it contains the prompt
          // printed the key being corrected straight into scrollback — the
          // one thing this function exists to prevent.
          //
          // Nothing is echoed at all while muted, redraws included: the
          // visible line never changed (no keystroke was ever shown), so a
          // redraw has nothing to restore. Emitting just the prompt instead
          // appended another copy of it on every correction, because readline
          // sends the cursor-home and clear-line escapes as separate writes
          // that this mute swallows.
          return true;
        };
        // EOF at a secret prompt: readline drops the pending question, so
        // without this the promise never settles, the loop drains and setup
        // leaves with status 0 having configured nothing — with stdout still
        // hijacked. ask() already handles this; the secret path must too.
        function onClose() {
          if (settled) return;
          settled = true;
          restore();
          console.error("\n  Input ended before setup finished — nothing was configured.");
          console.error("  Run `troth setup` in a terminal, or set troth up in the dashboard.\n");
          process.exit(1);
        }
        rl.once("close", onClose);
        rl.question(q, function (answer) {
          if (settled) return;
          settled = true;
          rl.removeListener("close", onClose);
          restore();
          origWrite('\n');
          resolve(answer);
        });
        muted = true;
      });
    }

    console.log("\n  Choose your primary LLM backend:\n");
    // Original order kept. Two changes only: the hardcoded prices are gone
    // (they had already drifted, and they are the vendor's to state, not ours
    // to cache in a CLI), and Kimi is added, because the README's first
    // paragraph calls it a first-class backbone and the guided path did not
    // offer it at all.
    console.log("  Link a subscription you already pay for:");
    console.log("    1) ChatGPT (Plus/Pro) — signs in with your own account, no API bill");
    console.log("    2) Kimi Code membership — flat-rate k3 (1M context), paste the key");
    console.log("    3) Claude Pro/Max — mounts troth inside Claude Code; your plan answers there" +
                (_claudeSubSeen ? "  [detected on this machine]" : ""));
    console.log("");
    console.log("  Pay a provider per token:");
    console.log("    4) Claude — Anthropic API key, console.anthropic.com");
    console.log("    5) Alibaba Coding Plan — Qwen3-Max, MiniMax M2.5, GLM");
    console.log("    6) DeepInfra — open-weight models, per token");
    console.log("    7) OpenRouter — one key, many models");
    console.log("    8) Kimi (Moonshot) — per-token API, platform.moonshot.ai");
    console.log("");
    console.log("  On your own hardware:");
    console.log("    Memory (embeddings, reranking) runs locally on its own — nothing to pick.");
    console.log("    Local chat models exist for advanced setups: dashboard → Engines → Local.");
    console.log("");
    console.log("  Each provider prices its own tokens; check their page before you commit.");
    console.log("  You can enable more than one later in the dashboard, and troth will fail");
    console.log("  over between them.");
    console.log("");

    var cfg = Object.assign({}, DEFAULTS);
    if (!cfg.providers) cfg.providers = {};

    // Ask until an engine is actually configured. The old code took exactly one
    // answer and moved on, so a bare Return (which selected Alibaba) or an empty
    // key wrote a config with no provider in it and still printed "Setup
    // complete!". What that user met next was the router reporting no engine,
    // with nothing on screen connecting the two.
    var configured = false;
    var _claudeLinked = false;
    while (!configured) {
      var choice = (await ask("  Choice [1-8]: ")).trim();

      if (choice === "1") {
        // The one path that needs no key at all: OAuth against the user's own
        // ChatGPT account. Same flow as `troth codex login`, offered here
        // because this is where a new user actually is.
        console.log("\n  This signs in to YOUR ChatGPT account and spends your own");
        console.log("  subscription quota. troth is not affiliated with OpenAI, and the");
        console.log("  interface it uses is not documented for third-party clients, so it");
        console.log("  can change without notice. See docs/SETUP_GUIDE.md.\n");
        var goCodex = (await ask("  Open the browser and sign in now? [Y/n]: ")).trim().toLowerCase();
        if (goCodex !== "n" && goCodex !== "no") {
          var codexAuth = require("../shared-core/codex-auth.js");
          if (!codexAuth.clientId()) {
            console.log("\n  The OAuth client id is blank on this install. Unset");
            console.log("  TROTH_CODEX_CLIENT_ID to use the default, or write your own to");
            console.log("  ~/.troth/codex-client-id, then run `troth codex login`.\n");
          } else {
            console.log("\n  Opening your browser. If nothing opens (a server with no");
            console.log("  desktop, or no xdg-open), the address is printed below —");
            console.log("  paste it into any browser on this machine.\n");
            try {
              await codexAuth.login();
              // Persist the enable flag the moment a token exists, the way
              // /api/providers/codex/login does. The token on its own is not
              // enough — the router skips any provider without enabled:true —
              // so a wizard abandoned after this point left someone signed in
              // and still engine-less. No model is seeded: the providers
              // default already carries the working one, and extra copies of
              // that constant are how the earlier ones drifted onto a model
              // this endpoint answers 400 for.
              cfg.providers.openai_sub = { enabled: true };
              try {
                configFileStore.updateConfig(function (current) {
                  current.providers = Object.assign({}, current.providers);
                  current.providers.openai_sub = Object.assign(
                    {}, current.providers.openai_sub || {}, { enabled: true });
                  return current;
                });
              } catch (_) { /* saveConfig at the end of the wizard still writes it */ }
              configured = true;
              console.log("\n  \x1b[32m+\x1b[0m ChatGPT subscription signed in.\n");
            } catch (e) {
              console.log("\n  Sign-in did not complete: " + (e && e.message || e));
              console.log("  Retry any time with `troth codex login`.\n");
            }
          }
        }
      } else if (choice === "2") {
        // Kimi Code MEMBERSHIP — the flat-rate lane behind k3. The router
        // reads this lane's key ONLY from TROTH_KIMI_SUB_KEY, so the wizard
        // writes it where the dashboard does: ~/.troth/.env, never config.
        console.log("\n  Kimi Code membership — flat-rate k3 (1M context) through your plan.\n");
        var kcKey = await askSecret("  Kimi Code key: ");
        if (kcKey && kcKey.trim()) {
          var kcModel = "k3";
          try { kcModel = require("../proxy/modules/catalog.js").getCatalog().kimi_sub.dflt || kcModel; } catch (_) {}
          try {
            require("../shared-core/env-file.js").writeKey("TROTH_KIMI_SUB_KEY", kcKey.trim());
            cfg.providers.kimi_sub = { enabled: true, model: kcModel };
            configured = true;
            console.log("\n  \x1b[32m+\x1b[0m Kimi Code configured (" + kcModel + "). Key saved to ~/.troth/.env.\n");
          } catch (e) {
            console.log("\n  Could not write ~/.troth/.env: " + (e && e.message || e) + "\n");
          }
        }
      } else if (choice === "5") {
        console.log("\n  Alibaba Coding Plan: get key at https://www.alibabacloud.com/en/campaign/ai-scene-coding\n");
        var aliKey = await askSecret("  Alibaba API key (sk-...): ");
        if (aliKey && aliKey.trim()) {
          cfg.providers.alibaba = { enabled: true, apiKey: aliKey.trim(), model: "qwen3-max" };
          configured = true;
          console.log("\n  \x1b[32m+\x1b[0m Alibaba configured (Qwen3-Max).\n");
        }
      } else if (choice === "3") {
        // The Claude subscription is its own numbered choice, sitting beside
        // the other two subscriptions — it used to hide behind an a/b prompt
        // under the API-key entry, which read as "there is no subscription
        // path" to anyone scanning the numbers. Linking runs troth INSIDE
        // Claude Code (plugin + MCP): the plan answers there and no proxy
        // ever touches its sign-in.
        if (!findClaude()) {
          console.log("\n  Claude Code is not installed — that is where your plan answers.");
          console.log("  Install it, then re-run this step:");
          console.log("    curl -fsSL https://claude.ai/install.sh | bash     (official installer)");
          console.log("    npm install -g @anthropic-ai/claude-code           (or via npm)\n");
        } else {
          console.log("\n  Mounting troth inside Claude Code…\n");
          try {
            // Linked only when the install actually succeeded — the child exits
            // non-zero on any failed step, and claiming success past that told
            // an operator their plan was wired while claude had just refused.
            var _ipr = require("child_process").spawnSync(process.execPath, [__filename, "install-plugin"], { stdio: "inherit" });
            if (_ipr.status !== 0) {
              console.log("\n  \x1b[31mx\x1b[0m Not linked — the plugin install failed (see above).");
              console.log("  Fix and retry with: troth install-plugin");
            } else {
            console.log("\n  \x1b[32m+\x1b[0m Linked. Open `claude` — your subscription answers there,");
            console.log("  with troth's memory and slash commands mounted.");
            // ...and troth's own REPL can now think with it too.
            addEntityFaculty(cfg, "claude_cli");
            console.log("  `troth` also answers through your plan now.");
            _claudeLinked = true;
            configured = true;
            var alsoLane = (await ask("\n  Also add an engine for troth's own REPL and dashboard? [y/N]: ")).trim().toLowerCase();
            if (alsoLane === "y" || alsoLane === "yes") { configured = false; console.log(""); continue; }
            }
          } catch (e) {
            console.log("  install-plugin failed: " + (e && e.message || e) + " — run `troth install-plugin` later.");
          }
        }
      } else if (choice === "4") {
        console.log("\n  Anthropic API key — pay-per-token, separate from a Pro/Max plan.");
        console.log("  (Have a subscription? That is choice 3.)");
        console.log("  Get one: https://console.anthropic.com/\n");
        var antKey = await askSecret("  Anthropic API key (sk-ant-...): ");
        if (antKey && antKey.trim()) {
          // Model from the ONE catalog, so the CLI and the dashboard agree
          // on what \"default Claude\" means.
          var aModel = "claude-sonnet-5";
          try { aModel = require("../proxy/modules/catalog.js").getCatalog().anthropic.dflt || aModel; } catch (_) {}
          cfg.providers.anthropic = { enabled: true, apiKey: antKey.trim(), model: aModel };
          configured = true;
          console.log("\n  \x1b[32m+\x1b[0m Anthropic API configured (" + aModel + ").\n");
        }
      } else if (choice === "6") {
        console.log("\n  DeepInfra API key from https://deepinfra.com/dash/api_keys\n");
        var diKey = await askSecret("  DeepInfra API key: ");
        if (diKey && diKey.trim()) {
          // Name the model that is actually configured. The old line offered
          // "DeepSeek V3.2" and then wrote V3-0324.
          cfg.providers.deepinfra = { enabled: true, apiKey: diKey.trim(), model: "deepseek-ai/DeepSeek-V3-0324" };
          configured = true;
          console.log("\n  \x1b[32m+\x1b[0m DeepInfra configured (DeepSeek-V3-0324).\n");
        }
      } else if (choice === "7") {
        console.log("\n  OpenRouter API key from https://openrouter.ai/keys\n");
        var orKey = await askSecret("  OpenRouter API key (sk-or-...): ");
        if (orKey && orKey.trim()) {
          cfg.providers.openrouter = { enabled: true, apiKey: orKey.trim(), model: "minimax/minimax-m2.5:free" };
          configured = true;
          console.log("\n  \x1b[32m+\x1b[0m OpenRouter configured (minimax-m2.5:free).\n");
        }
      } else if (choice === "8") {
        console.log("\n  Kimi (Moonshot) API key from https://platform.moonshot.ai/\n");
        var kimiKey = await askSecret("  Moonshot API key (sk-...): ");
        if (kimiKey && kimiKey.trim()) {
          var mkModel = "kimi-k3";
          try { mkModel = require("../proxy/modules/catalog.js").getCatalog().moonshot.dflt || mkModel; } catch (_) {}
          cfg.providers.moonshot = { enabled: true, apiKey: kimiKey.trim(), model: mkModel };
          configured = true;
          console.log("\n  \x1b[32m+\x1b[0m Kimi configured (kimi-k3).\n");
        }
      } else if (choice === "9") {
        console.log("\n  Point troth at any OpenAI-compatible local backend.");
        // Probe the ports the common servers actually sit on, so the operator
        // confirms a detection instead of guessing a number: 1234 (LM Studio /
        // llama.cpp convention here), 11434 (Ollama), 8080 (llama-server).
        var _found = [];
        for (var _fi = 0; _fi < 3; _fi++) {
          var _cand = [1234, 11434, 8080][_fi];
          var _ok = await new Promise(function (res) {
            var rq = require("http").get({ host: "127.0.0.1", port: _cand, path: "/v1/models", timeout: 600 },
              function (r) { r.resume(); res(r.statusCode < 500); });
            rq.on("error", function () { res(false); });
            rq.on("timeout", function () { try { rq.destroy(); } catch (_) {} res(false); });
          });
          if (_ok) _found.push(_cand);
        }
        if (_found.length) console.log("  Detected a server answering on port " + _found.join(" and ") + ".");
        console.log("");
        var host = await ask("  Backend host [127.0.0.1]: ");
        var port = await ask("  Backend port [" + (_found[0] || 1234) + "]: ");
        cfg.providers.local = { enabled: true, host: (host || "127.0.0.1").trim(), port: parseInt(port) || _found[0] || 1234 };
        configured = true;
        console.log("\n  \x1b[32m+\x1b[0m Local backend configured (" +
          cfg.providers.local.host + ":" + cfg.providers.local.port + ").");
        console.log("  It has to be serving before troth can answer — check with `troth doctor`.\n");
      } else {
        console.log("\n  Answer with a number from 1 to 9.\n");
        continue;
      }

      if (!configured) {
        console.log("  Nothing was configured, so troth still has no engine to think with.");
        console.log("  Pick again, or press Ctrl-C and run `troth setup` when you have a key.\n");
      }
    }
    // Leave the model unset. DEFAULTS says it plainly — no brand-locked default
    // and downstream reads `cfg.model || "any"`, so the router picks from the
    // providers that are actually enabled. Pinning a Claude model here meant
    // that choosing Kimi, or a local model, still wrote a Claude id into the
    // config of someone who had just told us otherwise.

    var proxyHost = (await ask("  Proxy host [localhost]: ")).trim();
    var proxyPort = (await ask("  Proxy port [8000]: ")).trim();
    // Digits alone in the host field are a port in the wrong box, not a host.
    if (/^\d+$/.test(proxyHost)) {
      if (!proxyPort) proxyPort = proxyHost;
      console.log("  " + proxyHost + " reads as a port, not a host — host stays localhost.");
      proxyHost = "";
    }
    // A pasted URL is a host with decoration on it.
    proxyHost = proxyHost.replace(/^https?:\/\//, "").replace(/[\/:].*$/, "");
    var _portN = parseInt(proxyPort, 10);
    if (proxyPort && !(_portN >= 1024 && _portN <= 65535)) {
      console.log("  " + proxyPort + " is not a usable port (1024-65535) — keeping 8000.");
      _portN = NaN;
    }
    cfg.host = proxyHost || "localhost";
    cfg.port = (_portN >= 1024 && _portN <= 65535) ? _portN : 8000;

    // ── Routing — the setting that decides what every turn costs. The
    // overlay asks it; a terminal-only operator deserves the same question
    // instead of inheriting a default they never saw.
    console.log("\n  Where should everyday turns go?");
    console.log("    1) Best quality first — your paid engine answers everything");
    console.log("    2) This machine first — a local model leads when present, cloud for hard reasoning");
    // "Always X" per enabled engine: the pin the dashboard offers, in the same
    // breath the routing is chosen — an operator who wants one engine and no
    // surprises should not have to discover config.routing.pin later.
    var _pinLabel = { kimi_sub: "Kimi", openai_sub: "ChatGPT", anthropic: "Claude (API key)",
                      deepseek: "DeepSeek", openrouter: "OpenRouter", deepinfra: "DeepInfra",
                      alibaba: "Alibaba", moonshot: "Kimi (per-token API)", google_ai: "Gemini",
                      xai: "Grok", zai: "GLM", local: "the local model" };
    var _pinnable = Object.keys(cfg.providers || {}).filter(function (k) {
      return cfg.providers[k] && cfg.providers[k].enabled && _pinLabel[k];
    });
    _pinnable.forEach(function (k, i) {
      console.log("    " + (3 + i) + ") Always " + _pinLabel[k] + " — every turn goes there, no silent fallback");
    });
    var pref = (await ask("  Choice [1-" + (2 + _pinnable.length) + ", Enter = 1]: ")).trim();
    var _pinIdx = parseInt(pref, 10) - 3;
    if (_pinIdx >= 0 && _pinIdx < _pinnable.length) {
      cfg.routing = Object.assign({}, cfg.routing || {}, { pin: _pinnable[_pinIdx] });
      cfg.dispatch_prefer = "hosted";
      console.log("  Every turn goes to " + _pinLabel[_pinnable[_pinIdx]] + ". Change it anytime: /engine pin auto");
    } else {
      cfg.dispatch_prefer = (pref === "2") ? "local" : "hosted";
    }

    // The wizard's config starts from DEFAULTS, which carry backendHost
    // 127.0.0.1 and backendPort 1234. Persisted for someone who picked a
    // cloud engine, those two fields make the router auto-enable a `local`
    // lane (its shortcut: host+port present and no explicit providers.local),
    // so a cloud-only install got a local engine it never chose — reported
    // ready, first in the chain under "this machine first", and answering
    // nothing on a port where nothing listens. Keep them only when the
    // operator actually configured a local backend.
    if (!(cfg.providers && cfg.providers.local && cfg.providers.local.enabled)) {
      delete cfg.backendHost;
      delete cfg.backendPort;
    }

    // The dashboard overlay keys off this: finishing here IS finishing
    // onboarding, and without the flag the browser ran the whole first-run
    // again for an operator who had just completed it in the terminal.
    cfg.onboarding_done = true;
    saveConfig(cfg);
    console.log("\n  \x1b[32m+\x1b[0m Config saved to " + CONFIG_FILE);

    // ── Claude Code integration — RUN it, not a printed homework line. The
    // wizard used to answer \"yes\" with instructions to type another
    // command; the step people skip is always the second command.
    if (_claudeLinked) {
      console.log("\n  Claude Code integration: already linked in the engine step.");
    } else {
      var wirePlugin = (await ask("\n  Mount troth inside Claude Code (slash commands, memory tools)? [Y/n]: ")).trim().toLowerCase();
      if (wirePlugin !== "n" && wirePlugin !== "no") {
        if (findClaude()) {
          console.log("");
          try {
            var _ipr2 = require("child_process").spawnSync(process.execPath, [__filename, "install-plugin"], { stdio: "inherit" });
            if (_ipr2.status !== 0) console.log("  Plugin install failed (see above) — retry later with: troth install-plugin");
            else {
              // Same reasoning as choice 3: a mounted plugin means the plan can
              // serve troth's own surfaces as well.
              addEntityFaculty(cfg, "claude_cli");
              try { saveConfig(cfg); } catch (_) {}
            }
          } catch (e) {
            console.log("  install-plugin failed: " + (e && e.message || e) + " — run `troth install-plugin` later.");
          }
        } else {
          console.log("\n  Claude Code is not installed — when it is, run: troth install-plugin");
          console.log("  Cursor, Cline and the rest: docs/MCP-HOST-INSTALL.md");
        }
      }
    }

    // ── Other MCP hosts — the same wiring, executed, not homework. The
    // shared installer (shared-core/mcp-hosts.js) is merge-only with backup
    // and atomic writes, so naming a host here cannot eat a config.
    var wireHosts = (await ask("  Wire troth's MCP into other hosts — cursor, cline, windsurf, claude_desktop, all? [name/N]: ")).trim().toLowerCase();
    if (wireHosts && wireHosts !== "n" && wireHosts !== "no") {
      console.log("");
      try {
        require("child_process").spawnSync(process.execPath, [__filename, "mcp", "install", wireHosts], { stdio: "inherit" });
      } catch (e) { console.log("  mcp install failed: " + (e && e.message || e)); }
    }

    // ── The local stack, offered one component at a time. A single "turn on
    // memory?" only ever nudged the embedder, so the reranker and the local
    // chat model were left for someone who already knew they existed — the
    // wizard quietly delivered half a product. Each part is named with its
    // size, offered separately, and where this platform cannot install it the
    // exact way forward is printed instead of nothing.
    console.log("\n  What runs on your machine (all optional, all local):");
    var _memParts = [
      { key: "embedder", q: "  Memory model — recall by meaning instead of word matching (~333 MB). Install? [Y/n]: ", dflt: true },
      { key: "reranker", q: "  Reranking model — sharpens which memories come back first (~610 MB). Install? [y/N]: ", dflt: false },
      { key: "chat",     q: "  Local chat model — answers with no account at all (several GB). Install? [y/N]: ", dflt: false }
    ];
    var memYes = false, _wantParts = [];
    for (var _mi = 0; _mi < _memParts.length; _mi++) {
      var _mp = _memParts[_mi];
      var _a = (await ask(_mp.q)).trim().toLowerCase();
      var _yes = _mp.dflt ? (_a !== "n" && _a !== "no") : (_a === "y" || _a === "yes");
      if (_yes) { _wantParts.push(_mp.key); if (_mp.key === "embedder") memYes = true; }
    }

    var dashUrl = "http://" + cfg.host + ":" + cfg.port + "/ui";
    console.log("\n  Setup complete.\n");
    console.log("  Dashboard:  " + dashUrl + "   — more providers, models, memory, routing");
    console.log("  Chat:       troth");
    console.log("  Check:      troth doctor      — says what is configured and what is not\n");

    var startNow = (await ask("  Start the proxy and open the dashboard now? [Y/n]: ")).trim().toLowerCase();
    // The interface closes here; the questions after ensureProxy use
    // askClosed, a plain-stdin fallback that keeps working after rl.close()
    // — readline cannot sit open across ensureProxy's synchronous block.
    rl.close();
    function askClosed(q) {
      return new Promise(function (resolve) {
        if (!process.stdin.isTTY) { resolve(""); return; }
        process.stdout.write(q);
        var chunks = "";
        function onData(d) {
          chunks += d.toString();
          var nl = chunks.indexOf("\n");
          if (nl !== -1) {
            process.stdin.removeListener("data", onData);
            process.stdin.pause();
            resolve(chunks.slice(0, nl));
          }
        }
        process.stdin.resume();
        process.stdin.on("data", onData);
        // EOF: resolve empty (= default No) instead of hanging a script.
        process.stdin.once("end", function () { resolve(""); });
      });
    }

    if (startNow !== "n" && startNow !== "no") {
      // ensureProxy blocks while the first run indexes, and prints the live
      // address itself — including the bumped one, when something else already
      // holds the configured port.
      var livePort = ensureProxy(cfg);
      var liveUrl = "http://" + cfg.host + ":" + livePort + "/ui";
      // One tiny HTTP helper reused for every call below — the wizard has no
      // fetch of its own and must not block the readline loop.
      function _api(method, apiPath, bodyObj) {
        try {
          var script =
            "var http=require('http');" +
            "var b=" + JSON.stringify(bodyObj ? JSON.stringify(bodyObj) : "") + ";" +
            "var r=http.request({host:'127.0.0.1',port:" + livePort + ",path:" + JSON.stringify(apiPath) +
            ",method:" + JSON.stringify(method) + ",timeout:8000,headers:b?{'content-type':'application/json','content-length':Buffer.byteLength(b)}:{}}" +
            ",function(s){var o='';s.on('data',function(c){o+=c});s.on('end',function(){process.stdout.write(o)})});" +
            "r.on('error',function(){process.stdout.write('{}')});r.on('timeout',function(){try{r.destroy()}catch(e){};process.stdout.write('{}')});" +
            "if(b)r.write(b);r.end();";
          return JSON.parse(execFileSync(process.execPath, ["-e", script],
            { encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "ignore"] }) || "{}");
        } catch (_) { return null; }
      }

      if (_wantParts.length) {
        console.log("");
        // Start every chosen part, then follow them together: they download in
        // parallel and reporting them one at a time would misrepresent both.
        for (var _wi = 0; _wi < _wantParts.length; _wi++) {
          // The reranker and the local chat model both need the llama.cpp
          // server, so ask for it first when either was chosen.
          if ((_wantParts[_wi] === "reranker" || _wantParts[_wi] === "chat") && _wantParts.indexOf("binary") === -1) {
            _wantParts.push("binary");
          }
        }
        for (var _wj = 0; _wj < _wantParts.length; _wj++) _api("POST", "/api/setup/local", { part: _wantParts[_wj] });

        var _tries = 0, _lastLine = "";
        while (_tries < 900) {   // 15 minutes, then leave them running
          _tries++;
          var _d = _api("GET", "/api/setup/local");
          if (!_d || !_d.parts) break;
          var _emb = _api("GET", "/api/embed/status") || {};
          var _bits = [], _allDone = true;
          for (var _pk = 0; _pk < _wantParts.length; _pk++) {
            var _k = _wantParts[_pk], _p = _d.parts[_k];
            if (!_p) continue;
            if (_k === "embedder") {
              if (_emb.verified) { _bits.push("memory ✓"); }
              else if (_p.present) { _bits.push("memory warming up"); _allDone = false; }
              // `blocked` before `downloading`: a part that cannot install
              // here may still carry a stale download flag, and spinning on
              // "0%" for fifteen minutes before admitting it is the worst of
              // both.
              else if (_p.blocked) { _bits.push("memory blocked"); }
              else if (_p.downloading) { _bits.push("memory " + Math.round((_p.progress || 0) * 100) + "%"); _allDone = false; }
              else { _bits.push("memory starting"); _allDone = false; }
            } else if (_p.serving || _p.present) { _bits.push(_k + " ✓"); }
            else if (_p.blocked) { _bits.push(_k + " unavailable here"); }
            else if (_p.downloading) { _bits.push(_k + " " + Math.round((_p.progress || 0) * 100) + "%"); _allDone = false; }
            else { _allDone = false; }
          }
          var _line = "  " + _bits.join("  ·  ");
          if (_line !== _lastLine) { process.stdout.write("\r" + _line + "          "); _lastLine = _line; }
          if (_allDone) break;
          sleepMs(1000);
        }
        console.log("");
        // Name anything this platform cannot install, with the way forward —
        // silence here is what sent people hunting through docs.
        var _final = _api("GET", "/api/setup/local");
        if (_final && _final.parts) {
          for (var _fk = 0; _fk < _wantParts.length; _fk++) {
            var _fp = _final.parts[_wantParts[_fk]];
            if (_fp && _fp.blocked && !_fp.present) console.log("  · " + _fp.label + ": " + _fp.blocked);
          }
        }
      }
      // `start` is a cmd.exe builtin rather than an executable, so spawning it
      // without a shell is a guaranteed ENOENT on Windows — swallowed by the
      // error handler, leaving the dashboard categorically unopenable there
      // rather than merely unopened. shared-core/codex-auth.js already opens
      // browsers the way that works on all three platforms; same shape here.
      var openCmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? 'start ""' : "xdg-open";
      // Best-effort: a headless Linux box has no xdg-open and nothing will
      // appear. Survivable, because ensureProxy has already printed the address
      // and it is repeated below.
      require("child_process").exec(
        openCmd + ' "' + liveUrl.replace(/"/g, '\\"') + '"', function () {});
      console.log("\n  Dashboard: " + liveUrl);
    } else if (memYes) {
      console.log("\n  Start it any time with `troth start` — memory begins downloading on the first dashboard open.");
    }

    // ── Import existing chats — memory should not start empty when months of
    // history sit on the same disk. Additive archive import into the
    // substrate corpus; never deletes anything. Only sources that actually
    // EXIST here are offered: the question used to name Claude Code and
    // Codex together and then import claude-cli regardless, so a machine
    // with no Codex was asked about one, and a machine with only Codex was
    // offered an import that could find nothing.
    var _sources = [];
    try {
      var _det = require("child_process").execFileSync(process.execPath,
        [path.join(__dirname, "troth-import-chats.js"), "--detect"],
        { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
      _sources = (JSON.parse(_det.trim() || "{}").detected || []).filter(function (s) { return s.sessions > 0; });
    } catch (_) { _sources = []; }
    for (var _si = 0; _si < _sources.length; _si++) {
      var _s = _sources[_si];
      var _ans = (await askClosed("\n  Import your " + _s.label + " history into memory? " +
        "(" + _s.fresh + " new of " + _s.sessions + " sessions) [y/N]: ")).trim().toLowerCase();
      if (_ans !== "y" && _ans !== "yes") continue;
      console.log("");
      try {
        // The importer speaks JSON lines; rendered here as one live counter
        // instead of raw JSON scrolling past the operator.
        var _impR = require("child_process").spawnSync(process.execPath,
          [path.join(__dirname, "troth-import-chats.js"), "--source", _s.source],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        var _impLines = String(_impR.stdout || "").split("\n");
        var _impRes = null, _impLast = null;
        for (var _il = 0; _il < _impLines.length; _il++) {
          var _lt = _impLines[_il].trim();
          if (!_lt || _lt[0] !== "{") continue;
          try {
            var _lj = JSON.parse(_lt);
            if (_lj.progress) { _impLast = _lj.progress;
              process.stdout.write("\r  importing… " + _impLast.done + "/" + _impLast.total +
                " conversations · " + (_impLast.chunks || 0) + " chunks   ");
            }
            if (_lj.result) _impRes = _lj.result;
          } catch (_) {}
        }
        if (_impRes) {
          console.log("\r  \x1b[32m+\x1b[0m " + _impRes.sessions + " conversations, " +
            (_impRes.chunks || 0) + " chunks, " + (_impRes.turns || 0) + " turns became memory.");
        } else if (_impR.status !== 0) {
          console.log("\r  import failed (see ~/.troth/import-chats.log) — rerun later: node bin/troth-import-chats.js --source " + _s.source);
        }
      } catch (e) {
        console.log("  import failed: " + (e && e.message || e) +
          " — rerun later: node bin/troth-import-chats.js --source " + _s.source);
      }
    }

    // ── Close with proof, not hope: the doctor names what is configured,
    // what answers, and what is missing — on the machine we just set up.
    if (startNow !== "n" && startNow !== "no") {
      console.log("\n  Final check:\n");
      try {
        require("child_process").spawnSync(process.execPath, [__filename, "doctor"], { stdio: "inherit" });
      } catch (_) {}
    }
    console.log("\n  Then: troth\n");
  })();
  return;
}

// ===== DEFAULT: Launch Claude Code with proxy =====

// 22, matching package.json engines and the README badge. Node 20 reached end
// of life in April 2026, and the browser-perception path needs the WebSocket
// that became built-in at 22.
if (parseInt(process.versions.node.split(".")[0]) < 22) {
  console.error("troth requires Node.js >= 22. Current: v" + process.versions.node);
  process.exit(1);
}

// Wrap the launch path in an async IIFE so we can `await ensureClaudeInstalled()`
// for the "first-run / not installed" prompt. Everything below, up to the final
// `})();` at the bottom of the file, runs inside this async scope.
(async function() {

// `troth cli` (or its `chat` alias) started its own REPL above. The
// default launcher path (which spawns `claude` for terminal pair-
// programming) must NOT also fire, or we'd run two foreground programs
// at once on the same TTY.
if (command === "cli" || command === "chat" || command === "body") return;

// Every command handler above ends in process.exit(). Reaching this line with a
// command still set means no handler claimed it: the word is in SUBCOMMANDS but
// its module is not in this build (several ship only with the app), or it is a
// stale entry. Falling through from here ran first-run onboarding and then the
// launcher, so on a public clone `troth graduate` quietly wrote a config file
// and opened a browser, and `troth config get` sat in the REPL until killed.
// Answering "there is no such command here" is the only honest thing to do with
// a word we did not implement.
//
// LAUNCHER_MODES are the exception, and the reason this list exists rather than
// a bare `if (command)`. `troth classic` is not a command with a handler; it is
// a request to run the launcher below in proxy mode for one invocation, so
// reaching this line IS its success path. The first version of this guard did
// not know that and turned `troth classic` into exit 127.
const LAUNCHER_MODES = new Set(['classic']);
if (command && !LAUNCHER_MODES.has(command)) {
  console.error("troth: no handler for `" + command + "` in this build.");
  console.error("Some commands ship only with the app. `troth help` lists what this build has.");
  process.exit(127);
}

// ───────────────────────────────────────────────────────────────────────


// First-run detection: if ~/.troth/config.json doesn't exist yet, the user
// just ran `troth` straight after `npm install -g troth`. We bootstrap a
// minimal config, start the proxy, and open the dashboard so they can add a
// provider API key (BYOK) or adjust the local backend (for local models).
// Re-running `troth` after that falls through to the normal launch below.
if (!fs.existsSync(CONFIG_FILE)) {
  var defaultCfg = Object.assign({}, DEFAULTS);
  saveConfig(defaultCfg);
  console.log("\n  \x1b[32m+\x1b[0m Welcome to troth v" + VERSION);
  console.log("  Wrote default config: " + CONFIG_FILE);
  console.log("\n  Nothing can answer yet: no engine is configured.");

  // `troth setup` has existed all along and this message never named it,
  // so the guided path was invisible and every new operator was sent to a
  // dashboard full of switches instead. Offer it here, where they are, and
  // only when someone is actually at a terminal to answer: piped or CI runs
  // get the instructions and no prompt, and no browser either, because
  // opening one from a script is never what the script wanted.
  var firstRunInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (firstRunInteractive) {
    var runSetup = await promptYesNoSync("  Set one up now? [Y/n] ", true);
    if (runSetup) {
      // The same wizard `troth setup` runs, spawned rather than copied, so
      // there is one implementation of it and it cannot drift from this path.
      var setupRun = require("child_process").spawnSync(
        process.execPath, [__filename, "setup"], { stdio: "inherit" });
      if (setupRun.status === 0) {
        console.log("\n  Now run:  troth\n");
        process.exit(0);
      }
      console.log("\n  Setup did not finish. You can run it again any time: troth setup\n");
      process.exit(1);
    }
  }

  console.log("\n  Two ways to fix that:");
  console.log("    troth setup                 guided — asks which engine, takes your key");
  console.log("    troth ui                    the dashboard, if you would rather click");
  console.log("\n  Then run:  troth\n");

  // The dashboard is only worth starting for someone who can look at it.
  if (firstRunInteractive) {
    ensureProxy(defaultCfg);
    // ensureProxy updates defaultCfg.port when the proxy had to move, so this
    // is the address it is really served on.
    var firstRunUrl = "http://" + defaultCfg.host + ":" + defaultCfg.port + "/ui";
    console.log("  Dashboard: " + firstRunUrl + "\n");
    var firstRunOpenCmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    // spawn() emits async 'error' on ENOENT (missing xdg-open on headless
    // Linux, etc.). Without a listener Node treats that as uncaught and
    // crashes, so a missing opener is swallowed: the URL is printed above.
    try {
      var firstRunBrowser = spawn(firstRunOpenCmd, [firstRunUrl], { detached: true, stdio: "ignore" });
      firstRunBrowser.on("error", function() { /* no opener — the printed URL stands */ });
      firstRunBrowser.unref();
    } catch (e) { /* sync spawn failure (rare) — also ignored */ }
    setTimeout(function() { process.exit(0); }, 500);
    return;
  }
  process.exit(0);
}

var cfg = loadConfig();

// The banner used to print "any", which tells the operator nothing: with a
// pinned engine he still could not see WHICH model was about to answer, and a
// chain that quietly served something else looked identical (pinned Kimi,
// GPT answered, felt like Sonnet). Resolve the actual MODEL NAME, not the
// provider, from the same sources the router reads.
function effectiveModelName() {
  var home = process.env.HOME || require("os").homedir();
  var rd = function (p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return {}; } };
  var c = rd(path.join(home, ".troth", "config.json"));
  var d = rd(path.join(home, ".troth", "desktop-config.json"));
  var pin = String(((c.routing || {}).pin) || d.engine_pin || "").trim();
  if (!pin) return "auto";
  var provs = c.providers || {};
  if (pin === "kimi_sub") {
    // Not a config provider: the membership model lives in desktop-config.
    return String(d.kimi_sub_model || process.env.TROTH_KIMI_SUB_MODEL || "kimi-for-coding").trim();
  }
  if (pin === "openai_sub") return String((provs.openai_sub || {}).model || "gpt-5.5").trim();
  var m = String(((provs[pin] || {}).model) || "").trim();
  return m || pin;
}
var model = cfg.model || effectiveModelName();

// default_command routing. Bare `troth` (or `troth -a`) drops into the
// substrate-native REPL — the substrate is the backend, any LLM is faculty.
// `-a` translates to auto_write=true (the analogue of
// --dangerously-skip-permissions). Power users can opt into the
// Claude-Code-proxy mode via `troth config set default_command classic`.
if (cfg.default_command !== "classic" && command !== "classic") {
  if (autoMode) process.env.TROTH_ENTITY_AUTO_WRITE = "1";
  require("./troth-chat.js").start();
  return;
}

// Classic (Claude-Code-proxy) mode only: the pair-programming session
// spawns `claude`, so THIS path needs it installed — the native REPL
// above must never stall a new user on a 15s claude install.
await ensureClaudeInstalled();

// Kimi Code membership: the proxy serves the kimi_sub subscription lane, but
// only when it sees the key in ITS env. Source it from the app's desktop config
// (or config.json) and set it BEFORE ensureProxy so the (re)spawned proxy
// inherits it and `/engine kimi` routes THROUGH the proxy like every other
// engine. The key is never logged.
if (!process.env.TROTH_KIMI_SUB_KEY) {
  try {
    var _rdJson = function (p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return {}; } };
    var _dc = _rdJson(path.join(HOME, ".troth", "desktop-config.json"));
    var _oc = _rdJson(path.join(HOME, ".troth", "config.json"));
    var _kk = String((_dc.kimi_sub_key) || (_oc.providers && _oc.providers.kimi_sub && _oc.providers.kimi_sub.apiKey) || "").trim();
    if (_kk) {
      process.env.TROTH_KIMI_SUB_KEY = _kk;
      var _km = String(_dc.kimi_sub_model || "").trim();
      if (_km) process.env.TROTH_KIMI_SUB_MODEL = _km;
    }
  } catch (_) {}
}
ensureProxy(cfg);

// Tell the proxy which backend to force-route to. Avoids warmup requests leaking
// to the wrong backend when Claude Code sends them without an explicit model.
function setRoutingMode(mode) {
  try {
    var payload = JSON.stringify({ mode: mode });
    var script =
      'const h=require("http");' +
      'const r=h.request({host:"' + cfg.host + '",port:' + cfg.port + ',path:"/api/routing",method:"POST",' +
      'headers:{"Content-Type":"application/json","Content-Length":' + Buffer.byteLength(payload) + '},timeout:2000},' +
      '(res)=>{res.resume();process.exit(res.statusCode===200?0:1)});' +
      'r.on("error",()=>process.exit(1));' +
      'r.on("timeout",()=>{r.destroy();process.exit(1)});' +
      'r.write(' + JSON.stringify(payload) + ');' +
      'r.end();';
    execFileSync(process.execPath, ["-e", script], { stdio: "pipe" });
  } catch (e) { /* non-fatal: proxy will fall back to 'auto' detection */ }
}
// Pre-flight: -g (useGemini) historically hard-routes to "fallback" which
// SKIPS the local backend entirely. If the user has -g but no enabled cloud
// provider with an api key, the proxy 503s and Claude Code retries silently
// for ~20 minutes (API_TIMEOUT_MS=1200000) — looks like the LLM is "down".
// Fix: probe /api/providers; if no cloud providers are usable, downgrade to
// "local" mode with a visible warning so the user has clear signal instead
// of silent hangs.
function hasEnabledCloudProviders() {
  // Was an HTTP probe of /api/providers. That route DOES NOT EXIST on the
  // proxy (no handler, no has_api_key field anywhere), so the probe always
  // threw and this function always answered "no cloud providers" — which is
  // why the -g path kept downgrading people to a local backend they may not
  // even run. Verified: GET /api/providers returns
  // {"error":"unknown_api_route"}. Read the same sources the proxy reads
  // instead, so the answer is true rather than merely reachable.
  try {
    var home = process.env.HOME || require("os").homedir();
    var provs = {};
    try {
      provs = (JSON.parse(fs.readFileSync(path.join(home, ".troth", "config.json"), "utf8")).providers) || {};
    } catch (e) { /* no config yet */ }
    // Mirrors ENV_KEY_MAP in proxy/modules/router.js: a key in the environment
    // enables a provider even when config carries no apiKey.
    var ENV_KEY = {
      anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY",
      deepseek: "DEEPSEEK_API_KEY", deepinfra: "DEEPINFRA_API_KEY",
      nvidia: "NVIDIA_API_KEY", alibaba: "ALIBABA_API_KEY",
      zai: "ZAI_API_KEY", moonshot: "MOONSHOT_API_KEY",
      xai: "XAI_API_KEY", custom_openai: "CUSTOM_OPENAI_API_KEY"
    };
    for (var name in provs) {
      if (name === "local") continue;
      var p = provs[name] || {};
      if (!p.enabled) continue;
      if (String(p.apiKey || "").trim()) return true;
      if (ENV_KEY[name] && String(process.env[ENV_KEY[name]] || "").trim()) return true;
      // Key-optional lane: a base_url is the whole credential.
      if (name === "custom_openai" && String(p.base_url || "").trim()) return true;
    }
    // Subscription lanes hold no apiKey in config at all.
    if (String(process.env.TROTH_KIMI_SUB_KEY || "").trim()) return true;
    try {
      if (require("../shared-core/codex-token-store.js").load()) return true;
    } catch (e) { /* codex not wired */ }
    return false;
  } catch (e) { return false; }
}

// Is the configured local backend actually listening? The proxy has
// isLocalAvailable() for exactly this, but it is not reachable from here and
// /api/providers carries no local entry, so probe the socket directly.
function localBackendReachable() {
  try {
    var home = process.env.HOME || require("os").homedir();
    var j = JSON.parse(fs.readFileSync(path.join(home, ".troth", "config.json"), "utf8"));
    var lp = (j.providers && j.providers.local) || {};
    var lhost = String(lp.host || "127.0.0.1");
    var lport = parseInt(lp.port, 10) || 1234;
    var probe =
      'const n=require("net");' +
      'const s=n.connect({host:"' + lhost + '",port:' + lport + '});' +
      's.setTimeout(1500);' +
      's.on("connect",()=>{s.destroy();process.exit(0)});' +
      's.on("timeout",()=>{s.destroy();process.exit(1)});' +
      's.on("error",()=>process.exit(1));';
    execFileSync(process.execPath, ["-e", probe], { stdio: "pipe" });
    return true;
  } catch (e) { return false; }
}

// Has the operator already chosen ONE engine? The app writes that choice to
// desktop-config as engine_pin; the proxy reads config.routing.pin. They are
// two different fields, so a pin set in the app was invisible here and this
// CLI happily forced a routing mode on top of it (operator,: "I had
// set Kimi only, why did it go local"). An explicit pin outranks any default
// we would pick, so read BOTH and let the pin govern.
function operatorEnginePin() {
  var home = process.env.HOME || require("os").homedir();
  var pin = "";
  try {
    var c = JSON.parse(fs.readFileSync(path.join(home, ".troth", "config.json"), "utf8"));
    pin = String((c.routing && c.routing.pin) || "").trim();
  } catch (e) { /* no config yet */ }
  if (!pin) {
    try {
      var d = JSON.parse(fs.readFileSync(path.join(home, ".troth", "desktop-config.json"), "utf8"));
      pin = String(d.engine_pin || "").trim();
    } catch (e) { /* no desktop config */ }
  }
  return pin;
}

// Not forcing a mode is only half the job: the proxy consults
// config.routing.pin, so an engine chosen in the app was still ignored and the
// chain served whoever came first (operator pinned Kimi, got openai_sub,
//). Mirror the app's choice into the field the proxy reads, through
// the single-writer helper so a concurrent proxy write cannot tear the file.
// loadProviders() re-reads routing on every call, so this takes effect without
// restarting anything.
function syncEnginePinFromApp() {
  try {
    var home = process.env.HOME || require("os").homedir();
    var d = JSON.parse(fs.readFileSync(path.join(home, ".troth", "desktop-config.json"), "utf8"));
    var appPin = String(d.engine_pin || "").trim();
    if (!appPin) return null;
    var changed = false;
    configFileStore.updateConfig(function (cfg) {
      cfg.routing = cfg.routing || {};
      if (String(cfg.routing.pin || "").trim() !== appPin) {
        cfg.routing.pin = appPin;
        changed = true;
      }
      return cfg;
    });
    return changed ? appPin : null;
  } catch (e) { return null; }
}
var _syncedPin = syncEnginePinFromApp();
if (_syncedPin) {
  console.log("\x1b[2m  engine pin → " + _syncedPin + " (from your app setting)\x1b[0m");
}
// Writing the config is not enough for a proxy that is ALREADY running: it
// reads routing prefs on load/reload, not per request, so a freshly written pin
// sat unused while the chain served whoever came first (: pinned Kimi,
// every turn answered by openai_sub). Nudge it; a dead or absent proxy just
// fails silently here and the next spawn picks the config up anyway.
try {
  var _reload =
    'const h=require("http");' +
    'const r=h.request({host:"' + cfg.host + '",port:' + cfg.port + ',path:"/api/routing/reload",method:"POST",timeout:1500},()=>process.exit(0));' +
    'r.on("error",()=>process.exit(0));' +
    'r.on("timeout",()=>{r.destroy();process.exit(0)});' +
    'r.end();';
  execFileSync(process.execPath, ["-e", _reload], { stdio: "pipe" });
} catch (e) { /* best effort */ }

var routingMode;
if (smartMode) {
  routingMode = "smart";
} else if (operatorEnginePin() && operatorEnginePin() !== "local") {
  // A named engine is pinned. Forcing any mode here would either override it
  // or, worse, send everything at the local backend it was chosen instead of.
  routingMode = "auto";
} else if (useGemini) {
  if (hasEnabledCloudProviders()) {
    routingMode = "fallback";
  } else {
    var Y = "\x1b[33m"; var N = "\x1b[0m";
    console.warn(Y + "⚠  -g requested cloud routing but no cloud providers are enabled+keyed." + N);
    console.warn(Y + "⚠  Falling back to local backend. Configure providers at http://" + cfg.host + ":" + cfg.port + "/ui" + N);
    routingMode = "local";
  }
} else if (localBackendReachable()) {
  routingMode = "local";
} else if (hasEnabledCloudProviders()) {
  // Plain `troth` used to pin the proxy to "local" unconditionally. With the
  // local server down that pin routes EVERY request at a dead socket, so the
  // whole session fails with connection-refused while perfectly good cloud
  // engines sit unused (operator hit this: `troth classic` set
  // mode=local, then every turn died on ECONNREFUSED 127.0.0.1:1234).
  var LY = "\x1b[33m"; var LN = "\x1b[0m";
  console.warn(LY + "⚠  Local backend is not responding — routing through your cloud engines instead." + LN);
  routingMode = "auto";
} else {
  // Nothing else to fall back to: keep the historical behaviour so the
  // failure is at least the familiar one, but say so out loud.
  var NY = "\x1b[33m"; var NN = "\x1b[0m";
  console.warn(NY + "⚠  Local backend is not responding and no cloud engine is configured." + NN);
  routingMode = "local";
}
setRoutingMode(routingMode);

// Detect whether the user is already logged in to claude.ai (macOS Keychain
// read-only — we NEVER modify the keychain). When they are, we deliberately
// avoid setting ANTHROPIC_API_KEY so Claude Code uses its own OAuth Bearer
// token to talk to our proxy. The proxy strips / ignores auth headers, so
// this works transparently. Most importantly, with only a token and no API
// key set there is no "Auth conflict: Both a token and an API key are set"
// warning to suppress in the first place — we fix the root cause instead of
// papering over the symptom.
//
// Historical note: 5.3.0 / 5.3.1 tried to hide the warning by swapping the
// Keychain entry out; that broke the entry's ACL and silently logged users
// out. 5.3.3 tried a NODE_OPTIONS preload to filter the warning from stdout
// but Claude Code's Ink/React TUI renderer wraps and re-formats the text,
// breaking the regex. This approach never touches the keychain and never
// tries to filter output — the warning simply never triggers.
function isLoggedInToClaudeAi() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" });
    return true;
  } catch (e) { return false; }
}

var loggedInToClaudeAi = isLoggedInToClaudeAi();

var env = Object.assign({}, process.env, {
  ANTHROPIC_BASE_URL: "http://" + cfg.host + ":" + cfg.port,
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  API_TIMEOUT_MS: "1200000",
  BASH_DEFAULT_TIMEOUT_MS: "1800000",
  BASH_MAX_TIMEOUT_MS: "7200000"
});

if (loggedInToClaudeAi) {
  // Even if the user has ANTHROPIC_API_KEY exported in their shell, make sure
  // the child does NOT inherit it, otherwise the conflict warning still fires.
  delete env.ANTHROPIC_API_KEY;
} else {
  // Not logged in anywhere — give Claude Code a placeholder key so it has
  // something to send to the proxy. The proxy ignores its value.
  env.ANTHROPIC_API_KEY = "troth";
}

// Kimi runs THROUGH the proxy now (its kimi_sub lane); the launcher passed
// TROTH_KIMI_SUB_KEY to the proxy above, so /engine kimi switches live like every
// other engine. No direct-to-Kimi bypass here: that would un-proxy the session
// and break live engine switching.

if (useGemini) {
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "16384";
  delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
} else {
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "8192";
  env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "58000";
}

var claudeArgs = ["--model", model];
if (autoMode) claudeArgs.push("--dangerously-skip-permissions");
claudeArgs = claudeArgs.concat(passthrough);

// Launch banner — compact, dark, legible
var R = "\x1b[31m";
var D = "\x1b[2m";
var W = "\x1b[97;1m";
var X = "\x1b[0m";
console.log("");
console.log(R + "  ┌──────────────────────────────┐" + X);
console.log(R + "  │" + W + "  T R O T H" + R + "                   │" + X);
console.log(R + "  │" + D + "  v" + VERSION + " // " + model.slice(0, 18) + R + X + R + " │" + X);
console.log(R + "  └──────────────────────────────┘" + X);
// ToS transparency: classic mode runs the Claude Code TUI but answers from
// the operator's configured backend (local / BYOK cloud). troth strips the
// inbound claude.ai OAuth token and NEVER forwards it upstream — proxying a
// consumer subscription through a third-party harness violates Anthropic's
// ToS. Make that explicit when a subscription session is detected.
if (loggedInToClaudeAi) {
  var Yc = "\x1b[33m"; var Dc = "\x1b[2m"; var Xc = "\x1b[0m";
  console.log(Dc + "  classic mode → backend: " + routingMode +
    " (your Claude subscription is NOT used)" + Xc);
  console.log(Yc + "  ⚠  troth never forwards claude.ai credentials upstream." + Xc);
}
console.log("");

var child = spawn("claude", claudeArgs, { env: env, stdio: "inherit" });
// Missing Claude Code used to surface as a raw unhandled ENOENT stack — the
// one crash a stranger hits on a Mac that never installed it (fresh-Mac
// audit). doctor already calls claude optional; the launch path
// has to be equally honest.
child.on("error", function (e) {
  if (e && e.code === "ENOENT") {
    console.error("troth: Claude Code is not installed (the `claude` command was not found).");
    console.error("  Classic mode drives a Claude Code session. Install it first:");
    console.error("    npm install -g @anthropic-ai/claude-code");
    console.error("  or run plain `troth` for the built-in REPL, or use the troth app — neither needs Claude Code.");
  } else {
    console.error("troth: could not launch claude: " + (e && e.message ? e.message : e));
  }
  process.exit(127);
});
child.on("exit", function(code) { process.exit(code || 0); });

})(); // end of async launch IIFE
