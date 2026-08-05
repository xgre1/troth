// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Host-abstraction seam. ONE interface for every platform-specific
// capability, resolved at boot by PROBE — never by a `if (platform)`
// string. Three namespaces:
//
//   host.keyhsm      — operator signing key (hardware-first, file fallback)
//   host.hypervisor  — the host launcher (pluggable; production ships separately)
//   host.presence    — operator presence + dead-man-switch (macos real; headless fallback)
//
// Backends self-describe via probe(); host picks the first AVAILABLE backend
// in priority order. A backend tagged dev_only:true is never selected as the
// production backend — it exists so development works against this seam
// while the production backend ships separately.
//
// Consumers reach capabilities ONLY through host.*, so the file key can
// become a YubiKey, the docker shim a production VMM, the headless presence
// a Swift daemon — with zero consumer changes.

// Priority-ordered candidate backends per namespace. Production backends
// may not be present in this repo — the lazy thunks let the resolver fall
// through to the next candidate without crashing the seam.
const CANDIDATES = {
  keyhsm: [
    () => require('./keyhsm/yubikey.js'),
    () => require('./keyhsm/secure-enclave.js'),
    () => require('./keyhsm/file.js'),
  ],
  hypervisor: [
    () => require('./hypervisor/docker.js'),
  ],
  presence: [
    () => require('./presence/macos.js'),
    () => require('./presence/headless.js'),
  ],
};

const _resolved = {};

function _force() {
  // TROTH_HOST_FORCE=fallback forces the last (fallback) candidate per
  // namespace — used by tests + headless/CI runs.
  return process.env.TROTH_HOST_FORCE || null;
}

function resolve(namespace) {
  if (_resolved[namespace]) return _resolved[namespace];
  const cands = CANDIDATES[namespace];
  if (!cands) throw new Error('host: unknown namespace ' + namespace);
  const forceFallback = _force() === 'fallback';
  const ordered = forceFallback ? [cands[cands.length - 1]] : cands;
  let lastErr = null;
  for (const load of ordered) {
    let backend;
    try { backend = load(); }
    catch (e) { lastErr = e; continue; } // backend module not built yet
    let probe;
    try { probe = backend.probe(); }
    catch (e) { lastErr = e; continue; }
    if (probe && probe.available) {
      _resolved[namespace] = backend;
      return backend;
    }
  }
  throw new Error('host: no available backend for ' + namespace +
    (lastErr ? ' (last error: ' + lastErr.message + ')' : ''));
}

// Lazy namespace proxies — resolve on first method touch so requiring host.js
// never forces a probe at import time (keeps module load side-effect-free).
function ns(name) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'probe') return () => { try { return resolve(name).probe(); } catch (e) { return { backend: null, available: false, error: e.message }; } };
      if (prop === 'backendName') return () => { try { return resolve(name).name; } catch { return null; } };
      const b = resolve(name);
      const v = b[prop];
      return typeof v === 'function' ? v.bind(b) : v;
    },
  });
}

module.exports = {
  keyhsm:     ns('keyhsm'),
  hypervisor: ns('hypervisor'),
  presence:   ns('presence'),
  // test/diagnostic surface
  _resolve: resolve,
  _reset: () => { for (const k of Object.keys(_resolved)) delete _resolved[k]; },
};
