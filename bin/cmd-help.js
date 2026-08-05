// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: help).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { CONFIG_FILE, VERSION, loadConfig, command, showAdvanced } = ctx;
if (command === "help") {
  // Tiered help: primary (everyday), then advanced (--advanced), then a
  // line pointing at config + version. Internal/dev commands stay hidden
  // but remain wired and functional.
  var helpCfg = loadConfig();
  var DEFAULT_CMD = helpCfg.default_command || "cli";
  var defaultLabel = DEFAULT_CMD === "cli" ? "troth cli (substrate REPL)" : "claude through proxy";
  var lines = [
    "",
    "  troth v" + VERSION + " — substrate-as-identity coding agent",
    "",
    "  CHAT",
    "    troth                  launch chat (current default: " + defaultLabel + ")",
    "    troth -a               same, with auto-accept on",
    "    troth cli              troth native REPL (substrate-native REPL)",
    "    troth body             REPL into the autonomous runtime",
    "",
    "  WORK",
    "    troth run \"<task>\"     background worker",
    "    troth run \"<task>\" -f  same, follow live output",
    "    troth status [<id>]    list runs or inspect one",
    "    troth logs <id> [-f]   show or follow a run's output",
    "    troth kill <id>        stop a run",
    "",
    "  TOOLS",
    "    troth ui               open dashboard (http://localhost:8000/ui)",
    "    troth mcp              start MCP server (stdio JSON-RPC)",
    "    troth setup            first-run setup wizard",
    "    troth doctor           health check",
    "    troth codex login      sign in with your own ChatGPT subscription",
    "    troth version          print version",
    "",
    "  CONFIG",
    "    " + CONFIG_FILE,
    "    set the default with: troth config set default_command cli|classic",
    ""
  ];
  if (showAdvanced) {
    lines.push("  ADVANCED  (run scaffolding, scheduling, substrate introspection)");
    lines.push("    troth schedule add|list|remove   recurring runs (timer off unless TROTH_ENABLE_SCHEDULER=1)");
    lines.push("    troth diff <id>                  what a run changed");
    lines.push("    troth merge <id>                 cherry-pick run commits");
    lines.push("    troth clean <id>|--all|--stuck   prune runs / proxy siblings");
    lines.push("    troth stats                      module stats");
    lines.push("    troth telemetry                  model telemetry (cache, drift)");
    lines.push("    troth reflect                    recent reflexion lessons");
    lines.push("    troth dream                      consolidate reflexion memory");
    lines.push("    troth plan                       workflow state");
    lines.push("    troth checkpoint [msg]           manual git stash checkpoint");
    lines.push("    troth rollback                   rollback to last checkpoint");
    lines.push("    troth race \"<task>\"              fan out across providers");
    lines.push("    troth race-result <group>        compare race outputs");
    lines.push("    troth atlas                      substrate map");
    lines.push("    troth mind                       mind-protocol introspection");
    lines.push("    troth schema                     schema reflector");
    lines.push("    troth replay [<intent>]          counterfactual replay");
    lines.push("    troth knowledge                  curriculum import");
    lines.push("    troth chameleon                  adapter registry / driver");
    lines.push("    troth tenant                     multi-tenant ops");
    lines.push("    troth orchestrate                role orchestrator");
    lines.push("    troth orchestrate-status         orchestrator status");
    lines.push("    troth incognito                  substrate read-only mode");
    lines.push("    troth memory-clear [scope]       wipe stale memory");
    lines.push("    troth mcp-audit                  measure MCP prompt overhead");
    lines.push("    troth install-plugin             register plugin in Claude Code");
    lines.push("    troth uninstall-plugin           reverse the install");
    lines.push("    troth start | restart | tail | reset  proxy lifecycle");
    lines.push("");
  } else {
    lines.push("  More: troth --help --advanced");
    lines.push("");
  }
  console.log(lines.join("\n"));
  process.exit(0);
}
};
