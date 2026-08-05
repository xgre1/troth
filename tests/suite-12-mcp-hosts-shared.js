// SPDX-License-Identifier: AGPL-3.0-only
// suite-12: shared MCP host installer.
// Hermetic: every test runs against a throwaway HOME so the real
// ~/.claude.json / ~/.cursor/mcp.json / ~/.troth/router.json are never touched.
module.exports = function run({ test }) {
  const assert = require("assert");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const mcpHosts = require("../shared-core/mcp-hosts.js");

  console.log("\nMCP hosts shared installer (A3+A6):");

  const GATEWAY = ["troth-router", "troth-bash", "troth-cache", "troth-hashline"];
  const HEAVY = ["troth-substrate", "troth-memory", "troth-entity"];

  function withSandboxHome(fn) {
    const prev = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-hosts-test-"));
    process.env.HOME = tmp;
    try { return fn(tmp); }
    finally { process.env.HOME = prev; fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  function hostById(id) {
    const h = mcpHosts.hosts().filter(function (x) { return x.id === id; })[0];
    assert(h, "host " + id + " exists");
    return h;
  }

  function routerCfg(home) {
    return JSON.parse(fs.readFileSync(path.join(home, ".troth", "router.json"), "utf8"));
  }

  test("MH-1: install merges the 4 gateway servers, preserves foreign servers, absolute node command", () => {
    withSandboxHome(function (home) {
      const cursor = hostById("cursor");
      fs.mkdirSync(path.dirname(cursor.cfg), { recursive: true });
      fs.writeFileSync(cursor.cfg, JSON.stringify({ mcpServers: { foreign: { command: "keepme" } }, other: 1 }));
      const res = mcpHosts.installInto(cursor);
      assert(res.ok, "install ok: " + (res.error || ""));
      assert.deepStrictEqual(res.added.slice().sort(), GATEWAY.slice().sort(), "exactly the 4 gateway servers written");
      const root = JSON.parse(fs.readFileSync(cursor.cfg, "utf8"));
      assert(root.mcpServers.foreign && root.mcpServers.foreign.command === "keepme", "foreign server preserved");
      assert.strictEqual(root.other, 1, "sibling keys preserved");
      assert.strictEqual(root.mcpServers["troth-router"].command, process.execPath, "absolute node, not bare 'node'");
      assert(path.isAbsolute(root.mcpServers["troth-bash"].args[0]), "absolute server path");
      HEAVY.forEach(function (n) { assert(!root.mcpServers[n], n + " NOT wired top-level (router-gateway)"); });
      assert(fs.existsSync(cursor.cfg + ".bak-troth"), "rolling backup taken");
    });
  });

  test("MH-2: corrupt JSON fails closed - config file untouched, no backup-clobber", () => {
    withSandboxHome(function (home) {
      const cursor = hostById("cursor");
      fs.mkdirSync(path.dirname(cursor.cfg), { recursive: true });
      fs.writeFileSync(cursor.cfg, "{ this is not json");
      const res = mcpHosts.installInto(cursor);
      assert.strictEqual(res.ok, false, "install refused");
      assert(/not valid JSON/.test(res.error), "says why: " + res.error);
      assert.strictEqual(fs.readFileSync(cursor.cfg, "utf8"), "{ this is not json", "file NOT clobbered");
    });
  });

  test("MH-3: Claude Code with the troth plugin installed is a no-write skip (dup guard) + router still provisioned", () => {
    withSandboxHome(function (home) {
      const claude = hostById("claude");
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { "troth@troth": [{ scope: "user" }] } }));
      assert.strictEqual(mcpHosts.claudePluginInstalled(), true, "plugin detected from registry");
      const res = mcpHosts.installInto(claude);
      assert(res.ok && res.skipped === "plugin", "install skipped via plugin");
      assert(!fs.existsSync(claude.cfg), "no top-level ~/.claude.json written");
      assert.strictEqual(mcpHosts.hostStatus(claude), "wired via plugin", "status tells the truth");
      assert(res.router && res.router.ok, "router.json still provisioned for the plugin's gateway");
      const rc = routerCfg(home);
      HEAVY.forEach(function (n) { assert(rc.mcpServers[n], n + " in router.json"); });
    });
  });

  test("MH-4: explicitly disabled plugin does not count - install writes top-level entries", () => {
    withSandboxHome(function (home) {
      const claude = hostById("claude");
      const dotClaude = path.join(home, ".claude");
      fs.mkdirSync(path.join(dotClaude, "plugins"), { recursive: true });
      fs.writeFileSync(path.join(dotClaude, "plugins", "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { "troth@troth": [{ scope: "user" }] } }));
      fs.writeFileSync(path.join(dotClaude, "settings.json"),
        JSON.stringify({ enabledPlugins: { "troth@troth": false } }));
      assert.strictEqual(mcpHosts.claudePluginInstalled(), false, "disabled plugin ignored");
      const res = mcpHosts.installInto(claude);
      assert(res.ok && res.added.length === 4, "top-level gateway install proceeds");
      const root = JSON.parse(fs.readFileSync(claude.cfg, "utf8"));
      assert(root.mcpServers["troth-router"], "gateway servers written");
    });
  });

  test("MH-5: fresh host (no config yet) gets dirs + config created, status transitions", () => {
    withSandboxHome(function (home) {
      const windsurf = hostById("windsurf");
      assert.strictEqual(mcpHosts.hostStatus(windsurf), "no config yet");
      const res = mcpHosts.installInto(windsurf);
      assert(res.ok, "install ok: " + (res.error || ""));
      assert.strictEqual(mcpHosts.hostStatus(windsurf), "wired (4 servers)");
    });
  });

  test("MH-6: legacy 7-server config migrates to the gateway (heavy pruned, foreign kept)", () => {
    withSandboxHome(function (home) {
      const cursor = hostById("cursor");
      fs.mkdirSync(path.dirname(cursor.cfg), { recursive: true });
      const legacyServers = { foreign: { command: "keepme" } };
      GATEWAY.concat(HEAVY).forEach(function (n) { legacyServers[n] = { command: "old-node", args: ["/old/" + n] }; });
      fs.writeFileSync(cursor.cfg, JSON.stringify({ mcpServers: legacyServers }));
      assert(/legacy direct|wired \(4 servers \+ 3 legacy/.test(mcpHosts.hostStatus(cursor)), "status flags the legacy wiring");
      const res = mcpHosts.installInto(cursor);
      assert(res.ok, "migration install ok");
      assert.deepStrictEqual(res.pruned.slice().sort(), HEAVY.slice().sort(), "the 3 heavy entries pruned");
      const root = JSON.parse(fs.readFileSync(cursor.cfg, "utf8"));
      HEAVY.forEach(function (n) { assert(!root.mcpServers[n], n + " gone from top level"); });
      assert(root.mcpServers.foreign.command === "keepme", "foreign preserved through migration");
      assert.strictEqual(root.mcpServers["troth-router"].command, process.execPath, "gateway paths healed to current node");
      assert.strictEqual(mcpHosts.hostStatus(cursor), "wired (4 servers)");
    });
  });

  test("MH-8: claude wire via plugin pre-approves the PLUGIN-namespaced tools (bash-steer contract)", () => {
    withSandboxHome(function (home) {
      const claude = hostById("claude");
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { "troth@troth": [{ scope: "user" }] } }));
      const res = mcpHosts.installInto(claude);
      assert(res.ok && res.skipped === "plugin", "plugin skip path");
      assert(res.permissions && res.permissions.ok, "permissions merged: " + JSON.stringify(res.permissions));
      const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
      const allow = settings.permissions.allow;
      GATEWAY.forEach(function (n) {
        assert(allow.indexOf("mcp__plugin_troth_" + n + "__*") !== -1, n + " plugin-family allowed");
      });
      HEAVY.forEach(function (n) {
        assert(allow.indexOf("mcp__plugin_troth_" + n + "__*") === -1, n + " NOT allowed (behind the router)");
      });
    });
  });

  test("MH-9: direct claude wire pre-approves the direct-named tools, preserves foreign allow entries", () => {
    withSandboxHome(function (home) {
      const claude = hostById("claude");
      const dotClaude = path.join(home, ".claude");
      fs.mkdirSync(dotClaude, { recursive: true });
      fs.writeFileSync(path.join(dotClaude, "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__supabase__*", "Bash(git *)"] }, hooks: { keepme: 1 } }));
      const res = mcpHosts.installInto(claude);
      assert(res.ok, "direct install ok: " + (res.error || ""));
      assert(res.permissions && res.permissions.ok, "permissions merged");
      const settings = JSON.parse(fs.readFileSync(path.join(dotClaude, "settings.json"), "utf8"));
      const allow = settings.permissions.allow;
      GATEWAY.forEach(function (n) {
        assert(allow.indexOf("mcp__" + n + "__*") !== -1, n + " direct-family allowed");
      });
      assert(allow.indexOf("mcp__supabase__*") !== -1, "foreign allow preserved");
      assert(allow.indexOf("Bash(git *)") !== -1, "builtin allow preserved");
      assert.deepStrictEqual(settings.hooks, { keepme: 1 }, "sibling settings keys preserved");
      assert(fs.existsSync(path.join(dotClaude, "settings.json.bak-troth")), "settings backup taken");
      // Idempotent: second run adds nothing new.
      const res2 = mcpHosts.installInto(claude);
      assert(res2.permissions.ok && res2.permissions.added.length === 0, "second run adds no duplicates");
    });
  });

  test("MH-7: router.json provisioning is merge-only (foreign downstream preserved, ours healed)", () => {
    withSandboxHome(function (home) {
      const dir = path.join(home, ".troth");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "router.json"), JSON.stringify({
        mcpServers: {
          "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] },
          "troth-substrate": { command: "old-node", args: ["/old/troth-substrate/server.mjs"] },
        },
      }));
      const res = mcpHosts.provisionRouterConfig();
      assert(res.ok, "provision ok: " + (res.error || ""));
      const rc = routerCfg(home);
      assert(rc.mcpServers["chrome-devtools"].command === "npx", "foreign downstream preserved");
      assert.strictEqual(rc.mcpServers["troth-substrate"].command, process.execPath, "our downstream healed to current node");
      HEAVY.forEach(function (n) { assert(rc.mcpServers[n], n + " present"); });
      assert(fs.existsSync(path.join(dir, "router.json.bak-troth")), "backup taken");
    });
  });
};
