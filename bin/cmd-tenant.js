// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: tenant).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { fs, path, command, passthrough } = ctx;
if (command === "tenant") {
  var sub = passthrough[0];
  var nameArg = passthrough[1];
  var TENANTS_ROOT = path.join(process.env.HOME || require('os').homedir(), '.troth', 'tenants');
  var ACTIVE_FILE = path.join(process.env.HOME || require('os').homedir(), '.troth', '.active-tenant');
  if (!sub || sub === 'list') {
    if (!fs.existsSync(TENANTS_ROOT)) {
      console.log('No tenants. Create one with: troth tenant add <name>');
      process.exit(0);
    }
    var entries = fs.readdirSync(TENANTS_ROOT).filter(function(n) {
      try { return fs.statSync(path.join(TENANTS_ROOT, n)).isDirectory(); } catch (e) { return false; }
    });
    var active = fs.existsSync(ACTIVE_FILE) ? fs.readFileSync(ACTIVE_FILE, 'utf8').trim() : '';
    if (!entries.length) { console.log('No tenants.'); process.exit(0); }
    for (var i = 0; i < entries.length; i++) {
      var marker = entries[i] === active ? ' * ' : '   ';
      console.log(marker + entries[i]);
    }
    process.exit(0);
  }
  if (sub === 'current') {
    var cur = fs.existsSync(ACTIVE_FILE) ? fs.readFileSync(ACTIVE_FILE, 'utf8').trim() : '';
    console.log(cur || '(none — using global state.db)');
    process.exit(0);
  }
  if (sub === 'add') {
    if (!nameArg) { console.error('Usage: troth tenant add <name>'); process.exit(1); }
    var dir = path.join(TENANTS_ROOT, nameArg);
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created tenant: ' + nameArg);
    console.log('  DB will live at: ' + path.join(dir, 'state.db'));
    console.log('  Activate with:   troth tenant use ' + nameArg);
    process.exit(0);
  }
  if (sub === 'use') {
    if (!nameArg) { console.error('Usage: troth tenant use <name>'); process.exit(1); }
    var useDir = path.join(TENANTS_ROOT, nameArg);
    if (!fs.existsSync(useDir)) { console.error('Tenant not found: ' + nameArg + ' (create with: troth tenant add ' + nameArg + ')'); process.exit(1); }
    fs.writeFileSync(ACTIVE_FILE, nameArg + '\n');
    console.log('Active tenant: ' + nameArg);
    process.exit(0);
  }
  if (sub === 'remove') {
    if (!nameArg) { console.error('Usage: troth tenant remove <name>'); process.exit(1); }
    var rmDir = path.join(TENANTS_ROOT, nameArg);
    if (!fs.existsSync(rmDir)) { console.error('Tenant not found: ' + nameArg); process.exit(1); }
    // Two-step: refuse if active. Operator must `tenant use` something else first.
    var actNow = fs.existsSync(ACTIVE_FILE) ? fs.readFileSync(ACTIVE_FILE, 'utf8').trim() : '';
    if (actNow === nameArg) { console.error('Cannot remove active tenant. Switch first: troth tenant use <other>'); process.exit(1); }
    fs.rmSync(rmDir, { recursive: true, force: true });
    console.log('Removed tenant: ' + nameArg);
    process.exit(0);
  }
  console.error('Usage: troth tenant {add|list|use|remove|current} [name]');
  process.exit(1);
}
};
