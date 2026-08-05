// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { accentFold, normalizeBasic } = require('./base');

module.exports = {
  code: 'fr',
  detectsScript(text) { return /[a-zàâçéèêëîïôûùüÿœ]/i.test(text); },
  normalize(text) { return accentFold(normalizeBasic(text)); },
  supersessionMarkers: [
    /non[,!.\s]/, /au lieu/, /plutot/, /attends/, /oublie/, /laisse/
  ],
  chitchatTokens: ['oui', 'non', "d'accord", 'merci', 'bien', 'ok'],
  stopTokens: [
    'le', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'que',
    'qui', 'est', 'sont', 'pour', 'avec', 'dans', 'sur', 'ce', 'cette',
    'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils'
  ]
};
