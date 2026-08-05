// SPDX-License-Identifier: AGPL-3.0-only
// git-ok — one popup-free answer to "may we shell out to git here?".
//
// On a Mac without the Command Line Tools, /usr/bin/git EXISTS but is a shim:
// executing it (even `git --version`) makes macOS open the "Install developer
// tools?" dialog. Four proxy modules (checkpoint, cochange, commitmsg, critic)
// exec git casually during ordinary workspace chats, so a paying customer on
// a fresh Mac got a developer-tools popup from a chat app (fresh-Mac audit
//). The popup-free probe on darwin is `xcode-select -p`: it exits
// non-zero when the tools are missing and never opens UI. Elsewhere a plain
// `git --version` probe is safe.
//
// Cached for the process lifetime: the answer cannot change under us in a way
// we need to react to mid-session, and the probe must not run per-request.

'use strict';

const { execFileSync } = require('child_process');

let _ok = null; // null = unprobed

function gitOk() {
  if (_ok !== null) return _ok;
  try {
    if (process.platform === 'darwin') {
      // Exit 0 => CLT (or full Xcode) present => /usr/bin/git is real.
      execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'pipe', timeout: 2000 });
      _ok = true;
    } else {
      execFileSync('git', ['--version'], { stdio: 'pipe', timeout: 2000 });
      _ok = true;
    }
  } catch (_) {
    _ok = false;
  }
  return _ok;
}

module.exports = { gitOk };
