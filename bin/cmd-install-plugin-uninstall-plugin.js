// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: install-plugin, uninstall-plugin).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, migrateHeavyMcps, applyBashDenyDefault, deferHeavy } = ctx;
if (command === "install-plugin" || command === "uninstall-plugin") {
  // Single-command plugin wiring. The raw `claude plugin` flow requires
  // `marketplace add` + `install` + remembering the @marketplace suffix;
  // most users hit friction at step 2. This wrapper just runs the full
  // sequence (or reverses it) against this repo's marketplace manifest.
  var cpSync = require("child_process").spawnSync;
  var repoRoot = require("path").resolve(__dirname, "..");
  var fsMod = require("fs");
  var manifestPath = require("path").join(repoRoot, ".claude-plugin", "marketplace.json");
  if (!fsMod.existsSync(manifestPath)) {
    console.error("Expected marketplace manifest at " + manifestPath + " but it is missing.");
    console.error("Are you running this from inside the troth repo?");
    process.exit(1);
  }

  if (command === "install-plugin") {
    console.log("\n  Installing troth plugin…\n");
    var r1 = cpSync("claude", ["plugin", "marketplace", "add", repoRoot], { stdio: "inherit" });
    if (r1.status !== 0 && r1.status !== 1) {
      // status=1 often just means "already added" — soldier on.
      console.error("  marketplace add exited with status " + r1.status + "; continuing anyway");
    }
    var r2 = cpSync("claude", ["plugin", "install", "troth@troth-local"], { stdio: "inherit" });
    if (r2.status !== 0) { process.exit(r2.status); }

    // Plugin manifest source = ./plugin/, so CC's installer only copies that
    // subtree into the cache. Hooks + MCP servers reach back into the repo via
    // `pluginRoot/../<dir>/` paths, which land one level above the cached plugin
    // root. Symlink each required sibling directory there so those imports
    // resolve without touching plugin code, and so `npm install` / source edits
    // in the repo are picked up live without reinstalling the plugin.
    var pathMod = require("path");
    var osMod = require("os");
    var pluginManifest = require(pathMod.join(repoRoot, "plugin", ".claude-plugin", "plugin.json"));
    var pluginVersion = pluginManifest.version || "unknown";
    var cacheParent = pathMod.join(osMod.homedir(), ".claude", "plugins", "cache", "troth-local", "troth");
    // Add new entries here when plugin code starts importing from a new
    // top-level repo directory (keeps install drift to a single line).
    var requiredSiblings = ["shared-core", "proxy", "node_modules"];

    if (!fsMod.existsSync(cacheParent)) {
      console.error("  \x1b[33m⚠\x1b[0m plugin cache parent missing at " + cacheParent + " — did `claude plugin install` succeed?");
    } else {
      requiredSiblings.forEach(function (dir) {
        var src = pathMod.join(repoRoot, dir);
        var dst = pathMod.join(cacheParent, dir);
        if (!fsMod.existsSync(src)) {
          console.error("  \x1b[33m⚠\x1b[0m repo " + dir + "/ missing at " + src + (dir === "node_modules" ? " — run `npm install` first." : " — plugin imports will fail."));
          return;
        }
        try { fsMod.unlinkSync(dst); } catch (_) { /* not a symlink */ }
        try { fsMod.rmSync(dst, { recursive: true, force: true }); } catch (_) { /* nothing there */ }
        fsMod.symlinkSync(src, dst, "dir");
        console.log("  \x1b[32m✓\x1b[0m symlinked " + dir + "/ → " + dst);
      });
      console.log("  \x1b[32m✓\x1b[0m plugin v" + pluginVersion + " sibling dirs wired into " + cacheParent);
    }

    console.log("\n  \x1b[32m✓\x1b[0m plugin installed. Verify with: claude plugin list | grep troth");

    if (deferHeavy) {
      console.log("\n  --defer-heavy: auditing MCP servers and migrating HEAVY ones to the router…\n");
      var migrateResult = migrateHeavyMcps();
      if (migrateResult.migrated.length) {
        console.log("\n  \x1b[32m✓\x1b[0m Migrated " + migrateResult.migrated.length + " HEAVY MCP server(s) to ~/.troth/router.json:");
        migrateResult.migrated.forEach(function (n) { console.log("    • " + n); });
        console.log("\n  Original settings backed up to: " + migrateResult.backup);
        console.log("  Restart Claude Code for the new routing to take effect.");
      } else if (migrateResult.error) {
        console.error("\n  \x1b[33m⚠\x1b[0m  Migration skipped: " + migrateResult.error);
      } else {
        console.log("\n  No HEAVY MCP servers found — nothing to migrate.");
      }
    } else {
      // P0.1 — auto-apply the Bash-deny rule that previously was just a
      // printed recommendation. Without this, plugin-mode adds tokens
      // because Bash
      // output flows raw into context; with the deny rule the model is
      // forced to route through mcp__troth-bash__run which compresses
      // the output before it enters context. Idempotent: if Bash is
      // already present in permissions.deny, the rule is left alone.
      try {
        var denyResult = applyBashDenyDefault();
        if (denyResult.applied) {
          console.log("\n  \x1b[32m✓\x1b[0m settings.json: added Bash to permissions.deny");
          console.log("    Shell work now routes through mcp__troth-bash__run (compressed output).");
          console.log("    Backup at " + denyResult.backup);
        } else if (denyResult.alreadySet) {
          console.log("\n  \x1b[2m·\x1b[0m settings.json: Bash already in permissions.deny — left as-is.");
        } else if (denyResult.error) {
          console.error("\n  \x1b[33m⚠\x1b[0m  Could not auto-apply Bash deny: " + denyResult.error);
          console.error("     Add manually:  \"permissions\": { \"deny\": [\"Bash\"] }");
        }
      } catch (e) {
        console.error("\n  \x1b[33m⚠\x1b[0m  Bash deny defaults skipped: " + e.message);
      }
      console.log("\n  Optional: run  troth install-plugin --defer-heavy  to auto-migrate HEAVY MCPs");
      console.log("    behind the troth-router (9-15K tokens/turn saved per deferred server).");
    }
    console.log("");
    process.exit(0);
  }

  if (command === "uninstall-plugin") {
    console.log("\n  Uninstalling troth plugin…\n");
    var ru = cpSync("claude", ["plugin", "uninstall", "troth"], { stdio: "inherit" });
    if (ru.status !== 0) { process.exit(ru.status); }
    var rm = cpSync("claude", ["plugin", "marketplace", "remove", "troth-local"], { stdio: "inherit" });
    // status ≠ 0 is fine here (might not have been added)
    // Mirror the install side: tear down every sibling we wired in.
    var pathModU = require("path");
    var cacheParentU = pathModU.join(require("os").homedir(), ".claude", "plugins", "cache", "troth-local", "troth");
    ["shared-core", "proxy", "node_modules"].forEach(function (dir) {
      var dst = pathModU.join(cacheParentU, dir);
      try { fsMod.unlinkSync(dst); } catch (_) { /* not a symlink */ }
      try { fsMod.rmSync(dst, { recursive: true, force: true }); } catch (_) { /* nothing there */ }
    });
    console.log("\n  \x1b[32m✓\x1b[0m plugin uninstalled. State at ~/.troth/state.db is preserved (delete manually for a clean slate).\n");
    process.exit(0);
  }
}
};
