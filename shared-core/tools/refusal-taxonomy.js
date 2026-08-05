// SPDX-License-Identifier: AGPL-3.0-only
// Refusal taxonomy v1 — canonical category ontology for Wall 1 (B redesign).
//
// design grounding: tool-call refusals (operational), NOT content-harm
// filtering (Beavertails is wrong domain — covers LLM-output harms like
// hate speech, irrelevant to autonomous-agent tool gating).
//
// Lineage:
//   POSIX permission model (read / write / execute)
//   seL4 capability bits (Klein SOSP 2009) — typed-capability gating
//   CaMeL (Debenedetti 2503.18813) — sources/readers taint + capability typing
//   XACML 3.0 — policy-rule categories + combining algorithm
//   Constitutional AI (Bai 2212.08073) — principle-as-rule pattern
//   Sparrow (Glaese 2209.14375) — per-rule classifier pattern (Tier 3)
//   design R17/R18 — hard walls > soft instructions; out-of-process enforcement
//
// Two enforcement tiers (orthogonal to predicate kind):
//   HARD wall — reject pre-LLM-dispatch. Cannot be soft-overridden in turn.
//                Structural, bypass-proof.
//   SOFT preference — escalate_to_operator by default. Can be operator-allowed
//                     in-band per goal.
//
// Each category specifies (a) what it protects, (b) typical predicate kinds,
// (c) default action, (d) default scope, (e) per-tool examples.

'use strict';

// HARD wall categories — foundational, never operator-overridable
// in a single turn without explicit unlock + audit.
const HARD_CATEGORIES = Object.freeze({

  DESTRUCTIVE_FILESYSTEM: {
    id:              'DESTRUCTIVE_FILESYSTEM',
    protects:        'irreversible loss of operator data',
    predicate_kinds: ['pattern', 'tool_class'],
    default_action:  'reject',
    default_scope:   'hard-invariant',
    rationale_cite:  'POSIX permissions + design R17 (hard walls)',
    seed_examples: [
      { regex: 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-rf|-fr)\\s+/', on: 'tool_args.command' },
      { regex: '(^|/)\\.ssh/|(^|/)\\.aws/(?!config$)',                                              on: 'tool_args.file_path' }
    ]
  },

  DESTRUCTIVE_VCS: {
    id:              'DESTRUCTIVE_VCS',
    protects:        'irreversible git history rewrite affecting collaborators',
    predicate_kinds: ['pattern'],
    default_action:  'escalate_to_operator',  // VCS destructive often INTENTIONAL — escalate not reject
    default_scope:   'hard-invariant',
    rationale_cite:  'Git workflow safety; operator-deliberate exception expected',
    seed_examples: [
      { regex: 'git\\s+push\\s+(--force\\b|-f\\b)',     on: 'tool_args.command' },
      { regex: 'git\\s+reset\\s+--hard\\s+origin/',    on: 'tool_args.command' },
      { regex: 'git\\s+filter-branch\\b',                on: 'tool_args.command' }
    ]
  },

  DESTRUCTIVE_DATA: {
    id:              'DESTRUCTIVE_DATA',
    protects:        'irreversible loss of structured data (DB, search index, store)',
    predicate_kinds: ['pattern', 'tool_class'],
    default_action:  'reject',
    default_scope:   'hard-invariant',
    rationale_cite:  'XACML data-tier policy + R17',
    seed_examples: [
      { regex: '\\b(DROP\\s+TABLE|TRUNCATE\\s+TABLE|DELETE\\s+FROM\\s+\\w+\\s*;?\\s*$)\\b', flags: 'i', on: 'tool_args.command' },
      { regex: '\\b(DROP\\s+DATABASE|DROP\\s+SCHEMA)\\b',                                  flags: 'i', on: 'tool_args.command' }
    ]
  },

  CODE_INJECTION_SINK: {
    id:              'CODE_INJECTION_SINK',
    protects:        'introducing code-injection vulnerabilities into operator artifacts',
    predicate_kinds: ['pattern'],
    default_action:  'reject_and_revise',  // Force model to revise — usually a fixable design choice
    default_scope:   'hard-invariant',
    rationale_cite:  'CaMeL taint-flow §4 + OWASP A03 injection',
    seed_examples: [
      { regex: '\\beval\\s*\\(', on: 'tool_args.content' },
      { regex: '\\bFunction\\s*\\(',  on: 'tool_args.content' },
      { regex: '\\bexec\\s*\\([\'"`]', on: 'tool_args.content' }
    ]
  },

  UNTRUSTED_REMOTE_EXEC: {
    id:              'UNTRUSTED_REMOTE_EXEC',
    protects:        'executing untrusted remote code',
    predicate_kinds: ['pattern', 'prov_chain'],
    default_action:  'reject',
    default_scope:   'hard-invariant',
    rationale_cite:  'CaMeL sources taint + R17',
    seed_examples: [
      { regex: '(curl|wget)[^|]*\\|\\s*(bash|sh|zsh|fish)\\b',          on: 'tool_args.command' },
      { regex: '(curl|wget)[^|]*\\|\\s*python[23]?\\b',                  on: 'tool_args.command' },
      { regex: 'bash\\s+<\\(\\s*curl',                                   on: 'tool_args.command' }
    ]
  },

  CREDENTIAL_EXPOSURE: {
    id:              'CREDENTIAL_EXPOSURE',
    protects:        'leaking secrets via writes or stdout',
    predicate_kinds: ['pattern', 'argument_type'],
    default_action:  'reject',
    default_scope:   'hard-invariant',
    rationale_cite:  'seL4 capability isolation + credential vault contract',
    seed_examples: [
      { regex: '(^|/)\\.env(\\.|$)',                                    on: 'tool_args.file_path' },
      { regex: 'AKIA[0-9A-Z]{16}',                                       on: 'tool_args.content' },  // AWS access key
      { regex: 'sk-[A-Za-z0-9]{32,}',                                    on: 'tool_args.content' },  // OpenAI-style secret
      { regex: 'github_pat_[A-Za-z0-9_]{20,}',                           on: 'tool_args.content' }   // GitHub PAT
    ]
  },

  PRIVILEGE_ESCALATION: {
    id:              'PRIVILEGE_ESCALATION',
    protects:        'gaining elevated OS privileges',
    predicate_kinds: ['pattern'],
    default_action:  'escalate_to_operator',
    default_scope:   'hard-invariant',
    rationale_cite:  'POSIX setuid lineage + Docker CAP_SYS_ADMIN',
    seed_examples: [
      { regex: '\\bsudo\\b',                              on: 'tool_args.command' },
      { regex: '\\bchmod\\s+[0-7]*[4567][0-7]{2}\\s+',  on: 'tool_args.command' },  // world-writable
      { regex: '\\b(setuid|setcap)\\b',                   on: 'tool_args.command' }
    ]
  }
});

// SOFT preference categories — escalate-by-default but operator can allow
// per-goal. These fire reject_and_revise / escalate_to_operator.
const SOFT_CATEGORIES = Object.freeze({

  NETWORK_EGRESS: {
    id:              'NETWORK_EGRESS',
    protects:        'unbounded outbound network calls (data exfil, expense)',
    predicate_kinds: ['pattern', 'tool_class'],
    default_action:  'escalate_to_operator',
    default_scope:   'per-goal-class',
    rationale_cite:  'Cloud IAM egress controls; CaMeL readers',
    seed_examples: [
      { regex: '\\b(curl|wget)\\s+https?://(?!localhost|127\\.0\\.0\\.1)', on: 'tool_args.command' }
    ]
  },

  MONETARY_ACTION: {
    id:              'MONETARY_ACTION',
    protects:        'unintended spend',
    predicate_kinds: ['tool_class', 'effect_class'],
    default_action:  'escalate_to_operator',
    default_scope:   'hard-invariant',  // Money always asks
    rationale_cite:  'design partner-with-employees + budget_warden complement',
    seed_examples: []  // populated later (deferred) (Stripe Issuing scaffolding)
  },

  RATE_LIMIT: {
    id:              'RATE_LIMIT',
    protects:        'runaway action loops (cost + safety)',
    predicate_kinds: ['rate_limit'],
    default_action:  'reject_and_revise',
    default_scope:   'per-time-window',
    rationale_cite:  'Cloud rate-limiting + Knight Capital lesson (design R18)',
    seed_examples: [
      { kind: 'rate_limit', tool: 'Bash',        max: 50, window_ms: 60000 },
      { kind: 'rate_limit', tool: 'web_fetch',   max: 20, window_ms: 60000 }
    ]
  },

  SYCOPHANCY: {
    id:              'SYCOPHANCY',
    protects:        'response quality drift (caves to user pressure without evidence)',
    predicate_kinds: ['semantic'],
    default_action:  'reject_and_revise',
    default_scope:   'hard-invariant',
    rationale_cite:  'Sparrow rule classifiers + Sharma et al. arXiv 2310.13548 (sycophancy)',
    seed_examples: []  // Tier 3 semantic judge — v2 plumbing
  },

  OPERATOR_PREFERENCE: {
    id:              'OPERATOR_PREFERENCE',
    protects:        'operator-stated soft constraints (style, methodology)',
    predicate_kinds: ['pattern', 'tool_class', 'semantic'],
    default_action:  'reject_and_revise',
    default_scope:   'per-goal-class',
    rationale_cite:  'soft preferences + Constitutional AI principle pattern',
    seed_examples: []  // operator authors via CLI
  }
});

// All categories — flat lookup
const CATEGORIES = Object.freeze(Object.assign({}, HARD_CATEGORIES, SOFT_CATEGORIES));

// Capability ontology — 5-tier + CaMeL extension. tool_class predicate
// (B-redesign v2 plumbing) maps tool names → capability bits, and refusals
// can target capability classes rather than individual tools.
const CAPABILITY_BITS = Object.freeze({
  READ:        1 << 0,    // file/db/api read
  WRITE:       1 << 1,    // file/db/api mutate
  EXECUTE:     1 << 2,    // process spawn / shell
  NETWORK:     1 << 3,    // outbound network
  MONETARY:    1 << 4,    // billing/spend
  IDENTITY:    1 << 5,    // credential / auth
  PROCESS:     1 << 6,    // process control / signal
  PRIVILEGED:  1 << 7     // requires elevated OS privilege
});

// Per-tool capability annotation. tool_class predicate kind uses this to
// gate by capability bit rather than tool name. Operator can extend
// at registration; substrate falls back to PRIVILEGED (most restrictive)
// for unknown tools (default-deny per design R17).
const TOOL_CAPABILITIES = Object.freeze({
  Read:                  CAPABILITY_BITS.READ,
  Grep:                  CAPABILITY_BITS.READ,
  Glob:                  CAPABILITY_BITS.READ,
  Write:                 CAPABILITY_BITS.WRITE,
  Edit:                  CAPABILITY_BITS.WRITE,
  Bash:                  CAPABILITY_BITS.EXECUTE | CAPABILITY_BITS.WRITE | CAPABILITY_BITS.PROCESS,
  web_fetch:             CAPABILITY_BITS.NETWORK,
  engram_search:         CAPABILITY_BITS.READ,
  engram_record:         CAPABILITY_BITS.WRITE,
  chameleon_query:       CAPABILITY_BITS.READ,
  chameleon_ingest:      CAPABILITY_BITS.WRITE,
  dialogue_recent:       CAPABILITY_BITS.READ,
  dialogue_search:       CAPABILITY_BITS.READ,
  credential_list:       CAPABILITY_BITS.IDENTITY,  // metadata only, no values
  operator_request:      CAPABILITY_BITS.WRITE,
  submit_goal:           CAPABILITY_BITS.WRITE,
  web_allowlist_list:    CAPABILITY_BITS.READ
});

// Composition + combining algorithm — XACML 3.0 deny-overrides (locked
// in B1 + retained here as canonical). Tie-break: hard category > soft,
// then priority field, then refusal id (stable).
//
// Combining rule already implemented in refusal-evaluator.js evaluate().
// This taxonomy file is metadata — refusal records reference category id
// via output.category; evaluator gates by predicate (kind-agnostic to
// category). The category is for AUDIT + OPERATOR-UI grouping, not for
// runtime priority.

function categoryDefaults(categoryId) {
  return CATEGORIES[categoryId] || null;
}

function listCategories() {
  return Object.keys(CATEGORIES);
}

function isHard(categoryId) {
  return categoryId in HARD_CATEGORIES;
}

function toolCapabilityBits(toolName) {
  if (toolName in TOOL_CAPABILITIES) return TOOL_CAPABILITIES[toolName];
  // Default-deny per design R17: unknown tools route to PRIVILEGED so
  // any capability-class predicate that gates on PRIVILEGED catches them.
  return CAPABILITY_BITS.PRIVILEGED;
}

module.exports = {
  HARD_CATEGORIES,
  SOFT_CATEGORIES,
  CATEGORIES,
  CAPABILITY_BITS,
  TOOL_CAPABILITIES,
  categoryDefaults,
  listCategories,
  isHard,
  toolCapabilityBits
};
