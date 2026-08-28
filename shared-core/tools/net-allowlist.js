// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// net-allowlist.js — which hosts an install jail may reach, per project.
//
// The default list carries the public package registries, and that is all a
// normal project ever needs. Two ordinary cases need more: a company
// registry, and packages whose artifacts are served from a code host rather
// than the registry that indexed them. Both are the operator's call, so they
// live in a file only the operator writes — protected on the tool road, the
// shell road and the kernel road, exactly like the folder registry.
//
// Read lenient, fail CLOSED: a missing or unreadable file means the default
// registries and nothing else, never "allow everything".

const fs   = require('fs');
const path = require('path');

const ground = require(path.join(__dirname, 'ground-policy.js'));
const { DEFAULT_REGISTRY_HOSTS } = require(path.join(__dirname, 'egress-proxy.js'));

function allowlistPath() {
  return path.join(ground.trothDir(), 'net-allowlists.json');
}

function _read() {
  try {
    const raw = fs.readFileSync(allowlistPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { projects: {}, all: [] };
    return {
      projects: (parsed.projects && typeof parsed.projects === 'object') ? parsed.projects : {},
      all: Array.isArray(parsed.all) ? parsed.all : []
    };
  } catch (_) {
    return { projects: {}, all: [] };
  }
}

function _hosts(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((h) => typeof h === 'string' && h.trim() && h.indexOf('/') === -1)
          .map((h) => h.trim().toLowerCase());
}

// allowFor(projectRoot) → the host list an install in that project may reach.
// Entries are matched on the REAL path, so a link cannot borrow another
// project's additions.
function allowFor(projectRoot) {
  const cfg = _read();
  const list = DEFAULT_REGISTRY_HOSTS.slice().concat(_hosts(cfg.all));
  let real = projectRoot;
  try { real = fs.realpathSync(projectRoot); } catch (_) { /* not there: literal */ }
  for (const key of Object.keys(cfg.projects)) {
    let keyReal = key;
    try { keyReal = fs.realpathSync(key); } catch (_) { /* literal */ }
    if (keyReal === real) list.push(..._hosts(cfg.projects[key]));
  }
  return Array.from(new Set(list));
}

// addHost(host, projectRoot|null) → { ok } | { ok:false, error }
// The single writer, driven by the operator through the CLI. A corrupt file
// REFUSES rather than being overwritten: the operator's list is not
// something to silently replace with a fresh one.
function addHost(host, projectRoot) {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (!h || h.indexOf('/') !== -1 || h.indexOf(' ') !== -1) {
    return { ok: false, error: 'name a host, e.g. npm.example.com or *.example.com' };
  }
  const p = allowlistPath();
  let cfg = { projects: {}, all: [] };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('shape');
    cfg = {
      projects: (parsed.projects && typeof parsed.projects === 'object') ? parsed.projects : {},
      all: Array.isArray(parsed.all) ? parsed.all : []
    };
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) {
      return { ok: false, error: 'the allowlist file is unreadable; repair or remove ' + p + ' first' };
    }
  }
  let real = projectRoot || null;
  if (real) { try { real = fs.realpathSync(real); } catch (_) { /* literal */ } }
  const bucket = real ? (Array.isArray(cfg.projects[real]) ? cfg.projects[real] : []) : cfg.all;
  if (bucket.indexOf(h) === -1) bucket.push(h);
  if (real) cfg.projects[real] = bucket; else cfg.all = bucket;

  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, host: h, project: real || null };
}

function listAll() {
  const cfg = _read();
  return { path: allowlistPath(), all: _hosts(cfg.all), projects: cfg.projects,
           defaults: DEFAULT_REGISTRY_HOSTS.slice() };
}

module.exports = { allowFor, addHost, listAll, allowlistPath };
