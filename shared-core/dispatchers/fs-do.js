// SPDX-License-Identifier: AGPL-3.0-only
// Universal filesystem executor.
//
// Read / write / delete / list files within operator-authorized path
// prefixes. Capability scope IS the wall: `capability:fs:do:<abs-path-prefix>`
// declares the root the partner can act within. Resolved-path containment
// check rejects path-traversal escapes structurally.
//
// Operations (kept small — composes with shell:do for higher-level ops):
//   {op: 'read', path}                        — UTF-8 read, size-capped
//   {op: 'write', path, content, mode?}       — UTF-8 write, atomic temp+rename
//   {op: 'append', path, content}             — append
//   {op: 'delete', path}                      — unlink (file) / rmdir empty
//   {op: 'list', path}                        — readdir entries with type
//   {op: 'stat', path}                        — size, mtime, type
//   {op: 'mkdir', path}                       — recursive
//
// Capability scope:
//   capability:fs:do:<abs-path-prefix>
//   Examples:
//     capability:fs:do:/Users/operator/projects/landing-v2
//     capability:fs:do:/tmp/troth-workspace
//
// HARD walls:
//   - Path is realpath-resolved before the containment check: the longest
//     EXISTING ancestor of the target is passed through fs.realpathSync so a
//     symlink sitting INSIDE the root that points outside it cannot smuggle a
//     write/read past the boundary (a plain path.resolve is lexical only and
//     is fooled by such a symlink — confirmed escape, fixed).
//   - Containment uses startsWith on the real path PLUS a trailing separator
//     to prevent `/foo` from matching `/foobar`.
//   - Containment is enforced on the real path for EVERY op (read included):
//     an in-root symlink to outside the root fails closed rather than
//     following through. Widen the capability scope for genuinely external
//     data instead of relying on a symlink.
//   - Delete of capability root itself refused.
//   - Size cap on read (default 5 MiB) — large files surface via stream
//     primitive in later phase, not via fs:do.

'use strict';

const fs   = require('fs');
const path = require('path');

const ADAPTER_SCOPE = 'intent:fs:do:*';
const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024;
const ALLOWED_OPS = new Set(['read', 'write', 'append', 'delete', 'list', 'stat', 'mkdir']);

function _validate(payload) {
  if (!payload || typeof payload !== 'object') return 'payload required';
  if (!payload.op) return 'payload.op required';
  if (!ALLOWED_OPS.has(payload.op)) return 'payload.op not allowed: ' + payload.op;
  if (!payload.path) return 'payload.path required';
  if (typeof payload.path !== 'string') return 'payload.path must be a string';
  if ((payload.op === 'write' || payload.op === 'append') && payload.content === undefined) {
    return 'payload.content required for ' + payload.op;
  }
  return null;
}

function _capabilityRoot(capability) {
  if (!capability || typeof capability.scope !== 'string') return null;
  if (capability.scope.indexOf('capability:fs:do:') !== 0) return null;
  const root = capability.scope.slice('capability:fs:do:'.length);
  if (!path.isAbsolute(root)) return null;
  return path.normalize(root);
}

// Realpath the longest EXISTING ancestor of `p`, then re-append the trailing
// components that do not exist on disk yet (e.g. the new file/dir a write will
// create). This resolves any symlink in the on-disk part of the path so the
// containment check sees where the write/read will REALLY land, not the
// lexical spelling. A bare path.resolve is lexical and is fooled by an in-root
// symlink pointing outside the root.
function _realExistingPrefix(p) {
  let abs = path.resolve(p);
  const trailing = [];
  let guard = 0;
  while (guard++ < 4096) {
    if (fs.existsSync(abs)) {
      let real;
      try { real = fs.realpathSync(abs); } catch (_) { real = abs; }
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    }
    const parent = path.dirname(abs);
    if (parent === abs) return abs;   // reached filesystem root
    trailing.push(path.basename(abs));
    abs = parent;
  }
  return abs;
}

function _pathInsideRoot(targetPath, root) {
  if (!root) return false;
  // Resolve BOTH sides the same way. realpathSync throws when the root does
  // not exist yet, and falling back to normalize() left the root unresolved
  // while the target had already been resolved: on macOS /tmp is a symlink to
  // /private/tmp, so an existing target under a not-yet-created root compared
  // /private/tmp/... against /tmp/... and never matched. That refused every
  // write inside a capability's own root. It failed closed, so nothing was
  // exposed, but fs:do was unusable wherever an ancestor is a symlink.
  const realRoot = _realExistingPrefix(root);
  const target = _realExistingPrefix(targetPath);
  // Append separator to defeat `/foo` matching `/foobar`.
  const withSep = realRoot.endsWith(path.sep) ? realRoot : (realRoot + path.sep);
  return target === realRoot || target.indexOf(withSep) === 0;
}

async function dispatch(intent, capability, ctx) {
  ctx = ctx || {};
  const payload = (intent && intent.payload) || {};
  const invalid = _validate(payload);
  if (invalid) return { ok: false, error: 'fs_invalid: ' + invalid };
  if (!capability) return { ok: false, error: 'fs_capability_required' };
  const root = _capabilityRoot(capability);
  if (!root) return { ok: false, error: 'fs_capability_root_unset',
                       detail: 'capability scope must be capability:fs:do:<abs-path-prefix>' };
  if (!_pathInsideRoot(payload.path, root)) {
    return { ok: false, error: 'fs_path_outside_capability_root',
             detail: 'path=' + payload.path + ' root=' + root };
  }
  // Refuse delete-of-root.
  if (payload.op === 'delete' && path.resolve(payload.path) === root) {
    return { ok: false, error: 'fs_refuse_delete_capability_root' };
  }

  // Test injection.
  if (typeof ctx._fs_mock === 'function') {
    try {
      const r = await Promise.resolve(ctx._fs_mock({ intent, capability, payload, root }));
      return {
        ok: r.ok !== false,
        result: r.result || r,
        error: r.ok === false ? (r.error || 'mock_reported_failure') : null
      };
    } catch (e) { return { ok: false, error: 'fs_mock_threw: ' + (e && e.message || e) }; }
  }

  // Photograph before any mutation — the undo net, never a gate: a failed
  // photo is recorded by the module and the operation proceeds.
  if (payload.op === 'write' || payload.op === 'append' || payload.op === 'delete') {
    try {
      require('../tools/undo-shadow.js').snapshot(root, 'fs:' + payload.op, { allowShallow: true });
    } catch (e) { /* recorded in undo stats */ }
  }

  try {
    switch (payload.op) {
      case 'read': {
        const maxBytes = payload.max_bytes || DEFAULT_MAX_READ_BYTES;
        const st = fs.statSync(payload.path);
        if (!st.isFile()) return { ok: false, error: 'fs_not_a_file' };
        if (st.size > maxBytes) return { ok: false, error: 'fs_file_exceeds_max_bytes',
                                          detail: 'size=' + st.size + ' max=' + maxBytes };
        const data = fs.readFileSync(payload.path, 'utf8');
        return { ok: true, result: { content: data, bytes: st.size, mtime_ms: st.mtimeMs } };
      }
      case 'write': {
        const dir = path.dirname(payload.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = payload.path + '.tmp-' + process.pid + '-' + Date.now();
        fs.writeFileSync(tmp, String(payload.content), {
          mode: typeof payload.mode === 'number' ? payload.mode : 0o644
        });
        fs.renameSync(tmp, payload.path);
        const st = fs.statSync(payload.path);
        return { ok: true, result: { bytes: st.size, mtime_ms: st.mtimeMs } };
      }
      case 'append': {
        fs.appendFileSync(payload.path, String(payload.content));
        const st = fs.statSync(payload.path);
        return { ok: true, result: { bytes: st.size, mtime_ms: st.mtimeMs } };
      }
      case 'delete': {
        if (!fs.existsSync(payload.path)) return { ok: true, result: { existed: false } };
        const st = fs.statSync(payload.path);
        if (st.isDirectory()) fs.rmdirSync(payload.path);
        else fs.unlinkSync(payload.path);
        return { ok: true, result: { existed: true, was_dir: st.isDirectory() } };
      }
      case 'list': {
        const entries = fs.readdirSync(payload.path, { withFileTypes: true });
        return { ok: true, result: { entries: entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : (e.isFile() ? 'file' : (e.isSymbolicLink() ? 'symlink' : 'other'))
        })) } };
      }
      case 'stat': {
        if (!fs.existsSync(payload.path)) return { ok: true, result: { exists: false } };
        const st = fs.statSync(payload.path);
        return { ok: true, result: { exists: true, bytes: st.size, mtime_ms: st.mtimeMs,
                                      type: st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'other') } };
      }
      case 'mkdir': {
        fs.mkdirSync(payload.path, { recursive: true });
        return { ok: true, result: { path: payload.path } };
      }
    }
  } catch (e) {
    return { ok: false, error: 'fs_op_failed: ' + (e && e.message || e) };
  }
}

module.exports = {
  scope_match: ADAPTER_SCOPE,
  param_schema: { op: 'string', path: 'string', content: 'string?', max_bytes: 'number?', mode: 'number?' },
  irreversibility_class: 'medium',   // write/append/delete are reversible-with-backups; cap can raise
  dispatch,
  _validate,
  _capabilityRoot,
  _pathInsideRoot,
  ALLOWED_OPS
};
