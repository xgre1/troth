// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The proxy follows its port when the configured one is taken. Everything that
// wants to reach it must follow too — and several places did not: they carried
// 127.0.0.1:8000 as a literal, so on any machine that had moved they failed and
// reported the proxy as down. This occupies the port first and then asks the
// product to work anyway.
const http = require('http');
const net = require('net');

module.exports.describe = 'somebody else already has the port';
module.exports.run = async (ctx, check) => {
  const WANTED = 8811;

  // Squat on the port the operator configured.
  // Accept and hang up at once. A squatter that accepts and then says nothing
  // leaves the prober waiting on a socket that never answers, and close() waits
  // for those sockets — the scenario deadlocked on its own fixture.
  const squatter = net.createServer((sock) => { try { sock.destroy(); } catch (_) {} });
  await new Promise((r, j) => { squatter.once('error', j); squatter.listen(WANTED, '127.0.0.1', r); });

  try {
    // The requested port will never answer — the squatter has it. Give the boot
    // probe a short leash and read where the proxy actually went from its log.
    const proxy = await ctx.proxy({ port: WANTED, env: { GF_WATCH_DIR: ctx.root }, bootMs: 6000 });
    await new Promise((r) => setTimeout(r, 2000));

    // It must not have taken the port it could not have.
    const moved = (proxy.log().match(/Listening on 127\.0\.0\.1:(\d+)/) || [])[1];
    check('it starts even though the port was taken', !!moved,
      'no "Listening on" line: ' + proxy.log().slice(-200));
    if (!moved) return;
    check('it moved off the occupied port', Number(moved) !== WANTED, 'took ' + moved + ' anyway');

    const port = Number(moved);
    const get = (p) => new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      r.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    });

    const live = await get('/api/setup/local');
    check('it serves on the port it actually took', live.status === 200,
      'status=' + live.status + ' ' + (live.error || ''));

    // Whatever address it prints has to be the one it is on. Printing the port
    // it wanted is how an operator ends up in a dead browser tab.
    const printed = (proxy.log().match(/Dashboard: http:\/\/[^\s:]+:(\d+)/) || [])[1];
    check('the address it prints is the one it is on', printed === String(port),
      'printed ' + printed + ', listening on ' + port);

    // And nothing may hardcode the address it was born with. Source-tree only:
    // the shipped bundle is minified and has no comments to exempt.
    if (ctx.target === 'local') {
      const { execFileSync } = require('child_process');
      let hits = '';
      try {
        hits = execFileSync('grep', ['-rn', '--include=*.js', '-E',
          '(localhost|127\\.0\\.0\\.1):8000', 'bin', 'shared-core', 'proxy/modules', 'adapters'],
          { cwd: ctx.root, encoding: 'utf8' });
      } catch (e) { hits = (e && e.stdout) || ''; }
      const real = hits.split('\n').filter(Boolean).filter((l) => {
        const code = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1).trim();
        if (code.startsWith('//') || code.startsWith('*')) return false;       // prose
        return !/process\.env\.[A-Z_]+\s*\|\|/.test(code);                     // env-overridable default
      });
      check('no unconditional 8000 literal in the code that calls the proxy', real.length === 0,
        real.slice(0, 3).join(' | '));
    }
  } finally {
    await new Promise((r) => squatter.close(r));
  }
};
