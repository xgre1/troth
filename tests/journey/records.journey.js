// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A record must say what happened, not what its type is called.
//
// Measured 2026-08-11: the substrate holds 11,746 Read calls, 1,787 Bash,
// 1,435 Grep — and every one of them rendered as the bare tool name, because
// the line builder never reached into `args`. The detail panel meant to fix
// that read `input.tool` / `input.name` while every record on disk stores
// `input.tool_name`, so its tool row never rendered either and the generic
// fallback skipped `args` for being an object. The subject of the action was
// present in the record and absent from every surface.
module.exports.describe = 'a tool call shows WHICH file, command or pattern it touched';

module.exports.run = async (ctx, check) => {
  const path = require('path');
  const { spawnSync } = require('child_process');

  const MARKER = '/journey/records/ledger-of-the-harbour.md';
  const seed = spawnSync(process.execPath, ['-e',
    'const s=require(process.argv[1]);const ar=require(process.argv[2]);' +
    'const mk=(tool,args)=>{const id=ar.uuidv7();s.recordAction({id,timestamp:Date.now(),type:"tool_call",' +
    'agent_id:"journey",user_id:"default",cwd:null,memory_class:"episodic",audience:"model_visible",' +
    'input:{tool_name:tool,args},output:{status:"ok"}},tool);return id;};' +
    'console.log(JSON.stringify({read:mk("Read",{file_path:process.argv[3]}),' +
    'bash:mk("Bash",{command:"tar -cf /tmp/harbour.tar ."}),' +
    'grep:mk("Grep",{pattern:"reconciliation",path:"/journey/records"})}));',
    path.join(ctx.root, 'shared-core', 'state.js'),
    path.join(ctx.root, 'shared-core', 'action-record.js'),
    MARKER], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: ctx.home, TROTH_NO_MODEL_FETCH: '1', CLAUDE_PLUGIN_DATA: '' })
  });
  let ids = null;
  try { ids = JSON.parse(String(seed.stdout).trim().split('\n').pop()); } catch (_) {}
  check('three tool calls were recorded', !!(ids && ids.read && ids.bash && ids.grep),
    'stdout=' + String(seed.stdout).slice(-120) + ' err=' + String(seed.stderr).slice(-160));
  if (!ids) return;

  const proxy = await ctx.proxy({ env: { _TROTH_TEST_HOME: ctx.home, TROTH_MAINTENANCE: '0' } });
  const r = await proxy.get('/api/substrate/records?type=tool_call&limit=20');
  const items = (r.json && r.json.items) || [];
  const line = (id) => {
    const hit = items.find((i) => i.id === id);
    return hit ? String(hit.statement || '') : '';
  };

  check('a file read names the file, not just "Read"',
    line(ids.read).indexOf('Read') === 0 && line(ids.read).indexOf(MARKER) !== -1,
    JSON.stringify(line(ids.read)));
  check('a shell call names the command',
    line(ids.bash).indexOf('tar -cf') !== -1, JSON.stringify(line(ids.bash)));
  check('a search names the pattern AND where it looked',
    line(ids.grep).indexOf('reconciliation') !== -1 && / in /.test(line(ids.grep)),
    JSON.stringify(line(ids.grep)));

  // The detail panel is client-side; pin that it reads the field the records
  // actually carry, so this cannot silently regress to tool/name again.
  const fs = require('fs');
  const ui = fs.readFileSync(path.join(ctx.root, 'proxy', 'ui', 'dashboard.html'), 'utf8');
  check('the detail panel reads tool_name, the field records store',
    /inp\.tool_name \|\| inp\.tool \|\| inp\.name/.test(ui), 'dashboard.html');
  check('and renders the arguments rather than skipping them as objects',
    /\['file_path','command','pattern'/.test(ui), 'dashboard.html');
};
