// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: replicate-wal).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "replicate-wal") {
  // `troth replicate-wal --dest <path> [--once|--interval <sec>]`
  function _flag5(name) {
    var idx = args.indexOf(name);
    return (idx >= 0 && args[idx + 1]) ? args[idx + 1] : null;
  }
  var dest5 = _flag5("--dest");
  if (!dest5) {
    console.error("Usage: troth replicate-wal --dest <path> [--once | --interval <seconds>]");
    process.exit(2);
  }
  var walRep = require("../shared-core/wal-replicate.js");
  var intervalSec = _flag5("--interval");
  if (args.indexOf("--once") >= 0 || !intervalSec) {
    walRep.runOnce({ dest: dest5 }).then(function (r) {
      if (!r.ok) { console.error("Backup failed: " + r.error + (r.detail ? ' — ' + r.detail : '')); process.exit(2); }
      console.log("Backup OK → " + r.dest + (r.bytes ? ' (' + r.bytes + ' bytes)' : ''));
      process.exit(0);
    });
  } else {
    var cadenceMs = Math.max(60_000, Number(intervalSec) * 1000);
    var handle = walRep.startReplicator({ dest: dest5, cadence_ms: cadenceMs });
    console.log("WAL replicator started → " + dest5 + " every " + (cadenceMs / 1000) + "s (Ctrl-C to stop).");
    var statusTimer = setInterval(function () {
      var s = handle.status();
      if (s.last_backup_ms) {
        console.log("  last_backup=" + new Date(s.last_backup_ms).toISOString() +
                    " size=" + (s.last_backup_size || '?') +
                    (s.last_backup_error ? (' err=' + s.last_backup_error) : ''));
      }
    }, cadenceMs);
    process.on('SIGINT', function () {
      clearInterval(statusTimer);
      handle.stop();
      console.log("\nWAL replicator stopped.");
      process.exit(0);
    });
  }
  return;
}
};
