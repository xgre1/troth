// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: init).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { execFileSync, fs, path, readline, HOME, CONFIG_DIR, VERSION, resolveAgentId, command } = ctx;
if (command === "init") {
  (async function() {
    console.log("\n  troth Init — Substrate Onboarding v" + VERSION + "\n");
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    function ask(q) { return new Promise(function(resolve) { rl.question(q, resolve); }); }
    function yes(q, defNo) { return ask(q + (defNo ? ' [y/N]: ' : ' [Y/n]: ')).then(function(a) { var s = (a || '').trim().toLowerCase(); return defNo ? s === 'y' || s === 'yes' : s !== 'n' && s !== 'no'; }); }

    var checks = [];
    function tick(label, ok, hint) {
      var mark = ok ? "\x1b[32m+\x1b[0m" : "\x1b[33m·\x1b[0m";
      console.log("  " + mark + " " + label + (hint ? "  " + hint : ""));
      checks.push({ label: label, ok: ok });
    }

    // 1. Claude Code installed?
    var claudeDir = path.join(HOME, ".claude");
    var hasClaude = fs.existsSync(claudeDir);
    tick("Claude Code installed (~/.claude)", hasClaude, hasClaude ? "" : "(not detected — substrate still works standalone)");

    // 2. troth dir + L1 init
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    tick("~/.troth directory", true);
    var stateDb = path.join(CONFIG_DIR, "state.db");
    if (!fs.existsSync(stateDb)) {
      try {
        var stateInit = require(path.join(__dirname, "..", "shared-core", "state.js"));
        // Touch any read to trigger lazy migrate
        stateInit.countActions({});
      } catch (e) { /* swallow — state.db will be created on first substrate use anyway */ }
    }
    tick("L1 substrate ledger (state.db)", fs.existsSync(stateDb));

    // 3. .env file
    var envPath = path.join(CONFIG_DIR, ".env");
    if (!fs.existsSync(envPath)) {
      var skel = "# troth secrets — gitignored, 0600 perms\n" +
                 "# Provider API keys (uncomment + fill as needed)\n" +
                 "# ANTHROPIC_API_KEY=sk-ant-...\n" +
                 "# OPENROUTER_API_KEY=sk-or-...\n" +
                 "# DEEPSEEK_API_KEY=...\n" +
                 "# DEEPINFRA_API_KEY=...\n" +
                 "# NVIDIA_API_KEY=...\n" +
                 "# ALIBABA_API_KEY=sk-...\n";
      fs.writeFileSync(envPath, skel, { mode: 0o600 });
      try { fs.chmodSync(envPath, 0o600); } catch (_) {}
      tick("~/.troth/.env created (placeholder)", true);
    } else {
      tick("~/.troth/.env present", true);
    }

    // 4. Claude Code MCP wire — detect plugin .mcp.json next to this file
    var pluginMcp = path.join(__dirname, "..", "plugin", ".mcp.json");
    var hasPluginMcp = fs.existsSync(pluginMcp);
    tick("substrate MCP server (plugin/.mcp.json)", hasPluginMcp,
         hasPluginMcp ? "" : "(reinstall troth — plugin manifest missing)");
    if (hasClaude && hasPluginMcp) {
      var claudeMcpJson = path.join(claudeDir, "mcp.json");
      var alreadyWired = false;
      try {
        if (fs.existsSync(claudeMcpJson)) {
          var existing = JSON.parse(fs.readFileSync(claudeMcpJson, "utf8") || "{}");
          alreadyWired = !!(existing.mcpServers && existing.mcpServers["troth-substrate"]);
        }
      } catch (_) {}
      if (alreadyWired) {
        tick("Claude Code → troth-substrate MCP wired", true);
      } else {
        var wireIt = await yes("\n  Wire substrate MCP into Claude Code's ~/.claude/mcp.json?", false);
        if (wireIt) {
          var serverPath = path.join(__dirname, "..", "plugin", "mcp-servers", "troth-substrate", "server.mjs");
          var current = {};
          try { current = JSON.parse(fs.readFileSync(claudeMcpJson, "utf8") || "{}"); } catch (_) {}
          if (!current.mcpServers) current.mcpServers = {};
          current.mcpServers["troth-substrate"] = {
            // process.execPath, not PATH "node": for the app install this is
            // the BUNDLED node (self-contained; a customer without system
            // Node.js otherwise gets a silent MCP spawn failure), and for a
            // repo/CLI install it is exactly the node that ran init.
            command: process.execPath,
            args: [serverPath],
            env: { TROTH_ENTITY_AGENT_ID: resolveAgentId() }
          };
          fs.writeFileSync(claudeMcpJson, JSON.stringify(current, null, 2));
          tick("Wired into Claude Code", true, "(restart Claude Code to load)");
        }
      }
    }

    // 5. Local LLM backends — used for embeddings + auto-judge
    var llamaPort = 11436, ollamaPort = 11434;
    var llamaUp = await new Promise(function(r) {
      var s = require("net").createConnection(llamaPort, "127.0.0.1");
      s.on("connect", function() { s.destroy(); r(true); });
      s.on("error",   function() { r(false); });
      setTimeout(function() { try { s.destroy(); } catch(_){} r(false); }, 1500);
    });
    var ollamaUp = await new Promise(function(r) {
      var s = require("net").createConnection(ollamaPort, "127.0.0.1");
      s.on("connect", function() { s.destroy(); r(true); });
      s.on("error",   function() { r(false); });
      setTimeout(function() { try { s.destroy(); } catch(_){} r(false); }, 1500);
    });
    tick("llama.cpp on " + llamaPort, llamaUp,
         llamaUp ? "" : "(not running — `llama-server -m <model.gguf> --port 11436 --embeddings`)");
    tick("Ollama on " + ollamaPort, ollamaUp,
         ollamaUp ? "" : "(optional — `ollama serve`)");

    // 6. Backfill existing Claude Code sessions
    if (hasClaude) {
      var sessionsDir = path.join(claudeDir, "projects");
      var hasSessions = fs.existsSync(sessionsDir);
      if (hasSessions) {
        var doBackfill = await yes("\n  Ingest existing Claude Code sessions into substrate? (one-time, ~5-10 min)", true);
        if (doBackfill) {
          console.log("\n  Running backfill — this is safe + idempotent…\n");
          try {
            execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "backfill-claude-sessions.js"), "--max", "10000"],
                         { stdio: "inherit" });
            tick("Backfill complete", true);
          } catch (e) {
            tick("Backfill", false, "(error: " + e.message + ")");
          }
        }
      }
    }

    // 6.5 Operator key: the ceremony that makes the machine yours. The app
    // runs this on its bootstrap screen; the terminal path runs it here.
    // Interactive reads are done, so the readline can close before the
    // raw-fd passphrase reads begin.
    rl.close();
    try {
      var bootC = require(path.join(__dirname, "..", "shared-core", "bootstrap.js"));
      var bootSt = bootC.status();
      if (bootSt.has_bootstrap_seal) {
        tick("Operator key", true, "(already sealed)");
      } else {
        console.log("");
        console.log("  \x1b[1mCryptographically yours.\x1b[0m One passphrase creates your operator");
        console.log("  keypair: it signs the memories you confirm, seals high-stakes actions,");
        console.log("  and encrypts the vault. Nobody can reset it for you.");
        var passC = ctx._readPassphraseSync("  Set operator passphrase (>= 8 chars, Enter to skip)");
        if (!passC) {
          tick("Operator key", false, "(skipped: dashboard Vault page or `troth init --seal` later)");
        } else if (passC.length < 8) {
          tick("Operator key", false, "(too short, 8 chars minimum: run `troth init --seal` when ready)");
        } else {
          var passC2 = ctx._readPassphraseSync("  The same, again");
          if (passC2 !== passC) {
            tick("Operator key", false, "(mismatch: run `troth init --seal` when ready)");
          } else {
            var rInit = bootC.runInit({ passphrase: passC, charter: "" });
            if (rInit.ok) tick("Operator key sealed", true, "(" + rInit.public_key_id + ")");
            else tick("Operator key", false, "(" + (rInit.error || "failed") + ")");
          }
        }
      }
    } catch (eC) { tick("Operator key", false, "(" + (eC && eC.message || eC) + ")"); }

    // 7. Watcher start hint
    console.log("");
    console.log("  Live session watcher (captures every new Claude Code conversation):");
    console.log("    node " + path.relative(process.cwd(), path.join(__dirname, "..", "tools", "claude-session-watcher.js")));
    console.log("");

    // 8. Next steps
    console.log("  \x1b[1mNext steps:\x1b[0m");
    console.log("    • Open dashboard:  troth ui    (or " + require("../shared-core/dashboard-url.js").dashboardUrl("/ui/dashboard.html") + ")");
    console.log("    • Run substrate eval bench:  node benchmarks/substrate-eval-v2.js");
    console.log("    • Add provider keys to ~/.troth/.env  (then `troth start` to enable proxy)");
    if (hasClaude) {
      console.log("    • Restart Claude Code  to pick up MCP wire");
    }
    console.log("");
    console.log("  Substrate ready. Identity injection fires on every Claude Code prompt via hooks.");
    console.log("");
    rl.close();
  })();
  return;
}
};
