// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The context a prompt gets and the context a session starts with, as the
// Claude Code hooks build them, for any host that asks over the proxy: one
// road, so a memory provider in another agent reads what the hooks read.

const path = require('path');
const spawnPurpose = require('./tools/spawn-purpose.js');

const PLUGIN_ROOT = path.join(__dirname, '..', 'plugin');
const HOOK_MS = Math.max(5000, parseInt(process.env.TROTH_HOOK_CONTEXT_MS || '25000', 10) || 25000);

function runHook(script, payload, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cwd = (opts && opts.cwd) || process.cwd();
    const env = Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
    let child;
    try {
      child = spawnPurpose.spawn('hook-context', process.execPath, [path.join(PLUGIN_ROOT, 'hooks', script)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ context: '', ms: 0, error: e && e.message }); return; }
    let out = '', err = '';
    let done = false;
    const finish = (extra) => {
      if (done) return; done = true;
      let context = '';
      for (const line of String(out).split('\n').map((s) => s.trim()).filter(Boolean).reverse()) {
        if (line[0] !== '{') continue;
        try { const j = JSON.parse(line); context = (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || j.additionalContext || ''; break; } catch (_) { /* not the JSON line */ }
      }
      resolve(Object.assign({ context: String(context || ''), ms: Date.now() - t0 }, extra || {}));
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} finish({ timed_out: true }); }, HOOK_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); finish({ error: e && e.message }); });
    child.on('close', () => { clearTimeout(timer); finish(err.trim() ? { stderr: err.trim().slice(-400) } : {}); });
    try { child.stdin.end(JSON.stringify(payload)); } catch (_) { /* the child reports through close */ }
  });
}

// The per-prompt context: identity, standing rules, recall, goals, constraints.
function promptContext(o) {
  o = o || {};
  const cwd = o.cwd || process.cwd();
  return runHook('injector.mjs', {
    hook_event_name: 'UserPromptSubmit',
    prompt: String(o.prompt || ''),
    session_id: String(o.session_id || ('context-' + Date.now())),
    cwd
  }, { cwd });
}

// The session-start context: orientation, open goals, the last handoff.
function sessionContext(o) {
  o = o || {};
  const cwd = o.cwd || process.cwd();
  return runHook('session-start.mjs', {
    hook_event_name: 'SessionStart',
    session_id: String(o.session_id || ('context-' + Date.now())),
    cwd
  }, { cwd });
}

module.exports = { promptContext, sessionContext, PLUGIN_ROOT, HOOK_MS };
