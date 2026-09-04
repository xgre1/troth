// SPDX-License-Identifier: AGPL-3.0-only
// Orchestrate Triage — decide whether a user task warrants spawning
// role-specialist sub-agents, vs handling inline.
//
// Three outcome modes:
//
//   'inline'           — small / single-domain task. No hint. Main agent
//                        handles directly. Sub-agents add latency that
//                        small tasks don't earn back.
//
//   'ask_user'         — multi-domain detected by heuristic, BUT user did
//                        not explicitly request orchestration. Main agent
//                        SHOULD ask the user "this looks like 3 specialist
//                        roles — want me to orchestrate or handle inline?"
//                        before spawning. No silent fan-out.
//
//   'explicit_request' — user already named roles or used spawn keywords
//                        ("spawn a backend agent", "have backend, frontend
//                        and qa do this", "split into agents"). Main agent
//                        proceeds with `troth_orchestrate_run` immediately.
//
// Pure deterministic heuristic. No LLM call, no I/O. Cheap to call on
// every prompt (or once per "should I orchestrate?" decision).
//
// Conservative on `explicit_request` — false positive there means the
// agent skips asking and fans out unwanted sub-agents. Liberal on
// `ask_user` — false positive there only adds an extra question.

const KNOWN_ROLES = [
  'backend', 'frontend', 'qa', 'designer', 'researcher',
  // Common synonyms users might say:
  'api', 'ui', 'tests', 'design', 'research'
];

// Maps soft synonyms back onto the role registry's canonical names so
// the suggestion list is directly usable as `troth_orchestrate_run`
// `roles` argument without further translation.
const SYNONYM_TO_CANONICAL = {
  api: 'backend',
  ui:  'frontend',
  tests: 'qa',
  design: 'designer',
  research: 'researcher'
};

// Markers that strongly suggest the user is explicitly requesting
// orchestration. Word-boundary anchored. Order does not matter.
//
// Note: regexes tolerate up to 2 filler words between the verb and the
// "agent(s)" head noun so "spawn a backend agent" / "have the qa agent"
// match without us enumerating every adjective.
const EXPLICIT_PATTERNS = [
  /\bspawn\s+(?:\w+\s+){0,3}(?:agent|agents|sub-?agent|sub-?agents|worker|workers)\b/i,
  /\b(?:multiple|several|many)\s+agents?\b/i,
  /\bsplit\s+(?:this|that|the|it)(?:\s+\w+)?\s+(?:into|across)\s+(?:agents?|workers?|roles?)\b/i,
  /\b(?:have|use|put|run|launch|start)\s+(?:\w+\s+){0,2}(?:agent|agents|worker|workers)\b/i,
  /\b(?:backend|frontend|qa|designer|researcher)\s+agent\b/i,
  /\borchestrate\b/i,
  /\bin\s+parallel\s+(?:with|across|using)\s+(?:agents?|workers?|roles?)\b/i
];

// Multi-domain markers — would score the gap between "obviously inline"
// and "ask the user". Each match adds to the score; threshold below.
const DOMAIN_MARKERS = [
  { pat: /\b(?:rest\s+)?api\b|\bendpoint(?:s)?\b|\b\/api\/|\bback[-\s]?end\b/i,             role: 'backend' },
  { pat: /\b(?:react|vue|svelte)\b|\bfront[-\s]?end\b|\bcomponent(?:s)?\b|\bform\b|\bui\b/i, role: 'frontend' },
  { pat: /\btest(?:s|ing)?\b|\bunit\s+test|\bintegration\s+test|\bqa\b/i,                    role: 'qa' },
  { pat: /\bdesign(?:er)?\b|\bcss\b|\btailwind\b|\bspacing\b|\btypography\b|\bbrand\b/i,     role: 'designer' },
  { pat: /\bresearch\b|\binvestigate\b|\bcompare\b|\bsurvey\b|\bcompetitor(?:s)?\b/i,         role: 'researcher' }
];

// Important-job markers — "feature", "build", "implement", etc. Without
// at least one of these we don't recommend orchestration even if multiple
// domains are mentioned (e.g. a question about backend + frontend is just
// a question, not a task to orchestrate).
const IMPORTANT_TASK_MARKERS = [
  /\bbuild\b/i, /\bimplement\b/i, /\bcreate\b/i, /\badd\b/i, /\bship\b/i,
  /\bset\s+up\b/i, /\brefactor\b/i, /\bmigrate\b/i, /\bdeploy\b/i,
  /\bfeature\b/i, /\bproduct\b/i, /\bproject\b/i, /\bend[-\s]?to[-\s]?end\b/i
];

// Strict negative markers — even if domains appear, if the user is
// asking a question or wants a quick fix, do not suggest orchestration.
const QUESTION_MARKERS = [
  /^\s*(?:what|how|why|when|where|which|who|can\s+you|could\s+you|is\s+it|does\s+it)\b/i,
  /\?\s*$/
];

const QUICK_FIX_MARKERS = [
  /\bquick\s+(?:fix|question|edit)\b/i,
  /\bjust\s+(?:add|fix|change|update|tweak)\b/i,
  /\bone-?liner\b/i,
  /\btypo\b/i
];

// Triage entry. Returns:
//   {
//     mode: 'inline' | 'ask_user' | 'explicit_request',
//     suggested_roles: string[],
//     confidence: 0..1,
//     reason: string,
//     signals: {
//       explicit, important, domain_hits, question, quick_fix, role_mentions
//     }
//   }
function triage(userText, opts) {
  opts = opts || {};
  const text = String(userText || '').trim();
  if (!text) {
    return { mode: 'inline', suggested_roles: [], confidence: 0, reason: 'empty input', signals: {} };
  }

  // Signal 1: explicit role mentions by name (or common synonym).
  const mentioned = new Set();
  for (const role of KNOWN_ROLES) {
    const re = new RegExp('\\b' + role + '\\b', 'i');
    if (re.test(text)) {
      const canonical = SYNONYM_TO_CANONICAL[role.toLowerCase()] || role.toLowerCase();
      mentioned.add(canonical);
    }
  }

  // Signal 2: explicit orchestration request patterns.
  let explicit = false;
  for (const pat of EXPLICIT_PATTERNS) {
    if (pat.test(text)) { explicit = true; break; }
  }

  // Signal 3: domain markers (different from role mentions — these
  // detect domain VOCABULARY even when the role name isn't said).
  const domainHits = new Set();
  for (const m of DOMAIN_MARKERS) {
    if (m.pat.test(text)) domainHits.add(m.role);
  }

  // Signal 4: important-task markers (build/implement/feature/etc.)
  let important = false;
  for (const pat of IMPORTANT_TASK_MARKERS) {
    if (pat.test(text)) { important = true; break; }
  }

  // Signal 5: negative markers (question / quick fix).
  let question = false;
  for (const pat of QUESTION_MARKERS) {
    if (pat.test(text)) { question = true; break; }
  }
  let quickFix = false;
  for (const pat of QUICK_FIX_MARKERS) {
    if (pat.test(text)) { quickFix = true; break; }
  }

  // Combine domains the user mentioned + domains we detected by vocabulary.
  const allRoles = new Set();
  for (const r of mentioned) allRoles.add(r);
  for (const r of domainHits) allRoles.add(r);
  const suggested = Array.from(allRoles);

  // Mode decision tree:
  //
  // 1. EXPLICIT request beats everything. User said "spawn agents" → just do it.
  //    Even if list is empty, default to backend+frontend+qa.
  if (explicit) {
    return {
      mode: 'explicit_request',
      suggested_roles: suggested.length ? suggested : ['backend', 'frontend', 'qa'],
      confidence: 0.95,
      reason: 'explicit orchestration keywords detected',
      signals: { explicit: true, important, domain_hits: Array.from(domainHits), question, quick_fix: quickFix, role_mentions: Array.from(mentioned) }
    };
  }

  // 2. QUESTION or QUICK FIX overrides domain hits — user is asking,
  //    not requesting a multi-role build.
  if (question || quickFix) {
    return {
      mode: 'inline',
      suggested_roles: [],
      confidence: 0.9,
      reason: question ? 'question form, not a build task' : 'quick-fix marker present',
      signals: { explicit: false, important, domain_hits: Array.from(domainHits), question, quick_fix: quickFix, role_mentions: Array.from(mentioned) }
    };
  }

  // 3. Suggest only when BOTH important-task markers AND ≥2 domains hit.
  //    Single-domain build = inline (faster, simpler). Multi-domain build
  //    AND the user clearly wants something built → ask the user.
  if (important && allRoles.size >= 2) {
    return {
      mode: 'ask_user',
      suggested_roles: suggested,
      confidence: Math.min(0.5 + (allRoles.size * 0.15), 0.9),
      reason: 'multi-domain build task — ' + suggested.length + ' role(s) detected',
      signals: { explicit: false, important, domain_hits: Array.from(domainHits), question, quick_fix: quickFix, role_mentions: Array.from(mentioned) }
    };
  }

  // 4. Default: inline. Don't fan out for questions, quick edits,
  //    single-domain tasks, or anything we can't clearly classify.
  return {
    mode: 'inline',
    suggested_roles: [],
    confidence: 0.7,
    reason: 'no multi-role build signal',
    signals: { explicit: false, important, domain_hits: Array.from(domainHits), question, quick_fix: quickFix, role_mentions: Array.from(mentioned) }
  };
}

module.exports = { triage, KNOWN_ROLES, SYNONYM_TO_CANONICAL };
