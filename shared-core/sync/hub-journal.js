// SPDX-License-Identifier: AGPL-3.0-only
// The hub's own words enter the journal too.
//
// Events are born when devices knock — but the machine that KEEPS the mind
// also writes, straight through the local modules, and a follower that
// never hears those writes is quietly holding a different mind. So when at
// least one live device follows this machine, every local mind-write is
// also appended to the journal under the reserved device_id 'hub', with
// its own sequence, its outcome already stamped: this event is history
// that happened here, not a request to apply.
'use strict';

const state = require('../state.js');

let _cache = { at: 0, has: false };

function hasFollowers() {
  const now = Date.now();
  if (now - _cache.at < 5000) return _cache.has;
  let has = false;
  try { has = !!state.db().prepare('SELECT 1 FROM sync_devices WHERE revoked_at IS NULL LIMIT 1').get(); }
  catch (_) { has = false; }
  _cache = { at: now, has };
  return has;
}

function maybeJournal(op, args, ctx) {
  try {
    if (!hasFollowers()) return false;
    const db = state.db();
    const uuidv7 = require('../action-record.js').uuidv7;
    const hlc = require('./hlc.js');
    db.transaction(() => {
      const row = db.prepare("SELECT v FROM sync_client_state WHERE k = 'hub_seq'").get();
      const seq = (row ? (parseInt(row.v, 10) || 0) : 0) + 1;
      db.prepare("INSERT INTO sync_client_state (k, v) VALUES ('hub_seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(seq));
      db.prepare(
        'INSERT INTO sync_events (event_id, device_id, dev_seq, parent_gseq, op, op_v, args, ctx, hlc_ts, app_version, received_at, outcome) ' +
        "VALUES (?, 'hub', ?, NULL, ?, 1, ?, ?, ?, NULL, ?, ?)"
      ).run(
        uuidv7(), seq, op,
        JSON.stringify(args || {}),
        JSON.stringify({ agent_id: (ctx && ctx.agent_id) || null, user_id: (ctx && ctx.user_id) || 'default', cwd: (ctx && ctx.cwd) || null }),
        hlc.next(null, 'hub'),
        Date.now(),
        JSON.stringify({ ok: true, local: true })
      );
    })();
    return true;
  } catch (_) { return false; }
}

function _resetForTests() { _cache = { at: 0, has: false }; }

module.exports = { hasFollowers, maybeJournal, _resetForTests };
