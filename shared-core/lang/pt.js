// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { accentFold, normalizeBasic } = require('./base');

module.exports = {
  code: 'pt',
  detectsScript(text) { return /[a-záâãàçéêíóôõú]/i.test(text); },
  normalize(text) { return accentFold(normalizeBasic(text)); },
  supersessionMarkers: [
    /nao[,!.\s]/, /em vez/, /ao inves/, /melhor\s/, /espera/, /esquece/
  ],
  chitchatTokens: ['sim', 'nao', 'obrigado', 'tudo bem', 'ok', 'okay'],
  stopTokens: [
    'o', 'os', 'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'e', 'ou',
    'que', 'para', 'com', 'em', 'no', 'na', 'nos', 'nas', 'nao', 'sim',
    'e', 'sao', 'por', 'como'
  ]
};
