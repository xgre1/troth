#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The maintenance worker beside the loop: the child boots on a throwaway
// substrate, says ready with its task list, answers a status ask, takes a
// foreground ping, and stops when its stdin closes; the proxy-side handle
// reads the same fields the readiness view reads, and starts the child
// again after it dies.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-maint-'));
const ENV = Object.assign({}, process.env, {
  STATE_DB_PATH: path.join(TMP, 'state.db'), TROTH_CONFIG_DIR: TMP, HOME: TMP,
  TROTH_MAINT_TICK_MS: '200', TROTH_MAINT_IDLE_MS: '0', TROTH_MAINT_STATUS_MS: '500',
  TROTH_UNDERSTANDING: '0', TROTH_IMPORT_SYNC: '0', TROTH_EMBED_SPAWN: '0'
});

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lines(child) {
  const got = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { got.push(JSON.parse(l)); } catch (_) {} }
  });
  return got;
}
async function until(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(25); } return pred(); }

console.log('\n=== maintenance worker beside the loop ===\n');

(async () => {
  await t('the child says ready with its tasks, answers a status ask, and stops when stdin closes', async () => {
    const child = spawn(process.execPath, [path.join(REPO, 'bin', 'troth-maintenance.js')], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const got = lines(child);
    assert.ok(await until(() => got.some((m) => m.kind === 'ready'), 15000), 'ready within 15s; stderr: ' + err.slice(0, 300));
    const ready = got.find((m) => m.kind === 'ready');
    assert.ok(ready.pid > 0 && Array.isArray(ready.tasks) && ready.tasks.includes('embedding_backfill'), JSON.stringify(ready));
    child.stdin.write(JSON.stringify({ kind: 'foreground' }) + '\n');
    child.stdin.write(JSON.stringify({ kind: 'status' }) + '\n');
    assert.ok(await until(() => got.some((m) => m.kind === 'status'), 5000), 'a status line answers the ask');
    const st = got.find((m) => m.kind === 'status');
    assert.deepStrictEqual(st.skipped_tasks, []);
    assert.strictEqual(st.last_tick_error, null);
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    child.stdin.end();
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
    assert.strictEqual(code, 0, 'exits 0 when stdin closes, got ' + code);
    assert.ok(got.some((m) => m.kind === 'stopped'), 'and says so');
  });

  await t('the proxy-side handle reads the child and starts it again after it dies', async () => {
    const mc = require(path.join(REPO, 'proxy', 'modules', 'maintenance-child.js'));
    const logs = [];
    const h = mc.start({ log: (s) => logs.push(String(s)), env: ENV });
    assert.strictEqual(h.process, 'child');
    assert.ok(await until(() => h.status().alive && logs.some((l) => /Maintenance worker up/.test(l)), 15000), 'up: ' + logs.join(' / ').slice(0, 300));
    const pid1 = h.pid;
    assert.ok(pid1 > 0);
    h.noteForegroundActivity();
    assert.ok(await until(() => h.status().last_status_at != null, 5000), 'a status line arrived');
    assert.deepStrictEqual(h.skipped_tasks, []);
    assert.strictEqual(h.last_tick_error(), null);
    process.kill(pid1, 'SIGKILL');
    assert.ok(await until(() => !h.status().alive, 5000), 'the death is seen');
    assert.strictEqual(h.status().restarts, 1);
    // The first pause is five seconds; the child is back after it.
    assert.ok(await until(() => h.status().alive && h.pid !== pid1, 20000), 'started again with a new pid');
    h.stop();
    assert.ok(await until(() => !h.status().alive, 5000), 'stop() ends it');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\nmaintenance-child: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
