// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The context a journey scenario gets: a FRESH HOME and the three surfaces a
// person actually touches — the entity daemon over its wire protocol, the CLI,
// and the proxy's HTTP API. Nothing here reaches into the product's internals;
// if a scenario cannot express itself through these, a user could not have hit
// it either.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function make({ root, target }) {
  // Run the product on the runtime the product ships with. The app bundle
  // carries its own node, and driving its core with whatever node happens to
  // be on PATH made every native module (better-sqlite3) fail a
  // NODE_MODULE_VERSION check — a harness fault that reads exactly like three
  // broken commands. A harness that lies about the product is worse than none.
  const bundled = path.join(root, 'node');
  const NODE = fs.existsSync(bundled) ? bundled : process.execPath;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-'));
  fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
  const children = [];

  const baseEnv = () => Object.assign({}, process.env, {
    HOME: home,
    // Never fetch a multi-hundred-MB model because a scenario asked a question.
    TROTH_LLAMA_SERVER_BIN: '/nonexistent-journey-no-fetch',
    TROTH_NO_MODEL_FETCH: '1',
  });

  const ctx = {
    root, target, home,

    /** Write ~/.troth/config.json for this scenario's HOME. */
    writeConfig(obj) {
      fs.writeFileSync(path.join(home, '.troth', 'config.json'), JSON.stringify(obj, null, 2));
    },
    /** Write any file under the fresh HOME (e.g. a codex token). */
    writeHomeFile(rel, contents) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
    },
    readConfig() {
      try { return JSON.parse(fs.readFileSync(path.join(home, '.troth', 'config.json'), 'utf8')); }
      catch (_) { return null; }
    },

    /**
     * Speak the entity's wire protocol the way the app does — including
     * keeping stdin OPEN afterwards. Closing it immediately races the async
     * slash path and makes working handlers look dead; a harness that lies
     * about the product is worse than no harness.
     */
    daemon(lines, { env = {}, settleMs = 9000, timeoutMs = 60000 } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(NODE, [path.join(root, 'bin', 'troth-entity.js')], {
          cwd: root, env: Object.assign(baseEnv(), env), stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        const events = []; let out = '', err = '';
        child.stdout.on('data', (d) => {
          out += d.toString();
          let nl;
          while ((nl = out.indexOf('\n')) >= 0) {
            const line = out.slice(0, nl).trim(); out = out.slice(nl + 1);
            if (!line) continue;
            try { events.push(JSON.parse(line)); } catch (_) { /* human log noise */ }
          }
        });
        child.stderr.on('data', (d) => { err += d.toString(); });
        const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.on('error', (e) => { clearTimeout(hard); reject(e); });
        child.on('close', () => { clearTimeout(hard); resolve({ events, stderr: err }); });
        child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        setTimeout(() => { try { child.stdin.end(); } catch (_) {} }, settleMs);
      });
    },

    /** One user_input line, with a conversation id (a "pane"). */
    say(text, conversationId) {
      return { type: 'user_input', input: { text }, options: { conversation_id: conversationId } };
    },

    /** Run the CLI as a person would: `troth <args>`. */
    cli(args, { env = {}, timeoutMs = 60000 } = {}) {
      return new Promise((resolve) => {
        const child = spawn(NODE, [path.join(root, 'bin', 'troth.js')].concat(args), {
          cwd: root, env: Object.assign(baseEnv(), env), stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.on('close', (code) => { clearTimeout(hard); resolve({ stdout, stderr, code }); });
        child.stdin.end();
      });
    },

    /** Boot the proxy on a free-ish port and return an HTTP client for it. */
    async proxy({ port = 8700 + Math.floor(process.pid % 200), env = {}, bootMs = 25000 } = {}) {
      const child = spawn(NODE, [path.join(root, 'proxy', 'server.js')], {
        cwd: root,
        // TROTH_EXIT_WITH_PID: the proxy watches this pid and exits when it
        // dies. Teardown used to depend on the runner living long enough to
        // call cleanup(); a SIGKILLed runner left the proxy orphaned under
        // launchd — and one such orphan span a core for hours.
        env: Object.assign(baseEnv(), { GF_PORT: String(port), GF_WATCH_DIR: os.tmpdir(),
          TROTH_EXIT_WITH_PID: String(process.pid) }, env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let log = '';
      child.stdout.on('data', (d) => { log += d.toString(); });
      child.stderr.on('data', (d) => { log += d.toString(); });
      const req = (method, p, body) => new Promise((resolve) => {
        const data = body == null ? null : JSON.stringify(body);
        const r = http.request({ host: '127.0.0.1', port, path: p, method,
          headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
          timeout: 12000 }, (res) => {
          let b = ''; res.on('data', (c) => { b += c; });
          res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, body: b }); });
        });
        r.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
        r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, error: 'timeout' }); });
        if (data) r.write(data);
        r.end();
      });
      const deadline = Date.now() + bootMs;
      while (Date.now() < deadline) {
        const probe = await req('GET', '/api/setup/local');
        if (probe.status && probe.status !== 0) break;
        await new Promise((r) => setTimeout(r, 700));
      }
      return { port, get: (p) => req('GET', p), post: (p, b) => req('POST', p, b), log: () => log };
    },

    /** Stop every process started so far, keeping the HOME. For restart tests. */
    async killProxies() {
      for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
      children.length = 0;
      await new Promise((r) => setTimeout(r, 600));
    },

    async cleanup() {
      for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
      await new Promise((r) => setTimeout(r, 200));
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    },
  };
  return ctx;
}

module.exports = { make };
