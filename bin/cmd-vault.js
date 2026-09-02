// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: vault).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "vault") {
  // `troth vault unlock`               — prompt passphrase, populate session cache
  // `troth vault lock`                 — zero out session cache
  // `troth vault status`               — show locked/unlocked + entry count
  // `troth vault list`                 — METADATA-only entry list (no values)
  // `troth vault set <key> <cap-scope-glob> [<injection-kind>] [<injection-name>]`
  //                                        prompts for VALUE (hidden), writes entry
  // `troth vault remove <key>`         — delete entry
  // `troth vault capture <gh|keychain|env> [--key k] [--host h] [--service s] [--account a] [--name N]`
  //                                        the proxy reads the value from that source and
  //                                        writes it; nothing prints but the receipt
  var vault7 = require("../shared-core/vault.js");
  var sub7 = args[1] || "status";
  if (sub7 === "status") {
    var s7 = vault7.status();
    console.log(JSON.stringify(s7, null, 2));
    process.exit(0);
  }
  if (sub7 === "lock") {
    vault7.lock();
    console.log("Vault locked.");
    process.exit(0);
  }
  if (sub7 === "unlock") {
    var pass7 = _readPassphraseSync("Operator passphrase (vault)");
    try {
      var u7 = vault7.unlock(pass7);
      console.log("Vault unlocked. " + u7.entry_count + " entries. Session expires at " + new Date(u7.session_expires_at).toISOString() + ".");
    } catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
    process.exit(0);
  }
  if (sub7 === "list") {
    var l7 = vault7.listEntries();
    if (!l7.ok) { console.error("Refused: " + l7.error); process.exit(2); }
    console.log(JSON.stringify(l7.entries, null, 2));
    process.exit(0);
  }
  if (sub7 === "set") {
    var key7 = args[2], capScope7 = args[3];
    var injKind = args[4] || "bearer";
    var injName = args[5] || null;
    if (!key7 || !capScope7) {
      console.error("Usage: troth vault set <key> <capability-scope-glob> [<injection-kind> [<header-or-env-name>]]");
      process.exit(2);
    }
    if (!vault7.isUnlocked()) {
      console.error("Refused: vault locked. Run `troth vault unlock` first.");
      process.exit(2);
    }
    var val7 = _readPassphraseSync("Credential value");
    var w7 = vault7.writeEntry({
      key: key7, value: val7,
      capability_scope_glob: capScope7,
      injection: injName ? { kind: injKind, name: injName } : { kind: injKind },
      // The operator typed this key by hand; `vault set` on an existing
      // key is the rotation path, so replacing here is intentional.
      overwrite: true
    });
    if (!w7.ok) { console.error("Refused: " + w7.error); process.exit(2); }
    console.log("Vault entry written: " + w7.key);
    process.exit(0);
  }
  if (sub7 === "remove") {
    var rkey7 = args[2];
    if (!rkey7) { console.error("Usage: troth vault remove <key>"); process.exit(2); }
    if (!vault7.isUnlocked()) {
      console.error("Refused: vault locked. Run `troth vault unlock` first.");
      process.exit(2);
    }
    var r7 = vault7.removeEntry(rkey7);
    if (!r7.ok) { console.error("Refused: " + r7.error); process.exit(2); }
    console.log("Removed: " + r7.key);
    process.exit(0);
  }
  if (sub7 === "capture") {
    // The unlocked session lives in the proxy process, so the capture runs
    // there: this command only names the source and prints the receipt.
    var src7 = args[2];
    if (!src7) { console.error("Usage: troth vault capture <gh|keychain|env> [--key k] [--host h] [--service s] [--account a] [--name N]"); process.exit(2); }
    var flag7 = function (n) { var i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
    var body7 = { source: src7 };
    [["--key", "key"], ["--host", "host"], ["--service", "service"], ["--account", "account"], ["--name", "name"]].forEach(function (f) {
      var v = flag7(f[0]); if (v) body7[f[1]] = v;
    });
    if (args.indexOf("--overwrite") >= 0) body7.overwrite = true;
    var base7 = String(process.env.TROTH_PROXY_URL || "").trim().replace(/\/+$/, "");
    if (!base7) {
      var host7 = "127.0.0.1", port7 = 8000;
      try {
        var c7 = JSON.parse(require("fs").readFileSync(require("path").join(process.env.HOME || require("os").homedir(), ".troth", "config.json"), "utf8")) || {};
        if (typeof c7.host === "string" && c7.host) host7 = c7.host;
        if (c7.port) port7 = parseInt(c7.port, 10) || port7;
      } catch (_) { /* defaults */ }
      base7 = "http://" + host7 + ":" + port7;
    }
    var payload7 = JSON.stringify(body7);
    var u7c = new URL(base7 + "/api/vault/capture-cli");
    var req7 = require(u7c.protocol === "https:" ? "https" : "http").request({
      method: "POST", hostname: u7c.hostname, port: u7c.port || (u7c.protocol === "https:" ? 443 : 80), path: u7c.pathname,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload7) }
    }, function (res7) {
      var out7 = "";
      res7.setEncoding("utf8");
      res7.on("data", function (c) { out7 += c; });
      res7.on("end", function () {
        var j7; try { j7 = JSON.parse(out7); } catch (_) { j7 = { ok: false, error: "bad_reply", detail: out7.slice(0, 200) }; }
        console.log(JSON.stringify(j7, null, 2));
        process.exit(j7 && j7.ok ? 0 : 2);
      });
    });
    req7.on("error", function (e) { console.error("Refused: proxy unreachable at " + base7 + " (" + e.message + "). Run `troth start`."); process.exit(2); });
    req7.write(payload7); req7.end();
    return;
  }
  console.error("Unknown vault subcommand: " + sub7);
  console.error("Try: status | unlock | lock | list | set | remove | capture");
  process.exit(2);
}
};
