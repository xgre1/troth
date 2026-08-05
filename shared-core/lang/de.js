// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { accentFold, normalizeBasic } = require('./base');

module.exports = {
  code: 'de',
  detectsScript(text) { return /[a-zäöüß]/i.test(text); },
  normalize(text) { return accentFold(normalizeBasic(text)); },
  supersessionMarkers: [
    /nein[,!.\s]/, /stattdessen/, /lieber\s/, /warte/, /vergiss/, /lass\s/
  ],
  chitchatTokens: ['ja', 'nein', 'gut', 'danke', 'ach', 'ok', 'okay'],
  stopTokens: [
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'und',
    'oder', 'ist', 'sind', 'fur', 'mit', 'auf', 'von', 'zu', 'bei',
    'aus', 'nach', 'vor', 'nicht', 'ich', 'du', 'er', 'sie', 'wir', 'ihr'
  ]
};
