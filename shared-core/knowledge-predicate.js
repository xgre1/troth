// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What counts as knowledge the operator would want kept, versus a file the
// partner opened to do its job.
//
// Its own module, with NO requires, because it is called from a PostToolUse
// hook that runs on every Read. Reaching it through proxy/modules/troth-cache
// pulled better-sqlite3 and the whole cache layer into that hook and doubled
// it: 123ms -> 244ms per read, measured 2026-08-11. A predicate made of two
// regexes must not cost a database driver.
//
// Measured on the operator's own history: of 3,346 distinct files ever read,
// 737 are document-shaped and 1,443 are source code. Code is excluded on
// purpose — codelens already indexes it (13,488 entities, 15,472 call edges),
// it goes stale the moment it is edited, and a file opened 352 times while
// working is work, not something to remember.
//
// Build outputs and dependency trees are excluded by path: on ~/Documents an
// unfiltered predicate would have captured 30,218 files, 82% of them inside
// node_modules.
const KNOWLEDGE_EXT = /\.(pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|html?|adoc|rst)$/i;
// Application bundles, framework payloads and installer trees are somebody
// else's product, not the operator's knowledge. Measured 2026-08-11: the first
// backfill pulled 7,148 passages out of a Visual Studio Code bundle sitting in
// ~/Downloads — its LICENSE.rtf, its Credits.rtf, its changelogs — which was
// 43% of everything captured that run. Same failure as node_modules wearing a
// different coat.
const NOT_KNOWLEDGE_DIR = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|target|\.venv|venv|__pycache__|\.next|\.cache)(\/|$)|\.(app|framework|bundle|xcodeproj|pkg|dSYM)(\/|$)/i;
const MIN_KNOWLEDGE_BYTES = 200;   // a stub or a placeholder is not a document
const MAX_KNOWLEDGE_BYTES = 2 * 1024 * 1024;

function isKnowledgeFile(absPath) {
  const p = String(absPath || '');
  if (!p) return false;
  if (NOT_KNOWLEDGE_DIR.test(p)) return false;
  return KNOWLEDGE_EXT.test(p);
}

module.exports = { isKnowledgeFile, KNOWLEDGE_EXT, NOT_KNOWLEDGE_DIR, MIN_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_BYTES };
