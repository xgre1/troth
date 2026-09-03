// SPDX-License-Identifier: AGPL-3.0-only
// mcp-hosts.js — the ONE mcp-install semantics for every surface.
//
// The CLI (bin/cmd-mcp-install.js) and the proxy route /api/mcp/install both
// call this module, and the app's installer (setup module_mcps
// + provision_router_config) mirrors the same rules — keep them in sync when
// semantics change:
//   - merge-only: other servers in the host config are never touched
//   - fail-closed: unreadable or invalid JSON aborts; the file is never clobbered
//   - rolling .bak-troth backup before every write
//   - atomic write (tmp file + rename)
//   - troth-* entries are always overwritten, so a moved install heals paths
//   - absolute node (process.execPath) + absolute server paths, so app-only
//     users with no system node still get working servers
//
// A6: the wired surface is the 4-server ROUTER-GATEWAY, matching
// the app installer and the plugin's own .mcp.json. Wiring all 7 servers put
// ~79 tool schemas into every session (substrate 45 + memory 18 + entity 6 +
// the 4 light ones) — a recurring token tax + tool-choice overload. Now only
// the 4 lightweight servers are wired top-level; troth-router reaches the 3
// heavy ones on demand (mcp_list / mcp_describe / mcp_call) through
// ~/.troth/router.json, which installInto provisions (merge-only) with the
// same absolute node. Full access preserved, ~10 tools instead of ~79.
// Legacy direct entries for the 3 heavy servers are OURS by name, so install
// prunes them (7→4 migration); foreign servers are untouched as always.
//
// Claude Code special case: the troth PLUGIN already provides these servers
// (namespaced plugin:troth:*). Writing top-level mcpServers entries while the
// plugin is installed DUPLICATES the servers in the host (live incident
// 7 duplicate entries in ~/.claude.json). Both status and install
// therefore check the plugin registry first.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// What gets wired top-level into a host: the router-gateway surface.
const SERVER_NAMES = [
  "troth-router", "troth-bash", "troth-cache", "troth-hashline",
];
// Heavy servers reachable THROUGH the router (never wired top-level; pruned
// from host configs as a 7→4 migration since they are ours by name).
const DOWNSTREAM_SERVER_NAMES = [
  "troth-substrate", "troth-memory", "troth-entity",
];

function home() {
  return process.env.HOME || os.homedir();
}

// tcc: true = the config lives under ~/Library of ANOTHER app, so probing or
// writing it can trigger the macOS App Data Protection prompt. Surfaces only
// write these hosts when the operator names them explicitly.
function hosts() {
  const HOME = home();
  return [
    { id: "claude", label: "Claude Code", cfg: path.join(HOME, ".claude.json"), tcc: false },
    { id: "cursor", label: "Cursor", cfg: path.join(HOME, ".cursor", "mcp.json"), tcc: false },
    { id: "hermes", label: "Hermes Agent", cfg: path.join(HOME, ".hermes", "config.yaml"), format: "yaml", provider: path.join(HOME, ".hermes", "plugins", "memory", "troth"), tcc: false },
    { id: "windsurf", label: "Windsurf", cfg: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), tcc: false },
    { id: "cline", label: "Cline (VS Code)", cfg: path.join(HOME, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), tcc: true },
    { id: "claude_desktop", label: "Claude Desktop", cfg: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"), tcc: true },
  ];
}

function serverEntry(coreRoot, nodeBin, name) {
  const serverPath = path.resolve(coreRoot, "plugin", "mcp-servers", name, "server.mjs");
  if (!fs.existsSync(serverPath)) return null;
  return { command: nodeBin, args: [serverPath] };
}

function trothServers(opts) {
  const coreRoot = (opts && opts.coreRoot) || path.resolve(__dirname, "..");
  const nodeBin = (opts && opts.nodeBin) || process.execPath;
  const servers = {};
  const missing = [];
  for (const name of SERVER_NAMES) {
    const entry = serverEntry(coreRoot, nodeBin, name);
    if (!entry) { missing.push(name); continue; }
    servers[name] = entry;
  }
  return { servers, missing };
}

// Point troth-router at its heavy downstream (substrate/memory/entity) via
// ~/.troth/router.json using the SAME absolute node + absolute paths as the
// wired servers. Without this the router's own auto-default spawns bare
// `node` (breaks app-only users) and covers substrate+memory only (no
// entity). MERGE-ONLY like every host write: our three entries are always
// overwritten (path healing), foreign downstream entries (e.g. a hand-added
// chrome-devtools) are preserved. Best-effort: a failure here must never
// fail the host install — the router auto-default still covers the basics.
function provisionRouterConfig(opts) {
  const coreRoot = (opts && opts.coreRoot) || path.resolve(__dirname, "..");
  const nodeBin = (opts && opts.nodeBin) || process.execPath;
  try {
    const dir = path.join(home(), ".troth");
    const cfgPath = path.join(dir, "router.json");
    let root = {};
    if (fs.existsSync(cfgPath)) {
      try {
        // Strip a leading BOM: JSON.parse throws on U+FEFF, which turned a
        // legitimately-valid BOM-saved config into a full wire abort
        // (round-2 review; the Rust twin tolerates it the same way now).
        const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
        if (raw.trim()) root = JSON.parse(raw);
        if (typeof root !== "object" || root === null || Array.isArray(root)) root = {};
      } catch (e) {
        // Malformed existing config: do NOT rebuild — that would drop the
        // user's foreign downstream servers (e.g. a hand-added chrome-devtools).
        // Abort untouched, same fail-closed contract as ensureClaudeAllow
        //. Backup is taken only on the success path below.
        return { ok: false, error: "router.json is malformed; left untouched (fix or remove ~/.troth/router.json and re-wire): " + String(e && e.message || e) };
      }
      try { fs.copyFileSync(cfgPath, cfgPath + ".bak-troth"); } catch (_) { /* best effort */ }
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
    const serversObj = (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers))
      ? root.mcpServers : {};
    const written = [];
    for (const name of DOWNSTREAM_SERVER_NAMES) {
      const entry = serverEntry(coreRoot, nodeBin, name);
      if (!entry) continue;
      serversObj[name] = entry;
      written.push(name);
    }
    if (!written.length) return { ok: false, error: "no downstream servers found under plugin/mcp-servers" };
    root.mcpServers = serversObj;
    const tmp = cfgPath + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n");
    fs.renameSync(tmp, cfgPath);
    return { ok: true, written, cfgPath };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// True when the troth plugin is installed for Claude Code (v2 registry:
// ~/.claude/plugins/installed_plugins.json). Explicitly-disabled plugins
// (settings enabledPlugins[key] === false) do not count.
function claudePluginInstalled() {
  try {
    const regPath = path.join(home(), ".claude", "plugins", "installed_plugins.json");
    const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
    const plugins = (reg && reg.plugins) || {};
    let disabled = {};
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(home(), ".claude", "settings.json"), "utf8"));
      disabled = (settings && settings.enabledPlugins) || {};
    } catch (_) { /* no settings file: nothing explicitly disabled */ }
    return Object.keys(plugins).some(function (k) {
      const isOurs = k.indexOf("troth@") === 0;
      return isOurs && disabled[k] !== false;
    });
  } catch (_) {
    return false;
  }
}

// Pre-approve the troth gateway tools in Claude Code's user settings
// (~/.claude/settings.json permissions.allow). WHY THIS IS PART OF THE WIRE
// and not left to per-project accept prompts: the plugin ships the bash-steer
// hook, which denies built-in Bash and reroutes shell to troth-bash. Built-in
// Bash was covered by the user's accumulated Bash(...) allow rules; the MCP
// tool is NOT, so without this merge every new project stalls on an accept
// prompt for the very tool the steer forces (live incident on the operator's
// own Mac. Steering and its permission must travel together.
// Consent = the explicit wire action (app button / `troth mcp install`).
// Merge-only, narrowly scoped to the four troth server names; foreign allow
// entries untouched; rolling backup + atomic write; fail-soft (an install
// never fails because settings.json was weird).
function ensureClaudeAllow(prefix) {
  try {
    const dir = path.join(home(), ".claude");
    const cfgPath = path.join(dir, "settings.json");
    let root = {};
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, "utf8");
        if (raw.trim()) root = JSON.parse(raw);
        if (typeof root !== "object" || root === null || Array.isArray(root)) {
          return { ok: false, error: "settings.json is not a JSON object" };
        }
      } catch (e) {
        return { ok: false, error: "settings.json unreadable (" + e.message + ") — left untouched" };
      }
      try { fs.copyFileSync(cfgPath, cfgPath + ".bak-troth"); } catch (_) { /* best effort */ }
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
    const perms = (root.permissions && typeof root.permissions === "object" && !Array.isArray(root.permissions))
      ? root.permissions : (root.permissions = {});
    const allow = Array.isArray(perms.allow) ? perms.allow : (perms.allow = []);
    const added = [];
    for (const name of SERVER_NAMES) {
      const entry = "mcp__" + prefix + name + "__*";
      if (allow.indexOf(entry) === -1) { allow.push(entry); added.push(entry); }
    }
    const tmp = cfgPath + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n");
    fs.renameSync(tmp, cfgPath);
    return { ok: true, added };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ── YAML hosts (Hermes Agent) ────────────────────────────────────────────────
// The same merge-only, fail-closed, backed-up, atomic write, on a YAML file
// edited as text: only the troth entries under mcp_servers and the provider
// line under memory are ours, every other line stays as written.
function _yamlTopBlock(lines, key) {
  const re = new RegExp("^" + key + ":\\s*(#.*)?$");
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]) || /^#/.test(lines[end]))) end++;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return { start, end };
}
function _yamlChildRange(lines, block, name) {
  const re = new RegExp("^  " + name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + ":(\\s.*)?$");
  for (let i = block.start + 1; i < block.end; i++) {
    if (!re.test(lines[i])) continue;
    let j = i + 1;
    while (j < block.end && (lines[j].trim() === "" || /^   /.test(lines[j]) || /^\s+#/.test(lines[j]))) j++;
    while (j > i + 1 && lines[j - 1].trim() === "") j--;
    return { start: i, end: j };
  }
  return null;
}
function _yamlUpsert(text, key, children) {
  let lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (!_yamlTopBlock(lines, key)) {
    if (lines.length) lines.push("");
    lines.push(key + ":");
    for (const c of children) lines.push(...c.lines);
    return lines.join("\n") + "\n";
  }
  for (const c of children) {
    const block = _yamlTopBlock(lines, key);
    const r = _yamlChildRange(lines, block, c.name);
    if (r) lines.splice(r.start, r.end - r.start, ...c.lines);
    else lines.splice(block.start + 1, 0, ...c.lines);
  }
  return lines.join("\n") + "\n";
}
function _yamlHas(text, key, name) {
  const lines = String(text || "").split("\n");
  const block = _yamlTopBlock(lines, key);
  return !!(block && _yamlChildRange(lines, block, name));
}
function installIntoYaml(host, opts) {
  const cfgPath = host.cfg;
  let text = "";
  if (fs.existsSync(cfgPath)) {
    text = fs.readFileSync(cfgPath, "utf8");
    try { fs.copyFileSync(cfgPath, cfgPath + ".bak-troth"); } catch (e) { /* best effort */ }
  } else {
    try { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); }
    catch (e) { return { ok: false, error: "mkdir " + path.dirname(cfgPath) + ": " + e.message }; }
  }
  const { servers, missing } = trothServers(opts);
  const names = Object.keys(servers);
  if (!names.length) return { ok: false, error: "no troth MCP servers found under plugin/mcp-servers — install looks incomplete" };
  const children = names.map((n) => ({ name: n, lines: [
    "  " + n + ":",
    "    command: " + JSON.stringify(servers[n].command),
    "    args: [" + servers[n].args.map((a) => JSON.stringify(a)).join(", ") + "]"
  ] }));
  let next = _yamlUpsert(text, "mcp_servers", children);
  next = _yamlUpsert(next, "memory", [{ name: "provider", lines: ["  provider: troth"] }]);
  const tmp = cfgPath + ".tmp" + process.pid;
  try { fs.writeFileSync(tmp, next); fs.renameSync(tmp, cfgPath); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} return { ok: false, error: "write " + cfgPath + ": " + e.message }; }
  const back = fs.readFileSync(cfgPath, "utf8");
  for (const n of names) if (!_yamlHas(back, "mcp_servers", n)) return { ok: false, error: "the written config does not carry " + n + ": " + cfgPath };
  if (!/^  provider:\s*troth\s*$/m.test(back)) return { ok: false, error: "the written config does not name troth as the memory provider: " + cfgPath };
  const coreRoot = (opts && opts.coreRoot) || path.resolve(__dirname, "..");
  const src = path.join(coreRoot, "integrations", "hermes", "memory", "troth");
  const copied = [];
  if (host.provider) {
    try {
      fs.mkdirSync(host.provider, { recursive: true });
      for (const f of ["__init__.py", "plugin.yaml", "README.md"]) {
        const from = path.join(src, f);
        if (!fs.existsSync(from)) return { ok: false, error: "provider file missing in this install: " + from };
        fs.copyFileSync(from, path.join(host.provider, f));
        copied.push(f);
      }
    } catch (e) { return { ok: false, error: "provider install " + host.provider + ": " + e.message }; }
  }
  const router = provisionRouterConfig(opts);
  return { ok: true, added: names, pruned: [], missing, cfgPath, router, provider: host.provider, provider_files: copied,
    note: "Hermes reads troth as its memory provider; keep one memory by setting memory.memory_enabled: false in " + cfgPath };
}
function hostStatusYaml(host) {
  if (!fs.existsSync(host.cfg)) return "no config yet";
  try {
    const text = fs.readFileSync(host.cfg, "utf8");
    const ours = SERVER_NAMES.filter((n) => _yamlHas(text, "mcp_servers", n));
    const provider = /^  provider:\s*troth\s*$/m.test(text);
    if (ours.length === SERVER_NAMES.length) return "wired (" + ours.length + " servers" + (provider ? ", memory provider" : "") + ")";
    if (ours.length) return "partial (" + ours.length + "/" + SERVER_NAMES.length + " servers)";
    return provider ? "memory provider only" : "not wired";
  } catch (e) { return "config unreadable"; }
}

function installInto(host, opts) {
  if (host.format === "yaml") return installIntoYaml(host, opts);
  if (host.id === "claude" && claudePluginInstalled() && !(opts && opts.force)) {
    // The plugin provides the same gateway surface; still (re)provision the
    // router config so the gateway reaches its downstream with healed paths,
    // and pre-approve the PLUGIN-namespaced tools (plugin servers surface as
    // mcp__plugin_troth_<server>__<tool>).
    const router = provisionRouterConfig(opts);
    const permissions = ensureClaudeAllow("plugin_troth_");
    return {
      ok: true, skipped: "plugin", added: [], pruned: [], missing: [], cfgPath: host.cfg, router, permissions,
      note: "Claude Code is already wired via the troth plugin; top-level entries would duplicate the servers",
    };
  }

  const cfgPath = host.cfg;
  let root = {};
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, "utf8");
    if (raw.trim()) {
      try { root = JSON.parse(raw); }
      catch (e) { return { ok: false, error: "existing config is not valid JSON (" + e.message + "): " + cfgPath }; }
      if (typeof root !== "object" || root === null || Array.isArray(root)) {
        return { ok: false, error: "existing config is not a JSON object: " + cfgPath };
      }
    }
    // Rolling single backup — this file can hold the host's whole state
    // (Claude Code keeps everything in ~/.claude.json).
    try { fs.copyFileSync(cfgPath, cfgPath + ".bak-troth"); } catch (e) { /* best effort */ }
  } else {
    try { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); }
    catch (e) { return { ok: false, error: "mkdir " + path.dirname(cfgPath) + ": " + e.message }; }
  }

  if (root.mcpServers && (typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers))) {
    return { ok: false, error: "config.mcpServers exists but is not an object: " + cfgPath };
  }
  const serversObj = root.mcpServers || {};
  const { servers, missing } = trothServers(opts);
  const added = [];
  for (const name of Object.keys(servers)) {
    serversObj[name] = servers[name];
    added.push(name);
  }
  if (!added.length) {
    return { ok: false, error: "no troth MCP servers found under plugin/mcp-servers — install looks incomplete" };
  }
  // 7→4 migration: the heavy direct entries are OURS by exact name; they now
  // live behind the router. Prune them so upgraded hosts drop back to ~10
  // tool schemas. Foreign servers are never touched.
  const pruned = [];
  for (const name of DOWNSTREAM_SERVER_NAMES) {
    if (serversObj[name]) { delete serversObj[name]; pruned.push(name); }
  }
  root.mcpServers = serversObj;

  const tmp = cfgPath + ".tmp" + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n");
    fs.renameSync(tmp, cfgPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    return { ok: false, error: "write " + cfgPath + ": " + e.message };
  }
  // Gateway needs its downstream map; best-effort, never fails the install.
  const router = provisionRouterConfig(opts);
  // Claude Code surfaces top-level wired servers as mcp__<server>__<tool>;
  // pre-approve them so bash-steer's reroute never stalls on an accept
  // prompt (see ensureClaudeAllow). Other hosts manage their own approvals.
  const permissions = host.id === "claude" ? ensureClaudeAllow("") : undefined;
  return { ok: true, added, pruned, missing, cfgPath, router, permissions };
}

function hostStatus(host) {
  if (host.format === "yaml") return hostStatusYaml(host);
  if (host.id === "claude" && claudePluginInstalled()) return "wired via plugin";
  if (!fs.existsSync(host.cfg)) return "no config yet";
  try {
    const root = JSON.parse(fs.readFileSync(host.cfg, "utf8") || "{}");
    const servers = root.mcpServers || {};
    const ours = SERVER_NAMES.filter(function (n) { return servers[n]; });
    const legacy = DOWNSTREAM_SERVER_NAMES.filter(function (n) { return servers[n]; });
    if (ours.length === SERVER_NAMES.length) {
      return legacy.length
        ? "wired (" + ours.length + " servers + " + legacy.length + " legacy direct — rerun install to migrate)"
        : "wired (" + ours.length + " servers)";
    }
    if (ours.length) return "partial (" + ours.length + "/" + SERVER_NAMES.length + " servers)";
    if (legacy.length) return "legacy direct wiring (" + legacy.length + " servers — rerun install to migrate)";
    return "not wired";
  } catch (e) {
    return "config unreadable";
  }
}

module.exports = {
  SERVER_NAMES, DOWNSTREAM_SERVER_NAMES, hosts, trothServers,
  provisionRouterConfig, ensureClaudeAllow, claudePluginInstalled, installInto, hostStatus,
};
