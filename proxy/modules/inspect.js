// SPDX-License-Identifier: AGPL-3.0-only
// inspect.js — the partner's read-only road onto the operator's machine and
// troth's own state, served by the proxy.
//
// The partner's shell always sits inside a ground wall, and two things no
// wall can carry: setuid tools (`ps`, `top`) refuse to exec under any
// seatbelt, and `log show` refuses to run while sandboxed. The proxy runs
// outside the walls under its service manager, so it answers those questions
// on the partner's behalf, read-only, localhost-only, with the same redaction
// every proxy answer gets. Nothing here reads the substrate directory, the
// token store or a key: the ChatGPT probe uses the token inside this process
// and reports only what the endpoint said.
'use strict';

const spawnPurpose = require('../../shared-core/tools/spawn-purpose.js');

// ── proxy log buffer: since / grep / limit ──────────────────────────────
function filterLogLines(lines, q) {
  const since = parseInt((q && q.since) || '0', 10) || 0;
  const grep = String((q && q.grep) || '').slice(0, 200);
  const limit = Math.min(5000, Math.max(0, parseInt((q && q.limit) || '0', 10) || 0)) || null;
  let out = since ? lines.filter((l) => l && l.ts > since) : lines.slice();
  if (grep) {
    let re = null;
    try { re = new RegExp(grep, 'i'); } catch (_) { re = null; }
    const needle = grep.toLowerCase();
    out = out.filter((l) => re ? re.test(String(l && l.msg || '')) : String(l && l.msg || '').toLowerCase().includes(needle));
  }
  if (limit && out.length > limit) out = out.slice(-limit);
  return out;
}

// ── unified log (macOS `log show`) ───────────────────────────────────────
// The window is one number and a unit, at most a day. The predicate is held
// to the characters a `log` predicate needs and nothing a shell would care
// about; argv goes to the tool as an array, never through a shell.
const LAST_RE = /^(\d{1,4})(s|m|h)$/;
const PREDICATE_RE = /^[A-Za-z0-9 _.="'()&|!<>-]{0,200}$/;

function validateLast(s) {
  const m = String(s || '5m').trim().match(LAST_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1) return null;
  if (m[2] === 'h' && n > 24) return null;
  if (m[2] === 'm' && n > 1440) return null;
  if (m[2] === 's' && n > 86400) return null;
  return m[0];
}

function validatePredicate(s) {
  const p = String(s || '').trim();
  return PREDICATE_RE.test(p) ? p : null;
}

function unifiedLog(q) {
  q = q || {};
  if (process.platform !== 'darwin') throw new Error('the unified log is a macOS surface');
  const last = validateLast(q.last);
  if (!last) throw new Error('last: a number and a unit, like 30s, 5m or 2h, at most a day');
  const predicate = validatePredicate(q.predicate);
  if (predicate === null) throw new Error('predicate: letters, digits, spaces, quotes, dots, ==, &&, ||, parentheses, at most 200 characters');
  const limit = Math.min(2000, Math.max(1, parseInt(q.limit || '200', 10) || 200));
  const args = ['show', '--last', last, '--style', 'compact'];
  if (predicate) args.push('--predicate', predicate);
  let out = '';
  try {
    out = spawnPurpose.execFileSync('system-inspect', '/usr/bin/log', args,
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const tail = String((e && e.stderr) || (e && e.message) || e).slice(-300);
    throw new Error('log show did not answer (' + tail.trim() + ') — narrow the window or the predicate');
  }
  const all = String(out).split('\n').filter(Boolean);
  return { last, predicate, count: all.length, truncated: all.length > limit, lines: all.slice(-limit) };
}

// ── ChatGPT lane probe ───────────────────────────────────────────────────
function parseResetsIn(detail) {
  const m = String(detail || '').match(/resets_in_seconds"?\s*[:=]\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// One word through the codex transport. A delta is proof the lane answers;
// the stream is cut right after it so the probe costs one token of output.
// A refusal comes back as the endpoint's status, its reason and, on a plan
// limit, the seconds until the window resets.
async function codexProbe(opts) {
  opts = opts || {};
  const { makeCodexOAuthTransport } = require('../../shared-core/transports/codex-oauth.js');
  const t = makeCodexOAuthTransport({});
  const model = String(opts.model || '').trim() || null;
  const started = Date.now();
  const timeoutMs = Math.min(60000, Math.max(1000, parseInt(opts.timeout_ms || '20000', 10) || 20000));
  let handle;
  try {
    handle = await t.stream({ system: 'Answer with one word.', user: 'ping', options: model ? { model } : {} });
  } catch (e) {
    return { ok: false, model, reason: (e && e.code) || 'transport_error',
      detail: String((e && e.message) || e).slice(0, 300), elapsed_ms: Date.now() - started };
  }
  const served = (handle && handle.model) || model;
  let text = '';
  const deadline = started + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const timer = new Promise((r) => setTimeout(() => r({ value: { done: true, _abort_reason: 'timeout' } }), Math.max(1, deadline - Date.now())));
      const step = await Promise.race([handle.next(), timer]);
      const v = step && step.value;
      if (!v) break;
      if (v._abort_reason) {
        return { ok: false, model: served, status: v._status || null, reason: v._abort_reason,
          resets_in_seconds: parseResetsIn(v._detail), detail: String(v._detail || '').slice(0, 300),
          elapsed_ms: Date.now() - started };
      }
      if (v.delta) { text += v.delta; break; }
      if (v.done) break;
    }
  } finally {
    try { t.abort(handle); } catch (_) {}
  }
  return { ok: true, model: served, first_text: text.slice(0, 40), elapsed_ms: Date.now() - started };
}

module.exports = { filterLogLines, validateLast, validatePredicate, unifiedLog, parseResetsIn, codexProbe };
