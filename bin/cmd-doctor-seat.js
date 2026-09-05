// SPDX-License-Identifier: AGPL-3.0-only
// The doctor's checks from the operator's own seat: which plugin the Claude
// Code sessions really load, whether a hook answers inside its budget, whether
// the proxy freezes, how long recall takes, whether the dense index is built,
// whether a short "ok" keeps its thread, and whether the ChatGPT lane answers.
// Every check runs the way the operator's sessions run it, never a stand-in.
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var spawnPurpose = require('../shared-core/tools/spawn-purpose.js');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function pluginCheck(ctx) {
  var HOME = ctx.HOME || os.homedir();
  var repoRoot = ctx.repoRoot;
  var here = path.join(repoRoot, 'plugin');
  var manifest = readJson(path.join(here, '.claude-plugin', 'plugin.json')) || {};
  var hereVer = String(manifest.version || '?');
  var ip = readJson(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'));
  var entries = (ip && ip.plugins && (ip.plugins['troth@troth'] || ip.plugins['troth'])) || [];
  if (!entries.length) return { name: 'Plugin in Claude Code', ok: false, detail: 'not installed — run: troth install-plugin', installPath: null };
  var e = entries[entries.length - 1];
  var installPath = String(e.installPath || '');
  var ver = String(e.version || '?');
  var real = null; try { real = fs.realpathSync(installPath); } catch (_) { real = installPath; }
  var hereReal = null; try { hereReal = fs.realpathSync(here); } catch (_) { hereReal = here; }
  var fromHere = real === hereReal;
  var core = path.join(installPath, '..', 'shared-core', 'state.js');
  var coreOk = false; try { coreOk = fs.existsSync(fs.realpathSync(core)); } catch (_) { coreOk = false; }
  if (fromHere) return { name: 'Plugin in Claude Code', ok: true, detail: 'v' + ver + ' — runs from this checkout', installPath: installPath };
  if (!coreOk) return { name: 'Plugin in Claude Code', ok: false, detail: 'v' + ver + ' at ' + installPath + ' cannot reach shared-core: the hooks run without memory — run: troth install-plugin', installPath: installPath };
  if (ver !== hereVer) return { name: 'Plugin in Claude Code', ok: false, detail: 'v' + ver + ' in the plugin cache while this checkout is v' + hereVer + ' — the sessions run old hooks: claude plugin update troth@troth, then restart Claude Code', installPath: installPath };
  return { name: 'Plugin in Claude Code', ok: true, detail: 'v' + ver + ', shared-core wired', installPath: installPath };
}

function hookCheck(ctx, installPath) {
  var root = installPath || path.join(ctx.repoRoot, 'plugin');
  var hook = path.join(root, 'hooks', 'injector.mjs');
  if (!fs.existsSync(hook)) return { name: 'Hook answers (UserPromptSubmit)', ok: false, detail: 'injector.mjs missing at ' + root };
  var payload = JSON.stringify({ session_id: 'doctor-' + Date.now(), transcript_path: '', cwd: process.cwd(), hook_event_name: 'UserPromptSubmit', prompt: 'doctor: what did we decide about the proxy and the plugin?' });
  var env = Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: process.cwd() });
  var t0 = Date.now(), out = '', code = 0;
  try {
    out = String(spawnPurpose.execFileSync('hook-context', process.execPath, [hook], { input: payload, env: env, encoding: 'utf8', timeout: 40000, stdio: ['pipe', 'pipe', 'pipe'] }) || '');
  } catch (e) { code = (e && typeof e.status === 'number') ? e.status : -1; out = String((e && e.stdout) || ''); }
  var ms = Date.now() - t0;
  var budget = 25000;
  var ok = code === 0 && ms < 5000;
  var detail = code !== 0 ? ('exited ' + code + ' after ' + ms + ' ms')
    : ms >= budget ? ('took ' + ms + ' ms — past the ' + (budget / 1000) + ' s Claude Code allows; the session discards the memory it carried')
    : ms >= 5000 ? ('took ' + ms + ' ms — slow; recall or the proxy is holding it')
    : ('answered in ' + ms + ' ms' + (out.trim() ? '' : ' (no context emitted)'));
  return { name: 'Hook answers (UserPromptSubmit)', ok: ok, detail: detail };
}

function proxyChecks(ctx) {
  var checks = [];
  var host = ctx.host || '127.0.0.1', port = ctx.port || 8000;
  var get = ctx.httpGetSync;
  var alive = get(host, port, '/api/version', 3000);
  if (alive === null) { checks.push({ name: 'Proxy answers', ok: false, detail: 'no answer on ' + host + ':' + port + ' — run: troth start' }); return checks; }
  var worst = 0;
  for (var i = 0; i < 6; i++) { var t0 = Date.now(); get(host, port, '/api/version', 8000); var d = Date.now() - t0; if (d > worst) worst = d; }
  checks.push({ name: 'Proxy stays responsive', ok: worst < 500, detail: worst < 500 ? ('slowest of 6 pings ' + worst + ' ms') : ('a ping waited ' + worst + ' ms — the proxy froze; see /api/logs?grep=LOOP STALL') });
  var t1 = Date.now();
  var body = get(host, port, '/api/memory/search?q=' + encodeURIComponent('what did we decide') + '&profile=1', 60000);
  var ms = Date.now() - t1;
  var j = null; try { j = JSON.parse(body || ''); } catch (_) { j = null; }
  var phases = (j && j.profile && j.profile.phases) || [];
  var idx = phases.find(function (p) { return /^index_rows:/.test(p); }) || '';
  var rows = parseInt((idx.match(/index_rows:(\d+)/) || [])[1] || '0', 10);
  var hits = parseInt((idx.match(/hits:(\d+)/) || [])[1] || '0', 10);
  checks.push({ name: 'Recall latency', ok: !!j && ms < 1500, detail: !j ? ('no answer in ' + ms + ' ms') : (ms + ' ms · ' + phases.filter(function (p) { return !/^index_rows/.test(p); }).join(' ')) });
  checks.push({ name: 'Dense index', ok: rows > 0 && hits > 0, detail: rows > 0 ? (rows + ' vectors, ' + hits + ' candidates for the probe') : 'not built — pure-semantic recall is off until the proxy warms it' });
  // The maintenance worker beside the loop: alive, in which process, how
  // often it had to be started again, and whether its last cycle failed.
  var rb = get(host, port, '/api/memory/readiness', 20000);
  var rj = null; try { rj = JSON.parse(rb || ''); } catch (_) { rj = null; }
  var w = rj && rj.worker;
  var hostInfo = w && w.host;
  if (!w) {
    checks.push({ name: 'Maintenance worker', ok: false, detail: 'the readiness answer names no worker — the proxy started without one (TROTH_MAINTENANCE=0?)' });
  } else {
    var alive = !hostInfo || hostInfo.alive !== false;
    var err = w.last_tick_error;
    var where = hostInfo && hostInfo.process === 'child' ? ('its own process' + (hostInfo.pid ? ' (pid ' + hostInfo.pid + ')' : '')) : 'the proxy process';
    var again = hostInfo && hostInfo.restarts ? (', started again ' + hostInfo.restarts + 'x') : '';
    var okW = alive && !err && !(hostInfo && hostInfo.restarts > 3);
    checks.push({ name: 'Maintenance worker', ok: okW, detail: (alive ? 'runs in ' + where : 'not running') + again + (err ? ' — last cycle failed: ' + String(err).slice(0, 120) : '') + (hostInfo && hostInfo.last_note ? ' · ' + String(hostInfo.last_note).slice(0, 90) : '') });
  }
  return checks;
}

function continuityCheck(ctx) {
  try {
    var ir = require(path.join(ctx.repoRoot, 'shared-core', 'intent-router.js'));
    var ok = ir.routeInThread('ok psaxe', { thread_live: true }).mount_policy === 'dmn_slot'
      && ir.routeInThread('hi', { thread_live: true }).mount_policy === 'null_mount';
    return { name: 'Thread continuity', ok: ok, detail: ok ? 'a short "ok" inside a thread keeps the thread; a greeting stays a greeting' : 'a short "ok" inside a thread mounts nothing — the engine answers with no context' };
  } catch (e) { return { name: 'Thread continuity', ok: false, detail: 'router missing: ' + (e && e.message || e) }; }
}

function chatgptCheck(ctx) {
  var enabled = false;
  try { enabled = !!((ctx.cfg && ctx.cfg.providers && ctx.cfg.providers.openai_sub && ctx.cfg.providers.openai_sub.enabled)); } catch (_) {}
  if (!enabled) return null;
  var body = ctx.httpGetSync(ctx.host || '127.0.0.1', ctx.port || 8000, '/api/providers/codex/probe', 40000);
  var j = null; try { j = JSON.parse(body || ''); } catch (_) { j = null; }
  if (!j) return { name: 'ChatGPT lane', ok: false, detail: 'probe did not answer' };
  if (j.ok) return { name: 'ChatGPT lane', ok: true, detail: 'answered on ' + j.model + ' in ' + j.elapsed_ms + ' ms' };
  var wait = j.resets_in_seconds ? (' — resets in ' + Math.max(1, Math.round(j.resets_in_seconds / 60)) + ' min') : '';
  return { name: 'ChatGPT lane', ok: false, detail: (j.status ? 'HTTP ' + j.status + ' ' : '') + (j.reason || 'refused') + wait };
}

// The database binding and the node that runs it: hooks, the CLI and the
// proxy load better-sqlite3 with whatever `node` is first on the PATH, and a
// binding built for one Node line refuses to load under another with a
// NODE_MODULE_VERSION message. Every node on the PATH is tried, so the
// one a hook will meet is the one reported.
function nodeAbiCheck(ctx) {
  var cp = require('child_process');
  var binding = path.join(ctx.repoRoot, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(binding)) return { name: 'Database binding', ok: false, detail: 'better-sqlite3 is not installed under this checkout: npm ci' };
  var nodes = [];
  try {
    var w = cp.spawnSync('/bin/sh', ['-lc', 'which -a node'], { encoding: 'utf8', timeout: 8000 });
    nodes = String(w.stdout || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  } catch (_) { nodes = []; }
  if (nodes.indexOf(process.execPath) < 0) nodes.unshift(process.execPath);
  var seen = {}, bad = [], good = [];
  nodes.forEach(function (n) {
    var real = n; try { real = fs.realpathSync(n); } catch (_) {}
    if (seen[real]) return; seen[real] = true;
    var r = cp.spawnSync(n, ['-e', 'require(process.argv[1]); process.stdout.write(process.versions.node)', binding], { encoding: 'utf8', timeout: 15000 });
    var v = String(r.stdout || '').trim();
    if (r.status === 0) { good.push('node ' + v + ' (' + n + ')'); return; }
    var m = /NODE_MODULE_VERSION (\d+)[\s\S]*?requires NODE_MODULE_VERSION (\d+)/.exec(String(r.stderr || ''));
    bad.push((m ? 'built for ABI ' + m[1] + ', this node wants ' + m[2] : 'refuses to load') + ' (' + n + ')');
  });
  if (!bad.length) return { name: 'Database binding', ok: true, detail: 'loads under ' + good.join(', ') };
  return { name: 'Database binding', ok: false, detail: bad.join('; ') + (good.length ? '; loads under ' + good.join(', ') : '') + ' — rebuild for the node the hooks use: cd ' + ctx.repoRoot + ' && npm rebuild better-sqlite3' };
}

function seatChecks(ctx) {
  var out = [];
  var plug = pluginCheck(ctx);
  out.push({ name: plug.name, ok: plug.ok, detail: plug.detail });
  out.push(hookCheck(ctx, plug.installPath));
  out.push(nodeAbiCheck(ctx));
  out = out.concat(proxyChecks(ctx));
  out.push(continuityCheck(ctx));
  var gpt = chatgptCheck(ctx);
  if (gpt) out.push(gpt);
  return out;
}

module.exports = { seatChecks, pluginCheck, hookCheck, nodeAbiCheck, proxyChecks, continuityCheck, chatgptCheck };
