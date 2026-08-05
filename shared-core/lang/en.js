// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// English language module. Same shape as every other language module —
// no special status. Markers/stopwords/chitchat declared as data; the
// engine in lang/index.js does the matching.

const { accentFold, normalizeBasic } = require('./base');

module.exports = {
  code: 'en',

  // Detect by script: any prompt containing only basic-Latin chars
  // probably hits this module. (Layered language ID will refine.)
  detectsScript(text) {
    return /[a-z]/i.test(text);
  },

  normalize(text) { return normalizeBasic(accentFold(text)); },

  // Supersession / corrective discourse markers.
  supersessionMarkers: [
    /no[,!.\s]/, /not\s/, /instead/, /actually/, /wait[,!.\s]/,
    /stop[,!.\s]/, /rather/, /scrap that/, /forget/, /drop that/,
    /nvm/, /never\s?mind/
  ],

  // Chitchat acknowledgment tokens — the prompt is JUST the token (used
  // by the noise filter, end-anchored). One per array entry.
  chitchatTokens: [
    'yes', 'no', 'y', 'n', 'ok', 'okay', 'cool', 'nice', 'continue',
    'next', 'go', 'done', 'thanks', 'thx', 'ty', 'please', 'sure',
    'yep', 'nope', 'alright', 'good', 'great', 'perfect', 'got it',
    'understood', 'maybe', 'hmm', 'wait', 'stop', 'halt', 'pause',
    'cancel', 'abort'
  ],

  // Stopwords for tokenization-overlap calculations.
  stopTokens: [
    'the', 'a', 'an', 'to', 'for', 'and', 'or', 'of', 'in', 'on', 'at',
    'is', 'are', 'was', 'be', 'by', 'do', 'make', 'add', 'use', 'it',
    'this', 'that', 'my', 'our', 'we', 'you', 'i', 'please', 'can',
    'should', 'could', 'would', 'will', 'have', 'has', 'had'
  ]
};
