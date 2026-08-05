// SPDX-License-Identifier: AGPL-3.0-only
// kimi-cli-lane.js — decide how `troth classic` launches Claude Code on the
// Kimi Code membership: through the troth proxy when one is running, else
// directly on the membership endpoint.
//
// HISTORY, load-bearing: this helper originally argued "the troth proxy has
// NO subscription lane, so a Kimi-Code subscriber MUST go direct." That
// stopped being true when the proxy grew a model-addressed
// kimi_sub lane WITH tool-block compression, caching and context filtering,
// and the direct lane is the measured melt — 63-67% of a weekly quota in
// minutes. So the contract here now mirrors
// subprocess-cli.js / kimi-sub.js exactly: TROTH_KIMI_VIA_PROXY=1 points the
// lane at the proxy (TROTH_PROXY_URL, default loopback :8000); an explicit
// TROTH_KIMI_SUB_BASE still outranks everything (whoever overrides the base
// has decided where the traffic goes); with neither, the direct endpoint
// remains — a dead loopback would strand the terminal entirely.
//
// This module is PURE (no fs, no process): the caller passes the parsed configs
// and env, so it is fully unit-testable and cannot leak a key to a log.
'use strict';

const DEFAULT_BASE = 'https://api.kimi.com/coding/';

function nz(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// resolveKimiLane({ env, ossConfig, appConfig }) -> { chosen, lane }
//   chosen : the user selected Kimi as their CLI engine (via any source).
//   lane   : { base, key, model } when Kimi is chosen AND a usable key exists,
//            else null (caller keeps the proxy path). NEVER contains a log line.
// Sources, highest priority first:
//   1. env TROTH_KIMI_SUB_KEY            — explicit power-user / CI override.
//   2. ~/.troth/config.json (OSS)         — { cli_engine:'kimi', kimi_sub_key }.
//   3. ~/.troth/desktop-config.json (app) — { engine_pin:'kimi_sub', kimi_sub_key }.
function resolveKimiLane(opts) {
  opts = opts || {};
  const env = opts.env || {};
  const oss = opts.ossConfig || {};
  const app = opts.appConfig || {};
  let base = nz(env.TROTH_KIMI_SUB_BASE);
  if (!base) {
    base = nz(env.TROTH_KIMI_VIA_PROXY) === '1'
      ? (nz(env.TROTH_PROXY_URL) || 'http://127.0.0.1:8000')
      : DEFAULT_BASE;
  }

  const envKey = nz(env.TROTH_KIMI_SUB_KEY);
  if (envKey) {
    return { chosen: true, lane: { base, key: envKey, model: nz(env.TROTH_KIMI_SUB_MODEL) } };
  }

  const ossChosen = nz(oss.cli_engine).toLowerCase() === 'kimi';
  if (ossChosen && nz(oss.kimi_sub_key)) {
    return { chosen: true, lane: { base, key: nz(oss.kimi_sub_key), model: nz(oss.kimi_sub_model) } };
  }

  // The paid app stores the buyer's Kimi Code key here and sets engine_pin to
  // 'kimi_sub' when they pick Kimi — so an app user gets Kimi in the CLI with
  // no extra setup. Read-only, best-effort: absent on an OSS-only machine.
  const appChosen = nz(app.engine_pin).toLowerCase() === 'kimi_sub';
  if (appChosen && nz(app.kimi_sub_key)) {
    return { chosen: true, lane: { base, key: nz(app.kimi_sub_key), model: nz(app.kimi_sub_model) } };
  }

  // Chosen but unusable (engine says Kimi, no key found): the caller warns and
  // falls back to the proxy rather than silently routing to the wrong engine.
  return { chosen: (ossChosen || appChosen), lane: null };
}

module.exports = { resolveKimiLane, DEFAULT_BASE };
