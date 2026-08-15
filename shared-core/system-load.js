// SPDX-License-Identifier: AGPL-3.0-only
// What troth is running on this machine, and what it costs.
//
// The product starts long-lived children — a proxy, two small model servers,
// sometimes a chat model, sometimes a browser, and one MCP server set per
// editor session. When the machine gets hot, the operator's first question is
// "what of yours is doing this?", and until now the only way to answer it was
// a shell and a diagnosis session. The idle reaper already closes what has
// been forgotten; this makes the same inventory VISIBLE, with the one number
// that identifies a burner (CPU time actually consumed) instead of the one
// that lies about it (%CPU, which macOS reports as a lifetime average).
//
// Read-only: one `ps` call, a handful of stat() calls, no sudo anywhere.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Pure parser, so the classification is testable without a live machine ──
//
// Input: `ps -eo pid,rss,time,args` text. Output: troth-owned rows only.
function parsePsSnapshot(psText, opts) {
  const o = opts || {};
  const home = o.home || process.env.HOME || os.homedir();
  const agentProfile = o.agentProfile ||
    path.join(home, '.troth', 'agent-browser-profile');
  const ports = {
    embedder: String(o.embedPort || process.env.TROTH_EMBED_PORT || '11437'),
    reranker: String(o.rerankPort || process.env.TROTH_RERANK_PORT || '11438'),
    'local chat': String(o.localPort || process.env.TROTH_LOCAL_PORT || '11436')
  };

  const rows = [];
  for (const line of String(psText || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, rss, time, args] = m;

    let role = null;
    let port = null;
    const proxyM = args.match(/troth-proxy-(\d+)/);
    if (proxyM) { role = 'proxy'; port = parseInt(proxyM[1], 10); }
    else if (/llama-server/.test(args)) {
      const pm = args.match(/--port (\d+)/);
      port = pm ? parseInt(pm[1], 10) : null;
      for (const [name, p] of Object.entries(ports)) {
        if (String(port) === p) role = name;
      }
      if (!role) role = 'model server';
    }
    else if (/remote-debugging-port=/.test(args) && args.indexOf(agentProfile) !== -1) {
      // ONLY the agent's own browser. The operator's browsers are none of
      // this card's business, whatever port they listen on.
      const bm = args.match(/remote-debugging-port=(\d+)/);
      role = 'browser'; port = bm ? parseInt(bm[1], 10) : null;
    }
    else if (/plugin\/mcp-servers\/([a-z-]+)\/server\.mjs/.test(args)) {
      role = 'mcp:' + args.match(/plugin\/mcp-servers\/([a-z-]+)\/server\.mjs/)[1];
    }
    if (!role) continue;

    rows.push({
      role,
      pid: parseInt(pid, 10),
      rss_mb: Math.round(parseInt(rss, 10) / 1024),
      cpu_seconds: parseCpuTime(time),
      port
    });
  }
  return rows;
}

// ps TIME: [DD-]HH:MM:SS or MM:SS.ss — cumulative CPU actually consumed.
function parseCpuTime(s) {
  let days = 0;
  let t = String(s || '');
  if (t.indexOf('-') !== -1) { const p = t.split('-'); days = parseInt(p[0], 10) || 0; t = p[1]; }
  let sec = 0;
  for (const part of t.split(':')) sec = sec * 60 + parseFloat(part || '0');
  return Math.round(sec + days * 86400);
}

// The reaper's leash for a given role, in minutes — mirrors the target table
// in the proxy so the card can say "closes in 12m" instead of shrugging.
function leashMinutes(role) {
  const base = parseInt(process.env.TROTH_MODEL_IDLE_MIN || '30', 10);
  if (base <= 0) return null;                 // reaper disabled
  if (role === 'local chat') return base * 2;
  if (role === 'browser') return base * 4;
  if (role === 'embedder' || role === 'reranker') return base;
  return null;                                // proxy and MCP servers are not reaped on idle
}

function lastUse(port, home) {
  try {
    const p = path.join(home || process.env.HOME || os.homedir(), '.troth', 'lastuse-' + port + '.txt');
    const v = parseInt(fs.readFileSync(p, 'utf8'), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (_) { return null; }
}

// The full snapshot the route serves.
function snapshot() {
  let psText = '';
  try {
    psText = require('child_process')
      .execSync('ps -eo pid,rss,time,args', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (_) { /* a machine where ps fails still gets the machine block */ }

  const home = process.env.HOME || os.homedir();
  const now = Date.now();
  const processes = parsePsSnapshot(psText, { home }).map((r) => {
    const leash = leashMinutes(r.role);
    const last = r.port ? lastUse(r.port, home) : null;
    let reapInMin = null;
    if (leash != null && last != null) {
      reapInMin = Math.max(0, Math.round(leash - (now - last) / 60000));
    }
    return Object.assign({}, r, {
      last_use: last,
      reap_in_min: reapInMin
    });
  });

  return {
    ts: now,
    machine: {
      cores: os.cpus().length,
      load1: Math.round(os.loadavg()[0] * 100) / 100
    },
    total_rss_mb: processes.reduce((a, p) => a + (p.rss_mb || 0), 0),
    processes
  };
}

module.exports = { snapshot, parsePsSnapshot, parseCpuTime, leashMinutes };
