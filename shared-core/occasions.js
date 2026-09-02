// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Occasion nouns, and the classes they fall in. One list, read by the mount
// (a line's cosine to the asked head is taken against its occasion noun as
// much as against its entity) and by the reconciled view (a hike is a trip,
// whatever its cosine; a dinner is not). A word belongs to one class, and a
// class is narrow: the words in it are the same kind of occasion when a
// question counts them. A wedding is only a wedding.
const CLASSES = {
  travel: ['road trip', 'trip', 'hike', 'camping', 'backpacking', 'cruise', 'tour', 'retreat', 'vacation', 'getaway', 'excursion', 'journey', 'safari', 'expedition', 'holiday'],
  wedding: ['wedding'],
  birthday: ['birthday'],
  anniversary: ['anniversary'],
  reunion: ['reunion'],
  funeral: ['funeral'],
  graduation: ['graduation'],
  shower: ['baby shower', 'bridal shower', 'shower'],
  party: ['party', 'bachelor party', 'bachelorette', 'housewarming', 'celebration'],
  meal: ['dinner', 'brunch', 'lunch', 'picnic', 'barbecue', 'potluck', 'cookout'],
  care: ['appointment', 'checkup', 'check-up', 'consultation', 'visit'],
  concert: ['concert', 'performance', 'recital', 'musical', 'opera', 'ballet', 'gig'],
  festival: ['festival', 'fair', 'expo'],
  screening: ['screening', 'premiere'],
  ceremony: ['ceremony', 'gala', 'parade', 'exhibition'],
  learning: ['conference', 'workshop', 'seminar', 'lecture', 'class', 'summit', 'meetup', 'hackathon'],
  contest: ['tournament', 'race', 'marathon', 'competition']
};

const _classOfWord = new Map();
for (const [cls, words] of Object.entries(CLASSES)) for (const w of words) _classOfWord.set(w, cls);
const _all = [..._classOfWord.keys()].sort((a, b) => b.length - a.length);
const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longest words first, so "road trip" wins over "trip"; singular or plural.
const OCCASION_RE = new RegExp('\\b(' + _all.map(_esc).join('|') + ')s?\\b', 'i');
const OCCASION_ALL_RE = new RegExp(OCCASION_RE.source, 'ig');

// A statement head starts with its kind label ("visit: visited Dr. Lee");
// the label is not an occasion the line names.
const _strip = (text) => String(text || '').replace(/^\[instance\]\s*/, '').replace(/^[a-z]+:\s*/, '');

// The first occasion noun in a text, or null.
function occasionIn(text) {
  const m = OCCASION_RE.exec(_strip(text));
  return m ? m[1].toLowerCase() : null;
}

// Every occasion noun in a text, once each, in order of appearance.
function occasionsIn(text) {
  const out = [];
  for (const m of _strip(text).matchAll(OCCASION_ALL_RE)) { const w = m[1].toLowerCase(); if (!out.includes(w)) out.push(w); }
  return out;
}

// The class of an occasion noun (singular or plural), or null when the word
// is not an occasion.
function classOf(word) {
  const w = String(word || '').toLowerCase().trim();
  if (!w) return null;
  return _classOfWord.get(w) || _classOfWord.get(w.replace(/s$/, '')) || null;
}

// Two occasion nouns name the same kind of occasion: the same word, one
// inside the other ("road trip" / "trip"), or the same class (a hike is a
// trip; a dinner is not; a bachelor party is not a wedding).
function sameOccasion(a, b) {
  const x = String(a || '').toLowerCase().replace(/s$/, ''), y = String(b || '').toLowerCase().replace(/s$/, '');
  if (!x || !y) return false;
  if (x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return true;
  const cx = classOf(x), cy = classOf(y);
  return !!cx && cx === cy;
}

module.exports = { CLASSES, OCCASION_RE, occasionIn, occasionsIn, classOf, sameOccasion };
