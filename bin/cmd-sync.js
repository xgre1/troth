// SPDX-License-Identifier: AGPL-3.0-only
// Substrate sync commands — pairing devices to the one mind.
//
//   troth device add <name>       (on the MIND machine) mint a device token
//   troth device list             show paired devices + watermarks
//   troth device revoke <id>      cut one device off (one row, no re-keying)
//   troth sync connect <host> <device_id> <token>
//                                 (on the SATELLITE) point this install's
//                                 mind at the hub, then prove it with hello
//   troth sync status             satellite: hub, outbox depth, last gseq
//
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router, same pattern as every extracted command block.
module.exports = function run(ctx) {
const { command, args } = ctx;

if (command === "device") {
  const sub = args[args.indexOf("device") + 1] || "";
  const hub = require("../shared-core/sync/hub.js");

  if (sub === "add") {
    const name = args[args.indexOf("device") + 2];
    if (!name) {
      console.error('usage: troth device add <name>   (e.g. "laptop")');
      process.exit(1);
    }
    const d = hub.addDevice(name);
    console.log("");
    console.log("  Device paired: " + name + "  (" + d.device_id + ")");
    console.log("");
    console.log("  This token is shown ONCE and never stored in the clear:");
    console.log("");
    console.log("    " + d.token);
    console.log("");
    console.log("  On the device, run:");
    console.log("");
    console.log("    troth sync connect http://<this-machine>:8000 " + d.device_id + " <token>");
    console.log("");
    console.log("  (use the Tailscale/VPN address of this machine, and make sure");
    console.log("   the proxy here binds beyond loopback: bindHost in config)");
    process.exit(0);
  }

  if (sub === "list") {
    const rows = hub.listDevices();
    if (!rows.length) { console.log("no paired devices — troth device add <name>"); process.exit(0); }
    for (const r of rows) {
      console.log(
        "  " + r.device_id + "  " + r.name +
        "  seen through dev_seq " + r.last_dev_seq +
        (r.revoked_at ? "  [REVOKED]" : "")
      );
    }
    process.exit(0);
  }

  if (sub === "revoke") {
    const id = args[args.indexOf("device") + 2];
    if (!id) { console.error("usage: troth device revoke <device_id>"); process.exit(1); }
    const ok = hub.revokeDevice(id);
    console.log(ok ? "revoked " + id : "no live device " + id);
    process.exit(ok ? 0 : 1);
  }

  console.error("usage: troth device add <name> | list | revoke <device_id>");
  process.exit(1);
}

if (command === "sync") {
  const sub = args[args.indexOf("sync") + 1] || "";
  const rc = require("../shared-core/sync/remote-client.js");

  if (sub === "connect") {
    const host = args[args.indexOf("sync") + 2];
    const deviceId = args[args.indexOf("sync") + 3];
    const token = args[args.indexOf("sync") + 4];
    if (!host || !deviceId || !token) {
      console.error("usage: troth sync connect <host> <device_id> <token>");
      console.error("       host like http://100.x.y.z:8000 (the mind machine over your VPN)");
      process.exit(1);
    }
    rc.connect(host, deviceId, token).then((h) => {
      if (h && h.ok) {
        console.log("connected — the mind answers at " + host);
        console.log("protocol " + h.protocol + ", ops: " + Object.keys(h.ops || {}).join(", "));
        console.log("this install now writes to and recalls from the hub.");
        process.exit(0);
      }
      console.error("saved, but the hub did not answer hello: " + JSON.stringify(h));
      console.error("check the address, the token, and that the hub's proxy binds beyond loopback.");
      process.exit(1);
    });
    return;
  }

  if (sub === "status") {
    const s = rc.status();
    if (!s.active) { console.log("sync: off (no sync.host in config — this machine holds its own mind)"); process.exit(0); }
    console.log("sync: satellite of " + s.host + " as " + s.device_id);
    console.log("outbox pending: " + s.pending + (s.last_gseq ? "   last hub gseq: " + s.last_gseq : ""));
    rc.hello().then((h) => {
      console.log(h && h.ok ? "hub: reachable (latest gseq " + h.latest_gseq + ")" : "hub: UNREACHABLE — writes queue locally, recall is dark until it returns");
      process.exit(0);
    });
    return;
  }

  if (sub === "flush") {
    rc.flush().then((f) => {
      console.log("flushed " + f.flushed + (f.blocked ? " — blocked: " + f.blocked : ""));
      process.exit(f.blocked ? 1 : 0);
    });
    return;
  }

  if (sub === "off") {
    require("../shared-core/config-file.js").updateConfig((cfg) => { delete cfg.sync; return cfg; });
    console.log("sync: off — this install keeps a local mind again.");
    process.exit(0);
  }

  console.error("usage: troth sync connect <host> <device_id> <token> | status | flush | off");
  process.exit(1);
}
};
