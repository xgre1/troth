// SPDX-License-Identifier: AGPL-3.0-only
// time-window - the span a question names, anchored on the day it is asked.
//
// "in the past three months", "last week", "this year": one parser, shared by
// the retrieval window arm and the reconciled view, so both agree on what
// "last month" means for the same question. Months are 30 days and years
// 365 for relative spans; "this year/month/week" start on the calendar
// boundary of the reference day. Returns { since, until } in ms, or null
// when the question names no span.
'use strict';

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const UNIT_MS = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 };

function parseTimeWindow(query, referenceTs) {
  const q = String(query || '').toLowerCase();
  const ref = Number.isFinite(referenceTs) ? referenceTs : Date.now();
  let m = /\b(?:in the |over the |during the |within the )?(?:past|last|previous)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)?\s*(day|week|month|year)s?\b/.exec(q);
  if (m) {
    const n = m[1] ? (WORD_NUM[m[1]] || parseInt(m[1], 10) || 1) : 1;
    const unitMs = UNIT_MS[m[2]];
    if (!unitMs) return null;
    return { since: ref - n * unitMs, until: ref, span: n + ' ' + m[2] + (n > 1 ? 's' : '') };
  }
  m = /\bthis (year|month|week)\b/.exec(q);
  if (m) {
    const d = new Date(ref);
    let since;
    if (m[1] === 'year') since = Date.UTC(d.getUTCFullYear(), 0, 1);
    else if (m[1] === 'month') since = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    else since = ref - ((d.getUTCDay() + 6) % 7) * 86400000 - (ref % 86400000);
    return { since, until: ref, span: 'this ' + m[1] };
  }
  return null;
}

module.exports = { parseTimeWindow, WORD_NUM };
