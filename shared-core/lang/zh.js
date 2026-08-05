// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Chinese — CJK script. Bigram tokenization via default base. Pinyin
// transliteration table covers common chat-form markers.

const { normalizeBasic } = require('./base');

const PINYIN_TO_HANZI = [
  ['buyao', '不要'],
  ['bushi', '不是'],
  ['meiyou', '没有'],
  ['haishi', '还是'],
  ['qishi', '其实'],
  ['suanle', '算了'],
  ['gaiyong', '改用'],
  ['dengdeng', '等等'],
  ['nage', '那个'], ['zhege', '这个']
];

function transliterate(text) {
  if (!text) return text;
  let out = String(text).toLowerCase();
  for (const [lat, han] of PINYIN_TO_HANZI) {
    out = out.replaceAll(lat, han);
  }
  return out;
}

module.exports = {
  code: 'zh',
  detectsScript(text) { return /\p{Script=Han}/u.test(text); },
  normalize(text) { return transliterate(normalizeBasic(text)); },
  supersessionMarkers: [
    '不要', '等等', '其实', '算了', '改用', '不是', '没有', '还是'
  ],
  chitchatTokens: ['是', '不', '好', '谢谢', 'ok'],
  stopTokens: [],
  _internal: { PINYIN_TO_HANZI, transliterate }
};
