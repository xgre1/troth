// SPDX-License-Identifier: AGPL-3.0-only
// Situated awareness.
//
// Produces a `Situation` snapshot prepended to planning prompts so the
// partner KNOWS its current operational context — time, focus app, git
// state, recently-modified files. Without this the mind operates in a
// vacuum: it doesn't know whether it's 9am Monday before standup or 2am
// Saturday with uncommitted work in front of it.
//
// design grounding:
//   - Klinger current concerns (1987, 2013) — active situational context
//     biases attention/retrieval. Without situated context, recall is
//     ungrounded.
//   - Andrews-Hanna DMN (2014, Nat Rev Neurosci §self-generated thought)
//     situated self-awareness is core to default-mode cognition.
//   - design (Auto-Calibrated Confidence): empirical numbers
//     beat hallucinated ones; same principle for situational state —
//     query the OS, don't ask the LLM.
//
// v1 collectors (local-only, no credentials needed):
//   iso_time, tz                    — Date + Intl.DateTimeFormat
//   day_of_week, hour_local         — derived
//   git_status                      — execSync 'git status --porcelain'
//   git_branch + git_ahead_behind   — execSync 'git status -b --porcelain'
//   recent_files                    — git diff --name-only HEAD~3 (cwd-scoped)
//   battery_pct + on_ac             — macOS pmset / Linux /sys/class
//   frontmost_app                   — macOS AppleScript (skipped on Linux)
//   uptime_s                        — Node process.uptime()
//   load_average                    — os.loadavg() (1/5/15-min)
//   free_mem_pct                    — os.freemem / os.totalmem
//
// v2 (deferred):
//   calendar_next3                  — Google Calendar via vault credential
//                                     (extended tools module)
//   slack_status / dnd              — operator presence signals
//
// Cache: in-process 60s default (per the design spec spec). Refresh on demand
// via opts.force_refresh = true. Cache key includes cwd so per-project
// snapshots stay accurate.

'use strict';

const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_CACHE_MS = 60 * 1000;
const _cache = new Map();  // key: cwd -> { snapshot, cached_at }

function _safeExec(cmd, opts) {
  try {
    return execSync(cmd, Object.assign({
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }, opts || {})).trim();
  } catch (_) { return null; }
}

function _collectTime() {
  const now = new Date();
  let tz;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { tz = 'UTC'; }
  return {
    iso_time: now.toISOString(),
    tz,
    day_of_week: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()],
    hour_local: now.getHours(),
    epoch_ms: now.getTime()
  };
}

function _collectGit(cwd) {
  if (!cwd) return null;
  const branchRaw = _safeExec('git status -b --porcelain', { cwd });
  if (!branchRaw) return null;  // not a git repo OR git absent
  const lines = branchRaw.split('\n');
  const header = lines[0] || '';
  // "## main...origin/main [ahead 2, behind 1]"
  const branchMatch = header.match(/^##\s+([^\s.]+)/);
  const aheadMatch = header.match(/\bahead (\d+)/);
  const behindMatch = header.match(/\bbehind (\d+)/);
  const dirty = lines.slice(1).filter(Boolean);
  return {
    branch: branchMatch ? branchMatch[1] : null,
    ahead:  aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? parseInt(behindMatch[1], 10) : 0,
    dirty_count: dirty.length,
    dirty_files: dirty.slice(0, 10).map(l => l.slice(3))  // strip "MM " prefix
  };
}

function _collectRecentFiles(cwd) {
  if (!cwd) return null;
  // Last 3 commits' files (modified recently in dev terms)
  const raw = _safeExec('git diff --name-only HEAD~3 HEAD 2>/dev/null || git diff --name-only HEAD', { cwd });
  if (!raw) return null;
  return raw.split('\n').filter(Boolean).slice(0, 10);
}

function _collectBattery() {
  if (process.platform === 'darwin') {
    const raw = _safeExec('pmset -g batt');
    if (!raw) return null;
    // " 95%; discharging; ..." or "100%; AC attached;"
    const pctMatch = raw.match(/(\d+)%/);
    const onAc = /AC (Power|attached)|charged|charging/i.test(raw);
    return {
      pct: pctMatch ? parseInt(pctMatch[1], 10) : null,
      on_ac: onAc
    };
  }
  if (process.platform === 'linux') {
    // /sys/class/power_supply/BAT0/capacity
    try {
      const fs = require('fs');
      const candidates = fs.readdirSync('/sys/class/power_supply').filter(n => /^BAT/.test(n));
      if (!candidates.length) return null;
      const cap = parseInt(fs.readFileSync('/sys/class/power_supply/' + candidates[0] + '/capacity', 'utf8'), 10);
      let status = '';
      try { status = fs.readFileSync('/sys/class/power_supply/' + candidates[0] + '/status', 'utf8').trim(); } catch (_) {}
      return { pct: cap, on_ac: /Charging|Full/i.test(status) };
    } catch (_) { return null; }
  }
  return null;
}

function _collectFrontmostApp() {
  if (process.platform !== 'darwin') return null;
  // AppleScript: name of frontmost app. Cheap, ~50ms.
  const raw = _safeExec('osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\'');
  return raw || null;
}

function _collectSystem() {
  return {
    uptime_s: Math.round(process.uptime()),
    load_average: os.loadavg(),
    free_mem_pct: Math.round((os.freemem() / os.totalmem()) * 100),
    platform: process.platform
  };
}

// Build full snapshot. Each probe wrapped in try/catch via the
// `_safeExec` + null-return convention; one probe failing doesn't
// fail the whole snapshot.
function getSituationSnapshot(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const cacheMs = typeof opts.cache_ms === 'number' ? opts.cache_ms : DEFAULT_CACHE_MS;
  if (!opts.force_refresh) {
    const cached = _cache.get(cwd);
    if (cached && (Date.now() - cached.cached_at) < cacheMs) {
      return Object.assign({}, cached.snapshot, { _from_cache: true });
    }
  }
  const snapshot = {
    cwd,
    time:      _collectTime(),
    system:    _collectSystem(),
    git:       _collectGit(cwd),
    recent_files: _collectRecentFiles(cwd),
    battery:   _collectBattery(),
    frontmost_app: _collectFrontmostApp(),
    cached_at: Date.now(),
    cache_ms:  cacheMs
  };
  _cache.set(cwd, { snapshot, cached_at: Date.now() });
  // Bound cache memory — drop entries older than 1 hour
  if (_cache.size > 100) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, val] of _cache) {
      if (val.cached_at < cutoff) _cache.delete(key);
    }
  }
  return snapshot;
}

// Render snapshot as prefix-ready string for planning prompts.
// Compact format — every line ≤ 80 chars, no markdown, no excess prose.
// Token budget: ~150 tokens typical, ~250 worst-case (with dirty files).
function renderForPrefix(snapshot, opts) {
  opts = opts || {};
  if (!snapshot) return '';
  const lines = ['<situation>'];
  if (snapshot.time) {
    lines.push('  time: ' + snapshot.time.iso_time + ' ' + snapshot.time.tz +
               ' (' + snapshot.time.day_of_week + ' ' + snapshot.time.hour_local + 'h local)');
  }
  if (snapshot.cwd) lines.push('  cwd: ' + snapshot.cwd);
  if (snapshot.git) {
    const g = snapshot.git;
    let line = '  git: branch=' + (g.branch || '?');
    if (g.ahead)  line += ' ahead=' + g.ahead;
    if (g.behind) line += ' behind=' + g.behind;
    if (g.dirty_count) line += ' dirty=' + g.dirty_count;
    lines.push(line);
    if (g.dirty_files && g.dirty_files.length) {
      lines.push('  dirty: ' + g.dirty_files.slice(0, 5).join(', '));
    }
  }
  if (Array.isArray(snapshot.recent_files) && snapshot.recent_files.length) {
    lines.push('  recent: ' + snapshot.recent_files.slice(0, 5).join(', '));
  }
  if (snapshot.battery) {
    lines.push('  battery: ' + snapshot.battery.pct + '% ' + (snapshot.battery.on_ac ? 'AC' : 'on-battery'));
  }
  if (snapshot.frontmost_app) {
    lines.push('  frontmost: ' + snapshot.frontmost_app);
  }
  if (snapshot.system) {
    const s = snapshot.system;
    lines.push('  system: load=' + s.load_average.map(x => x.toFixed(2)).join('/') +
               ' free_mem=' + s.free_mem_pct + '% uptime=' + s.uptime_s + 's');
  }
  lines.push('</situation>');
  return lines.join('\n');
}

function clearCache() {
  _cache.clear();
}

module.exports = {
  getSituationSnapshot,
  renderForPrefix,
  clearCache,
  // Exposed for tests
  _collectTime,
  _collectGit,
  _collectRecentFiles,
  _collectBattery,
  _collectFrontmostApp,
  _collectSystem,
  DEFAULT_CACHE_MS
};
