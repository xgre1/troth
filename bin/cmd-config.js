// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: config).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "config" && args[1] === "l4") {
  // The L4 autonomy layer lives in the closed overlay, so on a public clone
  // this require fails. The fallback has to be complete enough to answer the
  // question that was asked: the previous stub defined neither getL4Config nor
  // setL4Config nor verifyCanEnable, so every subcommand threw a raw TypeError
  // at whoever typed it.
  var l4cfg = (function () {
    try { return require('../shared-core/l4-config.js'); }
    catch (e) {
      var absent = function () {
        throw new Error('the autonomous layer is not part of this build');
      };
      return {
        present: false,
        DEFAULTS: {},
        isEnabled: function () { return false; },
        getL4Config: function () { return { present: false, enabled: false }; },
        setL4Config: absent,
        verifyCanEnable: function () {
          return { ok: false, reason: 'not_in_this_build',
                   detail: 'the autonomous layer ships with the app, not with this tree' };
        }
      };
    }
  }());
  if (l4cfg.present === false) {
    console.error('note: the autonomous (L4) layer is not part of this build.');
  }
  var l4Sub = args[2] || "get";
  if (l4Sub === "get") {
    console.log(JSON.stringify(l4cfg.getL4Config(), null, 2));
    process.exit(0);
  }
  if (l4Sub === "enable") {
    try {
      var result = l4cfg.setL4Config({ enabled: true });
      console.log("autonomous mode ENABLED.");
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (e) {
      console.error("Refused to enable: " + e.message);
      process.exit(2);
    }
  }
  if (l4Sub === "disable") {
    l4cfg.setL4Config({ enabled: false });
    console.log("autonomous mode DISABLED.");
    process.exit(0);
  }
  if (l4Sub === "set") {
    // troth config l4 set <dotpath> <jsonValue>
    var dotPath = args[3];
    var rawVal  = args[4];
    if (!dotPath || rawVal === undefined) {
      console.error("Usage: troth config l4 set <dotpath> <jsonValue>");
      console.error("  Example: troth config l4 set transparency_level '\"execute_and_brief\"'");
      console.error("  Example: troth config l4 set idle_pursuit true");
      console.error("  Example: troth config l4 set budgets.code 8");
      process.exit(2);
    }
    var parsedVal;
    try { parsedVal = JSON.parse(rawVal); }
    catch (e) {
      console.error("Bad JSON value: " + e.message + " (try wrapping strings in single+double quotes: '\"foo\"')");
      process.exit(2);
    }
    // Build patch object from dotted path. Two-level deep ({k1:{k2:v}}).
    var pathParts = dotPath.split(".");
    var patch = {};
    if (pathParts.length === 1) {
      patch[pathParts[0]] = parsedVal;
    } else if (pathParts.length === 2) {
      patch[pathParts[0]] = {};
      patch[pathParts[0]][pathParts[1]] = parsedVal;
    } else {
      console.error("Only one or two-level dotted paths supported (got: " + dotPath + ")");
      process.exit(2);
    }
    try {
      var setResult = l4cfg.setL4Config(patch);
      console.log("OK. " + dotPath + " = " + JSON.stringify(parsedVal));
      console.log(JSON.stringify(setResult, null, 2));
      process.exit(0);
    } catch (e) {
      console.error("Refused: " + e.message);
      process.exit(2);
    }
  }
  if (l4Sub === "verify") {
    var v = l4cfg.verifyCanEnable();
    if (v.ok) {
      console.log("OK — " + v.usable_providers + " usable provider(s).");
      process.exit(0);
    } else {
      console.error("NOT OK — " + v.reason + ": " + v.detail);
      process.exit(2);
    }
  }
  console.error("Usage: troth config l4 <get|enable|disable|set|verify>");
  process.exit(2);
}
};
