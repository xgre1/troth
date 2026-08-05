// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: atlas).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "atlas") {
  var fsA = require("fs");
  var pathA = require("path");
  var stateA = require("../shared-core/state.js");
  var atlasLib = require("../shared-core/atlas.js");
  var sub = passthrough[0];

  if (sub === "export") {
    // troth atlas export [--cwd /path] [--type edit,lesson] [--out file.ndjson]
    var filter = {};
    var outPath = null;
    for (var ei = 1; ei < passthrough.length; ei++) {
      if (passthrough[ei] === '--cwd' && ei + 1 < passthrough.length) {
        filter.cwd = passthrough[ei + 1]; ei++;
      } else if (passthrough[ei] === '--type' && ei + 1 < passthrough.length) {
        filter.record_types = passthrough[ei + 1].split(',').map(function (s) { return s.trim(); });
        ei++;
      } else if (passthrough[ei] === '--session' && ei + 1 < passthrough.length) {
        filter.session_id = passthrough[ei + 1]; ei++;
      } else if (passthrough[ei] === '--out' && ei + 1 < passthrough.length) {
        outPath = passthrough[ei + 1]; ei++;
      }
    }
    var result = atlasLib.exportAtlas(stateA, { filter: filter });
    if (outPath) {
      fsA.writeFileSync(outPath, result.content);
      console.log("\x1b[32m✓\x1b[0m exported " + result.count + " records → " + outPath);
    } else {
      process.stdout.write(result.content);
    }
    process.exit(0);
  }

  if (sub === "import") {
    // troth atlas import <file> [--conflict skip|overwrite|fail]
    var importPath = passthrough[1];
    if (!importPath) {
      console.error("Usage: troth atlas import <file.ndjson> [--conflict skip|overwrite|fail]");
      process.exit(1);
    }
    if (!fsA.existsSync(importPath)) {
      console.error("File not found: " + importPath);
      process.exit(1);
    }
    var conflict = 'skip';
    for (var ii = 2; ii < passthrough.length; ii++) {
      if (passthrough[ii] === '--conflict' && ii + 1 < passthrough.length) {
        conflict = passthrough[ii + 1]; ii++;
      }
    }
    var content = fsA.readFileSync(importPath, 'utf8');
    var imp = atlasLib.importAtlas(stateA, content, { conflict: conflict });
    console.log("imported: " + imp.imported + ", skipped: " + imp.skipped + ", failed: " + imp.failed);
    if (imp.errors && imp.errors.length) {
      console.log("errors (first 5):");
      for (var ei2 = 0; ei2 < Math.min(5, imp.errors.length); ei2++) {
        console.log("  · " + JSON.stringify(imp.errors[ei2]));
      }
    }
    process.exit(imp.failed > 0 ? 1 : 0);
  }

  if (sub === "inspect") {
    // troth atlas inspect <file> — dry-run validate without importing
    var inspectPath = passthrough[1];
    if (!inspectPath) {
      console.error("Usage: troth atlas inspect <file.ndjson>");
      process.exit(1);
    }
    if (!fsA.existsSync(inspectPath)) {
      console.error("File not found: " + inspectPath);
      process.exit(1);
    }
    var icontent = fsA.readFileSync(inspectPath, 'utf8');
    var info = atlasLib.inspectAtlas(icontent);
    console.log("valid:   " + (info.ok ? "yes" : "no"));
    console.log("records: " + info.records_seen);
    if (info.header) {
      console.log("header:  " + JSON.stringify(info.header));
    }
    if (info.errors && info.errors.length) {
      console.log("errors:");
      for (var iei = 0; iei < info.errors.length; iei++) {
        console.log("  · " + JSON.stringify(info.errors[iei]));
      }
    }
    process.exit(info.ok ? 0 : 1);
  }

  console.error("Usage:");
  console.error("  troth atlas export [--cwd <path>] [--type edit,lesson] [--session <id>] [--out <file>]");
  console.error("  troth atlas import <file.ndjson> [--conflict skip|overwrite|fail]");
  console.error("  troth atlas inspect <file.ndjson>");
  process.exit(1);
}
};
