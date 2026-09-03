// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What counts as knowledge the operator would want kept, versus a file the
// partner opened to do its job.
//
// Its own module, with NO requires, because it is called from a PostToolUse
// hook that runs on every Read. Reaching it through proxy/modules/troth-cache
// pulled better-sqlite3 and the whole cache layer into that hook and doubled
// it: 123ms -> 244ms per read. A predicate made of two
// regexes must not cost a database driver.
//
// Of the files a partner reads, only a minority are document-shaped; the rest
// is source code. Code is excluded on purpose — codelens already indexes it,
// it goes stale the moment it is edited, and a file opened repeatedly while
// working is work, not something to remember.
//
// Build outputs and dependency trees are excluded by path: over a documents
// tree an unfiltered predicate captures mostly node_modules.
const KNOWLEDGE_EXT = /\.(pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|html?|adoc|rst)$/i;
// Application bundles, framework payloads and installer trees are somebody
// else's product, not the operator's knowledge. An application bundle left in a
// downloads folder carries thousands of licence files, credits and changelogs,
// and without this guard they dominate a backfill. Same failure as
// node_modules wearing a different coat.
const NOT_KNOWLEDGE_DIR = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|target|\.venv|venv|__pycache__|\.next|\.cache)(\/|$)|\.(app|framework|bundle|xcodeproj|pkg|dSYM)(\/|$)/i;
const MIN_KNOWLEDGE_BYTES = 200;   // a stub or a placeholder is not a document
const MAX_KNOWLEDGE_BYTES = 2 * 1024 * 1024;

// The assistant's own scratch is never the operator's knowledge: the
// transcripts, tool results and hook outputs Claude Code keeps under
// ~/.claude/projects, the session scratchpads, and the harness's throwaway
// homes. Reading one of them is work, not research (measured: a hook's
// additionalContext file came back as a document in recall).
const ASSISTANT_SCRATCH = /(^|\/)(\.claude\/projects|tool-results|scratchpad|claude-[0-9]+|troth-test-home-[^/]*|\.troth\/(?:telemetry|desktop|codelens|archive))(\/|$)/;
function isAssistantScratch(absPath) {
  return ASSISTANT_SCRATCH.test(String(absPath || '').replace(/\\/g, '/'));
}

function isKnowledgeFile(absPath) {
  const p = String(absPath || '');
  if (!p) return false;
  if (NOT_KNOWLEDGE_DIR.test(p)) return false;
  if (isAssistantScratch(p)) return false;
  return KNOWLEDGE_EXT.test(p);
}

module.exports = { isAssistantScratch, isKnowledgeFile, KNOWLEDGE_EXT, NOT_KNOWLEDGE_DIR, MIN_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_BYTES };
