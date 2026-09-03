// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A passphrase typed at the terminal, never echoed. The terminal is opened
// on its own (/dev/tty), so the read blocks whatever state stdin is in: a
// shell or a multiplexer can leave stdin non-blocking, and a synchronous
// read on it fails with EAGAIN before anything is typed. Without a terminal
// the read falls back to stdin, visible, and waits out EAGAIN.
const fs = require('fs');
const spawnPurpose = require('./tools/spawn-purpose.js');

const ENV = 'TROTH_OPERATOR_PASSPHRASE';
const WAIT_MS = 20;
const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_BYTES = 1024;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stty(fd, args) {
  try {
    const out = spawnPurpose.execFileSync('terminal-mode', 'stty', args, { stdio: [fd, 'pipe', 'ignore'], timeout: 5000 });
    return String(out || '').trim();
  } catch (_) { return null; }
}

// One line from a descriptor. In raw mode Enter arrives as \r, Backspace
// as 0x7f, Ctrl-C as 0x03 (an interruption, never a character) and Ctrl-D
// on an empty line as end of input.
function readLineSync(fd, opts) {
  const waitEagain = !!(opts && opts.wait_eagain);
  const one = Buffer.alloc(1);
  const bytes = [];
  let waited = 0;
  for (;;) {
    let n;
    try { n = fs.readSync(fd, one, 0, 1, null); }
    catch (e) {
      if (e && e.code === 'EAGAIN' && waitEagain && waited < MAX_WAIT_MS) { sleep(WAIT_MS); waited += WAIT_MS; continue; }
      throw e;
    }
    if (n === 0) break;
    const c = one[0];
    if (c === 0x0a || c === 0x0d) break;
    if (c === 0x03) { const err = new Error('interrupted'); err.code = 'INTERRUPTED'; throw err; }
    if (c === 0x04 && bytes.length === 0) break;
    if (c === 0x7f || c === 0x08) { bytes.pop(); continue; }
    bytes.push(c);
    if (bytes.length >= MAX_BYTES) break;
  }
  return Buffer.from(bytes).toString('utf8');
}

function readPassphraseSync(prompt) {
  if (process.env[ENV]) return process.env[ENV];
  const label = prompt || 'Operator passphrase';
  let tty = null;
  try { tty = fs.openSync('/dev/tty', 'r+'); } catch (_) { tty = null; }
  if (tty !== null) {
    const saved = stty(tty, ['-g']);
    const raw = saved !== null && saved !== '' && stty(tty, ['raw', '-echo']) !== null;
    fs.writeSync(tty, label + ': ');
    try {
      return readLineSync(tty, { wait_eagain: true });
    } finally {
      if (raw) stty(tty, [saved]);
      try { fs.writeSync(tty, '\n'); } catch (_) {}
      try { fs.closeSync(tty); } catch (_) {}
    }
  }
  process.stdout.write(label + ' (visible — clear scrollback after): ');
  return readLineSync(process.stdin.fd, { wait_eagain: true });
}

module.exports = { readPassphraseSync, readLineSync, ENV };
