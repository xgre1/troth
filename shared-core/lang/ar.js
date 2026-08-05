// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Arabic — RTL script. Arabic Chat Alphabet (3=ع, 7=ح, 9=ق, etc.)
// covers the common Latin-script chat form used in informal channels.
// Negation in Arabic frequently uses the cliticized prefix "ma-" on
// verbs; our marker list captures the standalone particles.

const { accentFold, normalizeBasic } = require('./base');

const ACA_TO_ARABIC = [
  // Numerals used as letter substitutes (Arabic Chat Alphabet)
  ['7abibi', 'حبيبي'],
  ['ma3lesh', 'معلش'],
  ['mish', 'مش'],
  ['la2', 'لأ'],
  ['lakin', 'لكن'],
  ['bal', 'بل']
];

function transliterate(text) {
  if (!text) return text;
  let out = String(text).toLowerCase();
  for (const [lat, ar] of ACA_TO_ARABIC) {
    out = out.replaceAll(lat, ar);
  }
  return out;
}

module.exports = {
  code: 'ar',
  detectsScript(text) { return /\p{Script=Arabic}/u.test(text); },
  // Arabic accent (harakat / tashkeel) folding via NFD covers diacritics.
  normalize(text) { return accentFold(transliterate(normalizeBasic(text))); },
  // Char classes include Arabic punctuation (، U+060C, ؛ U+061B, ؟ U+061F)
  // alongside ASCII so markers fire regardless of which keyboard typed them.
  supersessionMarkers: [
    /لا[,،!.\s]/, /ليس/, /بل\s/, /لكن/, /انتظر/, /دع/
  ],
  chitchatTokens: ['نعم', 'لا', 'شكرا', 'حسنا', 'ok'],
  stopTokens: [
    'ال', 'في', 'من', 'الى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك',
    'انا', 'انت', 'هو', 'هي', 'نحن', 'هم'
  ],
  _internal: { ACA_TO_ARABIC, transliterate }
};
