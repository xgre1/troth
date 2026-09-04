#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What counts as the operator's knowledge versus the assistant's own scratch:
// a research note is kept; a transcript, a tool result, a hook output, a
// scratchpad file or the harness's throwaway home never is.
const assert = require('assert');
const path = require('path');
const k = require(path.join(__dirname, '..', 'shared-core', 'knowledge-predicate.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== knowledge predicate ===\n');

t('a document the operator keeps is knowledge', () => {
  assert.ok(k.isKnowledgeFile('/Users/you/Documents/research/llama-cpp-notes.md'));
  assert.ok(k.isKnowledgeFile('/home/x/Desktop/plan-2026.md'));
});

t("the assistant's own scratch never is", () => {
  for (const p of [
    '/Users/you/.claude/projects/-Users-you/abc/tool-results/mcp-foo.txt',
    '/Users/you/.claude/projects/-Users-you/hook-5b61-7-additionalContext.txt',
    '/Users/you/.claude/projects/-Users-you/abc.jsonl',
    '/private/tmp/claude-501/-Users-you/sess/scratchpad/notes.md',
    '/tmp/troth-test-home-123-ab/.troth/state.md',
    '/Users/you/.troth/telemetry/hook-timing.jsonl'
  ]) {
    assert.ok(k.isAssistantScratch(p), 'scratch: ' + p);
    assert.ok(!k.isKnowledgeFile(p), 'never knowledge: ' + p);
  }
});

t('a project folder that merely contains the word is untouched', () => {
  assert.ok(!k.isAssistantScratch('/Users/you/Documents/scratchpad-app/README.md'));
  assert.ok(k.isKnowledgeFile('/Users/you/Documents/scratchpad-app/README.md'));
});

console.log('\nknowledge-predicate: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
