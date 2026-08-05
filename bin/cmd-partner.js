// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: partner).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "partner") {
  // autonomous-mode step — vessel deployment wrapper.
  //
  //   troth partner up [--faculty <name>] [--build]
  //   troth partner down [--wipe]    # --wipe removes the substrate volume
  //   troth partner logs [-f]
  //   troth partner attach            # interactive shell in the vessel
  //   troth partner status
  //   troth partner exec <args...>    # pass-through troth cmd
  //   troth partner init "<charter>"  # bootstrap the substrate in the vessel
  //
  // Remote vessel (always-on server): set DOCKER_HOST=ssh://user@host
  // before invoking. The compose project still resolves locally; only
  // the docker engine target changes.
  var subPartner = args[1];
  var pathMod   = require("path");
  var childMod  = require("child_process");
  var composeFile = pathMod.resolve(__dirname, "..", "docker", "docker-compose.partner.yml");
  var fsMod = require("fs");
  if (!fsMod.existsSync(composeFile)) {
    console.error("partner: compose file not found at " + composeFile);
    process.exit(2);
  }
  function _dc(args, opts) {
    opts = opts || {};
    var full = ["compose", "-f", composeFile].concat(args);
    var spawnOpts = { stdio: opts.stdio || "inherit", env: process.env };
    var r = childMod.spawnSync("docker", full, spawnOpts);
    if (r.error) {
      console.error("partner: docker not available — " + r.error.message);
      process.exit(2);
    }
    return r;
  }
  function _facultyFlag() {
    for (var i2 = 2; i2 < args.length; i2++) {
      if (args[i2] === "--faculty" && args[i2 + 1]) {
        process.env.TROTH_FACULTY = args[i2 + 1];
        return;
      }
    }
  }
  if (subPartner === "up") {
    _facultyFlag();
    var doBuild = args.indexOf("--build") >= 0;
    var upArgs = ["up", "-d"];
    if (doBuild) upArgs.push("--build");
    var r = _dc(upArgs);
    process.exit(r.status || 0);
  }
  if (subPartner === "down") {
    var wipe = args.indexOf("--wipe") >= 0;
    if (wipe) {
      // Destructive: refuse without explicit confirm env var. CLI typically
      // runs unattended; an env-var gate is safer than a stdin prompt.
      if (process.env.TROTH_PARTNER_WIPE_CONFIRM !== "DELETE") {
        console.error("partner down --wipe DELETES the substrate volume (operator keys, state.db, engrams).");
        console.error("Re-run with TROTH_PARTNER_WIPE_CONFIRM=DELETE to confirm.");
        process.exit(2);
      }
      _dc(["down", "-v"]);
    } else {
      _dc(["down"]);
    }
    process.exit(0);
  }
  if (subPartner === "logs") {
    var followFlag = args.indexOf("-f") >= 0 || args.indexOf("--follow") >= 0;
    var logArgs = followFlag ? ["logs", "-f", "partner"] : ["logs", "partner"];
    var r2 = _dc(logArgs);
    process.exit(r2.status || 0);
  }
  if (subPartner === "attach") {
    var r3 = childMod.spawnSync("docker", ["exec", "-it", "troth-partner", "bash"], { stdio: "inherit" });
    if (r3.error) { console.error("partner attach: " + r3.error.message); process.exit(2); }
    process.exit(r3.status || 0);
  }
  if (subPartner === "status") {
    var ps = childMod.spawnSync("docker", ["ps", "--filter", "name=troth-partner", "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}"], { stdio: "inherit" });
    if (ps.error) { console.error("partner status: " + ps.error.message); process.exit(2); }
    process.exit(ps.status || 0);
  }
  if (subPartner === "exec") {
    var passArgs = args.slice(2);
    if (!passArgs.length) {
      console.error("Usage: troth partner exec <troth-subcommand> [args...]");
      process.exit(2);
    }
    var full = ["exec", "troth-partner", "troth"].concat(passArgs);
    var r4 = childMod.spawnSync("docker", full, { stdio: "inherit" });
    if (r4.error) { console.error("partner exec: " + r4.error.message); process.exit(2); }
    process.exit(r4.status || 0);
  }
  if (subPartner === "init") {
    var charter = args.slice(2).join(" ");
    if (!charter) {
      console.error("Usage: troth partner init \"<charter text>\"");
      console.error("Pass TROTH_OPERATOR_PASSPHRASE in your env.");
      process.exit(2);
    }
    var initArgs = ["exec", "-e", "TROTH_OPERATOR_PASSPHRASE",
                    "troth-partner", "troth", "init", charter];
    var r5 = childMod.spawnSync("docker", initArgs, { stdio: "inherit" });
    if (r5.error) { console.error("partner init: " + r5.error.message); process.exit(2); }
    process.exit(r5.status || 0);
  }
  console.error("Usage: troth partner <up|down|logs|attach|status|exec|init> [flags]");
  console.error("  up           docker compose up -d (--build to rebuild, --faculty <name>)");
  console.error("  down         docker compose down (--wipe also removes substrate volume)");
  console.error("  logs         tail container logs (-f to follow)");
  console.error("  attach       open interactive bash inside the vessel");
  console.error("  status       docker ps for the partner container");
  console.error("  exec <cmd>   run a troth subcommand inside the vessel");
  console.error("  init \"<>\"    bootstrap the substrate (set TROTH_OPERATOR_PASSPHRASE)");
  console.error("");
  console.error("Remote vessel: prefix any of the above with DOCKER_HOST=ssh://user@host");
  process.exit(2);
}
};
