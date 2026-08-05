// SPDX-License-Identifier: AGPL-3.0-only
// Universal-executor registration. Run once at daemon startup so the
// dispatcher's adapter registry actually has the http/browser/shell/fs/
// skill/spawn executors when taskDispatchPending fires and starts
// draining validated intents.
//
// Tests already register adapters inline; this module is for the
// production daemon path (bin/troth-entity.js requires it once at
// boot). registerAdapter is idempotent — re-requiring this module is
// safe but the side effect runs only once thanks to require cache.
//
// Calling bootstrap() explicitly is also supported for any embedder
// that wants substrate dispatch without spawning the full entity
// daemon (custom CLI flows, test harnesses, the proxy server itself).

const dispatcher = require('../dispatcher.js');

// Pre-resolved adapter modules — top-level static requires with LITERAL
// string args so esbuild's bundler inlines them into substrate.js.
// Without these, the dynamic require below would fail in bundled-mode
// (Stage 3 body image): the relative paths don't exist on disk because
// esbuild inlined them. Source-tree mode still works (Node loads the
// modules from disk; same module cache as the dynamic require would hit).
//
// IMPORTANT: esbuild only bundles require() calls whose argument is a
// LITERAL STRING in the source. Wrapping require in a helper (`safeRequire(p)`)
// hides the literal and esbuild treats it as runtime — bundle fails.
// Each require here MUST be its own literal-arg call. We use IIFEs to
// keep the try/catch boilerplate inline (a single missing adapter,
// e.g. browser-do when playwright isn't installed, must not prevent
// the rest from loading).
// Classify a pre-resolve failure: the module ITSELF missing (absent by
// design in open builds — silent) vs present-but-threw (syntax error,
// missing transitive dep — must stay loud or a broken adapter ships dark;
// adversarial-review find. Function declaration: hoisted above
// the map evaluation below.
function _absentOrLoadError(modPath, e) {
  if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).indexOf(modPath) !== -1) return null;
  return { __load_error: (e && e.message) || String(e) };
}

const _BUNDLED_ADAPTERS = {
  './http-do.js':       (() => { try { return require('./http-do.js'); }       catch (e) { return _absentOrLoadError('./http-do.js', e); } })(),
  './browser-do.js':    (() => { try { return require('./browser-do.js'); }    catch (e) { return _absentOrLoadError('./browser-do.js', e); } })(),
  './shell-do.js':      (() => { try { return require('./shell-do.js'); }      catch (e) { return _absentOrLoadError('./shell-do.js', e); } })(),
  './fs-do.js':         (() => { try { return require('./fs-do.js'); }         catch (e) { return _absentOrLoadError('./fs-do.js', e); } })(),
  './skill-execute.js': (() => { try { return require('./skill-execute.js'); } catch (e) { return _absentOrLoadError('./skill-execute.js', e); } })(),
  './spawn-do.js':      (() => { try { return require('./spawn-do.js'); }      catch (e) { return _absentOrLoadError('./spawn-do.js', e); } })(),
  './cas-do.js':        (() => { try { return require('./cas-do.js'); }        catch (e) { return _absentOrLoadError('./cas-do.js', e); } })(),
  // MCP hands: governs the partner's external-MCP calls
  // through 'intent:mcp:call:*'. Literal-require IIFE, same as the others, so
  // esbuild inlines it into the bundle. mcp-client (its transport dep) is
  // core, so this never lands in the optional-absent branch.
  './mcp-do.js':        (() => { try { return require('./mcp-do.js'); }        catch (e) { return _absentOrLoadError('./mcp-do.js', e); } })()
};

const ADAPTER_MODULES = Object.keys(_BUNDLED_ADAPTERS);

let _bootstrapped = false;
let _registered   = [];

function bootstrap(opts) {
  opts = opts || {};
  if (_bootstrapped && !opts.force) return _registered.slice();
  _registered = [];
  for (const modPath of ADAPTER_MODULES) {
    // Use the pre-resolved module from _BUNDLED_ADAPTERS first (works
    // in both bundled + source-tree mode). Fall back to a dynamic
    // require for embedders who added a new adapter to ADAPTER_MODULES
    // after bootstrap.js loaded (uncommon but supported).
    let adapter = _BUNDLED_ADAPTERS[modPath];
    if (adapter && adapter.__load_error) {
      // Present but failed to load — this is a real defect, never silence it.
      try {
        process.stderr.write('[dispatchers/bootstrap] adapter ' + modPath + ' failed to load: ' + adapter.__load_error + '\n');
      } catch (_) {}
      continue;
    }
    if (!adapter) {
      if (Object.prototype.hasOwnProperty.call(_BUNDLED_ADAPTERS, modPath)) {
        // Pre-resolved as absent: an optional adapter this build ships
        // without (closed-overlay files in the open core). Skip silently;
        // warning here printed on every open-build CLI boot even though
        // the absence is by design.
        continue;
      }
      try { adapter = require(modPath); }
      catch (e) {
        try {
          process.stderr.write('[dispatchers/bootstrap] skipped ' + modPath + ': ' + (e && e.message || String(e)) + '\n');
        } catch (_) {}
        continue;
      }
    }
    if (adapter && adapter.scope_match && typeof adapter.dispatch === 'function') {
      dispatcher.registerAdapter(adapter);
      _registered.push(adapter.scope_match);
    }
  }
  _bootstrapped = true;
  return _registered.slice();
}

module.exports = {
  bootstrap,
  ADAPTER_MODULES,
  // Exposed for tests that want to re-run bootstrap with a clean slate.
  _reset: function () { _bootstrapped = false; _registered = []; }
};
