// SPDX-License-Identifier: AGPL-3.0-only
// May the idle reaper collect this browser?
//
// A browser is not a model server. A model server that has answered nothing
// for half an hour is idle by definition; a browser might have a person
// reading it. Human use writes no stamp, so silence means "cannot know".
//
// Three rules:
//
//   The operator's own debug session is never ours to kill. Port 9222 is
//   their real browser, offered on purpose, and the agent is a guest in it.
//
//   No stamp is never a reap. A browser nobody has ever asked troth to drive
//   is not troth's to collect.
//
//   A headed window may have somebody in front of it — unless it is ours.
//   The agent's browser is deliberately headed, because every mainstream
//   search page refuses a headless CDP session, so "only collect headless"
//   exempted the single browser this reaper exists to collect, and exempted
//   it permanently. Measured on one machine before this: six Chrome
//   processes holding 575 MB, two days old, forty-eight hours after the last
//   stamp, with a reaper running the whole time.
//
// What tells them apart is what the daemon already does — the agent's browser
// owns its own profile directory. That, not headedness, is the question.
//
// Ours still gets a longer leash than a model server: a page an agent opened
// may be on the operator's screen, and reopening a browser is cheap but
// losing the tab they were reading is not.

'use strict';

/**
 * @param {object} o
 * @param {number} o.port          CDP port this candidate is listening on
 * @param {number} o.lastUse       ms epoch of the last stamp, 0 when never stamped
 * @param {number} o.now           ms epoch
 * @param {number} o.idleMs        how long counts as idle for this candidate
 * @param {string[]} o.procLines   `pgrep -fl` lines for the matching processes
 * @param {string} o.agentProfile  the agent browser's own user-data-dir
 * @returns {{reap: boolean, reason: string}}
 */
function mayReapBrowser(o) {
  const opts = o || {};
  const lines = (opts.procLines || []).filter(Boolean);
  if (!lines.length) return { reap: false, reason: 'not running' };
  if (opts.port === 9222) return { reap: false, reason: "the operator's own browser" };
  if (!opts.lastUse) return { reap: false, reason: 'never stamped — cannot know it is idle' };

  const profile = String(opts.agentProfile || '');
  const ours = !!profile && lines.some((l) => l.indexOf(profile) !== -1);
  const headed = lines.some((l) => l.indexOf('headless') === -1);
  if (headed && !ours) return { reap: false, reason: 'headed, and not ours' };

  const idleFor = (opts.now || 0) - opts.lastUse;
  if (idleFor < (opts.idleMs || 0)) return { reap: false, reason: 'used recently' };
  return { reap: true, reason: 'idle for ' + Math.round(idleFor / 60000) + ' minutes' };
}

module.exports = { mayReapBrowser };
