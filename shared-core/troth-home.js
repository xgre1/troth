// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One answer to "where do my files live".
//
// Two answers were in circulation: `process.env.HOME || os.homedir()` in most
// places, and a bare `os.homedir()` in a couple of dozen others. On a normal
// unix login they agree, which is why this held. They part company wherever
// HOME is set to something else — a container, a sandbox, a test harness — and
// on Windows under Git Bash, which sets HOME while os.homedir() returns
// USERPROFILE. The failure that follows is the worst kind: the config is read
// from one home and the sign-in token from another, so the product looks
// configured and signed out at the same time. Found by running the suite on a
// real Windows machine, where the engine picker was missing the subscription
// whose token had just been written.
const os = require('os');
const path = require('path');

/** The operator's home directory, by one rule everywhere. */
function home() {
  const fromEnv = process.env.HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  return os.homedir();
}

/** <home>/.troth, honouring TROTH_DATA_DIR for callers that already did. */
function trothDir() {
  const override = process.env.TROTH_DATA_DIR;
  if (typeof override === 'string' && override.trim()) return override;
  return path.join(home(), '.troth');
}

/** <home>/.troth/<...parts> */
function trothPath(...parts) {
  return path.join(trothDir(), ...parts);
}

module.exports = { home, trothDir, trothPath };
