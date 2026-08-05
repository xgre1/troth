// SPDX-License-Identifier: AGPL-3.0-only
// suite-13: open /api/mcp routes.
// The dashboard's Wire buttons POST /api/mcp/install and poll /api/mcp/status;
// strip-l4 batch 4b had orphaned those handlers inside the closed overlay
// (whose owns() only claims /api/l4*), so the buttons 404ed in EVERY build.
// These tests pin the open module's contract. Hermetic: sandbox HOME, stubbed
// execFile for the claude flow (no real `claude` ever runs).
module.exports = function run({ test }) {
  const assert = require("assert");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const routes = require("../proxy/modules/mcp-routes.js");

  console.log("\nOpen MCP routes (/api/mcp, A6 part 2):");

  const GATEWAY = ["troth-router", "troth-bash", "troth-cache", "troth-hashline"];

  function withSandboxHome(fn) {
    const prev = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-routes-test-"));
    process.env.HOME = tmp;
    try { return fn(tmp); }
    finally { process.env.HOME = prev; fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  function fakeReq(method, ip, fullUrl) {
    // Mirrors server.js: handle() gets the query-STRIPPED url; req.url keeps the query.
    return { method: method, url: fullUrl, socket: { remoteAddress: ip || "127.0.0.1" }, headers: {} };
  }
  // Deferred response: resolves when the route answers (covers the async flow).
  function deferredRes() {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const res = {};
    const jsonResponse = (r, code, data) => { res.code = code; res.data = data; resolve(res); };
    return { res, done, jsonResponse };
  }
  const authYes = () => true;
  const authNo = () => false;

  test("MR-1: owns() claims exactly the two endpoints", () => {
    assert(routes.owns("/api/mcp/status"), "status owned");
    assert(routes.owns("/api/mcp/install"), "install owned");
    assert(routes.owns("/api/mcp/install?client=cursor"), "install with query owned");
    assert(!routes.owns("/api/mcp/install-anything"), "install-anything (different path) NOT owned");
    assert(!routes.owns("/api/l4/status"), "l4 not owned");
    assert(!routes.owns("/api/routing"), "other routes not owned");
  });

  test("MR-2: status is read-only, never throws on a bare HOME, reports all-false", () => {
    withSandboxHome(function () {
      const d = deferredRes();
      routes.handle(fakeReq("GET"), {}, "/api/mcp/status", { jsonResponse: d.jsonResponse, checkRemoteAuth: authYes });
      assert.strictEqual(d.res.code, 200);
      assert.strictEqual(d.res.data.ok, true);
      assert.strictEqual(d.res.data.claude_code.plugin_installed, false);
      assert.strictEqual(d.res.data.claude_code.marketplace_added, false);
      assert.strictEqual(d.res.data.plugin_name, "troth@troth");
    });
  });

  test("MR-3: status reads the v2 plugin registry (installed = true)", () => {
    withSandboxHome(function (home) {
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { "troth@troth": [{ scope: "user" }] } }));
      fs.writeFileSync(path.join(pluginsDir, "known_marketplaces.json"),
        JSON.stringify({ troth: { source: "/some/local/checkout" } }));
      const d = deferredRes();
      routes.handle(fakeReq("GET"), {}, "/api/mcp/status", { jsonResponse: d.jsonResponse, checkRemoteAuth: authYes });
      assert.strictEqual(d.res.data.claude_code.plugin_installed, true);
      assert.strictEqual(d.res.data.claude_code.marketplace_added, true, "2.1.19x registry path probed");
    });
  });

  test("MR-4: install without auth is 401 (token gate honored)", () => {
    const d = deferredRes();
    routes.handle(fakeReq("POST", "10.0.0.9"), {}, "/api/mcp/install", { jsonResponse: d.jsonResponse, checkRemoteAuth: authNo });
    assert.strictEqual(d.res.code, 401);
  });

  test("MR-5: install?client=cursor writes the 4-server gateway + provisions router.json", () => {
    withSandboxHome(function (home) {
      const d = deferredRes();
      routes.handle(fakeReq("POST", null, "/api/mcp/install?client=cursor"), {}, "/api/mcp/install", { jsonResponse: d.jsonResponse, checkRemoteAuth: authYes });
      assert.strictEqual(d.res.code, 200, JSON.stringify(d.res.data));
      assert.deepStrictEqual(d.res.data.servers_added.slice().sort(), GATEWAY.slice().sort());
      assert.strictEqual(d.res.data.router, "provisioned");
      const cfg = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
      GATEWAY.forEach((n) => assert(cfg.mcpServers[n], n + " wired"));
      const rc = JSON.parse(fs.readFileSync(path.join(home, ".troth", "router.json"), "utf8"));
      assert(rc.mcpServers["troth-substrate"], "router downstream provisioned");
    });
  });

  test("MR-6: unknown client is a 400, not a crash", () => {
    withSandboxHome(function () {
      const d = deferredRes();
      routes.handle(fakeReq("POST", null, "/api/mcp/install?client=notepad"), {}, "/api/mcp/install", { jsonResponse: d.jsonResponse, checkRemoteAuth: authYes });
      assert.strictEqual(d.res.code, 400);
      assert.strictEqual(d.res.data.error, "unknown_client");
    });
  });

  test("MR-7: claude_code flow runs remove→add(LOCAL core)→install via execFile seam", () => {
    const calls = [];
    const stub = (bin, args, opts, cb) => { calls.push(args.join(" ")); cb(null, "ok", ""); };
    const d = deferredRes();
    withSandboxHome(function () {
      routes.handle(fakeReq("POST"), {}, "/api/mcp/install", { jsonResponse: d.jsonResponse, checkRemoteAuth: authYes, execFileImpl: stub });
    });
    return d.done.then(() => {
      assert.strictEqual(d.res.data.ok, true, JSON.stringify(d.res.data));
      assert.strictEqual(calls.length, 3, "remove + add + install");
      assert(/^plugin marketplace remove troth$/.test(calls[0]), calls[0]);
      assert(/^plugin marketplace add /.test(calls[1]), calls[1]);
      assert(calls[1].indexOf("xgre1/troth") === -1, "local checkout preferred over the GitHub id");
      assert(path.isAbsolute(calls[1].replace("plugin marketplace add ", "")), "marketplace source is an absolute local path");
      assert(/^plugin install troth@troth$/.test(calls[2]), calls[2]);
    });
  });

  test("MR-8: claude_code flow reports marketplace_add_failed when the add step dies", () => {
    const stub = (bin, args, opts, cb) => {
      if (args[1] === "marketplace" && args[2] === "add") { const e = new Error("boom"); e.code = 1; cb(e, "", "boom"); return; }
      cb(null, "ok", "");
    };
    const d = deferredRes();
    withSandboxHome(function () {
      routes.handle(fakeReq("POST"), {}, "/api/mcp/install", { jsonResponse: d.jsonResponse, checkRemoteAuth: authYes, execFileImpl: stub });
    });
    return d.done.then(() => {
      assert.strictEqual(d.res.data.ok, false);
      assert.strictEqual(d.res.data.error, "marketplace_add_failed");
      assert(d.res.data.steps.length >= 2, "steps recorded for diagnosis");
    });
  });
};
