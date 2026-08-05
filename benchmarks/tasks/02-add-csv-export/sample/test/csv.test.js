// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('assert');
const http = require('http');
const { server } = require('../server');

server.listen(0, () => {
  const port = server.address().port;
  const req = http.request({ hostname: '127.0.0.1', port, path: '/users.csv', method: 'GET' }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c.toString('utf8'); });
    res.on('end', () => {
      try {
        assert.strictEqual(res.statusCode, 200, 'expected 200, got ' + res.statusCode);
        const ct = (res.headers['content-type'] || '').toLowerCase();
        assert.ok(/text\/csv/.test(ct), 'expected text/csv content-type, got ' + ct);

        const lines = body.trim().split('\n');
        assert.ok(lines.length >= 2, 'need header + at least one row');

        const header = lines[0].toLowerCase();
        for (const col of ['id', 'name', 'email', 'role']) {
          assert.ok(header.includes(col), 'csv header missing column: ' + col);
        }
        assert.ok(lines.length === 6, 'expected 5 data rows (one per user) + header, got ' + (lines.length - 1));
        console.log('All tests passed.');
        server.close(() => process.exit(0));
      } catch (e) {
        console.error(e.message);
        server.close(() => process.exit(1));
      }
    });
  });
  req.end();
});
