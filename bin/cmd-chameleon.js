// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: chameleon).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "chameleon") {
  var rt = require("../shared-core/chameleon-runtime.js");
  var subC = passthrough[0];
  var rest = passthrough.slice(1);

  function _flag(arr, name) {
    var i = arr.indexOf(name);
    if (i < 0) return null;
    var v = arr[i + 1];
    arr.splice(i, 2);
    return v;
  }

  if (subC === 'list') {
    var rows = rt.listAdapters();
    if (rows.length === 0) {
      console.log("(no adapters registered — run `troth chameleon register` or use the MCP tool)");
    } else {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        console.log(r.name + "  " + r.cmd + " " + (r.args || []).join(" ") +
          (r.default_scope ? "  [scope:" + r.default_scope + "]" : "") +
          (r.source_id ? "  [source:" + r.source_id + "]" : ""));
      }
    }
    process.exit(0);
  }

  if (subC === 'register') {
    var name = rest.shift();
    var sourceId = _flag(rest, '--source-id');
    var defaultScope = _flag(rest, '--default-scope');
    var cmdR = rest.shift();
    var argsR = rest.slice();
    if (!name || !cmdR) {
      console.error("Usage: troth chameleon register <name> <cmd> [arg ...] [--source-id ID] [--default-scope SCOPE]");
      process.exit(1);
    }
    var entry = rt.registerAdapter({
      name: name, cmd: cmdR, args: argsR,
      source_id: sourceId, default_scope: defaultScope
    });
    console.log("registered: " + JSON.stringify(entry));
    process.exit(0);
  }

  if (subC === 'unregister') {
    var nameU = rest.shift();
    if (!nameU) {
      console.error("Usage: troth chameleon unregister <name>");
      process.exit(1);
    }
    var resU = rt.unregisterAdapter(nameU);
    console.log("removed " + resU.removed + " adapter(s)");
    process.exit(0);
  }

  if (subC === 'run') {
    var nameRu = rest.shift();
    var scope = _flag(rest, '--scope');
    if (!nameRu) {
      console.error("Usage: troth chameleon run <name> [--scope SCOPE]");
      process.exit(1);
    }
    rt.runRegisteredAdapter(nameRu, {
      scope: scope || undefined,
      agent_id: 'troth-cli',
      cwd: process.cwd(),
      user_id: process.env.USER || 'cli'
    }).then(function (r) {
      console.log("ingested:    " + r.ingested);
      console.log("record_count:" + r.record_count);
      console.log("source_id:   " + r.source_id);
      console.log("scopes:      " + (r.scopes || []).join(', '));
      if (r.failures && r.failures.length) {
        console.warn("failures:");
        for (var k = 0; k < r.failures.length; k++) console.warn("  " + JSON.stringify(r.failures[k]));
      }
      process.exit(0);
    }).catch(function (e) {
      console.error("run failed: " + e.message);
      process.exit(1);
    });
    return;
  }

  if (subC === 'import') {
    // Convenience: ad-hoc filesystem ingestion through the Chameleon runtime
    // (vs the legacy direct ingestDocument bypass in `troth knowledge
    // import`). Uses the bundled chameleon-filesystem.mjs adapter.
    var importPath = rest.shift();
    var scopeI = _flag(rest, '--scope') || 'docs:fs';
    if (!importPath) {
      console.error("Usage: troth chameleon import <path> [--scope SCOPE]");
      process.exit(1);
    }
    var path2 = require('path');
    var adapterPath = path2.resolve(__dirname, '..', 'adapters', 'chameleon-filesystem.mjs');
    rt.runIngestionFlow('node', [adapterPath, '--root', importPath], {
      scope: scopeI,
      agent_id: 'troth-cli',
      cwd: process.cwd(),
      user_id: process.env.USER || 'cli'
    }).then(function (r) {
      console.log("ingested:    " + r.ingested);
      console.log("record_count:" + r.record_count);
      console.log("source_id:   " + r.source_id);
      console.log("scopes:      " + (r.scopes || []).join(', '));
      process.exit(0);
    }).catch(function (e) {
      console.error("import failed: " + e.message);
      process.exit(1);
    });
    return;
  }

  console.error("Usage:");
  console.error("  troth chameleon list");
  console.error("  troth chameleon register <name> <cmd> [arg ...] [--source-id ID] [--default-scope SCOPE]");
  console.error("  troth chameleon unregister <name>");
  console.error("  troth chameleon run <name> [--scope SCOPE]");
  console.error("  troth chameleon import <path> [--scope SCOPE]");
  process.exit(1);
}
};
