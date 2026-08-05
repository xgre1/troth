// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Hermetic test-DB guard. Require this BEFORE any module that loads
// shared-core/state.js (engram.js, action-record.js, background-worker.js …),
// or preload it with `node -r ./tests/hermetic-db.js <test>`.
//
// Why this exists: state.js resolves its data dir to CLAUDE_PLUGIN_DATA, but
// RESETS that to '' (→ HOME/.troth) when it points at the Claude plugin
// sandbox (…/.claude/plugins/data/…) — exactly what the operator's shell
// exports — and an unset value also falls through to HOME/.troth. So with no
// guard, the suite writes test junk into the operator's REAL substrate
//.
// A "unique marker per run" avoids collisions, not pollution.
//
// We redirect HOME (not CLAUDE_PLUGIN_DATA, not STATE_DB_PATH) on purpose.
// test-all.js resolves the DB three different ways — the state.js singleton
// (CLAUDE_PLUGIN_DATA), direct reads at homedir()/.troth/state.db, and
// per-block CLAUDE_PLUGIN_DATA=TMP overrides + state reloads. Only HOME is the
// common root of the first two, and leaving CLAUDE_PLUGIN_DATA untouched keeps
// the per-block override/reload dance (e.g. the audience-backfill block)
// working exactly as designed. Net: the whole suite uses tempHOME/.troth
// consistently — the same topology it passed under, just off the real home.
//
// Idempotent + survives child processes (they inherit HOME).
if (!process.env._TROTH_TEST_HOME) {
  const os     = require('os');
  const path   = require('path');
  const fs     = require('fs');
  const crypto = require('crypto');
  const realHome = process.env.HOME;       // capture before we redirect
  const home = path.join(os.tmpdir(),
    'troth-test-home-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
  process.env.HOME = home;
  process.env._TROTH_TEST_HOME = home; // sentinel: don't re-redirect in children
  // Stash the operator's REAL HOME so tests that need to reach into it
  // (e.g. playwright's browser cache at ~/Library/Caches/ms-playwright)
  // can without breaking the substrate isolation.
  if (realHome) process.env._TROTH_REAL_HOME = realHome;
}

// Hermetic network guarantee: NO model/binary fetches from tests.
// Without these, any embed attempt from a virgin home pulled the llama-server
// tarball + a ~333MB GGUF mid-suite — starving the timing-sensitive E2E
// phases and making the suite network-dependent. Children inherit process.env.
process.env.TROTH_NO_MODEL_FETCH = '1';
process.env.TROTH_LLAMA_SERVER_BIN = process.env.TROTH_LLAMA_SERVER_BIN || '/nonexistent-test-no-fetch';
