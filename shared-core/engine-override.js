// SPDX-License-Identifier: AGPL-3.0-only
// engine-override — the per-conversation /engine engine override store.
//
// One product design decision made concrete: in a focused pane the operator
// types `/engine <engine>` to steer WHICH faculty answers THAT conversation,
// without touching the global engine pin that governs every other pane. This
// module is the single source of truth for:
//   (a) the conversation_id -> override map (DURABLE, see below),
//   (b) the engine-word -> faculty translation both the slash handler and the
//       dispatch site must agree on.
//
// Both the deterministic /engine handler (shared-core/slash/executor.js) and the
// dispatch site (bin/troth-entity.js) require THIS module so the word the
// operator typed and the faculty the dispatcher picks can never drift.
//
// DURABILITY (operator rule: a partner that forgets your /engine
// choice on app restart repeats the amnesia sin; in-memory-only overrides are
// no longer acceptable). The map is persisted to ~/.troth/engine-overrides.json
// on EVERY set/clear (atomic temp+rename, file 0600) and LOADED at module init,
// so a daemon respawn / app restart restores every pane's choice AND the untagged
// surface's choice. All disk I/O is fail-safe: a missing or corrupt file starts
// the map empty and NEVER throws, so a bad file can never break dispatch.
//
// scope, stated honestly:
//   - `kimi` maps to the NATIVE kimi_sub faculty WHEN that faculty is wired
//     (TROTH_KIMI_SUB_KEY present) - operator rule: a capability
//     that should work is never scoped down silently. Kimi Code is Anthropic-
//     compatible, so it runs as a real per-pane faculty via shared-core/
//     transports/kimi-sub.js. When the key is ABSENT the faculty cannot wire,
//     so `kimi` still returns the honest backbone reply pointing at Settings
//     (fail closed - never invent an unwired faculty). This is the SAME "both
//     backbones" correction that gave the entity a native kimi_sub lane.
//   - Router provider names (deepseek etc.) select the `router` FACULTY. Pinning
//     ONE provider inside the router chain would need the shared router module,
//     which this task must not touch, so v1 selects the faculty and says so.

'use strict';

// conversation_id -> { engine, faculty, prefer }
//   engine  : the word the operator typed (for display), e.g. 'claude'
//   faculty : the dispatcher faculty name, e.g. 'claude_cli' (null for a
//             pure prefer-only entry set by `/engine auto <mode>`)
//   prefer  : 'local' | 'best' | null — per-pane dispatch preference for auto
const _overrides = new Map();

// ── Durable persistence ───────────────────────────────────────────────────
// The override map is mirrored to a small JSON file so a daemon respawn / app
// restart restores it. Path resolution mirrors config-file.js (honors
// TROTH_CONFIG_DIR / HOME) so tests and exotic setups redirect it the same way
// the config writer does, and it always sits next to config.json in ~/.troth.
const _fs   = require('fs');
const _os   = require('os');
const _path = require('path');

function _overridesDir() {
  const home = process.env.HOME || _os.homedir();
  return process.env.TROTH_CONFIG_DIR || _path.join(home, '.troth');
}
function _overridesPath() {
  // Distinct env override so a test can point JUST this file somewhere without
  // moving config.json; defaults to <config-dir>/engine-overrides.json.
  return process.env.TROTH_ENGINE_OVERRIDES_PATH || _path.join(_overridesDir(), 'engine-overrides.json');
}

// _persist(): atomically write the current map. Shape on disk:
//   { "<conversation_id-or-untagged-key>": { engine, faculty, prefer?, router_provider? } }
// temp+rename so a crash mid-write can never leave a torn file; file mode 0600
// (overrides are not secrets, but they sit in ~/.troth alongside config.json and
// there is no reason to widen the mode). Fail-safe: a write error is swallowed;
// losing durability is never worth breaking a /engine turn.
function _persist() {
  try {
    const obj = {};
    for (const [k, v] of _overrides.entries()) obj[k] = v;
    const dir = _overridesDir();
    _fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = _overridesPath();
    const tmp = p + '.tmp-' + process.pid;
    _fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    _fs.renameSync(tmp, p);
    try { _fs.chmodSync(p, 0o600); } catch (_) {}
  } catch (_) { /* durability is best-effort; never break dispatch */ }
}

// _load(): read the persisted map into memory. Fail-safe on missing/corrupt
// file: start empty, never throw. Only object-shaped entries are accepted, so a
// tampered/partial file degrades to "no override" rather than a crash. Called at
// module init and after a redirect (_reload) so a fresh daemon inherits state.
function _load() {
  _overrides.clear();
  let raw;
  try { raw = _fs.readFileSync(_overridesPath(), 'utf8'); }
  catch (_) { return; } // no file yet -> empty map
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return; } // corrupt -> empty map
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) _overrides.set(k, v);
  }
}

// Load once at module init so the very first turn after a respawn sees the
// operator's persisted choices.
_load();

// The untagged-surface bucket. The troth CLI and voice surfaces carry NO
// conversation_id (null/undefined); they are one long-lived local surface, not
// a set of panes. Rather than refuse /engine there, we give the whole untagged
// surface ONE shared bucket under this sentinel key: /engine typed in the CLI
// sets the override for every subsequent untagged turn, and tagged panes (real
// conversation_ids) are completely unaffected because they key on their own id.
// The sentinel is namespaced so it can never collide with a real conversation_id.
const UNTAGGED_KEY = '__troth_untagged_surface__';

// bucketKey: normalize an inbound conversation_id to its storage key. A null or
// undefined id (CLI / voice) maps to the single shared UNTAGGED_KEY bucket; any
// real id keys on itself. This is the ONE place null-vs-tagged is decided, so
// the handler, the dispatch site, and the tests can never drift on it.
function bucketKey(conversationId) {
  return conversationId == null ? UNTAGGED_KEY : conversationId;
}

// isUntagged: true when this turn came from a tagless surface (CLI / voice).
// The handler uses it to phrase the scope honestly ("this terminal surface"
// vs "this pane").
function isUntagged(conversationId) {
  return conversationId == null;
}

// Engine words that map straight to a wired faculty. `kimi` is intentionally
// NOT here: it maps to the kimi_sub faculty only when that faculty is wired
// (see kimiFacultyWired + resolveEngine), and falls back to the honest backbone
// reply otherwise — so its resolution is key-dependent, not static.
const ENGINE_TO_FACULTY = {
  claude:  'claude_cli',
  chatgpt: 'codex_oauth',
  local:   'llamacpp',
  // Claude on a raw Anthropic API key. A separate transport from claude_cli
  // (which drives the Claude Code harness), so it gets its own word instead of
  // overloading `claude`: an operator with a key but no subscription had no way
  // to name the lane they had actually paid for.
  anthropic: 'anthropic',
};

// The native faculty name the `kimi` word maps to once the membership is wired.
const KIMI_FACULTY = 'kimi_sub';

// Router provider words: these all ride the `router` faculty (the router walks
// its own configured provider chain). Listed so the handler can name them and
// so an unknown word is rejected honestly instead of silently mis-routed.
const ROUTER_PROVIDERS = ['deepseek', 'openrouter', 'nvidia', 'deepinfra', 'alibaba', 'router'];

// kimi rides the global backbone env ONLY when its native faculty is not wired.
// Named so the handler can reply honestly (Settings) in that case; when the
// faculty IS wired, resolveEngine returns it as a real per-pane faculty instead.
const BACKBONE_ONLY = ['kimi'];

// kimiFacultyWired: is the native kimi_sub faculty available to dispatch to?
// The faculty needs the Kimi membership key; without it, resolveTransport
// ('kimi_sub') and the transport itself hard-fail (no_api_key). Read at call
// time (env), matching the transport's own "read at call time" convention, so
// a live re-config takes effect without a restart. This is the ONE place the
// wired/unwired decision is made so the handler, dispatch site, and tests can
// never drift on it.
function kimiFacultyWired() {
  return !!String(process.env.TROTH_KIMI_SUB_KEY || '').trim();
}

// resolveEngine(word) -> one of:
//   { kind: 'faculty',  engine, faculty }          — set an override
//   { kind: 'auto',     prefer }                    — clear override / set prefer
//   { kind: 'backbone', engine }                    — rides the global backbone
//   { kind: 'unknown',  engine }                    — not recognized
// The `prefer` for auto is null (bare `auto` = clear), 'local' (local-first) or
// 'best' (best-first). The caller (handler) supplies the mode tail.
function resolveEngine(word, modeTail) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return { kind: 'report' };
  if (w === 'auto') {
    const m = String(modeTail || '').trim().toLowerCase();
    if (m === 'local-first' || m === 'local' || m === 'local_first') return { kind: 'auto', prefer: 'local' };
    if (m === 'best-first'  || m === 'best'  || m === 'best_first')  return { kind: 'auto', prefer: 'best' };
    return { kind: 'auto', prefer: null };
  }
  if (Object.prototype.hasOwnProperty.call(ENGINE_TO_FACULTY, w)) {
    return { kind: 'faculty', engine: w, faculty: ENGINE_TO_FACULTY[w] };
  }
  if (ROUTER_PROVIDERS.includes(w)) {
    // The provider word selects the router faculty; v1 cannot pin the exact
    // provider inside the router without the shared router module (off-limits).
    return { kind: 'faculty', engine: w, faculty: 'router', router_provider: true };
  }
  if (w === 'kimi') {
    // Kimi stops punting when its
    // native faculty is wired. With the membership key present it is a real
    // per-pane faculty (dispatches to kimi_sub); without the key it cannot
    // wire, so keep the honest backbone reply that points at Settings (fail
    // closed - never pin an unwired faculty).
    if (kimiFacultyWired()) {
      return { kind: 'faculty', engine: w, faculty: KIMI_FACULTY };
    }
    return { kind: 'backbone', engine: w };
  }
  if (BACKBONE_ONLY.includes(w)) return { kind: 'backbone', engine: w };
  return { kind: 'unknown', engine: w };
}

// get(conversation_id) -> the stored override entry or null. A null/undefined id
// reads the shared untagged-surface bucket (CLI / voice), NOT nothing.
function get(conversationId) {
  return _overrides.get(bucketKey(conversationId)) || null;
}

// setFaculty: the operator pinned this surface to an engine that maps to a
// wired faculty. Preserves any existing `prefer`. Works for both a tagged pane
// and the untagged CLI/voice surface (keyed via bucketKey).
function setFaculty(conversationId, engine, faculty, routerProvider) {
  const k = bucketKey(conversationId);
  const prev = _overrides.get(k) || {};
  const entry = { engine, faculty, prefer: prev.prefer || null, router_provider: !!routerProvider };
  _overrides.set(k, entry);
  _persist(); // durable: survives a daemon respawn / app restart
  return entry;
}

// setPrefer: `/engine auto <mode>`. Sets the surface's dispatch preference
// WITHOUT a hard faculty override (the normal dispatcher still runs, reordered
// by prefer at the dispatch site for NEW turns). A null prefer clears the whole
// entry; the surface returns to the pure global default. Untagged surface uses
// the shared bucket.
function setPrefer(conversationId, prefer) {
  const k = bucketKey(conversationId);
  if (prefer == null) { _overrides.delete(k); _persist(); return null; }
  const prev = _overrides.get(k) || {};
  const entry = { engine: prev.engine || null, faculty: prev.faculty || null, prefer };
  _overrides.set(k, entry);
  _persist(); // durable
  return entry;
}

// clear: `/engine auto` removes the surface's override entirely (tagged pane or
// the shared untagged bucket).
function clear(conversationId) {
  _overrides.delete(bucketKey(conversationId));
  _persist(); // durable: the cleared state is remembered too
}

// Test-only reset so suites do not leak overrides across cases. Clears the map
// AND the persisted file (best-effort) so a later _load() in the same process /
// home starts clean. Honors a test's redirected TROTH_ENGINE_OVERRIDES_PATH /
// TROTH_CONFIG_DIR / HOME just like the read+write paths.
function _reset() {
  _overrides.clear();
  try { _fs.unlinkSync(_overridesPath()); } catch (_) { /* no file -> nothing to clear */ }
}

// Test-only: re-read the persisted file into the in-memory map. Lets a unit test
// simulate a daemon restart against the same planted HOME without spawning a new
// process: set an override, _reload(), assert it survived.
function _reload() { _load(); }

module.exports = {
  ENGINE_TO_FACULTY,
  KIMI_FACULTY,
  ROUTER_PROVIDERS,
  BACKBONE_ONLY,
  UNTAGGED_KEY,
  kimiFacultyWired,
  bucketKey,
  isUntagged,
  resolveEngine,
  get,
  setFaculty,
  setPrefer,
  clear,
  _reset,
  _reload,
  _overridesPath,
};
