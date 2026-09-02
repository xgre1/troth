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
let _parseTimeWindow = null;
try { _parseTimeWindow = require('./time-window.js').parseTimeWindow; } catch (_) {}

// Cosine floor for "about the asked subject". Calibrated on the 13 count and
// order questions of the LongMemEval probe (2026-09-02): same-topic instances
// sit at 0.45-0.7 against the question, unrelated ones below 0.3.
const SUBJECT_FLOOR = 0.30;          // objects: hyponyms sit low ("boots" vs "clothing")
const OCCURRENCE_FLOOR = 0.45;       // occurrences: a barbecue is not a wedding, whatever its cosine
const OCCURRENCE_KINDS = new Set(['event', 'visit', 'activity']);
const DAY_MS = 86400000;
const _isoOf = (ts) => { try { return new Date(ts).toISOString().slice(0, 10); } catch (_) { return null; } };
// The date a statement pins: "[completed, 2023-02-05]" / "[completed, inferred, 2023-02-05]".
const _statedDate = (s) => { const m = /\[[a-z]+(?:, inferred)?, (\d{4}-\d{2}-\d{2})\]/.exec(String(s)); return m ? m[1] : null; };

// Verb families: what the question asks about, matched against the kind and
// the qualifier/facets an instance carries. A family lists the kinds that
// belong to it outright and the verbs that admit a line of another kind.
const VERB_FAMILIES = [
  { name: 'acquire', ask: /\b(acquire[ds]?|acquired|bought|buy|purchase[ds]?|purchased|got|get|received?|obtain(?:ed)?|adopt(?:ed)?|pick(?:ed)? up)\b/,
    kinds: new Set(['purchase']), verbs: /\b(bought|buy|purchased|purchase|got|get|received|receive|acquired|acquire|adopted|picked up|obtained|ordered)\b/ },
  { name: 'attend', ask: /\b(attend(?:ed)?|went to|go to|been to)\b/,
    kinds: new Set(['event', 'visit']), verbs: /\b(attended|attend|went|visited|joined|celebrated)\b/ },
  { name: 'visit', ask: /\b(visit(?:ed)?|tried|been to|eaten at|dined at)\b/,
    kinds: new Set(['visit']), verbs: /\b(visited|tried|went|ate|dined|stayed)\b/ },
  { name: 'work', ask: /\b(work(?:ed)? on|built|build|made|make|finish(?:ed)?|complete[ds]?|written|wrote|painted|assembled)\b/,
    kinds: new Set(['creation']), verbs: /\b(worked|working|built|building|made|making|finished|finishing|completed|wrote|writing|written|painted|painting|assembled|planning)\b/ },
  { name: 'lead', ask: /\b(led|lead(?:ing)?|manage[ds]?|managed|run|ran)\b/,
    kinds: new Set(['role', 'project']), verbs: /\b(led|leading|lead|managed|managing|ran|running|heading|headed)\b/ },
  // "have" only as possession, never as the auxiliary of "have I worked on".
  { name: 'own', ask: /\b(own|owns|keep|currently have|do i (?:still |currently )?have|have (?:got )?(?:at home|now|left)|how many [a-z]+ (?:do|did) i have)\b/,
    kinds: new Set(['possession', 'purchase']), verbs: /\b(owns|own|has|have|keeps|bought|got|received|adopted|purchased)\b/ }
];
// A question about what happened (has/have/did/how many ... did I) is not
// asking about plans: planned and cancelled lines are set aside for it.
const PAST_ASK = /\b(have i|did i|i have|i've|have attended|did|attended|bought|went|visited|acquired|worked on|made|led)\b/;
const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an|my|our|new|another|some)\b/g, ' ').replace(/\s+/g, ' ').trim();

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
    const after = m.input.slice(m.index + m[0].length).replace(/^\s+/, '');
    if (!Number.isFinite(value) || value <= 0 || value > 100) return;
    if (UNIT_AFTER.test(m[0].slice(m[1].length).replace(/^\s+/, ''))) return;
    void after;
    out.push({ value, kind, n: r.n, ts: Number.isFinite(r.ts) ? r.ts : null, text: m[0] });
  };
  for (const r of raw) {
    const text = String(r.statement || '');
    // Only the user's own words state a total; the assistant restating is not a claim.
    const userPart = text.indexOf(' / asst:') >= 0 ? text.slice(0, text.indexOf(' / asst:')) : text;
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
  const window = opts.window || (question && _parseTimeWindow ? _parseTimeWindow(question, refTs) : null);
  const floor = Number.isFinite(opts.subject_floor) ? opts.subject_floor : SUBJECT_FLOOR;
  const head = opts.noun_head ? String(opts.noun_head).toLowerCase().replace(/s$/, '') : null;
  const headPhrase = opts.head_phrase ? String(opts.head_phrase).toLowerCase().replace(/s$/, '') : null;
  const _re = (s) => new RegExp('(?<![a-z])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z]*', 'i');
  const headRe = head && head.length >= 3 ? _re(head) : null;
  const phraseRe = headPhrase && headPhrase.length >= 3 && headPhrase !== head ? _re(headPhrase) : null;
  // A question may carry several verbs ("worked on or bought"): a line is
  // kept when ANY named family accepts it.
  const families = question ? VERB_FAMILIES.filter((f) => f.ask.test(qLower)) : [];
  const pastAsk = question ? PAST_ASK.test(qLower) : false;

  // Each filter is a pass over the instances that names a reason; a filter
  // that would leave nothing is skipped so the ledger is never emptied.
  const reasonOf = new Map();
  const apply = (name, test) => {
    const survivors = instances.filter((it) => !reasonOf.has(it) && !test(it));
    if (!survivors.length) return;
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
  if (families.length) apply('outside the question\'s verb (' + families.map((f) => f.name).join(' or ') + ')', (it) => {
    if (!it._kind) return false;                        // no structure, no verdict
    const verbs = [it._qualifier].concat(Array.isArray(it._facets) ? it._facets : []).filter(Boolean).join(' ').toLowerCase();
    return !families.some((f) => f.kinds.has(String(it._kind)) || f.verbs.test(verbs));
  });
  if (pastAsk) apply('planned or cancelled, not done', (it) => it._status === 'planned' || it._status === 'cancelled');
  if (question) {
    // Cosine to the question has limited resolution (measured 2026-09-02:
    // true members 0.30-0.50, strangers 0.25-0.40). The strict floors are
    // used when they leave the reader at least three lines; otherwise the
    // object floor applies to every kind, and the reader judges the rest.
    const subjectTest = (barOf) => (it) => {
      const cos = typeof it._cos === 'number' ? it._cos : null;
      if (cos == null) return false;
      const s = String(it.statement);
      // Naming the counted phrase or its head keeps a line whatever its cosine.
      const named = (phraseRe && phraseRe.test(s)) || (headRe && headRe.test(s));
      return !named && cos < barOf(it);
    };
    const strict = subjectTest((it) => OCCURRENCE_KINDS.has(String(it._kind)) ? Math.max(floor, OCCURRENCE_FLOOR) : floor);
    const remaining = instances.filter((it) => !reasonOf.has(it));
    const keptStrict = remaining.filter((it) => !strict(it)).length;
    apply('not about the asked subject', keptStrict >= 3 ? strict : subjectTest(() => floor));
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
  // Stated totals ride only on a count-shaped question with a known head.
  const countShaped = question ? /\b(how many|how much|number of|total|count)\b/i.test(question) : false;
  const totals = (countShaped && head) ? statedTotals(raw, opts.noun_head, opts.head_phrase) : [];
  // Same object across lines (a kit bought in one line, finished in another):
  // the later line is annotated so the object is counted once. Matching is
  // the normalised entity string, or one contained in the other.
  const sameObject = new Map();
  if (question) {
    for (let i = 0; i < ledger.length; i++) {
      const a = _norm(ledger[i].entity); if (a.length < 4) continue;
      for (let j = 0; j < i; j++) {
        const b = _norm(ledger[j].entity); if (b.length < 4) continue;
        if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) { sameObject.set(ledger[i].n, ledger[j].n); break; }
      }
    }
  }
  // A raw statement that attests only set-aside lines is evidence of
  // something the question does not ask about; it is marked, never judged.
  // Only the certain reasons (window, status) earn the mark; a statement
  // behind a verb- or subject-set-aside line stays open for judgment.
  const certainIds = new Set();
  for (const a of aside) if (/time window|planned or cancelled/.test(a.reason)) for (const ref of (a.item.refs || [])) certainIds.add(String(ref).replace(/^dialogue\.turn:/, ''));
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
  const cast = castItems.map((it, i) => {
    const m = /^\[cast\]\s*([^—(]+)/.exec(String(it.statement || ''));
    const parsed = m ? m[1].trim().toLowerCase() : '';
    const names = (Array.isArray(it.link_names) && it.link_names.length ? it.link_names : (parsed ? [parsed] : []))
      .map((n) => String(n).toLowerCase())
      .filter((n) => n.length >= 3);
    const res = names.map(_nameRe);
    const links = [];
    const slinks = [];
    for (const l of ledger) if (res.some((re) => re.test(String(l.statement)))) links.push(l.n);
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
    families: families.map((f) => f.name),
    render() {
      const lines = [];
      if (ledger.length || aside.length) {
        lines.push('Consolidated ledger (each line is ONE real-world occurrence; its attestations are listed - never count an attestation separately):');
        if (window) {
          lines.push('The question spans ' + (window.span || 'a time window') + ': ' + _isoOf(window.since) + ' to ' + _isoOf(window.until) + '. Only lines dated inside it are listed; an undated line is listed and marked.');
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
        }
        for (const l of ledger) {
          let text = l.statement.replace(/^\[instance\]\s*/, '');
          if (/^possession:/.test(text)) text = text.replace('[completed', '[owned');
          // The day: a pinned date is already inside the status bracket; an
          // attested day is added when a question is asked, so an ordering
          // or a window can be read off the line.
          const dateNote = question
            ? (l.date_kind === 'attested' ? ' [first mentioned ' + l.date + ']' : (!l.date ? ' [undated]' : ''))
            : '';
          lines.push('L' + l.n + '. ' + text + dateNote +
            (l.refs.length ? ' (attested by ' + l.refs.map(n => 'S' + n).join(', ') + ')' : '') +
            (l.flags.length ? ' [flag: ' + l.flags.join('; ') + ']' : '') +
            (sameObject.has(l.n) ? ' [same object as L' + sameObject.get(l.n) + ' - count the object once]' : '') +
            (_possiblySame.has(l.n) ? ' [possibly the same occurrence as L' + _possiblySame.get(l.n) + ' - count it separately only on explicit evidence]' : ''));
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
      if (cast.length) {
        // The counting clause converts "distinct people mentioned nearby"
        // into "distinct occurrences" when the counted thing is NOT people
        // (measured: a weddings count read the cast's four people as four
        // weddings). Scope it: only a person-headed count question keeps the
        // clause; anything else gets the cast as a reading glossary. No head
        // supplied → the clause stays, exactly as before.
        const _head = opts && opts.noun_head ? String(opts.noun_head).toLowerCase().replace(/s$/, '') : null;
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
      for (const r of raw) {
        const mark = r.role === 'supports' ? ' [=' + r.supports.map(n => 'L' + n).join(',') + ']'
          : r.role === 'aside' ? ' [-]'
          : (hasLedger ? ' [+]' : '');
        lines.push('S' + r.n + '.' + mark + ' ' + r.statement);
      }
      return lines.join('\n');
    }
  };
}

module.exports = { buildReconciledView };
