// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: knowledge).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "knowledge") {
  var fsK     = require('fs');
  var pathK   = require('path');
  var cryptoK = require('crypto');
  var stateK  = require("../shared-core/state.js");
  var actionRecK = require("../shared-core/action-record.js");

  var subK = passthrough[0];
  if (subK !== 'import' && subK !== 'stats' && subK !== 'search' && subK !== 'reindex') {
    console.error("Usage:");
    console.error("  troth knowledge import <path> [<path> ...] [--dry-run]");
    console.error("  troth knowledge stats");
    console.error("  troth knowledge search \"<query>\" [--limit N]");
    console.error("  troth knowledge reindex   # rebuild FTS for legacy curriculum lessons");
    process.exit(1);
  }

  // ── reindex ─────────────────────────────────────────────────────────
  // Rebuilds FTS5 entries for all type=lesson records. Needed when
  // toSearchText changes (e.g. inclusion rules expand to cover long
  // chunk bodies) so previously-imported curriculum becomes searchable.
  if (subK === 'reindex') {
    var dRX = stateK.db();
    var lessonRows = dRX.prepare(
      "SELECT id, rowid FROM action_records WHERE type = 'lesson'"
    ).all();
    console.log("Reindexing " + lessonRows.length + " lesson records...");
    var rxOk = 0, rxSkip = 0;
    var delStmt = dRX.prepare("DELETE FROM action_records_fts WHERE rowid = ?");
    var insStmt = dRX.prepare("INSERT INTO action_records_fts(rowid, search_text) VALUES (?, ?)");
    for (var rxi = 0; rxi < lessonRows.length; rxi++) {
      var lr = lessonRows[rxi];
      var fullRow = stateK.getAction(lr.id);
      var rec = actionRecK.fromRow(fullRow);
      if (!rec) { rxSkip++; continue; }
      var st = actionRecK.toSearchText(rec);
      try {
        delStmt.run(lr.rowid);
        insStmt.run(lr.rowid, st);
        rxOk++;
      } catch (_) { rxSkip++; }
      if ((rxi + 1) % 500 === 0 || rxi === lessonRows.length - 1) {
        process.stdout.write("\r  reindexed " + (rxi + 1) + "/" + lessonRows.length);
      }
    }
    console.log("");
    console.log("\x1b[32m✓\x1b[0m reindex complete — " + rxOk + " ok, " + rxSkip + " skipped");
    process.exit(0);
  }

  // ── stats ───────────────────────────────────────────────────────────────────
  if (subK === 'stats') {
    var dStats = stateK.db();
    // The reservoir is where imports live now: what is owed, what was read.
    var spool = { pending: 0, done: 0 };
    try {
      spool = dStats.prepare(
        'SELECT SUM(CASE WHEN done_at IS NULL THEN 1 ELSE 0 END) AS pending, ' +
        '       SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) AS done ' +
        'FROM knowledge_spool'
      ).get() || spool;
    } catch (_) {}
    console.log('Documents waiting to be read: ' + (spool.pending || 0));
    console.log('Documents read and indexed:   ' + (spool.done || 0));
    // Chunks written by the OLD import road (documents stored as lessons).
    // Shown while any remain so an install that used the old command can
    // still account for its data; new imports never add to this number.
    var legacy = 0;
    try {
      legacy = dStats.prepare(
        "SELECT COUNT(*) AS n FROM action_records " +
        "WHERE type = 'lesson' AND json_extract(input, '$.source') = 'curriculum_import'"
      ).get().n;
    } catch (_) {}
    if (legacy) console.log('Legacy curriculum chunks:     ' + legacy + '  (written by the old import; new imports flow through the reservoir)');
    process.exit(0);
  }


  // ── search ──────────────────────────────────────────────────────────
  if (subK === 'search') {
    var query = passthrough[1];
    var limit = 10;
    for (var si2 = 2; si2 < passthrough.length; si2++) {
      if (passthrough[si2] === '--limit' && passthrough[si2+1]) { limit = parseInt(passthrough[++si2], 10); }
    }
    if (!query) { console.error("Usage: troth knowledge search \"<query>\" [--limit N]"); process.exit(1); }
    var hits = stateK.searchActions ? stateK.searchActions(query, { limit: limit }) : [];
    if (!hits.length) { console.log('No matches.'); process.exit(0); }
    console.log('Top ' + Math.min(limit, hits.length) + ' matches:\n');
    for (var hi = 0; hi < hits.length; hi++) {
      // searchActions returns {id, timestamp} only — fetch full row for content.
      var fullRow = stateK.getAction(hits[hi].id);
      var hr = actionRecK.fromRow(fullRow);
      if (!hr) continue;
      var srcPath = (hr.output && hr.output.source_path) || '?';
      var snippet = ((hr.output && hr.output.text) || '').slice(0, 240).replace(/\s+/g, ' ');
      console.log('  ' + srcPath);
      console.log('    ' + snippet + (snippet.length === 240 ? '...' : ''));
      console.log('');
    }
    process.exit(0);
  }

  // ── import ──────────────────────────────────────────────────────────
  // Parse paths + flags. --max-chunk is still swallowed for old scripts but
  // means nothing now: the reader chunks documents itself, the same way for
  // every road a document arrives by.
  var paths = [];
  var dryRun = false;
  for (var pi = 1; pi < passthrough.length; pi++) {
    var pa = passthrough[pi];
    if      (pa === '--dry-run')   { dryRun = true; }
    else if (pa === '--max-chunk' && passthrough[pi+1]) { pi++; }
    else if (pa.startsWith('--')) { /* unknown flag, ignore */ }
    else { paths.push(pa); }
  }
  if (!paths.length) {
    console.error("Usage: troth knowledge import <path> [<path> ...] [--dry-run]");
    process.exit(1);
  }

  // Filter rules: research is .md / .txt / .org by default. .json / .jsonl
  // are opt-in via --include-json / --include-jsonl because most JSONs in a
  // repo are config / data / credentials, not research.
  var EXTENSIONS_OK = new Set(['.md', '.markdown', '.txt', '.org']);
  var includeJson  = passthrough.indexOf('--include-json')  !== -1;
  var includeJsonl = passthrough.indexOf('--include-jsonl') !== -1;
  if (includeJson)  EXTENSIONS_OK.add('.json');
  if (includeJsonl) EXTENSIONS_OK.add('.jsonl');

  var SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
    'coverage', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv',
    '.troth', '.claude', '.vscode', '.idea', 'target', 'vendor',
    'bench', 'benchmarks', 'tests', 'test', '__tests__',
    // Source-code dirs — never research
    'src', 'lib', 'app', 'components', 'pages', 'routes', 'api',
    'public', 'static', 'assets', 'styles', 'fonts', 'images',
    'migrations', 'schema', 'prisma', 'drizzle'
  ]);
  // Skip noise + credentials. Credential patterns are NEVER negotiable —
  // ingesting an OAuth client_secret / API key into a substrate that gets
  // served to LLMs would be a security incident.
  var SKIP_BASENAME_RE = new RegExp(
    '^(' + [
      // Lock + config noise
      'package(-lock)?\\.json', 'yarn\\.lock', 'pnpm-lock\\.yaml',
      'tsconfig.*\\.json', '\\.eslintrc.*', '\\.prettierrc.*',
      '\\.babelrc.*', 'jest\\.config\\..*', 'vite\\.config\\..*',
      'webpack\\.config\\..*', 'rollup\\.config\\..*',
      'next\\.config\\..*', 'tailwind\\.config\\..*',
      'README\\.md', 'LICENSE.*', 'CHANGELOG\\.md', 'CONTRIBUTING\\.md',
      '\\.DS_Store', '\\.env.*',
      // Credentials — never ingest
      '.*credentials.*\\.json', 'client_secret.*\\.json',
      '.*service-account.*\\.json', '.*-key\\.json',
      '.*\\.pem', '.*\\.key', '.*\\.crt', '.*\\.pfx', '.*\\.p12',
      'id_rsa.*', 'id_ed25519.*', '.*_token.*',
      // Lockfiles for non-JS too
      'Cargo\\.lock', 'Gemfile\\.lock', 'poetry\\.lock', 'go\\.sum'
    ].join('|') + ')$',
    'i'
  );
  // Files smaller than this are noise (license badges, single-line README's, etc.)
  var MIN_FILE_BYTES = 200;
  // Files bigger than this we still ingest but warn — likely a transcript / data dump
  var BIG_FILE_BYTES = 5 * 1024 * 1024;

  function walk(dir, out) {
    var entries;
    try { entries = fsK.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (var ei = 0; ei < entries.length; ei++) {
      var ent = entries[ei];
      if (ent.name.startsWith('.') && ent.name !== '.troth' && ent.name !== '.claude') {
        // Hidden file/dir — usually noise. Skip dotfiles unless caller targets them explicitly.
      }
      var full = pathK.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, out);
      } else if (ent.isFile()) {
        var ext = pathK.extname(ent.name).toLowerCase();
        if (!EXTENSIONS_OK.has(ext)) continue;
        if (SKIP_BASENAME_RE.test(ent.name)) continue;
        try {
          var st = fsK.statSync(full);
          if (st.size < MIN_FILE_BYTES) continue;
          out.push({ path: full, size: st.size });
        } catch (_) {}
      }
    }
  }

  // Discover candidates across all input paths
  var candidates = [];
  for (var pp = 0; pp < paths.length; pp++) {
    var rooted = pathK.resolve(paths[pp]);
    var statRoot;
    try { statRoot = fsK.statSync(rooted); } catch (_) { continue; }
    if (statRoot.isDirectory()) walk(rooted, candidates);
    else if (statRoot.isFile())  candidates.push({ path: rooted, size: statRoot.size });
  }

  if (!candidates.length) {
    console.error("No research-shaped files found under: " + paths.join(', '));
    console.error("Filters: extensions = .md/.markdown/.txt/.org/.json/.jsonl ; skipped node_modules/.git/dist/build/etc; min size " + MIN_FILE_BYTES + " bytes.");
    process.exit(1);
  }

  console.log("Discovered " + candidates.length + " candidate file(s)" + (dryRun ? " (DRY RUN)" : "") + ":");
  var totalBytes = 0;
  for (var ci = 0; ci < Math.min(candidates.length, 30); ci++) {
    var c = candidates[ci];
    totalBytes += c.size;
    console.log("  " + (c.size > BIG_FILE_BYTES ? '⚠ ' : '  ') + (c.size/1024).toFixed(1).padStart(7) + ' KB  ' + c.path);
  }
  if (candidates.length > 30) console.log("  ... +" + (candidates.length - 30) + " more");
  console.log("");

  if (dryRun) {
    console.log("Dry run — re-run without --dry-run to ingest.");
    process.exit(0);
  }

  // The reservoir road.
  //
  // This command used to chunk documents ITSELF and write every piece as a
  // type='lesson' ActionRecord — semantic, model-visible. 3,785 of those
  // "lessons" were whole research documents on the substrate this was
  // measured on, and recall served them back as if they were memories the
  // partner had formed. The proper road existed the whole time: spool a
  // pointer, and the reader drains it — secret gate, redaction, chunking,
  // embedding, scoping — the same machinery every other document passes
  // through, on the reader's cadence rather than the CLI's.
  //
  // One spool row per FILE, keyed (kind, ref, sha): re-importing an unchanged
  // file is a no-op at the INSERT, an edited file queues again by its new
  // sha. The CLI's job ends at the doorstep.
  var queued = 0, unchanged = 0, errored = 0;
  for (var fi = 0; fi < candidates.length; fi++) {
    var f = candidates[fi];
    var content;
    try { content = fsK.readFileSync(f.path); }
    catch (e) { errored++; continue; }
    var sha = cryptoK.createHash('sha256').update(content).digest('hex');
    var sid = stateK.spoolKnowledge({
      kind: 'file',
      ref: f.path,
      sha: sha,
      bytes: f.size,
      why: 'operator import: troth knowledge import'
    });
    if (sid) queued++; else unchanged++;
  }
  console.log("\x1b[32m✓\x1b[0m queued for reading");
  console.log("  documents queued:  " + queued);
  console.log("  already known:     " + unchanged);
  if (errored) console.log("  unreadable:        " + errored);
  console.log("");
  console.log("The reader takes it from here in the background — gate, chunk, index.");
  console.log("Watch:  dashboard → Memory → Taking in      troth knowledge stats");
  process.exit(0);
}
};
