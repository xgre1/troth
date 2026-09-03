#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Seeds a small substrate with two conversations that share their words but
// not their facts, plus facts every thread shares, and writes the questions
// that tell them apart. The harness's own check, and the shape every
// thread-isolation measurement starts from.
//
// Usage: node benchmarks/substrate-questions/seed-two-threads.js [--out <dir>]
// Prints two lines: the database path, then the questions file path.
// Nothing here touches ~/.troth: HOME is a throwaway for the seeding process
// and the database lands under --out (default: a fresh temp directory).

const fs = require('fs');
const os = require('os');
const path = require('path');
require(path.join(__dirname, '..', '..', 'tests', 'hermetic-db.js'));

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const OUT = (oi >= 0 && argv[oi + 1]) ? path.resolve(argv[oi + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'troth-two-threads-'));
fs.mkdirSync(OUT, { recursive: true });
const DB = path.join(OUT, 'two-threads.db');
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suf); } catch (_) {} }
process.env.STATE_DB_PATH = DB;
process.env.TROTH_EMBED_PORT = '9';
process.env.TROTH_EMBEDDING_HOST = 'http://127.0.0.1:9';
const PROJECT = path.join(OUT, 'project');
fs.mkdirSync(PROJECT, { recursive: true });

const CORE = path.join(__dirname, '..', '..', 'shared-core');
const engram = require(path.join(CORE, 'engram.js'));
const dialogue = require(path.join(CORE, 'dialogue-memory.js'));
const contexts = require(path.join(CORE, 'context-registry.js'));

const AGENT = 'local-agent';
const now = Date.now();
const minutesAgo = (m) => now - m * 60000;

function fact(statement, context_id) {
  const r = engram.recordEngram({
    agent_id: AGENT, user_id: 'default', cwd: PROJECT, statement,
    source: 'two-threads:seed', context_id: context_id || null, auto_verify: false
  });
  if (r && r.ok === false) throw new Error('seed: engram refused: ' + statement + ' (' + (r.error || r.reason || '') + ')');
}
function turn(conversation_id, context_id, minutes, user_text, assistant_text) {
  const ok = dialogue.recordTurn({
    agent_id: AGENT, user_id: 'default', cwd: PROJECT, conversation_id, context_id,
    timestamp: minutesAgo(minutes), user_text, assistant_text, faculty: 'seed'
  });
  if (!ok) throw new Error('seed: turn refused: ' + user_text);
}

const F = contexts.contextIdFor('football');
const V = contexts.contextIdFor('volleyball');
contexts.ensureContext('football', { source: 'two-threads:seed' });
contexts.ensureContext('volleyball', { source: 'two-threads:seed' });

// Shared by every thread.
fact("The operator's stand mixer is a KitchenAid Artisan.");
fact('The operator drinks coffee black, no sugar.');

// One thread about football.
turn('conv-football', F, 50, 'the coach said training moves to Tuesday at 19:00 for the football team', 'Noted: football training is now Tuesday at 19:00.');
turn('conv-football', F, 45, 'our striker Kostas scored twice against Aris on Sunday', 'Two goals for Kostas against Aris, recorded.');
turn('conv-football', F, 40, 'next match is Sunday 17:00 at the municipal stadium', 'Next match: Sunday 17:00, municipal stadium.');
fact('Football training moved to Tuesday at 19:00, the coach said.', F);

// One thread about volleyball, in the same words.
turn('conv-volleyball', V, 30, 'the coach said training moves to Thursday at 20:30 for the volleyball team', 'Noted: volleyball training is now Thursday at 20:30.');
turn('conv-volleyball', V, 25, 'our setter Maria signed for two more seasons', 'Maria signed for two more seasons, recorded.');
turn('conv-volleyball', V, 20, 'next game is Saturday 18:00 at the indoor hall', 'Next game: Saturday 18:00, indoor hall.');
fact('Volleyball training moved to Thursday at 20:30, the coach said.', V);

const questions = {
  cwd: PROJECT,
  items: [
    { id: 'q1', q: 'what did the coach say about training?', conversation_id: 'conv-football', context_id: F,
      must: ['Tuesday'], must_not: ['Thursday', 'volleyball'], note: 'same words as the other thread; only this thread\'s answer may appear' },
    { id: 'q2', q: 'what did the coach say about training?', conversation_id: 'conv-volleyball', context_id: V,
      must: ['Thursday'], must_not: ['Tuesday', 'football'], note: 'the mirror of q1' },
    { id: 'q3', q: 'when is our next match and where?', conversation_id: 'conv-football', context_id: F,
      must: ['Sunday', 'stadium'], must_not: ['Saturday', 'indoor'], note: 'thread facts, different words' },
    { id: 'q4', q: 'what stand mixer do I have?', conversation_id: 'conv-football', context_id: F,
      must: ['KitchenAid'], must_not: ['Maria', 'setter'], note: 'a shared fact reaches every thread' },
    { id: 'q5', q: 'what did we say about the setter Maria?', conversation_id: null, context_id: null,
      must: ['Maria'], must_not: [], note: 'an unbound surface asking explicitly still gets the answer' }
  ]
};
const QFILE = path.join(OUT, 'questions.json');
fs.writeFileSync(QFILE, JSON.stringify(questions, null, 2));
process.stdout.write(DB + '\n' + QFILE + '\n');
