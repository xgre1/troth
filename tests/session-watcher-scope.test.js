#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The session watcher records a conversation wherever Claude Code was
// started: every project directory under ~/.claude/projects is tailed, and
// a directory that decodes to a temporary path (a throwaway home) never is.
require('./hermetic-db.js');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== session watcher: every project, never a throwaway home ===\n');

const HOME = process.env.HOME;
const root = path.join(HOME, '.claude', 'projects');
function transcript(dir, sessionId, cwd, userText, assistantText) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 2000).toISOString(), cwd, message: { role: 'user', content: userText } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 1000).toISOString(), cwd, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } })
  ];
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), lines.join('\n') + '\n');
}

(async () => {
  const projA = path.join(root, '-Users-someone-code-alpha');
  const projB = path.join(root, '-Users-someone-code-beta');
  const home  = path.join(root, HOME.replace(/\//g, '-'));
  const temp  = path.join(root, '-private-var-folders-zz-abc-T-lme-claude-home-XYZ');
  transcript(projA, '11111111-1111-4111-8111-111111111111', '/Users/you/code/alpha', 'alpha project: we chose sqlite for the cache', 'Noted, sqlite it is.');
  transcript(projB, '22222222-2222-4222-8222-222222222222', '/Users/you/code/beta', 'beta project: the deadline moved to friday', 'Understood, friday.');
  transcript(home,  '33333333-3333-4333-8333-333333333333', HOME, 'from home: remind me to call the dentist', 'Will do.');
  transcript(temp,  '44444444-4444-4444-8444-444444444444', '/private/var/folders/zz/abc/T/lme-claude-home-XYZ', 'bench haystack turn that must never enter memory', 'ok');

  const watcher = require('../tools/claude-session-watcher.js');

  await t('a throwaway home is recognised by its directory name', () => {
    assert.strictEqual(watcher.isTempSessionDir('-private-var-folders-zz-abc-T-lme-claude-home-XYZ'), true);
    assert.strictEqual(watcher.isTempSessionDir('-tmp-scratch'), true);
    assert.strictEqual(watcher.isTempSessionDir('-Users-someone-code-alpha'), false);
    assert.strictEqual(watcher.isTempSessionDir('-home-alice-work'), false);
  });

  await t('every project directory is listed, the throwaway home is not', () => {
    const files = watcher.listTranscriptFiles();
    const dirs = new Set(files.map((f) => path.basename(f.dir)));
    assert.ok(dirs.has('-Users-someone-code-alpha') && dirs.has('-Users-someone-code-beta') && dirs.has(path.basename(home)), [...dirs].join(' | '));
    assert.ok(!dirs.has(path.basename(temp)), 'temp dir excluded');
  });

  await t('one tick records the turns of every project with their own cwd, and none from the throwaway home', async () => {
    const rt = watcher.makeRuntime({ agent_id: 'watch-test', poll_ms: 50, start_at_eof: false });
    rt.start();
    await new Promise((r) => setTimeout(r, 900));
    rt.stop();
    const st = rt.status();
    assert.ok(st.ticks >= 1, 'ticked');
    const dm = require('../shared-core/dialogue-memory.js');
    const turns = dm.recentTurns({ agent_id: 'watch-test', limit: 20 }) || [];
    const texts = turns.map((x) => String(x.user_text || ''));
    assert.ok(texts.some((x) => /alpha project/.test(x)), 'alpha recorded: ' + texts.join(' | '));
    assert.ok(texts.some((x) => /beta project/.test(x)), 'beta recorded: ' + texts.join(' | '));
    assert.ok(texts.some((x) => /from home/.test(x)), 'home recorded');
    assert.ok(!texts.some((x) => /bench haystack/.test(x)), 'the throwaway home never enters memory');
    const alpha = turns.find((x) => /alpha project/.test(String(x.user_text || '')));
    assert.strictEqual(alpha && alpha.cwd, '/Users/you/code/alpha', 'the turn carries the project it was said in');
    const beta = turns.find((x) => /beta project/.test(String(x.user_text || '')));
    const convOf = (x) => x && (x.conversation_id || x.session_id) || null;
    assert.ok(convOf(alpha), 'the turn carries the conversation it was said in: ' + JSON.stringify(alpha));
    assert.ok(convOf(beta) && convOf(beta) !== convOf(alpha), 'two transcripts are two conversations');
  });

  console.log('\nsession-watcher-scope: ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
