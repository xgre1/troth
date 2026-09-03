// SPDX-License-Identifier: AGPL-3.0-only
// reconciled-view - one truth, shown with its receipts.
//
// A count prompt that carries the understood stratum (instances) NEXT TO the
// raw statements hands the model two competing truths and asks it to judge
// which to trust - and prose arbitration oscillates. This module builds ONE
// view instead, mechanically: every ledger line names the raw statements
// that attest it (set arithmetic over provenance ids, no judgment), covered
// raw statements stay visible as SUPPORT (the mind's power to re-examine its
// primary record - never amputated), and only raw statements outside the
// ledger are offered for judgment. Surviving disagreement is FLAGGED, not
// silently resolved: doubt is shown, not buried.
//
// The view is QUESTION-SHAPED when the caller passes the question. The ledger
// holds the whole class ("every purchase, possession and activity around
// plants"); the question asks for a slice of it ("acquired in the last
// month"). Four structural filters, each read off the instance's own fields
// (kind, qualifier, status, first attestation) and the question's words:
//   window  - lines dated outside the span the question names;
//   verb    - the question's verb family (acquire / attend / visit / work on /
//             lead / own) against the line's kind and qualifier;
//   status  - a question about what happened sets aside planned and
//             cancelled lines;
//   subject - cosine to the question below the floor, unless the line names
//             the counted head itself.
// What is set aside is counted in one summary line, never hidden; a filter
// that would empty the ledger is not applied (the reader keeps the whole
// class rather than nothing). Lines about the same object (one entity across
// a purchase and an activity) are annotated so the object is counted once.
// Without a question nothing is set aside and the view renders as before.
'use strict';

// Occasion head nouns come from the consolidation ladder so the two modules
// never disagree on what counts as an occasion. Fail-soft: without it the
// view renders exactly as before, minus the possibly-same annotation.
let _EVENT_HEAD = null;
try { _EVENT_HEAD = require('./instance-consolidation.js').EVENT_HEAD || null; } catch (_) {}
let _occ = null;
try { _occ = require('./occasions.js'); } catch (_) {}
// The registry's own judgment of what is a name, for the cast at render.
let _idn = null;
try { _idn = require('./entity-identity.js'); } catch (_) {}
let _parseTimeWindow = null;
try { _parseTimeWindow = require('./time-window.js').parseTimeWindow; } catch (_) {}
let _selfStatements = null;
try { _selfStatements = require('./self-statements.js').extractSelfStatements; } catch (_) {}
// A request-shaped question asks for advice built around who the user is.
const REQUEST_SHAPED = /\b(can you (?:recommend|suggest)|any (?:tips|suggestions|recommendations|ideas|advice)|what should i|could you (?:recommend|suggest)|suggest (?:some|a)|recommend (?:some|a)|help me (?:choose|pick|plan|decide)|what (?:would|do) you recommend)\b/i;

// Cosine floor for "about the asked subject". Calibrated on the 13 count and
// order questions of the LongMemEval probe (2026-09-02): same-topic instances
// sit at 0.45-0.7 against the question, unrelated ones below 0.3.
const SUBJECT_FLOOR = 0.30;          // objects: hyponyms sit low ("boots" vs "clothing")
const OCCURRENCE_FLOOR = 0.45;       // occurrences: a barbecue is not a wedding, whatever its cosine
// A question that counts or orders: the shape the status and totals rules key on.
const COUNT_ASK = /\b(how many|how much|number of|total|count|order of|first to last|earliest to latest)\b/i;
const OCCURRENCE_KINDS = new Set(['event', 'visit', 'activity']);
const DAY_MS = 86400000;
// Role words: a person named by relation alone ("cousin's wedding").
const _ROLE_WORD = /\b(cousin|sister|brother|mother|father|mom|dad|aunt|uncle|niece|nephew|grandm\w*|grandp\w*|roommate|friend|partner|neighbou?r|colleague|boss|wife|husband|spouse|sibling|parent|son|daughter|buddy|classmate|coworker)\b/gi;
const _isoOf = (ts) => { try { return new Date(ts).toISOString().slice(0, 10); } catch (_) { return null; } };
// The date a statement pins: "[completed, 2023-02-05]" / "[completed, inferred, 2023-02-05]".
const _statedDate = (s) => { const m = /\[[a-z]+(?:, inferred)?, (\d{4}-\d{2}-\d{2})\]/.exec(String(s)); return m ? m[1] : null; };

// Verb families: what the question asks about, matched against the kind and
// the qualifier/facets an instance carries. A family lists the kinds that
// belong to it outright and the verbs that admit a line of another kind.
const VERB_FAMILIES = [
  { name: 'acquire', ask: /\b(acquire[ds]?|acquired|bought|buy|purchase[ds]?|purchased|got|get|received?|obtain(?:ed)?|adopt(?:ed)?|pick(?:ed)? up)\b/,
    kinds: new Set(['purchase']), verbs: /\b(bought|buy|purchased|purchase|got|get|received|receive|acquired|acquire|adopted|picked up|obtained|ordered)\b/ },
  { name: 'attend', ask: /\b(attend(?:ed)?|went to|go to|been to|participated|took part)\b/,
    kinds: new Set(['event', 'visit']), verbs: /\b(attended|attend|went|visited|joined|celebrated|participated|competed|took part)\b/ },
  { name: 'visit', ask: /\b(visit(?:ed)?|tried|been to|eaten at|dined at|saw|seen)\b/,
    kinds: new Set(['visit']), verbs: /\b(visited|tried|went|ate|dined|stayed|saw|seen|see|appointment|checkup|consulted)\b/ },
  { name: 'work', ask: /\b(work(?:ed)? on|built|build|made|make|finish(?:ed)?|complete[ds]?|written|wrote|painted|assembled)\b/,
    kinds: new Set(['creation']), verbs: /\b(worked|working|built|building|made|making|finished|finishing|completed|wrote|writing|written|painted|painting|assembled|planning)\b/ },
  { name: 'lead', ask: /\b(led|lead(?:ing)?|manage[ds]?|managed|run|ran)\b/,
    kinds: new Set(['role', 'project']), verbs: /\b(led|leading|lead|managed|managing|ran|running|heading|headed)\b/ },
  // "have" only as possession, never as the auxiliary of "have I worked on".
  { name: 'own', ask: /\b(own|owns|keep|currently have|do i (?:still |currently )?have|have (?:got )?(?:at home|now|left)|how many [a-z]+ (?:do|did) i have)\b/,
    kinds: new Set(['possession', 'purchase']), verbs: /\b(owns|own|has|have|keeps|keeping|kept|bought|got|received|adopted|purchased|taking care|caring for|looking after|set up|setting up|maintain(?:s|ing)?)\b/ }
];
// A question about what happened (has/have/did/how many ... did I) is not
// asking about plans: planned and cancelled lines are set aside for it.
const PAST_ASK = /\b(have i|did i|i have|i've|have attended|did|attended|bought|went|visited|acquired|worked on|made|led|took|taken|participated)\b/;
const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an|my|our|new|another|some)\b/g, ' ').replace(/\s+/g, ' ').trim();
// The words a question or a statement is about: letters of any script,
// four or more of them, minus the asking words and the stems of the verbs
// every question carries.
const _ASK_WORDS = new Set(['how', 'many', 'much', 'what', 'which', 'when', 'where', 'who', 'whom', 'whose', 'why', 'does', 'did', 'have', 'has', 'had', 'been', 'were', 'was', 'will', 'would', 'could', 'should', 'there', 'their', 'they', 'them', 'this', 'that', 'these', 'those', 'from', 'with', 'about', 'into', 'over', 'than', 'then', 'also', 'ever', 'still', 'just', 'like', 'some', 'more', 'most', 'last', 'next', 'first', 'time', 'times', 'week', 'weeks', 'month', 'months', 'year', 'years', 'today', 'user', 'said', 'told', 'asked', 'says', 'tell', 'know', 'think', 'want', 'need', 'make', 'made', 'done', 'doing', 'thing', 'things', 'work', 'working', 'worked',
  'πόσα', 'πόσο', 'πόσες', 'πόσοι', 'ποια', 'ποιο', 'ποιος', 'πότε', 'πού', 'γιατί', 'είναι', 'έχω', 'έχει', 'έχουμε', 'ήταν', 'αυτό', 'αυτά', 'αυτή', 'στην', 'στον', 'στο', 'από', 'μου', 'μας', 'σου', 'θέλω', 'κάνω', 'κάνει', 'κάναμε', 'έκανα', 'είπα', 'είπες', 'ξέρεις', 'ξέρω']);
// A statement that states a value: an amount, a count, a rate, a date.
const _VALUE_RE = /(?:[€$£]\s?\d|\d+\s?(?:€|eur|euro|euros|usd|dollars?|%|per|\/)|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+\s+(?:days?|hours?|weeks?|months?|years?|times)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|hours?|weeks?|months?|years?|times)\b|\b\d{4}-\d{2}-\d{2}\b)/i;
const _statesValue = (s) => _VALUE_RE.test(String(s || ''));
const _valueFree = (s) => String(s || '').replace(/\[[^\]]*\]/g, ' ').replace(/[€$£]?\s?\d[\d.,]*\s?(?:€|eur|euro|euros|usd|k|%)?/gi, ' ');
const _contentTokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((t) => t.length >= 4 && !_ASK_WORDS.has(t)));

// Stated totals: the user naming the count itself ("I've written seven short
// stories", "my fourth Korean restaurant"). A cardinal before the head is a
// total; an ordinal is a running count. Each carries the day it was said, so
// the newest stated total wins and ledger lines dated after it add to it.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const ORD_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
function _headStem(head) {
  const h = String(head || '').toLowerCase();
  if (h.length < 4) return null;
  if (/ies$/.test(h)) return h.slice(0, -3);      // stories -> stor
  if (/s$/.test(h)) return h.slice(0, -1);        // restaurants -> restaurant
  return h;
}
// A number that is part of a designation or a measure is never a count:
// "F-15 Eagle kit", "1/72 scale", "20-gallon tank", "$50".
const NOT_A_COUNT_BEFORE = '(?<![A-Za-z0-9/$.\\-])';
const UNIT_AFTER = /^(scale|gallon|gallons|inch|inches|mm|cm|km|mile|miles|hour|hours|minute|minutes|day|days|week|weeks|month|months|year|years|percent|dollars?|euros?|kg|lb|lbs|pm|am)\b/i;
function statedTotals(raw, head, headPhrase) {
  const stem = _headStem(head);
  if (!stem) return [];
  // The full counted phrase, when the question gives one ("model kits"), so a
  // "meal kit" is not a model kit; the bare head otherwise.
  const phraseStem = headPhrase && String(headPhrase).toLowerCase() !== String(head).toLowerCase()
    ? String(headPhrase).toLowerCase().trim().split(/\s+/).map((w, i, a) => i === a.length - 1 ? _headStem(w) || w : w).join('\\s+')
    : null;
  const target = (phraseStem || stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) + '[a-z]*';
  const NUM = '(\\d{1,3}|' + Object.keys(NUM_WORDS).join('|') + ')';
  const ORD = '(' + Object.keys(ORD_WORDS).join('|') + '|\\d{1,2}(?:st|nd|rd|th))';
  const between = '(?:[a-z\\-]+\\s+){0,2}?';
  const card = new RegExp(NOT_A_COUNT_BEFORE + '\\b' + NUM + '\\s+' + between + target + '\\b', 'gi');
  const ord = new RegExp(NOT_A_COUNT_BEFORE + '\\b' + ORD + '\\s+' + between + target + '\\b', 'gi');
  // "I've tried four different ones so far": a pronoun total counts when the
  // same words of the user name the head somewhere.
  // "one of them was my cousin's wedding" is a partitive, not a total: the
  // pronoun form is refused before a verb, and "one" never counts as a total.
  const pron = new RegExp(NOT_A_COUNT_BEFORE + '\\b' + NUM + '\\s+(?:different\\s+|new\\s+|more\\s+|other\\s+)?(?:ones|of them)\\b(?!\\s+(?:was|were|is|are|has|had|being|had been|will|would)\\b)', 'gi');
  const headRe = new RegExp('\\b' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z]*\\b', 'i');
  const out = [];
  const push = (r, m, kind) => {
    const w = m[1].toLowerCase();
    const v = (kind === 'running' ? ORD_WORDS[w] : NUM_WORDS[w]);
    const value = v != null ? v : parseInt(w, 10);
    if (!Number.isFinite(value) || value <= 0 || value > 100) return;
    if (UNIT_AFTER.test(m[0].slice(m[1].length).replace(/^\s+/, ''))) return;
    // A total is the user speaking of themselves: the sentence the number
    // sits in carries a first person. "The clinic has 2 doctors" is about
    // the clinic.
    const s = m.input;
    const start = Math.max(s.lastIndexOf('. ', m.index), s.lastIndexOf('! ', m.index), s.lastIndexOf('? ', m.index), s.lastIndexOf('\n', m.index), s.lastIndexOf('; ', m.index)) + 1;
    const endCandidates = ['. ', '! ', '? ', '\n', '; '].map((d) => s.indexOf(d, m.index + m[0].length)).filter((i) => i >= 0);
    const end = endCandidates.length ? Math.min(...endCandidates) : s.length;
    const sentence = s.slice(start, end);
    if (!/\b(?:i|i've|i'd|i'm|i’ve|i’d|i’m|we|we've|we’ve|my|me|our|myself)\b/i.test(sentence)) return;
    out.push({ value, kind, n: r.n, ts: Number.isFinite(r.ts) ? r.ts : null, text: m[0] });
  };
  // Words the user pasted for correction, translation or rewriting are not
  // the user's own claims: a clinic notice naming "2 doctors" states nothing
  // about the doctors the user has seen.
  const PASTED = /\b(correct (?:my|the|this) (?:grammar|text|message|email)|proofread|the (?:message|text|email|letter)s? below|rewrite (?:this|the)|translate (?:this|the)|paraphrase|fix (?:my|the) grammar)\b/i;
  for (const r of raw) {
    const text = String(r.statement || '');
    // Only the user's own words state a total; the assistant restating is not a claim.
    const userPart = text.indexOf(' / asst:') >= 0 ? text.slice(0, text.indexOf(' / asst:')) : text;
    if (PASTED.test(userPart)) continue;
    let m;
    while ((m = card.exec(userPart))) push(r, m, 'total');
    while ((m = ord.exec(userPart))) push(r, m, 'running');
    if (headRe.test(userPart)) while ((m = pron.exec(userPart))) { if (!/^(1|one)$/i.test(m[1])) push(r, m, 'total'); }
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

// items: the retrieval output - instance-pool items carry refs (dialogue
// turn ids from provenance) and, when the mount supplies them, the instance
// fields (_kind, _qualifier, _status, _entity, _facets, _attested_ts, _cos);
// raw dialogue items carry their own id.
// opts: { noun_head, head_phrase, question, reference_ts, window, subject_floor }.
// Returns { ledger, cast, raw, aside, window, render() }.
function buildReconciledView(items, opts) {
  opts = opts || {};
  const instances = [];
  const castItems = [];
  const raws = [];
  for (const it of (items || [])) {
    if (it.source === 'instance-pool') instances.push(it);
    else if (it.source === 'identity-cast') castItems.push(it);
    else raws.push(it);
  }
  const rawIndex = new Map();  // action id -> raw entry
  const raw = raws.map((it, i) => {
    const entry = { n: i + 1, id: it.id, statement: it.statement, ts: it.ts, role: 'new', supports: [] };
    rawIndex.set(String(it.id), entry);
    return entry;
  });

  // The question's shape: window, verb family, tense, subject.
  const question = opts.question ? String(opts.question) : null;
  const qLower = question ? question.toLowerCase() : '';
  const refTs = Number.isFinite(opts.reference_ts) ? opts.reference_ts : null;
  // opts.shape: the question's shape as read by the model (question-shape.js),
  // in any language. It overrides every English pattern below; without it
  // the patterns stand in.
  const shape = opts.shape && typeof opts.shape === 'object' ? opts.shape : null;
  const window = opts.window || (shape ? shape.window || null : (question && _parseTimeWindow ? _parseTimeWindow(question, refTs) : null));
  const floor = Number.isFinite(opts.subject_floor) ? opts.subject_floor : SUBJECT_FLOOR;
  const nounHead = shape && shape.head ? shape.head : opts.noun_head;
  const nounPhrase = shape && shape.head_phrase ? shape.head_phrase : opts.head_phrase;
  const head = nounHead ? String(nounHead).toLowerCase().replace(/s$/, '') : null;
  const headPhrase = nounPhrase ? String(nounPhrase).toLowerCase().replace(/s$/, '') : null;
  const _re = (s) => new RegExp('(?<![a-z])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z]*', 'i');
  const headRe = head && head.length >= 3 ? _re(head) : null;
  const phraseRe = headPhrase && headPhrase.length >= 3 && headPhrase !== head ? _re(headPhrase) : null;
  // A question may carry several verbs ("worked on or bought"): a line is
  // kept when ANY named family accepts it.
  const families = shape
    ? VERB_FAMILIES.filter((f) => Array.isArray(shape.families) && shape.families.includes(f.name))
    : (question ? VERB_FAMILIES.filter((f) => f.ask.test(qLower)) : []);
  const pastAsk = shape ? shape.past !== false : (question ? PAST_ASK.test(qLower) : false);
  // What is still open: a question about what is yet to be picked up,
  // returned, paid or renewed keeps the owed and planned lines and sets the
  // rest aside, whatever verb the words carry ("pick up" is not acquiring).
  const PENDING_ASK = /\b(still (?:need|have) to|need to (?:pick up|return|pay|renew|collect)|haven't (?:yet|picked|returned|paid)|not yet|pending|outstanding|owe|owed|to be (?:picked up|returned))\b/;
  const statusAsk = shape && typeof shape.status === 'string' ? shape.status : (question && PENDING_ASK.test(qLower) ? 'pending' : 'any');
  const pendingAsk = statusAsk === 'pending';
  const asks = shape && typeof shape.asks === 'string' ? shape.asks : null;

  // Each filter is a pass over the instances that names a reason; a filter
  // that would leave nothing is skipped so the ledger is never emptied.
  const reasonOf = new Map();
  const apply = (name, test) => {
    const survivors = instances.filter((it) => !reasonOf.has(it) && !test(it));
    if (!survivors.length) return;
    for (const it of instances) if (!reasonOf.has(it) && test(it)) reasonOf.set(it, name);
  };
  const applyForced = (name, test) => {
    for (const it of instances) if (!reasonOf.has(it) && test(it)) reasonOf.set(it, name);
  };
  const dateOf = (it) => {
    const stated = _statedDate(it.statement);
    const attested = Number.isFinite(it._attested_ts) ? _isoOf(it._attested_ts) : null;
    return { iso: stated || attested, kind: stated ? 'stated' : (attested ? 'attested' : null) };
  };
  if (window) apply('outside the time window', (it) => {
    const d = dateOf(it).iso; if (!d) return false;
    const ts = Date.parse(d + 'T12:00:00Z');
    return Number.isFinite(ts) && (ts < window.since - DAY_MS || ts > window.until + DAY_MS);
  });
  if (pendingAsk) apply('not an open obligation (the question asks what is still pending)', (it) => it._kind && it._status !== 'owed' && it._status !== 'planned');
  // A question about what is OWNED is answered by possessions: an activity
  // or an event on the ledger is never one of the tanks, however the words
  // score, so for the own family the verb filter may empty the ledger; the
  // statements below remain the truthful answer.
  const ownAsk = families.some((f) => f.name === 'own');
  if (families.length && !pendingAsk) (ownAsk ? applyForced : apply)('outside the question\'s verb (' + families.map((f) => f.name).join(' or ') + ')', (it) => {
    if (!it._kind) return false;                        // no structure, no verdict
    const verbs = [it._qualifier].concat(Array.isArray(it._facets) ? it._facets : []).filter(Boolean).join(' ').toLowerCase();
    return !families.some((f) => f.kinds.has(String(it._kind)) || f.verbs.test(verbs));
  });
  // A count of what happened or what is owned never includes what is only
  // planned: "how many tanks do I have" is not answered by a tank the user is
  // thinking of setting up. A question about plans keeps its planned lines.
  const countAsk = shape ? !!shape.count : (question ? COUNT_ASK.test(question) : false);
  const planAsk = question ? /\b(plan(?:s|ning|ned)?|going to|upcoming|will i|intend|thinking (?:of|about))\b/i.test(qLower) : false;
  if ((pastAsk || (countAsk && !planAsk)) && !pendingAsk) apply('planned or cancelled, not done', (it) => it._status === 'planned' || it._status === 'cancelled');
  if (question) {
    // Cosine to the question has limited resolution (measured 2026-09-02:
    // true members 0.30-0.50, strangers 0.25-0.40). The strict floors are
    // used when they leave the reader at least three lines; otherwise the
    // object floor applies to every kind, and the reader judges the rest.
    // Subject by kind. A line is ABOUT its entity: "java moss" is not a tank
    // however often its description says "in the tank" (measured: the
    // plants and the children rode into a tank count on statement cosine).
    // When the mount carries the entity's own cosine to the asked head, that
    // decides; the entity naming the head keeps a line whatever the number;
    // the statement cosine is the road when no entity cosine came along.
    // Three rungs, in order. (1) A line whose words name an occasion (wedding,
    // festival, gala) is about THAT occasion: it stays when the occasion is
    // the asked head and leaves otherwise, whatever the numbers say (measured:
    // a charity gala and a bachelor party sat close enough to "wedding" to
    // pass any floor). (2) An entity that names the head stays. (3) Otherwise
    // the line's cosine to the head decides (the larger of its entity's and
    // its occasion noun's, computed at mount time): 0.30, and 0.40 for an
    // event, whose neighbours (a gala, a party) score nearer than a plant
    // scores to a tank.
    // Measured floors (embeddinggemma-300m, 2026-09-02): doctors 0.35-0.43 vs a
    // gym 0.25; tanks 0.35-0.56 vs plants 0.21-0.26; a jewelry-store errand
    // 0.33 against "wedding"; a hike 0.39 and a camping trip 0.47 against
    // "trip"; boots 0.32 against "clothing item".
    const ENTITY_FLOOR = 0.30, VISIT_ENTITY_FLOOR = 0.35, EVENT_ENTITY_FLOOR = 0.40;
    const headStem = head ? head.replace(/s$/, '') : null;
    // The occasion words a line carries: the ladder's heads anywhere in the
    // statement, and any occasion noun in the line's own head (kind,
    // qualifier, entity). A hike is a trip; a dinner, a gala or a bachelor
    // party is not a wedding, whatever its cosine.
    const occsOf = (it) => {
      const s = String(it.statement || '').replace(/^\[instance\]\s*/, '');
      const set = new Set();
      const m = _EVENT_HEAD && _EVENT_HEAD.exec(s);
      if (m) set.add(m[1].toLowerCase().replace(/s$/, ''));
      if (_occ) for (const w of _occ.occasionsIn(s.split(' — ')[0])) set.add(w);
      return [...set];
    };
    const sameOcc = (occ) => _occ ? _occ.sameOccasion(occ, headStem) : (occ === headStem || headStem.indexOf(occ) >= 0 || occ.indexOf(headStem) >= 0);
    const headClass = (_occ && headStem) ? _occ.classOf(headStem) : null;
    const OCC_KINDS = new Set(['visit', 'event']);
    const entityNames = (it) => {
      const e = String(it._entity || '').toLowerCase();
      return !!e && ((phraseRe && phraseRe.test(e)) || (headRe && headRe.test(e)));
    };
    // The occasion rules belong to the strict test; the relaxed floor that
    // stands in when strictness would leave the reader under three lines
    // judges on cosine alone.
    const subjectTest = (barOf, occasionRules) => (it) => {
      if (occasionRules && headStem && it._kind) {
        const occs = occsOf(it);
        if (occs.length) return !occs.some(sameOcc);
        // The asked head is an occasion: a line that is no occasion at all (an
        // activity, a purchase, with no occasion word of that kind anywhere in
        // it) is not one of them, whatever its cosine (measured: stamps and a
        // commute rode into a trips order on entity cosine).
        if (headClass && !OCC_KINDS.has(String(it._kind))) {
          const anywhere = _occ.occasionsIn(String(it.statement || ''));
          if (!anywhere.some(sameOcc)) return true;
        }
      }
      if (typeof it._entity_cos === 'number') {
        if (entityNames(it)) return false;
        const kind = String(it._kind);
        const bar = kind === 'event' ? EVENT_ENTITY_FLOOR : (kind === 'visit' ? VISIT_ENTITY_FLOOR : ENTITY_FLOOR);
        return it._entity_cos < bar;
      }
      const cos = typeof it._cos === 'number' ? it._cos : null;
      if (cos == null) return false;
      const s = String(it.statement);
      // Naming the counted phrase or its head keeps a line whatever its cosine.
      const named = (phraseRe && phraseRe.test(s)) || (headRe && headRe.test(s));
      return !named && cos < barOf(it);
    };
    const strict = subjectTest((it) => OCCURRENCE_KINDS.has(String(it._kind)) ? Math.max(floor, OCCURRENCE_FLOOR) : floor, true);
    const remaining = instances.filter((it) => !reasonOf.has(it));
    const keptStrict = remaining.filter((it) => !strict(it)).length;
    const anyEntityCos = remaining.some((it) => typeof it._entity_cos === 'number');
    apply('not about the asked subject', (keptStrict >= 3 || anyEntityCos) ? strict : subjectTest(() => floor, false));
  }

  // A line whose cosine to the question is known and below the floor, and
  // that neither names the asked head nor shares a content word with the
  // question, is set aside even when that empties the ledger: an empty
  // ledger over the statements is the truthful answer to a question the
  // ledger does not touch (measured: a question about pay got eight
  // activity lines about other things). A line with no cosine at all is
  // left for the reader, and a pending question is selected by status.
  if (question && !pendingAsk) {
    const qTokens = _contentTokens(question);
    if (qTokens.size) {
      applyForced('not about the asked subject', (it) => {
        if (typeof it._cos !== 'number' && typeof it._entity_cos !== 'number') return false;
        const s = String(it.statement || '');
        if (headRe && headRe.test(s)) return false;
        if (phraseRe && phraseRe.test(s)) return false;
        if (typeof it._entity_cos === 'number' && it._entity_cos >= SUBJECT_FLOOR) return false;
        if (typeof it._cos === 'number' && it._cos >= floor) return false;
        for (const t of _contentTokens(s)) if (qTokens.has(t)) return false;
        return true;
      });
    }
  }
  const kept = instances.filter((it) => !reasonOf.has(it));
  const aside = instances.filter((it) => reasonOf.has(it)).map((it) => ({ item: it, reason: reasonOf.get(it) }));

  const ledger = kept.map((it, i) => {
    const refs = [];
    const flags = [];
    for (const ref of (it.refs || [])) {
      const id = String(ref).replace(/^dialogue\.turn:/, '');
      const hit = rawIndex.get(id);
      if (hit) {
        refs.push(hit.n);
        hit.role = 'supports';
        hit.supports.push(i + 1);
      }
    }
    if (!refs.length) flags.push('attested outside the shown statements');
    const d = dateOf(it);
    return { n: i + 1, statement: it.statement, refs, flags, date: d.iso, date_kind: d.kind, cos: typeof it._cos === 'number' ? it._cos : null, entity: it._entity || null, kind: it._kind || null };
  });
  // About the user: first-person statements lifted from the retrieved words,
  // newest first, for a request-shaped question. Identity and state, listed
  // before the episodes so the reply is built around them.
  const requestShaped = shape ? !!shape.request : (question ? REQUEST_SHAPED.test(question) : false);
  const about = [];
  if (requestShaped && _selfStatements) {
    const seen = new Set();
    for (const r of raw.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
      for (const st of _selfStatements(r.statement)) {
        const key = st.kind + ':' + st.what.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        about.push({ kind: st.kind, what: st.what, n: r.n, ts: Number.isFinite(r.ts) ? r.ts : null });
      }
    }
  }
  // Stated totals ride only on a count-shaped question with a known head.
  const countShaped = shape ? !!shape.count : (question ? COUNT_ASK.test(question) : false);
  const totals = (countShaped && head) ? statedTotals(raw, nounHead, nounPhrase) : [];
  // Same object across lines (a kit bought in one line, finished in another):
  // the later line is annotated so the object is counted once. Matching is
  // the normalised entity string, or one contained in the other.
  const sameObject = new Map();
  if (question) {
    for (let i = 0; i < ledger.length; i++) {
      const li = ledger[i];
      const a = _norm(li.entity); if (a.length < 4) continue;
      for (let j = 0; j < i; j++) {
        const lj = ledger[j];
        if (lj.folded_into) continue;
        const b = _norm(lj.entity); if (b.length < 4) continue;
        if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) {
          // The same object told in the same statement, or pinned to the same
          // day, is one occurrence retold ("attended AFI Fest" and "got back
          // from AFI Fest" out of one turn): the later line folds into the
          // earlier as an attestation, and the statements that attested it
          // now attest the line that stands. Any other pair keeps two lines,
          // annotated, for the reader to judge.
          const sameTelling = li.refs.some((r) => lj.refs.includes(r)) ||
            (!!li.date && li.date === lj.date && li.date_kind === 'stated' && lj.date_kind === 'stated');
          if (sameTelling) {
            li.folded_into = lj.n;
            for (const r of li.refs) if (!lj.refs.includes(r)) lj.refs.push(r);
            lj.also = (lj.also || []).concat(String(li.statement).replace(/^\[instance\]\s*/, '').split(' — ')[0]);
            for (const r of raw) {
              const k = r.supports ? r.supports.indexOf(li.n) : -1;
              if (k >= 0) { r.supports.splice(k, 1); if (!r.supports.includes(lj.n)) r.supports.push(lj.n); }
            }
          } else {
            sameObject.set(li.n, lj.n);
          }
          break;
        }
      }
    }
  }
  // A raw statement that attests only set-aside lines is evidence of
  // something the question does not ask about; it is marked, never judged.
  // Only the certain reasons (window, status) earn the mark; a statement
  // behind a verb- or subject-set-aside line stays open for judgment.
  const certainIds = new Set();
  // For a question about what is owned, an activity line is set aside for
  // certain (an activity is never one of the tanks), and so are the turns
  // that only attest it.
  for (const a of aside) if (/time window|planned or cancelled|open obligation/.test(a.reason) || (ownAsk && /outside the question's verb/.test(a.reason))) for (const ref of (a.item.refs || [])) certainIds.add(String(ref).replace(/^dialogue\.turn:/, ''));
  for (const r of raw) if (r.role === 'new' && certainIds.has(String(r.id))) r.role = 'aside';

  // Cast: identities the mounted material mentions. Distinctness questions
  // ("how many different doctors") are counted over people, not mentions,
  // so each cast line links the ledger AND statement lines that evidence
  // that person — over every registry-unique name it carries (an alias two
  // identities share renders but never joins).
  const _nameRe = (n) => {
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![a-z0-9])' + esc + '(?![a-z0-9])', 'i');
  };
  // The cast renders names only: an alias the registry would refuse today
  // (an insult, a sentence, a word of the chat that is nobody's name) is
  // dropped at render, and an entry whose own name is no name is left out,
  // whatever an older registry row holds.
  const castClean = castItems.map((it) => {
    const st = String(it.statement || '');
    const m = /^\[cast\]\s*([^—(]+)/.exec(st);
    const canonical = m ? m[1].trim() : '';
    if (!canonical || (_idn && !_idn.aliasAcceptable(canonical, canonical))) return null;
    const cleaned = st.replace(/\s*\(also:\s*([^)]*)\)/, (all, list) => {
      const keep = String(list).split(/,\s*/).map((a) => a.trim()).filter((a) => a && (!_idn || _idn.aliasAcceptable(a, canonical)));
      return keep.length ? ' (also: ' + keep.join(', ') + ')' : '';
    });
    return Object.assign({}, it, { statement: cleaned });
  }).filter(Boolean);
  const cast = castClean.map((it, i) => {
    const m = /^\[cast\]\s*([^—(]+)/.exec(String(it.statement || ''));
    const parsed = m ? m[1].trim().toLowerCase() : '';
    const names = (Array.isArray(it.link_names) && it.link_names.length ? it.link_names : (parsed ? [parsed] : []))
      .map((n) => String(n).toLowerCase())
      .filter((n) => n.length >= 3);
    const res = names.map(_nameRe);
    const links = [];
    const slinks = [];
    for (const l of ledger) if (!l.folded_into && res.some((re) => re.test(String(l.statement)))) links.push(l.n);
    for (const r of raw) if (res.some((re) => re.test(String(r.statement)))) slinks.push(r.n);
    return { n: i + 1, statement: it.statement, links, slinks };
  });
  return {
    ledger,
    cast,
    raw,
    aside,
    window,
    totals,
    about,
    families: families.map((f) => f.name),
    asks,
    status_ask: statusAsk,
    render() {
      const lines = [];
      // The kind of answer wanted, said once, so the reader serves a place
      // where a place was asked and not the channel it came through.
      const askLabel = { place: 'a place', time: 'a time', person: 'a person', thing: 'a thing', reason: 'a reason', manner: 'a way of doing it' };
      if (asks && askLabel[asks]) lines.push('The question asks for ' + askLabel[asks] + '; the answer names one.');
      if (pendingAsk) lines.push('The question asks what is still open: only owed or planned lines count, and a thing already done is not pending.');
      // No abstention with the answer in view: a statement that names the
      // thing asked is answered from, even in part (measured: a reader said
      // unknown with the coupon, the volunteer date and the occupation in
      // front of it).
      // A request (recommend, suggest) is answered around the About block, which
      // leads; the rule is for questions about what happened.
      if (question && !requestShaped) lines.push('When a statement names the thing asked, answer from it, even if it gives only part; unknown is only for what no statement touches.');
      if ((asks && askLabel[asks]) || pendingAsk || (question && !requestShaped)) lines.push('');
      if (about.length) {
        const label = { role: 'who they are', constraint: 'a constraint they keep', skill: 'a skill they have', liking: 'what they like', effort: 'something they made before' };
        // Preferences and constraints, never a whereabouts: a place the user
        // likes exploring is something to honour, not where they are now.
        lines.push('About the user, in their own words (newest first): preferences and constraints to honour in the answer, never where the user is now. Build the answer around the one most specific to this request, then honour the rest:');
        about.forEach((a, i) => {
          lines.push('A' + (i + 1) + '. ' + (a.ts ? '[' + _isoOf(a.ts) + '] ' : '') + a.what + ' (' + (label[a.kind] || a.kind) + ') (S' + a.n + ')');
        });
        lines.push('');
      }
      if (ledger.length || aside.length) {
        lines.push('Consolidated ledger (each line is ONE real-world occurrence; its attestations are listed - never count an attestation separately):');
        if (window) {
          lines.push('The question spans ' + (window.span || 'a time window') + ': ' + _isoOf(window.since) + ' to ' + _isoOf(window.until) + '. Only lines dated inside it are listed; an undated line is listed and marked. A "said on" day is when the user mentioned it, not necessarily when it happened.');
        }
        // No verb-matching prose here: a text rule that gates counting
        // cannot tell counting occurrences from summing quantities, and it
        // discarded quantity-bearing evidence the moment it shipped. The
        // qualifier lives structured on every line; discrimination belongs
        // to structure (question family + status maturation), not prose.
        // Ownership doctrine — measured: a possession's [completed] status read
        // as "done with it", and a real, still-owned tank was subtracted the
        // moment a newer one appeared. Completed acquisition means owned;
        // only explicit disposal ends ownership, and the header says so once.
        if (ledger.some((l) => /^(\[instance\]\s*)?possession:/.test(l.statement))) {
          lines.push('Possessions stay owned until an explicit disposal (sold, gave away, broke, returned) - a newer similar item never replaces an older one by itself.');
        }
        // Possibly-same annotation. The consolidation covenant refuses to
        // join two occasions linked only by a role two identities share
        // ("cousin's wedding" when two known people are cousins) - correctly.
        // But a count that then treats both lines as distinct occurrences
        // repeats the measured over-count from the raw lane. When ONE cast
        // identity links two ledger lines carrying the SAME occasion head
        // and neither pins a distinct date, the weaker-attested line says so
        // out loud. Doubt is shown, not buried - and never silently merged.
        const _headOf = (s) => { const m = _EVENT_HEAD && _EVENT_HEAD.exec(String(s)); return m ? m[1].toLowerCase() : null; };
        const _dateOf = (s) => { const m = /\[[a-z]+, (\d{4}-\d{2}-\d{2})\]/.exec(String(s)); return m ? m[1] : null; };
        const _possiblySame = new Map();
        if (_EVENT_HEAD) {
          for (const c of cast) {
            if (!c.links || c.links.length < 2) continue;
            for (let x = 0; x < c.links.length; x++) {
              for (let y = x + 1; y < c.links.length; y++) {
                const lx = ledger[c.links[x] - 1], ly = ledger[c.links[y] - 1];
                if (!lx || !ly) continue;
                if (lx.folded_into || ly.folded_into) continue;
                const hx = _headOf(lx.statement), hy = _headOf(ly.statement);
                if (!hx || hx !== hy) continue;
                const dx = _dateOf(lx.statement), dy = _dateOf(ly.statement);
                if (dx && dy && dx !== dy) continue;
                const weak = lx.refs.length <= ly.refs.length ? lx : ly;
                const anchor = weak === lx ? ly : lx;
                if (!_possiblySame.has(weak.n)) _possiblySame.set(weak.n, anchor.n);
              }
            }
          }
          // A line that names its occasion by a role alone ("cousin's wedding")
          // beside a line that names the same occasion with a person of that
          // role ("cousin Rachel's wedding") is possibly that one, never a
          // new one on its own: the reader counts it separately only on
          // explicit evidence.
          const rolesIn = (s) => new Set([...String(s).matchAll(_ROLE_WORD)].map((m) => m[1].toLowerCase()));
          const properIn = (s) => /\b[A-Z][a-z]{2,}\b/.test(String(s).replace(/^\[instance\]\s*/, '').replace(/\[[^\]]*\]/g, '').replace(/\((?:attested|qty)[^)]*\)/g, ''));
          for (const weak of ledger) {
            if (weak.folded_into || _possiblySame.has(weak.n)) continue;
            const hw = _headOf(weak.statement); if (!hw) continue;
            const body = String(weak.statement).split(' — ').slice(0, 2).join(' — ');
            if (properIn(body)) continue;
            const roles = rolesIn(body); if (!roles.size) continue;
            const anchor = ledger.find((o) => o !== weak && !o.folded_into && _headOf(o.statement) === hw && [...rolesIn(o.statement)].some((r) => roles.has(r)));
            if (anchor) _possiblySame.set(weak.n, anchor.n);
          }
        }
        for (const l of ledger) {
          if (l.folded_into) continue;
          let text = l.statement.replace(/^\[instance\]\s*/, '');
          if (/^possession:/.test(text)) text = text.replace('[completed', '[owned');
          // The day: a pinned date is already inside the status bracket. The
          // day it was SAID is added when a question is asked, worded so an
          // ordering is never read off it: a mention is not the event
          // (measured: "last month I helped with the nursery", said in May,
          // was ordered as a May event).
          const dateNote = question
            ? (l.date_kind === 'attested' ? ' [said on ' + l.date + '; the words say when it happened]' : (!l.date ? ' [undated]' : ''))
            : '';
          lines.push('L' + l.n + '. ' + text + dateNote +
            (l.also && l.also.length ? ' (also told as: ' + l.also.join('; ') + ')' : '') +
            (l.refs.length ? ' (attested by ' + l.refs.map(n => 'S' + n).join(', ') + ')' : '') +
            (l.flags.length ? ' [flag: ' + l.flags.join('; ') + ']' : '') +
            (sameObject.has(l.n) ? ' [same object as L' + sameObject.get(l.n) + ' - count the object once]' : '') +
            (_possiblySame.has(l.n) ? ' [possibly the same occurrence as L' + _possiblySame.get(l.n) + ' - count it separately only on explicit evidence]' : ''));
        }
        // The mind does the calendar. When the question asks for a time or an
        // order, every dated line gets its span to the day of the question and
        // the dated lines are put in order, with the spans between them, so no
        // reader counts days by hand (measured: 26 for 21, a month-day slip).
        const wantsCalendar = asks === 'time' || (countShaped && /\b(order|first to last|earliest|latest|sequence)\b/i.test(qLower));
        if (wantsCalendar && refTs) {
          const dated = ledger.filter((l) => !l.folded_into && l.date && /^\d{4}-\d{2}-\d{2}$/.test(l.date))
            .map((l) => ({ n: l.n, date: l.date, ts: Date.parse(l.date + 'T12:00:00Z') }))
            .filter((l) => Number.isFinite(l.ts))
            .sort((a, b) => a.ts - b.ts);
          if (dated.length) {
            const refIso = _isoOf(refTs);
            const days = (a, b) => Math.round((b - a) / DAY_MS);
            const span = (d) => d === 1 ? '1 day' : (d % 7 === 0 && d >= 14 ? d + ' days (' + (d / 7) + ' weeks)' : d + ' days');
            lines.push('');
            lines.push('Calendar (computed from the dates above; the question was asked on ' + refIso + '):');
            lines.push('  In order, earliest first: ' + dated.map((l) => 'L' + l.n + ' (' + l.date + ')').join(' → '));
            for (const l of dated) {
              const d = days(l.ts, refTs);
              lines.push('  L' + l.n + ': ' + l.date + ', ' + (d >= 0 ? span(d) + ' before the question' : span(-d) + ' after the question'));
            }
            for (let i = 1; i < dated.length; i++) {
              const a = dated[i - 1], b = dated[i];
              lines.push('  L' + b.n + ' is ' + span(days(a.ts, b.ts)) + ' after L' + a.n);
            }
          }
        }
        if (aside.length) {
          const byReason = new Map();
          for (const a of aside) byReason.set(a.reason, (byReason.get(a.reason) || 0) + 1);
          lines.push('Set aside, not listed: ' + [...byReason.entries()].map(([r, n]) => n + ' ledger line' + (n === 1 ? '' : 's') + ' ' + r).join('; ') + '. They are not what the question counts.');
        }
        lines.push('');
      }
      if (totals.length) {
        lines.push('Stated totals (the user naming the count in their own words, newest first; the newest stated total wins, and ledger lines dated after it add to it - ledger lines dated before it are already inside it):');
        totals.forEach((t, i) => {
          lines.push('T' + (i + 1) + '. ' + (t.ts ? '[' + _isoOf(t.ts) + '] ' : '') + t.value + (t.kind === 'running' ? ' (running count: "' + t.text + '")' : ' ("' + t.text + '")') + ' (S' + t.n + ')' + (i === 0 ? '   <- newest' : ''));
        });
        lines.push('');
      }
      // The cast is a glossary for reading a ledger, or the list a
      // person-headed count is counted over. A fact question with no ledger
      // line gets neither (measured: fifteen entities under a pay question).
      const _PERSON_HEADS_EARLY = new Set(['person', 'people', 'doctor', 'dentist', 'specialist', 'therapist', 'physician', 'friend', 'cousin', 'relative', 'sibling', 'colleague', 'neighbor', 'neighbour', 'provider', 'practitioner', 'contact', 'member', 'guest']);
      const castWanted = cast.length && (ledger.some((l) => !l.folded_into) || (head && _PERSON_HEADS_EARLY.has(head)));
      if (castWanted) {
        // The counting clause converts "distinct people mentioned nearby"
        // into "distinct occurrences" when the counted thing is NOT people
        // (measured: a weddings count read the cast's four people as four
        // weddings). Scope it: only a person-headed count question keeps the
        // clause; anything else gets the cast as a reading glossary. No head
        // supplied → the clause stays, exactly as before.
        const _head = head;
        const _PERSON_HEADS = new Set(['person', 'people', 'doctor', 'dentist', 'specialist', 'therapist', 'physician', 'friend', 'cousin', 'relative', 'sibling', 'colleague', 'neighbor', 'neighbour', 'provider', 'practitioner', 'contact', 'member', 'guest']);
        lines.push(!_head || _PERSON_HEADS.has(_head)
          ? 'Known people and entities here (identity registry) - when the question counts DISTINCT people or entities, count over THIS list, using ledger and statements as each one\'s evidence:'
          : 'Known people and entities here (identity registry) - a glossary for reading the evidence; the question does not count people, so this list is never what is counted:');
        for (const c of cast) {
          lines.push('C' + c.n + '. ' + c.statement.replace(/^\[cast\]\s*/, '') +
            (c.links.length ? ' (ledger: ' + c.links.map(n => 'L' + n).join(', ') + ')' : '') +
            (c.slinks && c.slinks.length ? ' (statements: ' + c.slinks.map(n => 'S' + n).join(', ') + ')' : ''));
        }
        lines.push('');
      }
      // The coverage marks live in ONE legend up here — measured: a per-line
      // "judge this one" clause got quoted back mid-reasoning and derailed an
      // enumeration. Statements stay clean; the marks stay terse.
      const hasLedger = ledger.length > 0 || aside.length > 0;
      lines.push(hasLedger
        ? 'Memory statements ("=Ln" marks one already counted by ledger line Ln; "+" marks one the ledger does not cover - judge those individually' + (aside.length ? '; "-" marks one that attests only a set-aside line - not what the question counts' : '') + '):'
        : 'Memory statements:');
      // The same fact told five ways is one statement with five receipts:
      // "User has a road bike", "User owns a road bike", "The user has a
      // road bike." fold into the first, which names the others. A raw
      // dialogue turn is never folded: its words are the evidence.
      const factKey = (s) => {
        const t = String(s || '').toLowerCase();
        if (/^user:/.test(t) || t.length > 200) return null;
        return t.replace(/^\[[^\]]*\]\s*/, '').replace(/^(?:the\s+)?user\s+/, '').replace(/\bowns or has access to\b/g, 'has').replace(/\bowns\b/g, 'has').replace(/\bhave\b/g, 'has').replace(/[^a-z0-9Ͱ-Ͽ ]+/g, ' ').replace(/\s+/g, ' ').trim() || null;
      };
      const foldAnchor = new Map();   // fact key -> anchor entry
      const foldedInto = new Map();   // statement number -> anchor number
      for (const r of raw) {
        const k = factKey(r.statement);
        if (!k) continue;
        const a = foldAnchor.get(k);
        if (a) { foldedInto.set(r.n, a.n); a.also = (a.also || []).concat(r.n); } else foldAnchor.set(k, r);
      }
      // Every statement carries its day: a fact about pay, a job or a plan is
      // true as of that day. Two statements on the same subject that each
      // state an amount, a count or a date are one fact told twice; the
      // newest wins and the older one says which newer statement replaces
      // it (measured: a May pay figure stood beside its September correction
      // with nothing to say which was current).
      const newerOf = new Map();   // statement number -> number of the newest statement on the same subject
      const valued = raw.filter((r) => !foldedInto.has(r.n) && Number.isFinite(r.ts) && _statesValue(r.statement) && !/^user:/i.test(String(r.statement)));
      for (const a of valued) {
        const ta = _contentTokens(_valueFree(a.statement));
        if (ta.size < 2) continue;
        let newest = a;
        for (const b of valued) {
          if (b === a || b.ts <= newest.ts) continue;
          const tb = _contentTokens(_valueFree(b.statement));
          let shared = 0;
          for (const t of ta) if (tb.has(t)) shared++;
          if (shared >= 2 || (shared >= 1 && shared >= Math.min(ta.size, tb.size))) newest = b;
        }
        if (newest !== a) newerOf.set(a.n, newest.n);
      }
      for (const r of raw) {
        if (foldedInto.has(r.n)) continue;
        const mark = r.role === 'supports' ? ' [=' + r.supports.map(n => 'L' + n).join(',') + ']'
          : r.role === 'aside' ? ' [-]'
          : (hasLedger ? ' [+]' : '');
        const same = r.also && r.also.length ? ' (the same fact told ' + (r.also.length + 1) + ' times: also S' + r.also.join(', S') + ')' : '';
        const day = question && Number.isFinite(r.ts) && r.ts > 0 ? ' [' + _isoOf(r.ts) + ']' : '';
        const older = newerOf.has(r.n) ? ' (as of its day; S' + newerOf.get(r.n) + ' is newer on this subject and wins)' : '';
        lines.push('S' + r.n + '.' + mark + ' ' + r.statement + same + day + older);
      }
      return lines.join('\n');
    }
  };
}

module.exports = { buildReconciledView };
