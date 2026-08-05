// SPDX-License-Identifier: AGPL-3.0-only
// cmd-mcp-install.js — `troth mcp install [host]` / `troth mcp hosts`.
//
// One-command MCP wiring. A3:
// the install semantics moved to shared-core/mcp-hosts.js so the CLI, the
// proxy route /api/mcp/install and the app installer share ONE behavior
// (merge-only, backup, atomic write, fail-closed JSON, plugin-awareness for
// Claude Code, absolute bundled-node paths). This file is only the CLI UX.

module.exports = function run(ctx) {
  const { passthrough } = ctx;
  const mcpHosts = require("../shared-core/mcp-hosts.js");
  const sub = passthrough[0]; // "install" | "hosts"
  const HOSTS = mcpHosts.hosts();

  if (sub === "hosts") {
    console.log("MCP hosts:");
    for (const h of HOSTS) {
      console.log("  " + h.id.padEnd(15) + h.label.padEnd(17) + mcpHosts.hostStatus(h) + "  (" + h.cfg + ")");
    }
    console.log("");
    console.log("Wire one:  troth mcp install <host>   (or: troth mcp install all)");
    console.log("Note: `all` skips hosts under ~/Library (cline, claude_desktop) because");
    console.log("macOS prompts for access — name them explicitly to wire them.");
    return;
  }

  // sub === "install"
  const target = (passthrough[1] || "claude").toLowerCase();
  const picked = target === "all"
    ? HOSTS.filter((h) => !h.tcc)
    : HOSTS.filter((h) => h.id === target);
  if (!picked.length) {
    console.error("Unknown host: " + target);
    console.error("Hosts: " + HOSTS.map((h) => h.id).join(", ") + " (or: all)");
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const h of picked) {
    const res = mcpHosts.installInto(h);
    if (res.ok && res.skipped === "plugin") {
      console.log(h.label + ": " + res.note + " — nothing to write.");
    } else if (res.ok) {
      console.log(h.label + ": wired " + res.added.length + " troth servers into " + res.cfgPath);
      if (res.missing && res.missing.length) {
        console.log("  note: skipped missing servers: " + res.missing.join(", "));
      }
    } else {
      failed = true;
      console.error(h.label + ": " + res.error);
    }
  }
  if (!failed) {
    console.log("");
    console.log("Restart the host app to pick up the new tools.");
  } else {
    process.exitCode = 1;
  }
};
