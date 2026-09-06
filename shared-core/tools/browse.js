// SPDX-License-Identifier: AGPL-3.0-only
// browse — one real Chrome page over CDP, for the partner's own hands.
//
// The same road the Claude Code plugin drives (troth-bash `browse`), lifted
// here so the troth CLI agent has it too: navigate, wait, evaluate JS in
// the page, screenshot to a file. With no port it uses the troth browser
// only (the daemon's private profile, started if needed); an explicit port
// is attach-only, and 9222 stays the operator's own opt-in. perform() is the
// whole contract and the plugin calls it; run() wraps it for the tool loop.
'use strict';

const path = require('path');
const fs = require('fs');

const schema = { type: 'function', function: {
  name: 'browse',
  description: 'Drive a real Chrome page over CDP: navigate, read the DOM, click and fill through eval JS, screenshot. Steps in order: goto url, wait_ms, eval JS (JSON result returned), screenshot to a PNG path. With no port it uses the troth browser and starts it if needed (private profile, never the operator\'s own session). With an explicit port it only attaches; port 9222 reaches a browser the operator started with --remote-debugging-port=9222. eval and screenshot count as writes.',
  parameters: { type: 'object', properties: {
    url:        { type: 'string',  description: 'Navigate here first (optional).' },
    eval:       { type: 'string',  description: 'JS expression evaluated in the page; JSON-serializable result returned.' },
    screenshot: { type: 'string',  description: 'PNG file path (absolute or cwd-relative) to save a screenshot to.' },
    wait_ms:    { type: 'integer', description: 'Settle time after navigation in ms (default 1200).' },
    host:       { type: 'string',  description: 'CDP host (default 127.0.0.1).' },
    port:       { type: 'integer', description: 'CDP port. Omit to use the troth browser (started if needed on 18222). Explicit ports are attach-only; 9222 is the operator\'s own debug browser.' }
  } }
} };

function _load(rel) {
  try { return { mod: require(rel) }; } catch (e) { return { error: e && e.message || String(e) }; }
}

// Where the page comes from. Returns { host, port, explicit } or { error }.
async function resolveTarget(args) {
  let host = (args && args.host) || '127.0.0.1';
  let port = Number(args && args.port) || 0;
  const explicit = port > 0;
  if (explicit) return { host, port, explicit };
  // No port asked: find or start the TROTH browser only. Whatever a
  // body/daemon already exported, then the private daemon port, then
  // launch the daemon's Chrome. The operator's own debug browser (9222) is
  // never a candidate here: the contract says "never your own session".
  const d = _load('../perception/chromium-daemon.js');
  if (d.mod) {
    const daemon = d.mod;
    const candidates = [];
    const envPort = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '', 10);
    if (envPort) candidates.push(envPort);
    if (candidates.indexOf(daemon.DEFAULT_PORT) === -1) candidates.push(daemon.DEFAULT_PORT);
    for (const c of candidates) {
      const h = await daemon.aliveHost(c, 900);
      if (h) { host = h; port = c; break; }
    }
    if (!port) {
      if (args && args.attach_only) return { error: 'no troth browser alive to attach and starting one was not asked for' };
      const up = await daemon.ensure({});
      if (up && up.ok) { host = up.host || host; port = up.port; }
      else return { error: 'no browser to attach and could not start one: ' + ((up && (up.detail || up.error)) || 'unknown') };
    }
  }
  // No daemon module on this install: there is no troth browser to use.
  // Falling back to 9222 would silently do what the no-port contract
  // exists to prevent; say what is missing instead.
  if (!port) {
    return { error: 'no troth browser available on this install. To drive your OWN debug Chrome, start it with --remote-debugging-port=9222 and call browse with port 9222 explicitly.' };
  }
  return { host, port, explicit };
}

// The whole browse: { ok: true, out } or { ok: false, error }.
async function perform(args, cwd) {
  const a = args || {};
  const c = _load('../perception/cdp-client.js');
  if (!c.mod) return { ok: false, error: 'cdp client unavailable: ' + c.error };
  const cdp = c.mod;
  const target = await resolveTarget(a);
  if (target.error) return { ok: false, error: target.error };
  const { host, port, explicit } = target;
  let page;
  try { page = await cdp.connectFirstPage(host, port); }
  catch (e) {
    return { ok: false, error: 'no debuggable browser at ' + host + ':' + port + (explicit
      ? ' - explicit ports are attach-only; start that browser yourself with --remote-debugging-port=' + port
      : ' - and starting the troth browser did not yield a page') + '. Underlying: ' + (e && e.message || e) };
  }
  const out = {};
  try {
    await page.send('Page.enable', {});
    await page.send('Runtime.enable', {});
    if (a.url) {
      await page.send('Page.navigate', { url: String(a.url) });
      await new Promise((r) => setTimeout(r, Number(a.wait_ms) || 1200));
    } else if (a.wait_ms) {
      await new Promise((r) => setTimeout(r, Number(a.wait_ms)));
    }
    if (a.eval) {
      const r = await page.send('Runtime.evaluate', {
        expression: '(function(){ try { return JSON.stringify(' + a.eval + '); } catch (e) { return JSON.stringify({ __eval_error: String(e && e.message || e) }); } })()',
        returnByValue: true, awaitPromise: true
      });
      const v = r && r.result && r.result.value;
      try { out.eval = JSON.parse(v); } catch (_) { out.eval = v; }
    }
    if (a.screenshot) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.data) {
        const file = path.resolve(cwd || process.cwd(), String(a.screenshot));
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        out.screenshot = file;
      } else { out.screenshot = null; }
    }
  } catch (e) {
    try { page.close(); } catch (_) {}
    return { ok: false, error: 'browse failed: ' + (e && e.message || e) };
  }
  try { page.close(); } catch (_) {}
  return { ok: true, out };
}

// Is this call a write (eval runs script in the page, screenshot lands a
// file) or a read (navigate, wait)? permission.js asks per call.
function isWriteCall(args) {
  const a = args || {};
  return !!((typeof a.eval === 'string' && a.eval.trim()) || (typeof a.screenshot === 'string' && a.screenshot.trim()));
}

async function run(args, ctx) {
  const r = await perform(args, ctx && ctx.cwd);
  if (!r.ok) return { error: 'browse_failed', detail: r.error };
  return Object.assign({ ok: true }, r.out);
}

module.exports = { schema, run, perform, resolveTarget, isWriteCall };
