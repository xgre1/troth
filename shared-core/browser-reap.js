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
//   One narrow exception: a browser wearing the LEGACY shared directory
//   (~/.troth/chrome-profile). No current opt-in launches with it, so on any
//   port it is an orphan of an older troth install — measured: one sat on
//   9222 for nine days, catching every link the operator's system opened.
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
 * @param {string} o.agentProfileTail  the last path segments every agent profile ends with, whatever HOME it sits under
 * @param {string} o.legacyProfile  the pre-hardening shared user-data-dir; wearing it is reapable on any port
 * @returns {{reap: boolean, reason: string}}
 */
function mayReapBrowser(o) {
  const opts = o || {};
  const lines = (opts.procLines || []).filter(Boolean);
  if (!lines.length) return { reap: false, reason: 'not running' };
  const legacy = String(opts.legacyProfile || '');
  const wearsLegacy = !!legacy && lines.some((l) => l.indexOf('--user-data-dir=' + legacy) !== -1);
  if (opts.port === 9222 && !wearsLegacy) return { reap: false, reason: "the operator's own browser" };
  if (!opts.lastUse) return { reap: false, reason: 'never stamped — cannot know it is idle' };

  const profile = String(opts.agentProfile || '');
  const tail = String(opts.agentProfileTail || '');
  const wearsDir = (l, dir) => {
    const i = l.indexOf('--user-data-dir=');
    if (i === -1) return false;
    const val = l.slice(i + '--user-data-dir='.length).split(/\s/)[0];
    return val === dir || (!!tail && dir === tail && (val === tail || val.endsWith('/' + tail)));
  };
  const ours = wearsLegacy
    || (!!profile && lines.some((l) => l.indexOf(profile) !== -1))
    || (!!tail && lines.some((l) => wearsDir(l, tail)));
  const headed = lines.some((l) => l.indexOf('headless') === -1);
  if (headed && !ours) return { reap: false, reason: 'headed, and not ours' };

  const idleFor = (opts.now || 0) - opts.lastUse;
  if (idleFor < (opts.idleMs || 0)) return { reap: false, reason: 'used recently' };
  return { reap: true, reason: 'idle for ' + Math.round(idleFor / 60000) + ' minutes' };
}

/**
 * How long the agent's browser may sit idle before it is collected. A browser
 * with a page open keeps the longer leash (someone may be reading it); one
 * showing nothing but blank tabs has nothing to lose and goes after the
 * standard idle time. Unknown pages (the target list could not be read)
 * count as a page open.
 * @param {object} o
 * @param {Array|null} o.pages   the browser's page targets ({url}), null when unknown
 * @param {number} o.idleMs      the standard idle time
 * @param {number} o.mult        the longer leash, as a multiple of idleMs
 * @returns {number} ms of idleness that allows a reap
 */
function browserLeash(o) {
  const opts = o || {};
  const base = opts.idleMs || 0;
  const long = base * (opts.mult || 4);
  if (!Array.isArray(opts.pages)) return long;
  const pages = opts.pages.filter((p) => p && (p.type == null || p.type === 'page'));
  const blank = pages.every((p) => /^(about:blank|chrome:\/\/newtab\/?)?$/.test(String(p.url || '')));
  return blank ? base : long;
}

module.exports = { mayReapBrowser, browserLeash };
