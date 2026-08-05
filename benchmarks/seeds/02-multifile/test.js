// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('assert');
const http = require('http');
process.env.NODE_ENV = 'test';
const app = require('./server');

let server, token;
const BASE = 'http://localhost:3002';

function req(method, path, body, auth) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = 'Bearer ' + auth;
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers };
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
  server = app.listen(3002);
  let passed = 0, failed = 0;

  async function test(name, fn) {
    try { await fn(); passed++; console.log(`  PASS: ${name}`); }
    catch (e) { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }
  }

  // ========== EXISTING FUNCTIONALITY (should already work) ==========

  await test('Register user', async () => {
    const r = await req('POST', '/auth/register', { username: 'alice', password: 'pwd123' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.username, 'alice');
  });

  await test('Login returns token', async () => {
    const r = await req('POST', '/auth/login', { username: 'alice', password: 'pwd123' });
    assert.strictEqual(r.status, 200);
    assert(r.body.token);
    token = r.body.token;
  });

  await test('Protected route rejects without token', async () => {
    const r = await req('GET', '/posts');
    assert.strictEqual(r.status, 401);
  });

  await test('Create post with token', async () => {
    const r = await req('POST', '/posts', { title: 'First', body: 'Hello world' }, token);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.title, 'First');
  });

  await test('Create comment with token', async () => {
    const r = await req('POST', '/comments', { post_id: 1, body: 'Nice post' }, token);
    assert.strictEqual(r.status, 201);
  });

  // ========== NEW FEATURE: User profile aggregate ==========
  // The agent must add: GET /users/:id/profile that returns user info + post count + comment count + last post date

  await test('Profile aggregate endpoint returns combined data', async () => {
    const r = await req('GET', '/users/1/profile', null, token);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.username, 'alice');
    assert.strictEqual(r.body.post_count, 1);
    assert.strictEqual(r.body.comment_count, 1);
    assert(r.body.last_post_date, 'Should include last_post_date');
  });

  await test('Profile of non-existent user returns 404', async () => {
    const r = await req('GET', '/users/999/profile', null, token);
    assert.strictEqual(r.status, 404);
  });

  // ========== NEW FEATURE: Post search ==========
  // The agent must add: GET /posts/search?q=<query> that returns posts matching title or body (case-insensitive)

  await req('POST', '/posts', { title: 'JavaScript tips', body: 'Learn JS' }, token);
  await req('POST', '/posts', { title: 'Python guide', body: 'Code in Python' }, token);

  await test('Post search matches title', async () => {
    const r = await req('GET', '/posts/search?q=javascript', null, token);
    assert.strictEqual(r.status, 200);
    assert(Array.isArray(r.body));
    assert(r.body.length >= 1);
    assert(r.body.some(p => p.title.toLowerCase().includes('javascript')));
  });

  await test('Post search matches body case-insensitive', async () => {
    const r = await req('GET', '/posts/search?q=PYTHON', null, token);
    assert.strictEqual(r.status, 200);
    assert(r.body.length >= 1);
  });

  await test('Post search returns empty array for no matches', async () => {
    const r = await req('GET', '/posts/search?q=xyznevermatches', null, token);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, []);
  });

  // ========== NEW FEATURE: Rate limiting middleware ==========
  // The agent must add middleware that limits POST /comments to 5 per minute per user, returning 429

  await test('Rate limit on /comments allows first 5 requests', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await req('POST', '/comments', { post_id: 1, body: `comment ${i}` }, token);
      assert(r.status === 201, `Request ${i+1} should succeed, got ${r.status}`);
    }
  });

  await test('Rate limit on /comments returns 429 on 6th request', async () => {
    const r = await req('POST', '/comments', { post_id: 1, body: 'over limit' }, token);
    assert.strictEqual(r.status, 429);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
