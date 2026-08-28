// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// env-door.js — the write-only door for dotenv files.
//
// The read wall refuses dotenv contents to the model on every road, so the
// partner cannot edit a .env the way it edits code. This module is the one
// sanctioned way through: keys are written by NAME, secret values come from
// the vault by NAME, and every reply carries names and counts only. The
// file's contents pass through this process, never through the model.
//
// Two consequences of the file being model-opaque shape this API:
//   - Replacing an existing key is destructive in a way the model cannot
//     see or undo, so a collision without overwrite:true is refused with
//     the colliding names (same contract as vault.writeEntry).
//   - Partial application would leave a state nobody can inspect, so the
//     batch is all-or-nothing: every entry resolves before one byte moves.
//
// The door runs in the host process, outside the kernel walls that jewel
// the substrate directory for spawned children — so it must refuse that
// ground itself. Workspace projects are the exception: a partner project's
// own .env is exactly what this door is for.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const policy   = require(path.join(__dirname, 'path-policy.js'));
const vault    = require(path.join(__dirname, '..', 'vault.js'));
const redactor = require(path.join(__dirname, '..', 'secret-redactor.js'));
const ground   = require(path.join(__dirname, 'ground-policy.js'));

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_KEY_RE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Resolve through links even when the final components do not exist yet:
// the deepest existing ancestor is resolved and the rest rejoined, so a
// linked directory cannot put the real target outside every check below.
function _realDeep(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(head);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_) {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

// Containment on a separator boundary, compared case-folded where the
// filesystem itself folds case (macOS/Windows defaults): a case-flipped
// spelling of a protected ancestor names the same directory there, and a
// case-sensitive volume on those platforms only ever over-refuses.
const _fold = (process.platform === 'darwin' || process.platform === 'win32')
  ? (p) => String(p).toLowerCase() : (p) => String(p);
function _under(child, parent) {
  const c = _fold(child), p = _fold(parent);
  if (c === p) return true;
  return c.indexOf(p + path.sep) === 0;
}

function _refuse(error, detail, extra) {
  return Object.assign({ ok: false, error, detail }, extra || {});
}

// Shared entry checks for both tools. Returns { ok:true, real, scope } or a
// refusal. `scope` is the capability scope a vault entry must cover for this
// target: capability:env:write:<project root>, where the root comes from the
// same classifier every wall uses — one answer to "what project is this".
function _admitTarget(file, cwd) {
  if (typeof file !== 'string' || !file.trim()) {
    return _refuse('file_required', 'name the dotenv file to operate on.');
  }
  const home = process.env.HOME || os.homedir();
  const expanded = file === '~' ? home
    : file.startsWith('~/') ? path.join(home, file.slice(2)) : file;
  const abs = path.isAbsolute(expanded) ? path.normalize(expanded)
    : path.resolve(cwd || process.cwd(), expanded);
  const real = _realDeep(abs);

  const dotenv = policy.SECRET_READ_NAMES.find((e) => e.name === 'dotenv');
  if (!dotenv || !dotenv.test(path.basename(real))) {
    return _refuse('not_a_dotenv_file',
      'this door writes dotenv files only (.env, .env.*); edit ' + path.basename(real) + ' with the ordinary tools.');
  }
  try {
    if (fs.statSync(real).isDirectory()) {
      return _refuse('target_is_directory', real + ' is a directory, not a dotenv file.');
    }
  } catch (_) { /* not existing yet is fine — the door creates it */ }

  // The substrate's own ground: refused outright, except a workspace
  // project's interior, which is partner ground and the door's ordinary
  // customer. The workspace root itself is not a project.
  const troth = _realDeep(ground.trothDir());
  const ws = _realDeep(ground.workspaceRoot());
  const dir = path.dirname(real);
  if (_under(real, troth) && !(_under(dir, ws) && _fold(dir) !== _fold(ws))) {
    return _refuse('substrate_ground', 'the substrate directory holds the partner\u2019s own credentials and policy; no dotenv door opens there.');
  }

  const w = policy.isWritablePath(real, {});
  if (!w.allowed) {
    return _refuse('blocked_destination', w.detail || w.reason);
  }

  let root = null;
  try {
    const c = ground.classifyGround(dir);
    if (c && c.ground === 'escape') {
      return _refuse('claims_vs_lands', 'the path names one ground but lands in another; spell the real location.');
    }
    root = (c && c.root) || null;
  } catch (_) { /* classification is advisory here; the scope falls back to the directory */ }
  const scope = 'capability:env:write:' + (root || dir);
  return { ok: true, real, scope };
}

// KEY=value serialization. Values that carry whitespace, quotes, comment or
// expansion characters are double-quoted with backslash escapes, which the
// common dotenv parsers all read back; everything else is written bare.
function _serialize(value) {
  if (value === '' || /[\s#"'`$\\]/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                      .replace(/\$/g, '\\$').replace(/`/g, '\\`')
                      .replace(/\n/g, '\\n') + '"';
  }
  return value;
}

// envSet({ file, entries, overwrite, cwd })
//   entries: [{ key, value }] for plain configuration,
//            [{ key, from_vault }] for secrets — resolved host-side, never
//            surfaced. Replies carry key NAMES and a count, nothing else.
function envSet(opts) {
  opts = opts || {};
  const adm = _admitTarget(opts.file, opts.cwd);
  if (!adm.ok) return adm;
  const real = adm.real;

  const entries = Array.isArray(opts.entries) ? opts.entries : null;
  if (!entries || !entries.length) {
    return _refuse('entries_required', 'pass entries: [{key, value}] or [{key, from_vault}].');
  }
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e.key !== 'string' || !KEY_RE.test(e.key)) {
      return _refuse('bad_key', 'keys must be env-var names ([A-Za-z_][A-Za-z0-9_]*); got: ' + String(e && e.key));
    }
    if (seen.has(e.key)) return _refuse('duplicate_key', e.key + ' appears twice in one batch.');
    seen.add(e.key);
    const hasValue = typeof e.value === 'string';
    const hasVault = typeof e.from_vault === 'string' && e.from_vault.trim();
    if (hasValue === !!hasVault) {
      return _refuse('bad_entry', e.key + ': exactly one of value or from_vault.');
    }
    // A secret pasted as a literal is already in the model's context; the
    // door does not launder it into looking handled. The vault road exists
    // precisely so the value never transits the conversation.
    if (hasValue && redactor.looksSecret(e.key, e.value)) {
      return _refuse('secret_literal', e.key + ' looks like a credential. Put it in the vault first (dashboard, or `troth vault set`) and pass from_vault instead — literals here are for non-secret configuration.');
    }
  }

  // Resolve everything before writing anything.
  const needVault = entries.filter((e) => typeof e.from_vault === 'string');
  const resolved = new Map();
  if (needVault.length) {
    if (!vault.isUnlocked()) {
      return _refuse('vault_locked', 'the vault is locked; unlock it from the dashboard or `troth vault unlock`, then retry.');
    }
    for (const e of needVault) {
      let hit = null;
      try { hit = vault.getValueByKey(e.from_vault.trim(), adm.scope); } catch (_) { hit = null; }
      // One message for missing, mis-scoped and reserved alike: the door is
      // not an oracle for what the vault holds.
      if (!hit || typeof hit.value !== 'string') {
        return _refuse('vault_entry_unusable',
          'no vault entry named \u2018' + e.from_vault.trim() + '\u2019 is usable for this project (missing, or not scoped to ' + adm.scope + '). The operator manages entries and scopes from the dashboard.');
      }
      resolved.set(e.key, hit.value);
    }
  }

  let text = '';
  try { text = fs.readFileSync(real, 'utf8'); }
  catch (err) {
    if (err && err.code !== 'ENOENT') {
      return _refuse('unreadable_target', 'cannot open ' + real + ': ' + (err.message || err));
    }
  }
  const lines = text.length ? text.split('\n') : [];
  const present = new Set();
  for (const line of lines) {
    const m = LINE_KEY_RE.exec(line);
    if (m) present.add(m[2]);
  }
  const colliding = entries.map((e) => e.key).filter((k) => present.has(k));
  if (colliding.length && opts.overwrite !== true) {
    return _refuse('key_exists',
      'already set in ' + path.basename(real) + ': ' + colliding.join(', ') + '. The current values are not readable from here; pass overwrite:true only if replacing them is intended.',
      { exists: colliding });
  }

  const byKey = new Map(entries.map((e) => [e.key, _serialize(
    resolved.has(e.key) ? resolved.get(e.key) : e.value)]));
  const out = lines.map((line) => {
    const m = LINE_KEY_RE.exec(line);
    if (!m || !byKey.has(m[2])) return line;
    // Every line that sets the key is rewritten, not only the first: the
    // common parsers disagree on which duplicate wins, and after this write
    // they must all agree on the new value. The export prefix is kept.
    return (m[1] ? 'export ' : '') + m[2] + '=' + byKey.get(m[2]);
  });
  // A final newline splits into a trailing empty element; appended keys go
  // BEFORE it, or every append manufactures a blank line mid-file.
  const appends = entries.filter((e) => !present.has(e.key));
  if (appends.length && out.length && out[out.length - 1] === '') out.pop();
  for (const e of appends) out.push(e.key + '=' + byKey.get(e.key));
  let body = out.join('\n');
  if (!body.endsWith('\n')) body += '\n';

  const tmp = path.join(path.dirname(real), '.envdoor-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.tmp');
  try {
    // Owner-only from birth: the mode rides the temp file through the
    // rename, and nothing touches the destination path afterward — a
    // post-rename chmod would follow a link swapped in behind the checks.
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, real);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return _refuse('write_failed', 'could not write ' + real + ': ' + (err.message || err));
  }

  // Anything the vault resolved is now on disk in the clear; if it ever
  // transits a later tool result, it leaves masked.
  for (const v of resolved.values()) redactor.addKnown(v);

  return {
    ok: true,
    file: real,
    written: entries.map((e) => e.key),
    from_vault: needVault.map((e) => e.key),
    count: entries.length
  };
}

// envKeys({ file, cwd }) — the names present in a dotenv file, and whether a
// vault entry of the same name is usable for this project. Names only; the
// values stay where the read wall put them.
function envKeys(opts) {
  opts = opts || {};
  const adm = _admitTarget(opts.file, opts.cwd);
  if (!adm.ok) return adm;

  let text = '';
  try { text = fs.readFileSync(adm.real, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, file: adm.real, keys: [] };
    return _refuse('unreadable_target', 'cannot open ' + adm.real + ': ' + (err.message || err));
  }

  let usable = null;
  if (vault.isUnlocked()) {
    const l = vault.listEntries();
    if (l && l.ok) {
      usable = new Set(l.entries
        .filter((e) => vault._scopeMatches(e.capability_scope_glob, adm.scope))
        .map((e) => e.key));
    }
  }
  const keys = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const m = LINE_KEY_RE.exec(line);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    keys.push({ name: m[2], vault_usable: usable ? usable.has(m[2]) : false });
  }
  return { ok: true, file: adm.real, keys, vault: vault.isUnlocked() ? 'unlocked' : 'locked' };
}

module.exports = { envSet, envKeys, _admitTarget, _serialize, _realDeep };
