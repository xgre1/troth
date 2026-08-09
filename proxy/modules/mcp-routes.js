// SPDX-License-Identifier: AGPL-3.0-only
// mcp-routes.js — the dashboard's MCP wire endpoints, in the OPEN proxy
//.
//
// These routes used to live in a module that also carried autonomy routes, and
// when that module moved out of this tree they went with it: /api/mcp/status
// and /api/mcp/install answered nowhere and the dashboard's Wire buttons hit
// 404. MCP wiring belongs here, next to the installer (shared-core/mcp-hosts.js)
// and the dashboard that uses it, so server.js dispatches these first.
//
//   GET  /api/mcp/status   → read-only; best-effort probes, never throws.
//   POST /api/mcp/install  → auth-gated (checkRemoteAuth: loopback bypass,
//                            Bearer token for anything remote).
//     ?client=claude_code (default): the plugin flow via `claude plugin ...`
//       run with execFile (no shell) and HARD-CODED args — nothing from the
//       request is ever spliced into a command. Marketplace source prefers
//       THIS core checkout (its .claude-plugin/marketplace.json ships in the
//       repo and in the app bundle), falling back to the GitHub id for
//       installs where the local manifest is absent.
//     ?client=cursor|windsurf|cline|claude_desktop: the shared installer
//       (shared-core/mcp-hosts.js): 4-server router-gateway, merge-only,
//       backup + atomic write, router.json provisioning.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const PLUGIN_NAME = "troth@troth";
const GITHUB_MARKETPLACE = "xgre1/troth";

function home() {
  return process.env.HOME || os.homedir();
}

function coreRoot() {
  return path.resolve(__dirname, "..", "..");
}

function owns(url) {
  // Match on the PATH only: server.js strips the query before handle(), but
  // owns() may be called directly with one. Exact-match the two endpoints so a
  // different PATH like /api/mcp/install-anything is NOT claimed (the old
  // indexOf===0 prefix did claim it — reviewer) while
  // /api/mcp/install?client=cursor still is.
  if (typeof url !== "string") return false;
  const p = url.split("?")[0];
  return p === "/api/mcp/status" || p === "/api/mcp/install";
}

// Prefer the local checkout/bundle as the marketplace source: it always
// matches the running core's version and works offline + pre-publication.
function marketplaceSource() {
  const local = coreRoot();
  if (fs.existsSync(path.join(local, ".claude-plugin", "marketplace.json"))) return local;
  return GITHUB_MARKETPLACE;
}

function claudeBin() {
  const HOME = home();
  const candidates = [
    path.join(HOME, ".claude", "local", "claude"),   // native installer
    path.join(HOME, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* keep probing */ }
  }
  return "claude"; // PATH fallback
}

function handle(req, res, url, deps) {
  const { jsonResponse, checkRemoteAuth } = deps;

  if (req.method === "GET" && url === "/api/mcp/status") {
    // Auth-gate like install: loopback bypasses (the local dashboard), remote
    // needs the Bearer token. Status echoes marketplaceSource(), an absolute
    // checkout path that contains the OS username — not for unauthed remote
    // callers when the daemon binds beyond loopback.
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return true; }
    let marketplaceAdded = false;
    let pluginEnabled = false;
    const HOME = home();
    // enabledPlugins lives in ~/.claude/settings.json ({ "troth@troth": true }).
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "settings.json"), "utf8"));
      const ep = settings && settings.enabledPlugins;
      if (ep && ep[PLUGIN_NAME]) pluginEnabled = true;
    } catch (_) { /* absent = false */ }
    // Marketplace registry location + shape vary by Claude Code version
    // (2.1.19x: ~/.claude/plugins/known_marketplaces.json; older builds used
    // ~/.claude/known_marketplaces.json). Probe the serialized blob for our
    // ids (GitHub id, repo name, or the local-dir marketplace name "troth")
    // rather than assuming a schema.
    try {
      for (const mkPath of [
        path.join(HOME, ".claude", "plugins", "known_marketplaces.json"),
        path.join(HOME, ".claude", "known_marketplaces.json"),
      ]) {
        if (!fs.existsSync(mkPath)) continue;
        const raw = fs.readFileSync(mkPath, "utf8");
        // "troth-core" stays as a LITERAL here: pre-rename installs added the
        // marketplace under that id, and dedup must recognize them too.
        if (raw.indexOf(GITHUB_MARKETPLACE) !== -1 || raw.indexOf("troth-core") !== -1 || raw.indexOf('"troth"') !== -1) {
          marketplaceAdded = true;
          break;
        }
      }
    } catch (_) { /* absent = false */ }
    // The v2 plugin registry is the truth for "installed" (settings.json
    // misses registry-installed plugins — the status dot lied before A3).
    let pluginInstalled = false;
    try { pluginInstalled = require("../../shared-core/mcp-hosts.js").claudePluginInstalled(); } catch (_) {}
    // Detection the setup surfaces need to OFFER the subscription path
    // instead of merely describing it: is the Claude Code CLI on this
    // machine, and is a claude.ai login present? macOS keeps that credential
    // in the keychain under "Claude Code-credentials"; elsewhere the CLI
    // writes ~/.claude/.credentials.json. Presence only — nothing is read.
    let cliInstalled = false;
    try {
      require("child_process").execFileSync(
        process.platform === "win32" ? "where" : "which", ["claude"], { stdio: "pipe" });
      cliInstalled = true;
    } catch (_) {
      try { cliInstalled = claudeBin() !== "claude"; } catch (_) {}
    }
    let subscriptionActive = false;
    try {
      subscriptionActive = require("../../shared-core/claude-subscription.js").claudeSubscriptionActive();
    } catch (_) {}
    // Per-client wiring for the Connections tab. TCC-protected configs
    // (Cline, Claude Desktop on macOS) are NOT probed unless the operator
    // explicitly asked (?include_tcc=cline,claude_desktop) — reading another
    // app's folder can raise the macOS data-protection prompt.
    let clients = [];
    try {
      const mh = require("../../shared-core/mcp-hosts.js");
      const inc = String((new URL((req && req.url) || url, "http://x")).searchParams.get("include_tcc") || "")
        .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      clients = mh.hosts().filter(function (h) { return h.id !== "claude"; }).map(function (h) {
        if (h.tcc && process.platform === "darwin" && inc.indexOf(h.id) === -1) {
          return { id: h.id, label: h.label, status: "not checked", checked: false };
        }
        return { id: h.id, label: h.label, status: mh.hostStatus(h), checked: true };
      });
    } catch (_) {}
    jsonResponse(res, 200, {
      ok: true,
      claude_code: {
        marketplace_added: marketplaceAdded,
        plugin_enabled: pluginEnabled,
        plugin_installed: pluginInstalled,
        cli_installed: cliInstalled,
        subscription_active: subscriptionActive
      },
      clients: clients,
      plugin_name: PLUGIN_NAME,
      marketplace: marketplaceSource(),
    });
    return true;
  }

  if (req.method === "POST" && url === "/api/mcp/install") {
    if (!checkRemoteAuth(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return true; }

    // server.js strips the query before dispatch (url = req.url.split('?')[0]),
    // so the client selector MUST come from req.url. (The old closed copy read
    // the stripped url — every ?client= would have silently become claude_code;
    // one more sign those routes never actually ran.)
    let client = "claude_code";
    try {
      const full = (req && req.url) || url;
      client = (new URL(full, "http://x").searchParams.get("client") || "claude_code").toLowerCase();
    } catch (_) {}

    if (client !== "claude_code") {
      // Shared installer: 4-server router-gateway + router.json (A6 part 1).
      try {
        const mcpHosts = require("../../shared-core/mcp-hosts.js");
        const host = mcpHosts.hosts().filter(function (h) { return h.id === client; })[0];
        if (!host) { jsonResponse(res, 400, { ok: false, error: "unknown_client", client: client }); return true; }
        const r = mcpHosts.installInto(host);
        if (r.ok) {
          jsonResponse(res, 200, {
            ok: true, client: client, config_path: r.cfgPath,
            servers_added: r.added, pruned: r.pruned || [], missing: r.missing || [],
            router: r.router && r.router.ok ? "provisioned" : "unchanged", note: r.note,
          });
        } else {
          jsonResponse(res, 400, { ok: false, client: client, error: r.error });
        }
      } catch (e) {
        jsonResponse(res, 500, { ok: false, client: client, error: e.message });
      }
      return true;
    }

    // Claude Code: the full plugin flow. Args are constants; execFile = no
    // shell; the ONLY variable is the marketplace source, which is either
    // this checkout's absolute path or the fixed GitHub id — never request
    // data. `marketplace remove` first keeps the add idempotent when a stale
    // marketplace with the same name points elsewhere (proven necessity on
    // the Studio.
    const bin = claudeBin();
    const exec = deps.execFileImpl || execFile; // test seam
    const tail = (s) => String(s == null ? "" : s).slice(-800);
    const steps = [];
    const runStep = (args) => new Promise((resolve) => {
      exec(bin, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const exit = err && typeof err.code === "number" ? err.code : (err ? 1 : 0);
        steps.push({
          cmd: [bin].concat(args).join(" "),
          exit: exit,
          stdout_tail: tail(stdout),
          stderr_tail: tail(stderr || (err ? err.message : "")),
        });
        resolve(exit === 0);
      });
    });
    (async () => {
      try {
        await runStep(["plugin", "marketplace", "remove", "troth"]); // idempotent, failure is fine
        const okAdd = await runStep(["plugin", "marketplace", "add", marketplaceSource()]);
        let okInstall = false;
        if (okAdd) okInstall = await runStep(["plugin", "install", PLUGIN_NAME]);
        const ok = okAdd && okInstall;
        jsonResponse(res, 200, ok
          ? { ok: true, steps: steps }
          : { ok: false, steps: steps, error: okAdd ? "plugin_install_failed" : "marketplace_add_failed" });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, steps: steps, error: e.message });
      }
    })();
    return true;
  }

  jsonResponse(res, 404, { error: "not_found" });
  return true;
}

module.exports = { owns, handle, marketplaceSource };
