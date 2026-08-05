// SPDX-License-Identifier: AGPL-3.0-only
// Session timeline — visualize what happened in a session for debugging.
//
// Records every event: tool calls, errors, retries, model switches, etc.
// Used by troth stats / dashboard to show "what troth actually did".

let timeline = []; // [{ ts, kind, summary, details? }]
const MAX_KEEP = 200;

function event(kind, summary, details) {
  timeline.push({ ts: Date.now(), kind, summary, details: details || null });
  if (timeline.length > MAX_KEEP) timeline.shift();
}

function getRecent(limit) { return timeline.slice(-(limit || 50)); }

function clear() { timeline = []; }

function summarizeByKind() {
  const counts = {};
  for (const e of timeline) counts[e.kind] = (counts[e.kind] || 0) + 1;
  return counts;
}

module.exports = { event, getRecent, clear, summarizeByKind };
