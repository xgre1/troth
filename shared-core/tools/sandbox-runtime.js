// SPDX-License-Identifier: AGPL-3.0-only
// sandbox-runtime.js — cross-platform sandbox selector.
//
// Uniform API across multiple container runtimes
// so the rest of substrate (today: shared-core/tools/bash.js) doesn't
// care which is installed. Mac users on Apple Silicon get Apple
// Container (no Docker Desktop tax); Linux / Mac-x86 users get Docker;
// hosts with neither get the loud bare-exec fallback.
//
// Adapter priority (auto mode):
//   1. apple-container — Apple Silicon native, no Docker Desktop
//   2. docker          — broadest compatibility
//   3. bare            — refuse-by-default fallback
//
// Operator override via ~/.troth/config.json:
//   {
//     "l4": {
//       "sandbox": {
//         "runtime": "auto" | "apple-container" | "docker" | "bare"
//       }
//     }
//   }
//
// Or per-call via opts.runtime_override.
//
// API (mirrors docker-sandbox.js for drop-in compatibility):
//   isAvailable(opts?)     → { available, kind, version, error?, warning? }
//   runInSandbox(cmd, opts)→ Promise<{
//     stdout, stderr, exit_code, interrupted, sandboxed,
//     sandbox_kind, elapsed_ms, signal?, error?, detail?, warning?
//   }>
//   getActiveAdapter()     → 'apple-container' | 'docker' | 'bare' | null
//
// Selection is cached per session via the adapters' own caches; this
// module re-asks them only when explicitly bypassed via opts.fresh.

'use strict';

const ADAPTER_PRIORITY = ['apple-container', 'docker', 'bare'];

const ADAPTERS = {
  'apple-container': () => require('./sandbox-apple-container.js'),
  'docker':          () => require('./docker-sandbox.js'),
  'bare':            () => require('./sandbox-bare-exec.js')
};

function _readOperatorOverride() {
  // Read l4.sandbox.runtime from ~/.troth/config.json if present.
  // Safe-fails to null so the runtime stays auto when config is unset
  // or unreadable.
  try {
    const l4cfg = require('../l4-config.js');
    const cfg = l4cfg.getL4Config();
    if (cfg && cfg.sandbox && typeof cfg.sandbox.runtime === 'string') {
      return cfg.sandbox.runtime;
    }
  } catch (_) {}
  return null;
}

function _pickAdapter(opts) {
  opts = opts || {};
  const override = opts.runtime_override || _readOperatorOverride() || 'auto';
  if (override !== 'auto') {
    if (!ADAPTERS[override]) {
      return { kind: null, error: 'unknown_runtime_override: ' + override };
    }
    const ad = ADAPTERS[override]();
    const avail = ad.isAvailable(opts);
    if (!avail.available) {
      return { kind: null, error: 'override_runtime_unavailable: ' + override + ': ' + (avail.error || '?') };
    }
    return { kind: override, adapter: ad, availability: avail };
  }
  for (const kind of ADAPTER_PRIORITY) {
    const ad = ADAPTERS[kind]();
    const avail = ad.isAvailable(opts);
    if (avail.available) {
      return { kind, adapter: ad, availability: avail };
    }
  }
  return { kind: null, error: 'no_sandbox_runtime_available' };
}

function isAvailable(opts) {
  const pick = _pickAdapter(opts);
  if (!pick.adapter) {
    return { available: false, kind: null, error: pick.error };
  }
  return Object.assign({}, pick.availability, { kind: pick.kind });
}

function runInSandbox(command, opts) {
  opts = opts || {};
  const pick = _pickAdapter(opts);
  if (!pick.adapter) {
    return Promise.resolve({
      error:        pick.error || 'no_sandbox_runtime_available',
      detail:       pick.error || 'no_sandbox_runtime_available',
      sandboxed:    false,
      sandbox_kind: null,
      stdout: '', stderr: '',
      exit_code: null,
      interrupted: false
    });
  }
  return pick.adapter.runInSandbox(command, opts);
}

function getActiveAdapter(opts) {
  const pick = _pickAdapter(opts);
  return pick.kind || null;
}

module.exports = {
  isAvailable,
  runInSandbox,
  getActiveAdapter,
  // exposed for tests + introspection
  ADAPTER_PRIORITY,
  _pickAdapter
};
