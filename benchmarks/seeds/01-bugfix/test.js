// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('assert');
const http = require('http');
const app = require('./server');

let server;
const BASE = 'http://localhost:3001';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'content-type': 'application/json' } };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function run() {
  server = app.listen(3001);
  let passed = 0, failed = 0;

  async function test(name, fn) {
    try { await fn(); passed++; console.log(`  PASS: ${name}`); }
    catch (e) { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }
  }

  // Test 1: POST requires title
  await test('POST without title returns 400', async () => {
    const r = await req('POST', '/tasks', { description: 'no title' });
    assert.strictEqual(r.status, 400);
  });

  // Test 2: POST with valid data
  await test('POST creates task', async () => {
    const r = await req('POST', '/tasks', { title: 'Task A', priority: 'high' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.title, 'Task A');
    assert.strictEqual(r.body.priority, 'high');
    assert.strictEqual(r.body.status, 'todo');
  });

  // Create more tasks for filter tests
  await req('POST', '/tasks', { title: 'Task B', priority: 'low' });
  await req('POST', '/tasks', { title: 'Task C', priority: 'high' });

  // Test 3: GET with status filter
  await test('GET /tasks?status=todo returns only todo tasks', async () => {
    const r = await req('GET', '/tasks?status=todo');
    assert.strictEqual(r.status, 200);
    assert(Array.isArray(r.body));
    assert(r.body.every(t => t.status === 'todo'));
  });

  // Test 4: GET with priority filter
  await test('GET /tasks?priority=high returns only high priority', async () => {
    const r = await req('GET', '/tasks?priority=high');
    assert.strictEqual(r.status, 200);
    assert(r.body.length === 2);
    assert(r.body.every(t => t.priority === 'high'));
  });

  // Test 5: PUT non-existent task returns 404
  await test('PUT /tasks/999 returns 404', async () => {
    const r = await req('PUT', '/tasks/999', { status: 'done' });
    assert.strictEqual(r.status, 404);
  });

  // Test 6: PUT existing task updates status
  await test('PUT /tasks/1 updates status', async () => {
    const r = await req('PUT', '/tasks/1', { status: 'done' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'done');
  });

  // Test 7: Stats grouped by status
  await test('GET /tasks/stats returns counts by status', async () => {
    const r = await req('GET', '/tasks/stats');
    assert.strictEqual(r.status, 200);
    const done = r.body.find(s => s.group_key === 'done');
    const todo = r.body.find(s => s.group_key === 'todo');
    assert(done, 'Should have done group');
    assert(todo, 'Should have todo group');
    assert.strictEqual(done.count, 1);
    assert.strictEqual(todo.count, 2);
  });

  // Test 8: DELETE
  await test('DELETE /tasks/1 removes task', async () => {
    const r = await req('DELETE', '/tasks/1');
    assert.strictEqual(r.status, 204);
    const check = await req('GET', '/tasks');
    assert.strictEqual(check.body.length, 2);
  });

  // Test 9: DELETE non-existent
  await test('DELETE /tasks/999 returns 404', async () => {
    const r = await req('DELETE', '/tasks/999');
    assert.strictEqual(r.status, 404);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
