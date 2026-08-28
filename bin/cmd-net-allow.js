// SPDX-License-Identifier: AGPL-3.0-only
// `troth net-allow` / `troth net-allowed` — the operator's own road to the
// egress allowlist.
//
// An install runs jailed and reaches the public package registries. A company
// registry, or a project whose artifacts are served from a code host, needs
// one more name — and an entry here widens the only road out of that jail, so
// the partner must never write it. This command is the only writer, and it
// runs as the operator in the operator's own shell.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command !== 'net-allow' && command !== 'net-allowed') return;

const path = require('path');
const net = require('../shared-core/tools/net-allowlist.js');
const ground = require('../shared-core/tools/ground-policy.js');

if (command === 'net-allowed') {
  const l = net.listAll();
  console.log('Always reachable from an install jail:');
  for (const h of l.defaults) console.log('  ' + h);
  if (l.all.length) {
    console.log('Added for every project:');
    for (const h of l.all) console.log('  ' + h);
  }
  const keys = Object.keys(l.projects || {});
  for (const k of keys) {
    const hosts = Array.isArray(l.projects[k]) ? l.projects[k] : [];
    if (!hosts.length) continue;
    console.log('Added for ' + k + ':');
    for (const h of hosts) console.log('  ' + h);
  }
  if (!l.all.length && !keys.length) {
    console.log('Nothing added. `troth net-allow <host>` from inside a project'
              + ' adds a host for that project alone.');
  }
  console.log('List: ' + l.path);
  process.exit(0);
}

const rest = args.slice(1);
const everywhere = rest.indexOf('--everywhere') !== -1;
const hosts = rest.filter((a) => !a.startsWith('-'));
if (!hosts.length) {
  console.error('Name a host: troth net-allow npm.example.com'
              + ' (from inside the project it is for, or --everywhere)');
  process.exit(2);
}

// Scoped to the project the operator is standing in, by the same walk the
// walls use — so the entry means the same directory the jail will scope to.
let project = null;
if (!everywhere) {
  try { project = ground.projectRoot(process.cwd()); } catch (_) { project = null; }
  project = project || process.cwd();
  project = path.resolve(project);
}

for (const host of hosts) {
  const res = net.addHost(host, project);
  if (!res.ok) {
    console.error('Refused: ' + res.error);
    process.exit(2);
  }
  console.log(res.host + (res.project
    ? ' is reachable from installs in ' + res.project + '.'
    : ' is reachable from installs in every project.'));
}
process.exit(0);
};
