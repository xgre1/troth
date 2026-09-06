#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The video preset: config.video sets the source, model and clip shape a
// request gets unless the request says otherwise; the proxy serves the
// catalogue with the saved preset and keeps other preset fields on a partial
// save.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'video-preset-'));
fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
const CFG = path.join(HOME, '.troth', 'config.json');
process.env.TROTH_CONFIG_PATH = CFG;
const vg = require(path.join(ROOT, 'shared-core', 'tools', 'video-gen.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch((e) => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function req(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    r.on('error', reject); r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
async function waitUp(port) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try { const r = await req(port, 'GET', '/health'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('proxy did not come up');
}

console.log('\n=== video preset ===\n');

(async () => {
  await t('the preset from config becomes the request, and a request field wins over it', async () => {
    fs.writeFileSync(CFG, JSON.stringify({ video: { provider: 'google_ai', model: 'veo-3.1', duration_s: 10, resolution: '1080p', aspect: '16:9', audio: false } }));
    const p = vg.readVideoPrefs();
    assert.deepStrictEqual(p, { provider: 'google_ai', model: 'veo-3.1', seconds: 10, aspect: '16:9', resolution: '1080p', audio: false });
    const v = vg.validate({ prompt: 'a cat', duration_s: 5 });
    assert.strictEqual(v.provider, 'google_ai');
    assert.strictEqual(v.model, 'veo-3.1');
    assert.strictEqual(v.seconds, 5);
    assert.strictEqual(v.resolution, '1080p');
    assert.strictEqual(v.audio, false);
  });

  await t('a request that names the other source drops the preset model', async () => {
    const v = vg.validate({ prompt: 'a cat', provider: 'openrouter' });
    assert.strictEqual(v.provider, 'openrouter');
    assert.strictEqual(v.model, null);
    const w = vg.validate({ prompt: 'a cat', provider: 'openrouter', model: 'alibaba/wan-3.0' });
    assert.strictEqual(w.model, 'alibaba/wan-3.0');
  });

  await t('a preset with values outside the ranges falls back to the defaults, and no preset is the defaults', async () => {
    fs.writeFileSync(CFG, JSON.stringify({ video: { provider: 'nope', model: '', duration_s: 99, resolution: '8k', aspect: '3:2', audio: 'yes' } }));
    assert.deepStrictEqual(vg.readVideoPrefs(), Object.assign({ provider: null, model: null }, vg.DEFAULTS));
    fs.writeFileSync(CFG, '{}');
    assert.deepStrictEqual(vg.readVideoPrefs(), Object.assign({ provider: null, model: null }, vg.DEFAULTS));
  });

  const port = await freePort();
  const env = Object.assign({}, process.env, { HOME, GF_PORT: String(port), TROTH_KEEP_SIBLINGS: '1' });
  delete env.GF_WATCH_DIR;
  const proxy = spawn(process.execPath, [path.join(ROOT, 'proxy', 'server.js')], { cwd: HOME, env, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    await waitUp(port);
    await t('the proxy serves the video catalogue with the saved preset', async () => {
      fs.writeFileSync(CFG, JSON.stringify({ video: { provider: 'openrouter', model: 'alibaba/wan-3.0', duration_s: 15 } }));
      const r = await req(port, 'GET', '/api/video/models');
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      const j = JSON.parse(r.text);
      assert.deepStrictEqual(j.providers.map((p) => p.id), ['openrouter', 'google_ai']);
      const or = j.models.filter((m) => m.provider === 'openrouter').map((m) => m.id);
      assert.ok(or.indexOf('bytedance/seedance-2.5') === 0, 'Seedance 2.5 leads the OpenRouter list: ' + or.join(','));
      assert.ok(j.models.some((m) => m.provider === 'google_ai' && m.id === 'veo-3.1-fast'), 'Veo 3.1 fast is on the Google list');
      assert.strictEqual(j.prefs.model, 'alibaba/wan-3.0');
      assert.strictEqual(j.prefs.seconds, 15);
      assert.ok(Array.isArray(j.aspects) && j.aspects.length >= 2);
    });
    await t('a partial preset save keeps the other preset fields', async () => {
      const r = await req(port, 'POST', '/api/config', { video: { resolution: '480p' } });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      const saved = JSON.parse(fs.readFileSync(CFG, 'utf8')).video;
      assert.strictEqual(saved.resolution, '480p');
      assert.strictEqual(saved.model, 'alibaba/wan-3.0', 'the model survived a save that did not carry it');
      assert.strictEqual(saved.duration_s, 15);
    });
  } finally {
    try { proxy.kill('SIGKILL'); } catch (_) {}
  }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  console.log('\nvideo-preset: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
