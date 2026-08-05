// SPDX-License-Identifier: AGPL-3.0-only
// `troth config (list|get|set)` — the plain settings surface.
//
// bin/cmd-help.js has always told operators to run
// `troth config set default_command cli|classic`, and CHANGELOG.md repeats it,
// but no handler existed for it: the word `config` matched, none of the four
// subcommand handlers (credential / inbox / web allowlist / l4) claimed it, and
// the CLI fell through to first-run onboarding or the REPL. The instruction was
// real and the setting is real, so the missing piece is the handler.
//
// Secrets are masked on the way out. Reading a key back is a deliberate act with
// its own auth-gated route in the dashboard; it should not be a side effect of
// asking what your settings are, where the answer lands in scrollback, in a
// screen share, or in a pasted bug report.
module.exports = function run(ctx) {
const { args, command, loadConfig } = ctx;
if (command !== "config") return;
const sub = args[1];
if (sub !== "list" && sub !== "get" && sub !== "set") return;

const SECRET_KEY = /(^|[._-])(apikey|api_key|token|secret|password|passphrase|credential)([._-]|$)/i;

function isSecretPath(dotPath) {
  return String(dotPath).split(".").some((seg) => {
    // camelCase is a word boundary too. The first version of this check tested
    // the raw segment, so `remoteToken` (the bearer token for remote proxy
    // access) printed in clear while `remote_token` would have been masked.
    return SECRET_KEY.test(seg.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
  });
}

// Walks the object, replacing secret leaves with a presence marker. The shape
// stays intact so the output is still a map of what exists.
function masked(value, pathSoFar) {
  if (value === null || typeof value !== "object") {
    if (isSecretPath(pathSoFar)) {
      return (typeof value === "string" && value.trim()) ? "<set>" : "(not set)";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => masked(v, pathSoFar + "." + i));
  const out = {};
  for (const k of Object.keys(value)) out[k] = masked(value[k], pathSoFar ? pathSoFar + "." + k : k);
  return out;
}

function readPath(obj, dotPath) {
  let cur = obj;
  for (const seg of String(dotPath).split(".")) {
    if (cur === null || typeof cur !== "object" || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

if (sub === "list") {
  console.log(JSON.stringify(masked(loadConfig(), ""), null, 2));
  console.log("");
  console.log("Secrets show as <set> / (not set). Reveal one in the dashboard under Providers.");
  process.exit(0);
}

if (sub === "get") {
  const dotPath = args[2];
  if (!dotPath) {
    console.error("Usage: troth config get <key>");
    console.error("  Example: troth config get default_command");
    console.error("  `troth config list` shows every key.");
    process.exit(2);
  }
  const value = readPath(loadConfig(), dotPath);
  if (value === undefined) {
    console.error("No such setting: " + dotPath);
    process.exit(1);
  }
  const shown = masked(value, dotPath);
  console.log(typeof shown === "object" ? JSON.stringify(shown, null, 2) : String(shown));
  process.exit(0);
}

// sub === "set"
const dotPath = args[2];
const rawVal  = args[3];
if (!dotPath || rawVal === undefined) {
  console.error("Usage: troth config set <key> <value>");
  console.error("  Example: troth config set default_command classic");
  console.error("  Example: troth config set port 8123");
  console.error("  Provider API keys go through the dashboard, not here.");
  process.exit(2);
}
// __proto__ walks onto Object.prototype, which IS an object, so the mutation
// loop's type guard lets it through: the write lands on the prototype for the
// life of the process, JSON.stringify never serialises it, and readPath finds
// it through the prototype chain and reports success for a value that was
// never saved. constructor is neutralised by the same guard but still leaves a
// junk key. Neither is a setting; refuse both by name.
const UNSAFE_SEGMENT = /^(__proto__|prototype|constructor)$/;
if (String(dotPath).split(".").some((seg) => UNSAFE_SEGMENT.test(seg))) {
  console.error("Refusing " + dotPath + ": __proto__, prototype and constructor are not settings.");
  process.exit(2);
}
if (isSecretPath(dotPath)) {
  console.error("Refusing to set " + dotPath + " from the command line: it would land in your shell history.");
  console.error("Add provider keys in the dashboard under Providers.");
  process.exit(2);
}

// JSON first, so `true`, `8123` and `["a","b"]` arrive as the types they look
// like; a bare word that is not valid JSON stays the string it obviously is,
// rather than making the operator write '"classic"'.
let parsed;
try { parsed = JSON.parse(rawVal); }
catch (_) { parsed = rawVal; }

const parts = dotPath.split(".");
const configFileStore = require("../shared-core/config-file.js");
try {
  // Same single-writer discipline as saveConfig: merge over a fresh strict read
  // rather than writing back a whole object we may have read leniently.
  const after = configFileStore.updateConfig(function (current) {
    let cur = current;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = parsed;
    return current;
  });
  const now = readPath(after && typeof after === "object" ? after : loadConfig(), dotPath);
  console.log("OK. " + dotPath + " = " + JSON.stringify(now === undefined ? parsed : now));
  process.exit(0);
} catch (e) {
  console.error("Could not save: " + (e && e.message || e));
  process.exit(1);
}
};
