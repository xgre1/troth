// SPDX-License-Identifier: AGPL-3.0-only
// publish-gate.js — guarded publish destinations.
//
// Most pushes are nobody's business but the operator's repositories, and they
// run to completion inside the walls. A few destinations are different: a
// push there is public and irreversible, and the operator has a checklist
// that must be green first. This module carries that checklist as MECHANISM
// instead of memory: the operator names the destination once, a push toward
// it passes only while a green gate pass exists for the exact tree being
// pushed, and the refusal names the road — run the gate, green lets the same
// push through untouched. Nothing here asks anyone to click anything.
//
// The list ships EMPTY. An operator who never arms it never meets this file.
//
// Boundary, stated honestly: this judges the ordinary spelling — `git push`
// through the partner shell — which is the shape confusion actually takes.
// A hand-rolled pack upload is not judged here; the destination's own server
// rules (branch protection) remain the operator's backstop for that.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const gp = require('./ground-policy.js');
const spawnPurpose = require('./spawn-purpose.js');

function guardedPath() {
  return path.join(gp.trothDir(), 'guarded-remotes.json');
}

function passDir() {
  return path.join(gp.trothDir(), 'gate-pass');
}

// Lenient reader, strict writer — the same split every policy file here uses.
function loadGuarded() {
  let raw;
  try { raw = fs.readFileSync(guardedPath(), 'utf8'); }
  catch (_) { return []; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { return []; }
  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.remotes)) ? parsed.remotes : null;
  if (!list) return [];
  const out = [];
  for (const e of list) {
    if (e && typeof e.match === 'string' && e.match.trim() && typeof e.gate === 'string' && e.gate.trim()) {
      out.push({ match: e.match.trim(), gate: e.gate.trim(), note: typeof e.note === 'string' ? e.note : '' });
    }
  }
  return out;
}

function addGuard(match, gate, note) {
  const m = typeof match === 'string' ? match.trim() : '';
  const g = typeof gate === 'string' ? gate.trim() : '';
  if (!m) return { ok: false, error: 'name a destination, e.g. github.com/owner/repo' };
  if (!g) return { ok: false, error: 'name the gate command that must be green, e.g. "scripts/release-gate.sh repo"' };
  const p = guardedPath();
  let cfg = { remotes: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && Array.isArray(parsed.remotes)) cfg = parsed;
    else if (Array.isArray(parsed)) cfg = { remotes: parsed };
    else if (parsed && typeof parsed === 'object') return { ok: false, error: 'unrecognized shape in ' + p + '; repair it first' };
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) return { ok: false, error: p + ' is unreadable; repair or remove it first' };
  }
  const already = cfg.remotes.some((e) => e && e.match === m);
  if (!already) cfg.remotes.push({ match: m, gate: g, note: typeof note === 'string' ? note : '' });
  else cfg.remotes = cfg.remotes.map((e) => (e && e.match === m) ? { match: m, gate: g, note: typeof note === 'string' ? note : (e.note || '') } : e);
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, match: m, gate: g, updated: already };
}

function removeGuard(match) {
  const p = guardedPath();
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return { ok: true, removed: false }; }
  if (!cfg || !Array.isArray(cfg.remotes)) return { ok: true, removed: false };
  const before = cfg.remotes.length;
  cfg.remotes = cfg.remotes.filter((e) => !(e && e.match === match));
  if (cfg.remotes.length === before) return { ok: true, removed: false };
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  return { ok: true, removed: true };
}

// github.com/owner/repo from every spelling a remote URL takes:
// https://github.com/owner/repo.git, git@github.com:owner/repo.git,
// ssh://git@github.com/owner/repo, user@host:path.
function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');       // scheme
  const at = s.indexOf('@');
  const slash = s.indexOf('/');
  if (at !== -1 && (slash === -1 || at < slash)) s = s.slice(at + 1);  // userinfo
  s = s.replace(/^([^\/:]+):(?!\d)/, '$1/');           // scp colon (not a port)
  s = s.replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.toLowerCase();
}

function matchesGuard(url, pattern) {
  const u = normalizeUrl(url);
  const p = normalizeUrl(pattern);
  if (!u || !p) return false;
  if (p.indexOf('*') !== -1) {
    const rx = new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return rx.test(u);
  }
  return u === p || u.startsWith(p + '/');
}

// ── pass files: green gate runs, bound to the exact tree they judged ──────

function _passFile(match) {
  const key = crypto.createHash('sha256').update(normalizeUrl(match)).digest('hex').slice(0, 24);
  return path.join(passDir(), key + '.json');
}

function recordPass(match, tree, gate) {
  if (!match || !tree) return { ok: false, error: 'match and tree required' };
  const f = _passFile(match);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ match, tree, gate: gate || '', when: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  return { ok: true, file: f };
}

function readPass(match) {
  try { return JSON.parse(fs.readFileSync(_passFile(match), 'utf8')); }
  catch (_) { return null; }
}

// A remote name from a parsed command is model-shaped text; it may only ever
// travel as a config KEY, so anything that could read as an option is refused
// before it reaches an argv.
function _saneRemoteName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name);
}

function _git(dir, argv) {
  try {
    const out = spawnPurpose.execFileSync('publish-preflight', 'git', ['-C', dir].concat(argv), {
      timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'
    });
    return typeof out === 'string' ? out.trim() : String(out || '').trim();
  } catch (_) { return null; }
}

function headTree(dir) {
  return _git(dir, ['rev-parse', 'HEAD^{tree}']);
}

function _remoteUrl(dir, name) {
  if (!_saneRemoteName(name)) return null;
  return _git(dir, ['config', '--get', 'remote.' + name + '.url']);
}

function _upstreamRemote(dir) {
  // The branch's own remote first; git's default when none is set is origin.
  const head = _git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head) {
    const r = _git(dir, ['config', '--get', 'branch.' + head + '.remote']);
    if (r) return r;
  }
  return 'origin';
}

// One git-push invocation, parsed from one command segment. Returns null when
// the segment is not a push.
function _parsePush(tokens, cwd) {
  let i = 0;
  while (i < tokens.length && path.basename(String(tokens[i]).replace(/^\\+/, '')) !== 'git') i++;
  if (i >= tokens.length) return null;
  let dir = cwd;
  let j = i + 1;
  for (; j < tokens.length; j++) {
    const t = String(tokens[j]);
    if (t === '-C') { const v = tokens[++j]; if (v) dir = path.resolve(cwd, String(v)); continue; }
    if (t === '-c') { j++; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(t)) continue;
    if (/^-/.test(t)) continue;
    break;
  }
  if (j >= tokens.length || String(tokens[j]) !== 'push') return null;
  const rest = tokens.slice(j + 1).map(String);
  const flags = rest.filter((t) => /^-/.test(t));
  const operands = rest.filter((t) => !/^-/.test(t) && !/^[|;&]$/.test(t));
  const forced = flags.some((t) => /^(-f|--force|--force-with-lease(=.*)?|--mirror|--tags|--all|--delete|-d)$/.test(t) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) && t !== '--force-with-lease');
  return { dir, remote: operands[0] || null, forced };
}

// preflight(command, cwd, opts) → null (nothing guarded is touched)
//                               | { blocked: true, message }
//
// Never gates on its own judgment of the push's CONTENT — only on whether a
// green pass exists for the exact tree. The empty-list fast path costs one
// stat and nothing else. opts.road replaces the default road sentence for
// doors that do not mount run_gate — the facts stay identical either way.
function preflight(command, cwd, opts) {
  let guarded;
  try { guarded = loadGuarded(); } catch (_) { return null; }
  if (!guarded.length) return null;
  if (typeof command !== 'string' || command.indexOf('push') === -1) return null;

  let safety;
  try { safety = require('./bash-safety.js'); } catch (_) { return null; }
  let tokens;
  try { tokens = safety._tokenize(command); } catch (_) { return null; }

  // Split on segment separators the tokenizer already isolates.
  const segments = [];
  let cur = [];
  for (const t of tokens) {
    if (t === ';' || t === '&' || t === '|') { if (cur.length) segments.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) segments.push(cur);

  for (const seg of segments) {
    const push = _parsePush(seg, cwd);
    if (!push) continue;
    let url = null;
    const named = push.remote;
    if (named && (/^[a-z][a-z0-9+.-]*:\/\//i.test(named) || named.indexOf('@') !== -1 || named.indexOf(':') !== -1)) {
      url = named;                                  // pushing straight to a URL
    } else if (named) {
      url = _remoteUrl(push.dir, named);
    } else {
      const r = _upstreamRemote(push.dir);
      url = r ? _remoteUrl(push.dir, r) : null;
    }
    if (!url) continue;
    for (const g of guarded) {
      if (!matchesGuard(url, g.match)) continue;
      if (push.forced) {
        return { blocked: true, message:
          normalizeUrl(url) + ' is a guarded destination, and force/mirror/tags/delete '
          + 'pushes there stay the operator\'s own act — the destination\'s branch '
          + 'protection is the road for history surgery, not a flag.' };
      }
      const tree = headTree(push.dir);
      const pass = readPass(g.match);
      if (tree && pass && pass.tree === tree) return null;   // green for this exact tree
      const why = !pass ? 'no gate pass exists yet'
        : 'the last pass covered a different tree (the work moved since the gate ran)';
      const road = (opts && typeof opts.road === 'string' && opts.road.trim())
        ? opts.road.trim()
        : 'Run its gate from your own hand: call run_gate with match "' + g.match + '" '
          + '— green records the pass for the exact tree at HEAD and this same push '
          + 'then proceeds; red names what failed. Nothing here needs the operator.';
      return { blocked: true, message:
        normalizeUrl(url) + ' is a guarded destination and ' + why + '. ' + road };
    }
  }
  return null;
}

module.exports = {
  guardedPath, passDir, loadGuarded, addGuard, removeGuard,
  normalizeUrl, matchesGuard, recordPass, readPass, headTree,
  preflight,
  _parsePush, _passFile
};
