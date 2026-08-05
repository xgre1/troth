// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Greek language module. Includes Greeklish transliteration (Latin
// script form of Greek chat). Greek is one example of a language with
// a Latin-chat form — Japanese has romaji, Chinese has pinyin,
// Arabic has Arabic Chat Alphabet, Russian has translit. Each gets
// the same treatment in its own module.

const { accentFold, normalizeBasic } = require('./base');

// Greeklish → Greek transliteration. Bidirectional in spirit (we
// normalize Greeklish toward Greek so markers can be matched once).
// Order matters: longer multigraph mappings first to avoid greedy
// short matches eating them. This is heuristic, not phonetically
// complete — covers ~80% of common chat patterns.
const GREEKLISH_TO_GREEK = [
  ['oxi', 'όχι'], ['ohi', 'όχι'],
  ['anti', 'αντί'],
  ['kalitera', 'καλύτερα'], ['kallitera', 'καλύτερα'],
  ['perimene', 'περίμενε'],
  ['xexna', 'ξέχνα'], ['ksexna', 'ξέχνα'],
  ['ase', 'άσε'],
  ['kane', 'κάνε'], ['kano', 'κάνω'],
  ['vale', 'βάλε'], ['valto', 'βάλτο'],
  ['allakse', 'άλλαξε'], ['allazo', 'αλλάζω'],
  ['ftiakse', 'φτιάξε'], ['ftiaxe', 'φτιάξε'],
  ['parapanw', 'παραπάνω'],
  ['evgale', 'έβγαλε'], ['evgaze', 'έβγαζε'],
  ['douleve', 'δούλευε'], ['douleyei', 'δουλεύει'], ['douleue', 'δούλευε'],
  ['kolaei', 'κολλάει'], ['kolage', 'κόλαγε'],
  ['eipa', 'είπα'], ['eipame', 'είπαμε'], ['eichame', 'είχαμε'],
  ['exo', 'έχω'], ['exoume', 'έχουμε'],
  ['mou', 'μου'], ['mas', 'μας'], ['sas', 'σας'],
  ['theloume', 'θέλουμε'], ['thelw', 'θέλω'],
  ['paei', 'πάει'], ['pame', 'πάμε']
];

function transliterate(text) {
  if (!text) return text;
  let out = String(text).toLowerCase();
  for (const [lat, gr] of GREEKLISH_TO_GREEK) {
    out = out.replaceAll(lat, gr);
  }
  return out;
}

module.exports = {
  code: 'el',

  detectsScript(text) {
    if (/[\u0370-\u03ff]/.test(text)) return true; // Greek block
    // Greeklish: ≥2 distinct Greeklish chunks → treat as Greek for routing.
    if (!text) return false;
    const lower = String(text).toLowerCase();
    let hits = 0;
    for (const [lat] of GREEKLISH_TO_GREEK) {
      if (lower.includes(lat)) { hits++; if (hits >= 2) return true; }
    }
    return false;
  },

  // Normalize chain: lowercase + whitespace, transliterate Greeklish
  // toward Greek, then accent-fold so δεν/δέν/δὲν all match.
  normalize(text) {
    return accentFold(transliterate(normalizeBasic(text)));
  },

  // Markers — declared in accent-folded form (matches against the
  // module's normalize output). Use RegExp for patterns that need
  // character classes; plain strings work for fixed text.
  supersessionMarkers: [
    /οχι[,!.\s]/, /αντι\s/, /καλυτερα/, /περιμενε/, /ξεχνα/, /ασε\s/
  ],

  chitchatTokens: [
    'ναι', 'οχι', 'οκ', 'νταξει', 'ενταξει',
    'ευχαριστω', 'μπραβο'
  ],

  stopTokens: [
    'να', 'το', 'τα', 'του', 'της', 'των', 'με', 'σε', 'ειναι', 'θα',
    'παμε', 'ενα', 'μια', 'και', 'η', 'αν', 'μου', 'μας', 'σας',
    'τον', 'τη', 'τους', 'που', 'γιατι', 'ως', 'οπως'
  ],

  _internal: { GREEKLISH_TO_GREEK, transliterate }
};
