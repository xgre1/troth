# troth Standards — the invariants that keep the project on its own architecture

These invariants encode the substrate-as-subject thesis as **machine-checkable
tests** (`tests/standards/`). The deepest finding of the architecture review
was that the system does not fail by
missing features — it fails by **drift**: scope-creep layers and LLM-as-driver patterns
that quietly invert the thesis. Prose cannot stop that recurring. A red test can.

The build is **ratcheted**: every check declares `expect: 'pass' | 'debt'`.
- `expect:'pass'` and it fails → **BUILD RED** (a regression — the thesis was violated).
- `expect:'debt'` and it still fails → **tracked debt** (a known gap a milestone pays down; build stays green but the debt is printed).
- `expect:'debt'` and it now PASSES → **BUILD RED with "flip to enforced"** — someone paid the debt; change `expect` to `'pass'` so it can never regress.

Run: `node tests/standards/run.js`.

---

## S1 — Substrate-as-subject (the LLM is not the loop driver)
**Principle:** the substrate is the single subject. The faculty is a rented language
region invoked at a bounded set of sites; it never *is* the control loop.
**Check:** no `shared-core/*.js` module imports an LLM transport
(`shared-core/transports/*`, `transport-config.js`) directly, except the sanctioned
faculty seam (`shared-core/faculty.js`) and the transport plumbing itself. A census of
offenders is printed so the migration target is explicit.
**Grounds:** a module-by-module census, plus historical `procedure-matcher` drift.
**Status:** enforced by `tests/standards/s1_substrate_subject.js` on every run.

## S2 — Intents, not tools (the LLM holds no authority)
**Principle:** the LLM never holds a tool whose effect writes authoritative memory or
commits an action in the world. It produces language; the substrate parses that language
into intents and gates them through STVC.
**Check:** `substrate-tools.toolsArray()` contains none of the action/authority-committing
tools (`intent_emit`, `api_call`, `browser_session`, `email_search`, `email_open`).
**Grounds:** an internal review of the tool surface.
**Status:** the S2 check ships with the closed overlay; this checkout reports it as skipped. The principle still binds the code here.

## S3 — Authority is signature-rooted, never caller-trusted
**Principle:** an engram's authority comes from a verified operator signature, not from who
wrote it or whether it carries a label. Absent provenance → **neutral** weight (trusted
until labeled), never **weakest** (suppressed).
**Check:** authority weights are single-sourced through `authority-weights.js`, so a missing `source_authority` cannot fall to a suppressing default
(0.30×). It must use a fail-neutral sentinel (weight 1.00) pending backfill.
**Grounds:** an internal review; the suppressing default was measured against a
long-lived substrate, where it hid the majority of engrams. See `recall.js`.
**Status:** enforced by `tests/standards/s3_authority_signature.js` on every run.

## S4 — STVC walls are pre-LLM and structural
**Principle:** every safety claim is backed by a predicate that fires **before** the LLM
sees content, unforgeable in-process. A cosmetic audience label is not a wall.
**Check:** `state-machine.PREDICATE_KINDS` contains an `external_suspicious` promotion-refusal
predicate (the wall this standard was written to force into existence).
**Grounds:** an internal review: the label was cosmetic until a predicate backed it.
**Status:** enforced by `tests/standards/s4_stvc_pre_llm.js` on every run.

## S5 — Self-modification is PAC-bounded
**Principle:** no self-write may mutate the STVC predicate set or the validation gate —
the statistically-unrecoverable trap. The predicate registry is immutable at runtime to
faculty/self writes; only operator-signed invariants may register.
**Check:** `state-machine.PREDICATE_KINDS` is frozen (`Object.isFrozen`), so no code path
can hot-patch a predicate.
**Grounds:** the PAC bound on self-modification.
**Status:** enforced by `tests/standards/s5_pac_bounded.js` on every run.
