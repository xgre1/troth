// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Japanese — CJK script. Uses default tokenizer's bigram path for
// Han/Hiragana/Katakana. Romaji transliteration covers the common
// Latin-chat form that some users mix in.

const { normalizeBasic } = require('./base');

// Romaji → Hiragana mapping for the most common discourse markers.
// Heuristic, not a full romaji parser. Order: longer multigraphs first.
const ROMAJI_TO_KANA = [
  ['demo', 'でも'],
  ['dakedo', 'だけど'],
  ['kawari', '代わり'], ['kawarini', '代わりに'],
  ['matte', '待って'], ['matto', '待って'],
  ['yappari', 'やっぱり'],
  ['iya', 'いや'], ['iie', 'いいえ'],
  ['hai', 'はい']
];

function transliterate(text) {
  if (!text) return text;
  let out = String(text).toLowerCase();
  for (const [lat, kana] of ROMAJI_TO_KANA) {
    out = out.replaceAll(lat, kana);
  }
  return out;
}

module.exports = {
  code: 'ja',
  detectsScript(text) {
    return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
  },
  // CJK doesn't need accent fold. Just lowercase + transliterate romaji
  // markers toward kana so a "iya kawari ni" prompt matches the いや /
  // 代わり markers.
  normalize(text) { return transliterate(normalizeBasic(text)); },
  supersessionMarkers: [
    'いや', 'やっぱり', '待って', 'やめ', '代わり', 'でも', 'だけど'
  ],
  chitchatTokens: ['はい', 'いいえ', 'ありがとう', 'ok'],
  // CJK has no traditional "stopwords" in our overlap-coefficient model.
  // Particles (を, は, が, の) are 1-char and the tokenizer drops < 3-char
  // word-tokens anyway; CJK bigrams over them rarely match meaningfully.
  stopTokens: [],
  _internal: { ROMAJI_TO_KANA, transliterate }
};
