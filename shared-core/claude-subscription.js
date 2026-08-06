// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Is there a Claude Code sign-in on this machine?
//
// The onboarding overlay asked one place and got a real answer; the providers
// panel asked another that never set the field at all, so it told every
// operator "No subscription detected — run claude login" whether or not they
// were signed in, including right after they had picked Claude in setup. One
// question, one answer, one place to change when the credential moves.
const fs = require('fs');
const path = require('path');
const os = require('os');

/** true when a Claude Code login exists here. Never throws, never prompts. */
function claudeSubscriptionActive() {
  const home = process.env.HOME || os.homedir();
  if (process.platform === 'darwin') {
    // The keychain item Claude Code writes on sign-in. `security` exits
    // non-zero when it is absent, which is the whole test.
    try {
      require('child_process').execFileSync(
        'security', ['find-generic-password', '-s', 'Claude Code-credentials'],
        { stdio: 'ignore' }
      );
      return true;
    } catch (_) { return false; }
  }
  // Linux and the rest keep it on disk.
  try { return fs.existsSync(path.join(home, '.claude', '.credentials.json')); }
  catch (_) { return false; }
}

module.exports = { claudeSubscriptionActive };
