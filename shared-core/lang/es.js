// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { accentFold, normalizeBasic } = require('./base');

module.exports = {
  code: 'es',
  detectsScript(text) { return /[a-záéíóúñü]/i.test(text); },
  normalize(text) { return accentFold(normalizeBasic(text)); },
  supersessionMarkers: [
    /no[,!.\s]/, /en cambio/, /en lugar de/, /mejor\s/,
    /espera/, /olvida/, /deja\s/
  ],
  chitchatTokens: ['si', 'no', 'vale', 'gracias', 'claro', 'bueno', 'ok', 'okay'],
  stopTokens: [
    'el', 'la', 'los', 'las', 'de', 'del', 'y', 'o', 'que', 'para',
    'con', 'un', 'una', 'en', 'es', 'son', 'por', 'como', 'su', 'sus',
    'le', 'les', 'lo', 'al', 'este', 'esta', 'esto'
  ]
};
