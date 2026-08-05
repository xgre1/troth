// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Phase 5: per-worker transport resolver for autonomy. Treats a role's model_pref
// as a PREFERENCE, not a pin, and spreads workers across what the user actually
// has - so autonomy never collapses every role onto ONE local box (the qwen-
// hammering bug). The actual cloud spread (deepseek vs openai vs openrouter) is
// done by the proxy router's existing health/fallback chain when we route a worker
// through transport_hint 'router'; this resolver decides WHEN to do that.
//
// Rules:
//   * frontier-first (dispatch_prefer=hosted) + cloud available:
//       - a role that PREFERRED local is re-routed to 'router' (distributed cloud),
//       - a role that preferred a cloud transport keeps it.
//   * local allowed (dispatch_prefer=local, or no cloud) + local can host:
//       - keep the role's preference (local stays within the device cap upstream).
//   * local cannot host + cloud available: route through 'router' (best available).
//   * nothing usable: return the pref as-is (the readiness gate should have refused).
const os = require('os');
const fs = require('fs');
const path = require('path');

function _isLocalTransport(t) { return /llamacpp|local|ollama/i.test(String(t || '')); }

// Gather the live routing context (dispatch_prefer + which providers exist + can
// local host another worker). Override-able for tests.
function gatherContext() {
  let dispatchPrefer = 'local', cloudCount = 0, localOk = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.troth', 'config.json'), 'utf8'));
    // Unset means the operator has never chosen, which is every fresh
    // install. Falling back to 'local' claimed this Mac leads even when no
    // local model exists; localOk below is resolved a few lines down, so the
    // derivation waits until it is known (see after gatherProviderState).
    dispatchPrefer = cfg.dispatch_prefer || (cfg.routing && cfg.routing.dispatch_prefer) || '';
    const ar = require('./autonomy-readiness.js');
    const st = ar.gatherProviderState();
    cloudCount = (st.cloudProviders || []).length;
    if (!dispatchPrefer) dispatchPrefer = st.localAvailable ? 'local' : 'hosted';
    let localCanRun = false;
    try { localCanRun = require('./device-capabilities.js').detectCapabilities().localCanRun === true; } catch (_) {}
    localOk = st.localAvailable === true && localCanRun;
  } catch (_) {}
  return { dispatchPrefer, cloudCount, localOk };
}

// role: the role def (model_pref, transport_hint). ctx: optional override.
function resolveWorkerTransport(role, ctx) {
  role = role || {};
  ctx = ctx || gatherContext();

  // Route workers through the proxy 'router' transport, which selects from the
  // user's ENABLED providers honoring their dispatch_prefer (frontier-first). This
  // REPLACES the hardcoded per-role model_pref (e.g. backend=qwen3-max/alibaba),
  // which broke when that provider was disabled -> the worker fell to a LOCAL model
  // (the qwen3-max-on-the-box bug). The role's system_prompt still specializes the
  // worker; the proxy picks the best ENABLED model. So routing derives from what the
  // user actually has enabled, not a baked-in provider.
  if (ctx.cloudCount > 0) {
    return { model: null, transport_hint: 'router', reason: 'via proxy over ENABLED providers (honors dispatch_prefer)' };
  }
  // No cloud provider enabled: local-only. Use the local model IF the device can host
  // it (the readiness gate already refused local-only on a box too small).
  if (ctx.localOk) {
    return { model: role.model_pref || null, transport_hint: role.transport_hint || 'router', reason: 'local-only: role/local model' };
  }
  // Nothing usable (the readiness gate should have refused before reaching here).
  return { model: null, transport_hint: 'router', reason: 'no provider: proxy fallback' };
}

module.exports = { resolveWorkerTransport, gatherContext };
