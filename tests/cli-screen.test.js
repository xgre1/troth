#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The chat's composer on a real terminal, driven through tmux on a socket of
// its own: a pasted text taller than the screen is shown through a window
// with a marker row and never scrolls into the terminal's history; Ctrl-C
// clears the whole panel; a narrower window redraws one panel with the text
// still in it. Without tmux the run is reported as skipped by the runner.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..');

if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
  console.log('  ○ SKIP cli-screen (needs tmux for a real terminal)');
  process.exit(0);
}

const SOCK = 'troth-screen-' + process.pid;
const SES = 'chat';
const tmux = (args) => spawnSync('tmux', ['-L', SOCK].concat(args), { encoding: 'utf8', timeout: 20000 });
const screen = (history) => String(tmux(['capture-pane', '-p', '-t', SES].concat(history ? ['-S', '-300'] : [])).stdout || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

async function startChat(cols, rows) {
  tmux(['kill-server']);
  const env = 'HOME=' + process.env.HOME + ' TROTH_CONFIG_DIR=' + process.env.HOME + '/.troth STATE_DB_PATH=' + process.env.HOME + '/.troth/state.db';
  const r = tmux(['new-session', '-d', '-s', SES, '-x', String(cols), '-y', String(rows), 'cd ' + process.env.HOME + ' && env ' + env + ' node ' + path.join(REPO, 'bin', 'troth-chat.js') + ' 2>/dev/null']);
  assert.strictEqual(r.status, 0, 'tmux session: ' + (r.stderr || ''));
  for (let i = 0; i < 40; i++) { await sleep(500); if (/╭/.test(screen())) return; }
  throw new Error('the composer did not appear: ' + screen().slice(-300));
}
function pasteBracketed(text) {
  tmux(['set-buffer', '-b', 'pb', text]);
  tmux(['paste-buffer', '-p', '-b', 'pb', '-t', SES]);
}
const line = (i) => i + '. This is pasted point number ' + i + ' of an external list that is long enough to wrap around the composer width several times over.';

console.log('\n=== chat composer on a real terminal ===\n');

(async () => {
  try {
    await startChat(110, 30);

    await t('a paste taller than the screen is windowed with a marker and never scrolls into history', async () => {
      const text = Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n');
      pasteBracketed(text);
      await sleep(1500);
      const s = screen();
      assert.ok(/… \d+ more lines above/.test(s), 'the marker row: ' + s.slice(0, 200));
      const bars = (s.match(/│/g) || []).length / 2;
      assert.ok(bars <= 30, 'the panel fits the screen: ' + bars + ' rows');
      const history = screen(true);
      const scrolled = (history.match(/pasted point/g) || []).length - (s.match(/pasted point/g) || []).length;
      assert.strictEqual(scrolled, 0, 'rows that scrolled into history: ' + scrolled);
    });

    await t('Ctrl-C clears the whole panel and leaves nothing behind', async () => {
      tmux(['send-keys', '-t', SES, 'C-c']);
      await sleep(1500);
      const history = screen(true);
      assert.strictEqual((history.match(/pasted point/g) || []).length, 0, 'leftover rows: ' + history.slice(-300));
      assert.ok(/│\s+│/.test(screen()), 'an empty panel is drawn');
    });

    await t('a short paste then Ctrl-C leaves an empty panel', async () => {
      pasteBracketed('one line\nand another');
      await sleep(1000);
      assert.ok(/one line and another/.test(screen()), 'the paste is in the panel, newlines folded');
      tmux(['send-keys', '-t', SES, 'C-c']);
      await sleep(1000);
      assert.ok(!/one line and another/.test(screen(true)), 'cleared');
    });

    await t('a narrower window redraws one panel with the text still in it', async () => {
      tmux(['send-keys', '-t', SES, 'typed text that stays after a resize']);
      await sleep(800);
      tmux(['resize-window', '-t', SES, '-x', '70', '-y', '30']);
      await sleep(1500);
      const s = screen();
      assert.ok(/typed text that stays after a resize/.test(s), 'the text is still in the panel');
      assert.strictEqual((s.match(/╭/g) || []).length, 1, 'exactly one panel top: ' + (s.match(/╭/g) || []).length);
    });
  } catch (e) {
    console.log('  ✗ the chat came up: ' + e.message); fail++;
  } finally {
    tmux(['kill-server']);
  }
  console.log('\ncli-screen: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
