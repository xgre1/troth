// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: reflect).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { fs, path, HOME, command } = ctx;
if (command === "reflect") {
  // Show recent reflexions from SQLite
  try {
    var Database = require('better-sqlite3');
    var dbPath = path.join(HOME, '.troth', 'reflexion.db');
    if (!fs.existsSync(dbPath)) { console.log('No reflexions yet.'); process.exit(0); }
    var db = new Database(dbPath, { readonly: true });
    var rows = db.prepare('SELECT * FROM reflections ORDER BY ts DESC LIMIT 20').all();
    if (!rows.length) { console.log('No reflexions yet.'); process.exit(0); }
    console.log('=== Recent Reflexions (lessons learned) ===');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var when = new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ');
      console.log('[' + when + '] ' + (r.tool || '?') + ' (used ' + r.used_count + 'x):');
      console.log('  ' + r.reflection);
    }
    db.close();
    process.exit(0);
  } catch (e) { console.error('Reflect failed:', e.message); process.exit(1); }
}
};
