// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: kv-state).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { http, command } = ctx;
if (command === "kv-state") {
  var host = process.env.TROTH_LLAMACPP_HOST || "http://127.0.0.1:11436";
  console.log("\n  troth KV-state diagnostic");
  console.log("  host: " + host + "  (env TROTH_LLAMACPP_HOST)");
  console.log("");
  // Probe via a save attempt on a sentinel filename. 200/2xx = slot-save-path
  // configured; 404 with body about action = endpoint exists but flag missing;
  // 500 + 'Slot save/load is not enabled' = same; connection refused = no
  // llama-server at all. Distinguish all three for the operator.
  var urlMod = require("url");
  var probe = urlMod.parse(host);
  var sentinelName = "_troth_kvstate_probe_" + process.pid + ".kv";
  var body = JSON.stringify({ filename: sentinelName });
  var req = http.request({
    method: "POST",
    hostname: probe.hostname,
    port: probe.port || 80,
    path: "/slots/0?action=save",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "connection": "close"
    },
    agent: false,
    timeout: 4000
  }, function (res) {
    var chunks = "";
    res.setEncoding("utf8");
    res.on("data", function (c) { chunks += c; });
    res.on("end", function () {
      var ok = res.statusCode >= 200 && res.statusCode < 300;
      console.log("  HTTP " + res.statusCode + (ok ? "  (slot-save endpoint OK)" : ""));
      if (chunks) console.log("  body: " + chunks.slice(0, 240).replace(/\s+/g, " ").trim());
      console.log("");
      if (ok) {
        console.log("  \u2713 llama-server supports --slot-save-path — KV continuity is PHYSICAL");
        console.log("    (substrate save/restore via shared-core/kv-state.js will succeed)");
        // Clean up the probe file so it doesn't accumulate.
        var del = http.request({
          method: "POST", hostname: probe.hostname, port: probe.port || 80,
          path: "/slots/0?action=erase",
          headers: { "content-length": 0, "connection": "close" },
          agent: false, timeout: 2000
        });
        del.on("error", function () {}); del.end();
      } else if (/slot save\/load|not enabled|slot.save.path/i.test(chunks)) {
        console.log("  \u2717 llama-server reachable but slot save/load NOT enabled");
        console.log("    Restart llama-server with: --slot-save-path /some/dir");
        console.log("    Until then, substrate continuity stays text-only (prefix injection).");
      } else {
        console.log("  ? endpoint responded but shape unrecognized — manual check needed");
      }
      process.exit(0);
    });
  });
  req.on("error", function (e) {
    console.log("  \u2717 cannot reach llama-server at " + host);
    console.log("    error: " + (e && e.message || e));
    console.log("    Either no llama-server is running there, or TROTH_LLAMACPP_HOST");
    console.log("    points at the wrong endpoint. Start one with:");
    console.log("      llama-server -m <model.gguf> --port " + (probe.port || 11436) + " --slot-save-path ~/.troth/kv-slots");
    process.exit(1);
  });
  req.on("timeout", function () {
    req.destroy();
    console.log("  \u2717 timeout connecting to llama-server at " + host);
    process.exit(1);
  });
  req.write(body);
  req.end();
  return;
}
};
