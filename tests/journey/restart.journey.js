// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What the product says about itself must not depend on which process is
// saying it. A restart with an untouched HOME changed nothing on disk, yet
// status went from "the memory model is installed" to "install the memory
// model" and offered to fetch 333 MB that was already sitting there — because
// the answer came from process memory rather than from the disk it described.
module.exports.describe = 'a restart does not change what is true';
module.exports.run = async (ctx, check) => {
  // Volatile fields: a second process legitimately differs here.
  const VOLATILE = /^(uptime|pid|started_at|now|ts|elapsed|boot|port|progress)/i;
  const stable = (o) => {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(stable);
    const out = {};
    for (const k of Object.keys(o).sort()) {
      if (VOLATILE.test(k)) continue;
      out[k] = stable(o[k]);
    }
    return out;
  };

  const first = await ctx.proxy({ env: { GF_WATCH_DIR: ctx.root } });
  const a = await first.get('/api/setup/local');
  check('the first process answers', a.status === 200, 'status=' + a.status);
  if (a.status !== 200) return;

  // Same HOME, nothing touched on disk — only the process is new.
  await ctx.killProxies();
  const second = await ctx.proxy({ port: first.port + 1, env: { GF_WATCH_DIR: ctx.root } });
  const b = await second.get('/api/setup/local');
  check('the second process answers', b.status === 200, 'status=' + b.status);
  if (b.status !== 200) return;

  const sa = JSON.stringify(stable(a.json));
  const sb = JSON.stringify(stable(b.json));
  check('it reports the same state after a restart', sa === sb,
    'before: ' + sa.slice(0, 240) + '\n        after:  ' + sb.slice(0, 240));

  // The specific claim that used to flip: every part's presence must be a fact
  // about the disk, so two processes cannot disagree about it.
  const pa = (a.json && a.json.parts) || {};
  const pb = (b.json && b.json.parts) || {};
  for (const key of Object.keys(pa)) {
    check('"' + key + '" is present or absent, not per-process', !!pa[key].present === !!(pb[key] || {}).present,
      'first=' + !!pa[key].present + ' second=' + !!(pb[key] || {}).present);
  }
};
