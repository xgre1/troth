// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A door onto the code graph the partner already keeps.
//
// codelens indexes every project it sees: 8,303 entities and 31,248 edges for
// this repo alone, with a full CALLS graph. It reaches the model exactly one
// way — the proxy injects 2-5 KB of related code chunks into each request —
// and there has never been a way to ASK it anything. So the structural
// questions get answered with grep: "who calls this", "is this reachable",
// "what would break if I changed it".
//
// Grep gets this wrong at real cost. Whether
// `shared-core/action-outcome.js` was dead code was once answered by grepping
// four directories (excluding tests/), so the answer
// came back "zero callers" when the truth was "only the test suite calls it" —
// which is a sharper finding, and the one the graph gives in milliseconds).
//
// While wrapping them, `store.getCallers` / `getCallees` turned out to have
// been broken since they were written: they filtered on `e.relation = 'CALLS'`
// where the column is `relation_type` and the values are lower-case. Every
// call threw. Nobody noticed because nobody called them — an API that is
// wrong, unused and unreachable is one fact, not three.
const path = require('path');
const fs   = require('fs');

// codelens names its store after the project's identity key — one function,
// shared with the indexer that writes it and the edit hook that updates it, so
// the reader can never look under a different name than the writer used.
function dbPathFor(dir) {
  const target = String(dir || process.cwd());
  return require('./project-id.js').projectStorePath(target, 'codelens/{key}.db');
}

// Open read-only. A missing index is not an error: it means this directory has
// never been indexed, and saying so is more useful than an empty result that
// reads like "nothing calls it".
function openStore(dir) {
  const p = dbPathFor(dir);
  if (!fs.existsSync(p)) return null;
  try {
    const CodeStore = require('../proxy/modules/codelens/store.js');
    return new CodeStore(p);
  } catch (_) { return null; }
}

const rel = (p, root) => {
  const s = String(p || '');
  const r = String(root || '');
  return (r && s.indexOf(r) === 0) ? s.slice(r.length).replace(/^\//, '') : s;
};

// Entities matching a name, exactly first then by search. Returns [] when the
// index is absent so callers can distinguish "not indexed" via indexed:false.
function findEntities(store, name, root) {
  const out = [];
  // Exact name first, and completely. FTS is ranked and lossy: asked for
  // `recordAction` it returned 15 of the 24 definitions in this index and
  // missed the one carrying all 254 inbound edges, so the tool answered
  // "nothing calls this" about the substrate's central write path.
  try {
    if (typeof store.getEntitiesByName === 'function') {
      for (const e of store.getEntitiesByName(name) || []) out.push(e);
    }
  } catch (_) { /* older store: fall through to search */ }
  // Then the fuzzy pass, for partial names and misspellings.
  try {
    const seenIds = new Set(out.map((e) => e.id));
    const hits = store.search(String(name || '')) || [];
    for (const h of hits) {
      const id = h.rowid || h.id;
      if (!id || seenIds.has(id)) continue;
      const e = store.getEntity(id);
      if (e) out.push(e);
    }
  } catch (_) { /* fts unavailable */ }
  // Rank before answering, because a common name has many definitions: a repo
  // can hold a dozen entities called `recordAction`, and an unranked lookup
  // takes whichever the index happens to return. A test's own local helper won,
  // reported "nothing calls this" about the substrate's central write path, and
  // would have been believed. Order: exact name, then real code over tests, then
  // shallower paths — a definition in shared-core outranks one in a fixture.
  const isTest = (p) => /(^|\/)(tests?|spec|__tests__|fixtures?)\//.test(String(p || '')) ||
                        /\.(test|spec)\./.test(String(p || ''));
  const rank = (e) => (e.name === name ? 0 : 1) * 100 +
                      (isTest(e.file_path) ? 10 : 0) +
                      Math.min(9, String(e.file_path || '').split('/').length);
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

// Who calls this? The question grep answers badly and the graph answers exactly.
function whoCalls(name, opts) {
  opts = opts || {};
  const root = opts.cwd || process.cwd();
  const store = openStore(root);
  if (!store) {
    return {
      indexed: false, name,
      verdict: 'this directory has no code index yet — the answer is unknown, not "nothing"',
      reason: 'this directory has no code index yet',
      production_callers: 0, test_callers: 0, callers: [], defined_in: []
    };
  }
  const ents = findEntities(store, name, root).filter((e) => !opts.exact || e.name === name);
  // Same shape whatever the answer: a caller that has to check whether
  // `verdict` exists will forget to, and read absence as "unused".
  if (!ents.length) {
    return {
      indexed: true, name, found: 0,
      verdict: 'no definition with this name is in the index yet (new or unindexed code)',
      production_callers: 0, test_callers: 0, callers: [], defined_in: []
    };
  }

  const seen = new Set();
  const callers = [];
  for (const e of ents.slice(0, 12)) {
    let rows = [];
    try { rows = store.getCallers(e.id) || []; } catch (_) { rows = []; }
    for (const r of rows) {
      const key = r.source_file + '#' + r.source_name;
      if (seen.has(key)) continue;
      seen.add(key);
      callers.push({
        caller: r.source_name,
        file: rel(r.source_file, root),
        line: r.source_line || null,
        calls: e.name,
        in_tests: /(^|\/)(tests?|spec|__tests__)\//.test(String(r.source_file)) || /\.(test|spec)\./.test(String(r.source_file)),
        same_file: String(r.source_file) === String(e.file_path)
      });
    }
  }
  // The shape of the answer matters more than the list: production callers
  // versus test-only versus nothing at all is the difference between live
  // code, code that is only exercised, and code nothing reaches.
  const production = callers.filter((c) => !c.in_tests && !c.same_file);
  const testsOnly = callers.filter((c) => c.in_tests);
  // Honest about what the index can and cannot resolve.
  //
  // Calls are attributed BY NAME across the whole tree, not by resolving the
  // module a caller actually imported: `state.recordAction(...)` is recorded
  // as a call to *some* entity named recordAction, and this repo has 24 of
  // them. So the answer is trustworthy at the level of the NAME — is anything
  // in production reaching a function called this — and must not be read as
  // "this exact definition". Saying "nothing calls this" without that caveat
  // is how a live function gets deleted.
  return {
    indexed: true, name, found: ents.length,
    attribution: 'by name across the tree; ' + ents.length + ' definition(s) share this name',
    verdict: production.length ? 'reached from production'
           : (testsOnly.length ? 'ONLY the test suite calls this — built and tested, never wired'
                               : 'the index records no caller (verify before deleting: unresolved call styles exist)'),
    production_callers: production.length,
    test_callers: testsOnly.length,
    callers: callers.slice(0, opts.limit || 25),
    defined_in: ents.slice(0, 3).map((e) => ({ name: e.name, type: e.type, file: rel(e.file_path, root), line: e.line_number }))
  };
}

// What does this reach? The blast radius before changing something.
function whatItCalls(name, opts) {
  opts = opts || {};
  const root = opts.cwd || process.cwd();
  const store = openStore(root);
  if (!store) {
    return {
      indexed: false, name,
      verdict: 'this directory has no code index yet — the answer is unknown, not "nothing"',
      reason: 'this directory has no code index yet', callees: []
    };
  }
  const ents = findEntities(store, name, root).filter((e) => !opts.exact || e.name === name);
  const out = [];
  const seen = new Set();
  for (const e of ents.slice(0, 4)) {
    let rows = [];
    try { rows = store.getCallees(e.id) || []; } catch (_) { rows = []; }
    for (const r of rows) {
      const key = r.target_file + '#' + r.target_name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ calls: r.target_name, file: rel(r.target_file, root), line: r.target_line || null });
    }
  }
  return { indexed: true, name, found: ents.length, callees: out.slice(0, opts.limit || 25) };
}

// Everything defined in one file, with how many things reach each. The
// file-level version of "is any of this still alive".
function fileMap(filePath, opts) {
  opts = opts || {};
  const root = opts.cwd || process.cwd();
  const store = openStore(root);
  if (!store) {
    return {
      indexed: false, file: filePath,
      verdict: 'this directory has no code index yet — the answer is unknown, not "nothing"',
      reason: 'this directory has no code index yet', entities: [], never_reached: []
    };
  }
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  let ents = [];
  try { ents = store.getFileEntities(abs) || []; } catch (_) { ents = []; }
  const entities = ents.map((e) => {
    let callers = [];
    try { callers = store.getCallers(e.id) || []; } catch (_) { callers = []; }
    const outside = callers.filter((c) => String(c.source_file) !== abs);
    const prod = outside.filter((c) => !/(^|\/)(tests?|spec|__tests__)\//.test(String(c.source_file)) && !/\.(test|spec)\./.test(String(c.source_file)));
    return {
      name: e.name, type: e.type, line: e.line_number,
      reached_from_production: prod.length,
      reached_from_tests: outside.length - prod.length
    };
  });
  return {
    indexed: true, file: rel(abs, root), entities,
    never_reached: entities.filter((e) => !e.reached_from_production && !e.reached_from_tests).map((e) => e.name)
  };
}

// The entities an edit touched, for the ledger.
//
// Every recorded edit is supposed to carry the ids and symbols of the code it
// changed — that link is what lets the graph answer "what has been worked on"
// rather than only "what calls what". Two different writers record edits: the
// PostToolUse hook for the host's own Edit/Write, and troth's hashline tool,
// whose comment says it writes "the same record shape" and did not: it wrote
// the hash and the line count and nothing else. Measured over 120 consecutive
// edit records, 101 carried no entities — and hashline is the tool this
// project's own contributors are told to use, so the path that learns least is
// the one that runs most.
//
// One function now, called by both, so "the same shape" is a fact rather than a
// claim in a comment. Best-effort by design: a project that has never been
// indexed still gets its edit recorded, just without the link.
function entitiesForFile(absFile, fallbackDir) {
  const empty = { ids: null, symbols: null };
  const abs = String(absFile || '');
  if (!abs) return empty;
  try {
    const projectId = require('./project-id.js');
    const dir = projectId.projectDirForFile(abs, fallbackDir || process.cwd());
    const dbPath = projectId.projectStorePath(dir, 'codelens/{key}.db');
    if (!fs.existsSync(dbPath)) return empty;
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(
        'SELECT id, name, type FROM entities WHERE file_path = ? LIMIT 50'
      ).all(abs);
      if (!rows.length) return empty;
      return {
        ids: rows.map((r) => r.id),
        symbols: rows.slice(0, 8).map((r) => r.type + ':' + r.name)
      };
    } finally { db.close(); }
  } catch (_) {
    // No index, unreadable index, or no better-sqlite3 on this machine. The
    // edit still gets recorded; only the link is missing.
    return empty;
  }
}

module.exports = { whoCalls, whatItCalls, fileMap, dbPathFor, openStore, entitiesForFile };
