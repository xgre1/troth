// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { accentFold, normalizeBasic } = require('./base');

module.exports = {
  code: 'it',
  detectsScript(text) { return /[a-zàèéìíîòóùú]/i.test(text); },
  normalize(text) { return accentFold(normalizeBasic(text)); },
  supersessionMarkers: [
    /no[,!.\s]/, /invece/, /piuttosto/, /aspetta/, /dimentica/, /lascia/
  ],
  chitchatTokens: ['si', 'no', 'certo', 'grazie', 'bene', 'ok'],
  stopTokens: [
    'il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'del', 'della', 'dei',
    'delle', 'un', 'una', 'che', 'per', 'con', 'non', 'sono', 'ed',
    'o', 'si', 'ma', 'come'
  ]
};
