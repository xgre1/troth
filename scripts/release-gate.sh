#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# release-gate.sh — the checks that must pass before anything reaches a user.
#
# Exists because a build was once produced with files in it that the open
# repository does not contain. Nothing automated noticed; a manual look did,
# and only because someone thought to take one. Every check below is a thing
# that was true and unverified. Judgment does not scale; a program does.
#
# Run modes:
#   ./scripts/release-gate.sh repo          before making the open repo public
#   ./scripts/release-gate.sh dmg <path>    before uploading a build
#   ./scripts/release-gate.sh all <path>    both
#
# Exit non-zero on ANY failure. No warnings-only mode on purpose: a gate that
# can be ignored is not a gate.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
note() { printf '        %s\n' "$1"; }

# The operator's own identifiers. Kept OUT of this file: the gate reads them
# from the dev environment, so the gate itself never becomes the leak.
#   TROTH_GATE_IDENTIFIERS="name,handle,city,otherproduct"
IDENTIFIERS="${TROTH_GATE_IDENTIFIERS:-$(cat "$HOME/.troth/gate-identifiers" 2>/dev/null || true)}"

# Closed-overlay modules. Any of these inside a shipped bundle is a release
# stopper, and any of them tracked in git is worse.
#
# The list is DERIVED, not written down. On a machine that carries the closed
# overlay, the definition is exact and needs nobody's memory: a file sitting in
# a source directory that git does not track IS the overlay. A hand-kept list
# had 18 entries while the disk had 47, and the 29 it forgot included the cost
# circuit breaker and the goal classifier, both named openly in shipped code.
#
# ~/.troth/gate-closed-probes is still read and merged, for names that are not
# on this disk today. If neither source produces anything the check FAILS,
# because a probe list that is empty cannot catch a thing.
derive_probes() {
  # ls-files, not status. `git status --ignored` collapses a wholly-ignored
  # directory into one entry with a trailing slash, and dropping those (they
  # are not files) silently exempted every file inside: five closed modules
  # under shared-core/tools/optional were invisible to this function on the
  # day it was written to stop exactly that kind of gap. ls-files enumerates
  # them. -o alone catches a closed file that has not been added to an ignore
  # rule yet, which is how one usually arrives.
  local d="${1:-$ROOT}"
  { git -C "$d" ls-files -o -i --exclude-standard 2>/dev/null
    git -C "$d" ls-files -o --exclude-standard 2>/dev/null; } \
    | grep -E '^(bin|shared-core|proxy|adapters|plugin|tools)/' \
    | grep -vE 'node_modules|\.log$' | sort -u
}

CLOSED_PROBES=()
if [ -r "$HOME/.troth/gate-closed-probes" ]; then
  while IFS= read -r _p; do
    case "$_p" in ''|\#*) continue ;; esac
    CLOSED_PROBES+=("$_p")
  done < "$HOME/.troth/gate-closed-probes"
fi
# On a machine that carries the overlay, check the stored list against what is
# actually on disk. A tree being gated is usually an export with no overlay in
# it, so the derivation is only meaningful where the files live; when it is
# meaningful and it disagrees, the stored list has gone stale and says so.
_derived=$(derive_probes)
if [ -n "$_derived" ]; then
  _new=$(printf '%s\n' "$_derived" | while IFS= read -r _d; do
    printf '%s\n' "${CLOSED_PROBES[@]:-}" | grep -qxF "$_d" || printf '%s\n' "$_d"
  done)
  if [ -n "$_new" ]; then
    while IFS= read -r _d; do [ -n "$_d" ] && CLOSED_PROBES+=("$_d"); done <<< "$_new"
    STALE_PROBES="$_new"
  fi
fi

check_repo() {
  echo "REPO GATE"

  # The declared-non-secrets ledger is a dependency of two checks below, and
  # both of them launder it through `grep -vxF -f`. If the file is missing that
  # grep errors, prints nothing, and the empty result reads as "no findings" —
  # the checks go green precisely when their allowlist has been deleted. Assert
  # it here so the failure is loud and first, not silent and last.
  if [ ! -r "$ROOT/scripts/fixture-secrets.txt" ]; then
    fail "scripts/fixture-secrets.txt missing: the credential and live-id checks cannot run"
    note 'without it grep -f fails open and both checks report PASS on a dirty tree'
    return
  fi

  # 1. No closed module may be tracked.
  if [ ${#CLOSED_PROBES[@]} -eq 0 ]; then
    fail "closed-probe list not configured: the closed-module check did not run"
    note 'write one path per line to ~/.troth/gate-closed-probes'
  fi
  if [ -n "${STALE_PROBES:-}" ]; then
    fail "closed modules on this disk are missing from the probe list:"
    note "$(printf '%s' "$STALE_PROBES" | head -5 | tr '\n' ' ')"
    note 'the stored list has gone stale; refresh ~/.troth/gate-closed-probes'
  fi
  local tracked_closed=""
  for p in "${CLOSED_PROBES[@]:-}"; do
    [ -z "$p" ] && continue
    git ls-files --error-unmatch "$p" >/dev/null 2>&1 && tracked_closed="$tracked_closed $p"
  done
  [ -z "$tracked_closed" ] && pass "no closed-overlay module is tracked" \
                           || { fail "closed modules tracked:$tracked_closed"; }

  # 2. No secrets. Shapes only; a real key matches, a fixture like sk-abc does not.
  #     Two things were wrong here for a long time. The character class was
  #     [A-Za-z0-9]{32,}, but real keys carry hyphens inside the body
  #     (sk-ant-api03-…, sk-proj-…), so the match stopped at the first hyphen
  #     and a planted live-shaped key walked straight past. And the first
  #     attempt at a fix filtered matches by fuzzy words (FAKE, EXAMPLE,
  #     abcdef…), which is a filter a real secret can accidentally satisfy.
  #
  #     So: one wide pattern, and an EXPLICIT allowlist of the fixture strings
  #     this repo deliberately ships. Anything credential-shaped that is not
  #     on that list fails, wherever it lives.
  #
  #     Spell escapes carefully: this pattern lives in SINGLE quotes, so a
  #     doubled backslash reaches the engine as an escaped BACKSLASH, not an
  #     escaped dot. The JWT arm was written that way and matched nothing, so
  #     a leaked Supabase service-role key would have passed. Same failure
  #     shape as the \b incident above, one character wide. Adding a new test fixture means
  #     adding it here on purpose, which is the point: the decision is made by
  #     a person, once, in the open, instead of by a regex that guesses.
  local secrets
  secrets=$(git grep -IhoE '(sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{15,}|ya29\.[A-Za-z0-9_-]{30,}|(AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sbp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(\.[A-Za-z0-9_-]+)?|sk_[A-Za-z0-9]{24,}|rk_live_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|ntn_[A-Za-z0-9]{20,}|(postgres|postgresql|mysql|mongodb\+srv|mongodb|redis|amqp)://[^:/@[:space:]]+:[^@[:space:]]+@)' -- . 2>/dev/null \
    | sort -u | grep -v '^#' | grep -vxF -f "$ROOT/scripts/fixture-secrets.txt" | head -5)
  [ -z "$secrets" ] && pass "no credential-shaped strings" || { fail "possible credentials:"; note "$secrets"; }

  # 3. No private key material, ever.
  local keys=""
  while IFS= read -r f; do
    # A real PEM body runs to hundreds of base64 characters. Anything shorter
    # is a fixture, and tests/suite-22 ships one on purpose to prove the
    # redactor masks it.
    # Inline source, not a here-document: bash 3.2 (the macOS default) spools
    # here-documents and here-strings through a temp file under /tmp, and a
    # confined shell may have no /tmp to spool into. The gate must run from
    # any shell the tree is checked out in.
    python3 -c '
import re, sys
d = open(sys.argv[1], errors="ignore").read()
for m in re.findall(r"BEGIN [A-Z ]*PRIVATE KEY-----(.*?)-----END", d, re.S):
    if len(re.sub(r"[^A-Za-z0-9+/=]", "", m)) > 200:
        sys.exit(1)
sys.exit(0)
' "$f" || keys="$keys $f"
  done < <(git grep -lI 'BEGIN [A-Z ]*PRIVATE KEY' -- . 2>/dev/null)
  [ -z "$keys" ] && pass "no real private keys (short fixtures allowed)" \
                 || fail "private key material in:$keys"

  # 4. No build-machine paths.
  local homes
  # This file is NOT excluded from its own scans. An earlier version excused
  # itself, and promptly carried the operator's first name into the public
  # repo where nothing was looking for it. The comments here are written to
  # avoid the literals instead.
  homes=$(git grep -IhoE '/Users/[A-Za-z0-9_.-]+' -- . 2>/dev/null | sort -u \
          | grep -vE '/Users/(\.\.\.|you|op|operator|alex|user|username|me)$' | head -5)
  [ -z "$homes" ] && pass "no real home paths" || { fail "home paths leak the build machine:"; note "$homes"; }

  # 5. Operator identifiers, read from the environment.
  if [ -n "$IDENTIFIERS" ]; then
    local hits=""
    IFS=',' read -ra WORDS < <(printf '%s' "$IDENTIFIERS")
    for w in "${WORDS[@]}"; do
      w="$(echo "$w" | xargs)"; [ -z "$w" ] && continue
      # Word-bounded on purpose: an unbounded match fires on every word that
      # merely contains the identifier, and that noise trains you to ignore
      # the gate.
      git grep -qiIE "(^|[^A-Za-z0-9_])${w}([^A-Za-z0-9_]|$)" -- . 2>/dev/null && hits="$hits $w"
    done
    [ -z "$hits" ] && pass "no operator identifiers" || fail "operator identifiers present:$hits"
  else
    fail "TROTH_GATE_IDENTIFIERS unset: the identifier check did not run"
    note 'export TROTH_GATE_IDENTIFIERS="firstname,handle,city,otherproduct"'
  fi

  # 5b′. Personal mail domains are identifiers too, whoever they belong to:
  #      a fixture address lives on invented domains, never on a real inbox.
  local pmail
  pmail=$(git grep -lIiE '@(gmail|yahoo|hotmail|outlook|icloud)\.' -- . 2>/dev/null | head -3)
  [ -z "$pmail" ] && pass "no personal mail domains in the tree" \
    || { fail "personal mail domains in:"; note "$pmail"; }

  # 5c. Working-language text stays out of the tree. A handful of files carry
  #     Greek phrases ON PURPOSE — language pins and detection vocabularies,
  #     features for an operator who works in Greek — but a comment quoting
  #     what an operator actually said is a piece of somebody's private
  #     conversation in a public repository. Review caught two such quotes
  #     before they ever shipped; this keeps the count at zero. A file that
  #     legitimately needs working-language text joins the list below in the
  #     same commit that adds the text, as a conscious act.
  local greek_ok=" plugin/hooks/voice-shape.mjs plugin/hooks/session-start.mjs shared-core/decision-patterns.js scripts/backfill-mind-from-transcripts.js bin/troth-entity.js shared-core/engram.js shared-core/intent-decisions.js shared-core/intent-extract.js shared-core/intent-router.js shared-core/lang/base.js shared-core/lang/el.js shared-core/lang/index.js shared-core/memory-shaped.js shared-core/constraint-ledger.js plugin/hooks/constraint-capture.mjs tests/entity-identity.test.js tests/suite-06-voice-triage.js tests/suite-07-intent-routed-mounting-policy.js tests/suite-60-recallforce.js tests/suite-63-memory-dispatch.js tests/suite-66-constraint-ledger.js "
  local greek_hits="" gf
  for gf in $(git grep -lIP '[\x{03B1}-\x{03C9}\x{03AC}-\x{03CE}]' -- '*.js' '*.mjs' '*.py' '*.sh' '*.md' '*.html' 2>/dev/null); do
    case "$greek_ok" in *" $gf "*) ;; *) greek_hits="$greek_hits $gf";; esac
  done
  [ -z "$greek_hits" ] && pass "no conversation-language text outside the multilingual feature files" \
                       || fail "working-language text in:$greek_hits"

  # 5d. The maker's process never ships inside the artifact. An assistant that
  #     helped build a deliverable can leak its own working voice into it — a
  #     newsletter once went to a real client carrying the agent's design
  #     notes (palette, layout rationale) inside the body. The equivalents
  #     here are unambiguous machine artifacts: raw thinking tags, assistant
  #     self-narration, references to other agents or injected reminders.
  #     Files whose JOB is to strip those artifacts from transcripts must name
  #     them to remove them — they are declared below, the same conscious act
  #     as the working-language list. Everything else fails on any hit.
  local voice_ok=" bin/troth-import-chats.js plugin/hooks/constraint-capture.mjs proxy/modules/router.js proxy/server.js scripts/backfill-mind-from-transcripts.js tools/backfill-claude-sessions.js tests/suite-02-ratelimit-behavior.js "
  local voice_hits="" vf
  for vf in $(git grep -lIiE '<thinking|as an ai language model|the previous agent|system-reminder|antml' -- ':!scripts/release-gate.sh' 2>/dev/null); do
    case "$voice_ok" in *" $vf "*) ;; *) voice_hits="$voice_hits $vf";; esac
  done
  [ -z "$voice_hits" ] && pass "no assistant process-voice artifacts outside the transcript strippers" \
                       || fail "process-voice artifacts in:$voice_hits"

  # 6. No database or environment files.
  local data
  data=$(git ls-files | grep -iE '\.(db|sqlite3?|db-wal|db-shm)$|(^|/)\.env' | head -3)
  [ -z "$data" ] && pass "no databases or env files tracked" || fail "data files tracked: $data"

  # 6b. Files named with the ".local." convention are personal by definition
  #     (the recall eval documents that contract). Tracking one is a leak even
  #     when no identifier word-list catches what is inside it: the probe file
  #     that forced this check passed every sweep because its vocabulary WAS
  #     the thing leaking, and no list contains words it does not know yet.
  local locals
  locals=$(git ls-files | grep -iE '\.local\.' | head -3)
  [ -z "$locals" ] && pass "no .local. files tracked" || fail ".local. files tracked: $locals"

  # 6c. Identifiers copied out of a live database.
  #     A real engram id once reached a user-facing error string, and nothing
  #     could have caught it: it carries no vendor prefix, so every credential
  #     pattern is blind to it, and it is not a name, so the identifier list is
  #     blind too. What separates it from a fixture is not vocabulary, it is
  #     entropy. The fixtures here announce themselves with a zeroed group, a
  #     repeated-character tail, or a counter; a row from a real table has
  #     randomness in every group. Declared exceptions live in the same file
  #     as the fixture secrets.
  local liveids
  liveids=$(git grep -IhoE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32,}' -- . ':!proxy/ui/vendor' ':!*.min.js' 2>/dev/null \
    | python3 -c '
import re, sys
# Both renderings: dashed, and the bare 32-hex SQLite prints for a BLOB id.
# Extraction is greedy ({32,}) so a 40-char sha1 or a 64-char sha256 arrives
# whole and fails this exact-length match. Matching {32} instead would have
# clipped the first 32 characters off every commit hash in the tree and called
# each one an identifier.
U = re.compile(r"^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$")
out = set()
for line in sys.stdin:
    m = U.match(line.strip().lower())
    if not m: continue
    g1, g2, g3, g4, g5 = m.groups()
    # A UUID declares itself with a version nibble and a variant nibble; an md5
    # or sha fragment of the same width does not, and that is what separates an
    # identifier from a checksum without needing a file allowlist.
    #
    # The variant set covers RFC 4122 (8/9/a/b) and the older Microsoft layout
    # (c/d). Dropping the filter entirely was tried, to also admit the 1980s NCS
    # layout, and reverted: on this tree it changed nothing, but a probe showed
    # it lets a plain md5 through, so the recurring cost is real noise while the
    # gap it closes is an id shape nothing here can produce.
    if g3[0] not in "12345678": continue
    if g4[0] not in "89abcd": continue
    # Judge the TAIL only. A zeroed second group looks synthetic but is not:
    # in v7 it holds the low 16 bits of the millisecond clock and in v4 it is
    # uniform random, so one real id in 65536 lands on 0000 and would have
    # been waved through. The 48 random bits at the end are the honest signal.
    if len(set(g5)) == 1: continue                 # repeated tail
    if g5.startswith("00000000"): continue         # counter tail
    if len(set(g1 + g2 + g3 + g4 + g5)) <= 2: continue
    out.add(m.group(0))
print("\n".join(sorted(out)))' \
    | grep -v '^$' | grep -vxF -f "$ROOT/scripts/fixture-secrets.txt" | head -5)
  [ -z "$liveids" ] && pass "no live-database identifiers" \
    || { fail "identifiers that look copied from a real database:"; note "$liveids"; }

  # 7a. A tree of TRACKED FILES ONLY, which is what a stranger clones. The
  #     machine that runs this gate also has the closed overlay on disk, and
  #     measuring here instead of there is exactly how README came to claim 25
  #     smoke checks and 6 standards when a clone produces 11 and 5. Every
  #     count below that a reader will see is taken in this tree.
  local PUBROOT PUBTREE
  # mktemp's no-template form resolves to the system temp dir, which walled
  # ground refuses; the explicit template keeps gate scratch in the session's
  # own temp, where the gate runs no matter whose hand invokes it.
  PUBROOT=$(mktemp -d "${TMPDIR:-/tmp}/gate.XXXXXXXX")
  PUBTREE="$PUBROOT/public"
  mkdir -p "$PUBTREE"
  git archive HEAD | tar -x -C "$PUBTREE" 2>/dev/null
  ln -sfn "$ROOT/node_modules" "$PUBTREE/node_modules"

  # 7. Every number README puts in front of a reader must match what the
  #    commands actually print. README says this gate enforces that, so it has
  #    to, or that sentence is itself one of the claims it is meant to catch.
  local suite_out passed skipped claimed_pass claimed_skip
  suite_out=$( (cd "$PUBTREE" && node tests/test-all.js 2>/dev/null | grep -E '^=== Results' | head -1) )
  passed=$(echo "$suite_out"  | grep -oE '[0-9]+ passed'  | tr -d ' passed')
  skipped=$(echo "$suite_out" | grep -oE '[0-9]+ skipped' | tr -d ' skipped')
  # Loosely anchored on purpose: these were tied to an exact phrasing, so a
  # reworded sentence failed the gate for saying the same true thing. Anchor on
  # the words that carry the meaning, not the ones around them.
  claimed_pass=$(grep -oE '[0-9][0-9,]* checks in one' README.md 2>/dev/null | head -1 | grep -oE '[0-9,]+' | tr -d ',')
  claimed_skip=$(grep -oE 'further [0-9][0-9,]*' README.md 2>/dev/null | head -1 | grep -oE '[0-9,]+' | tr -d ',')
  [ -n "$passed" ] && [ "$passed" = "$claimed_pass" ] \
    && pass "README check count matches the suite ($passed)" \
    || fail "README claims '$claimed_pass' checks, the suite prints '$passed'"
  [ -n "$skipped" ] && [ "$skipped" = "$claimed_skip" ] \
    && pass "README skipped count matches the suite ($skipped)" \
    || fail "README claims '$claimed_skip' skipped, the suite prints '$skipped'"

  # The suite must also be honest that nothing failed.
  # Anchored: an unanchored '0 failed' also matches '10 failed'.
  echo "$suite_out" | grep -qE '(^|[^0-9])0 failed' \
    && pass "no failing checks in the suite" \
    || fail "the suite reports failures: $suite_out"

  # 7b. Smoke count.
  local smoke_out smoke_pass claimed_smoke
  smoke_out=$( (cd "$PUBTREE" && npm run --silent smoke 2>/dev/null | tail -1) )
  smoke_pass=$(echo "$smoke_out" | grep -oE '[0-9]+ passed' | tr -d ' passed')
  claimed_smoke=$(grep -oE '[0-9]+ integration smoke checks' README.md 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ -n "$smoke_pass" ] && [ "$smoke_pass" = "$claimed_smoke" ] \
    && pass "README smoke count matches ($smoke_pass)" \
    || fail "README claims '$claimed_smoke' smoke checks, the run prints '$smoke_out'"
  echo "$smoke_out" | grep -qE '(^|[^0-9])0 failed' \
    && pass "no failing smoke checks" \
    || fail "smoke reports failures: $smoke_out"

  # 7bb. Standalone checks — the files that own their own setup. They were
  #      unreachable by any runner until one existed, and most of them FAILED
  #      when typed by hand because nothing preloaded the hermetic database
  #      their headers assume.
  local sa_out sa_pass claimed_sa
  sa_out=$( (cd "$PUBTREE" && npm run --silent test:standalone 2>/dev/null | tail -1) )
  # One of these needs a running Docker daemon and skips without it, so the
  # PASSED count is a property of the machine, not of the tree: 30 with the
  # daemon down, 31 with it up, and the gate failed on the second for a
  # perfectly healthy checkout. Compare the total the tree defines instead.
  local sa_skip sa_total
  sa_pass=$(echo "$sa_out" | grep -oE '[0-9]+ passed' | tr -d ' passed')
  sa_skip=$(echo "$sa_out" | grep -oE '[0-9]+ skipped' | tr -d ' skipped')
  sa_total=$(( ${sa_pass:-0} + ${sa_skip:-0} ))
  claimed_sa=$(grep -oE '[0-9]+ standalone checks' README.md 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ -n "$sa_pass" ] && [ "$sa_total" = "$claimed_sa" ] \
    && pass "README standalone count matches ($sa_total)" \
    || fail "README claims '$claimed_sa' standalone checks, the tree defines $sa_total ('$sa_out')"
  echo "$sa_out" | grep -qE '(^|[^0-9])0 failed' \
    && pass "no failing standalone checks" \
    || fail "standalone reports failures: $sa_out"

  # 7c. Standards count.
  local std_n claimed_std
  std_n=$( (cd "$PUBTREE" && npm run --silent test:standards 2>/dev/null | grep -c 'PASS   S') )
  claimed_std=$(grep -oE '[0-9]+ enforced standards' README.md 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ -n "$claimed_std" ] && [ "$std_n" = "$claimed_std" ] \
    && pass "README standards count matches ($std_n)" \
    || fail "README claims '$claimed_std' standards, the runner passes '$std_n'"

  # 7d. MCP server directories vs what the plugin wires by default.
  local mcp_dirs mcp_wired claimed_dirs claimed_wired
  # Tracked, not on-disk: an untracked local server directory is not something
  # a reader of the repo would ever count.
  mcp_dirs=$(git ls-files 'plugin/mcp-servers/*' | cut -d/ -f3 | sort -u | wc -l | tr -d ' ')
  mcp_wired=$(node -e 'console.log(Object.keys(require("./plugin/.mcp.json").mcpServers).length)' 2>/dev/null)
  claimed_dirs=$(grep -oE '[0-9]+ MCP servers \([0-9]+ wired' README.md 2>/dev/null | head -1 | grep -oE '^[0-9]+')
  claimed_wired=$(grep -oE '\([0-9]+ wired by default' README.md 2>/dev/null | head -1 | grep -oE '[0-9]+')
  { [ "$mcp_dirs" = "$claimed_dirs" ] && [ "$mcp_wired" = "$claimed_wired" ]; } \
    && pass "README MCP counts match ($mcp_dirs in tree, $mcp_wired wired)" \
    || fail "README says $claimed_dirs/$claimed_wired MCP servers; the tree has $mcp_dirs, wired $mcp_wired"

  # 8. Every relative markdown link must resolve.
  local broken=""
  while IFS= read -r m; do
    local d; d="$(dirname "$m")"
    while IFS= read -r l; do
      case "$l" in http*|'#'*|mailto:*) continue ;; esac
      local t="$d/${l%%#*}"
      t="$(python3 -c "import os,sys;print(os.path.normpath(sys.argv[1]))" "$t" 2>/dev/null)"
      [ -e "$t" ] || broken="$broken $m -> $l"
    done < <(grep -oE '\]\(([^)]+)\)' "$m" 2>/dev/null | sed 's/](\(.*\))/\1/')
  done < <(git ls-files '*.md')
  [ -z "$broken" ] && pass "every relative doc link resolves" || { fail "broken links:"; note "$broken"; }

  # The public tree has served its purpose.
  [ -n "$PUBROOT" ] && [ -d "$PUBROOT" ] && command rm -rf -- "$PUBROOT"

  # 10. The npm publish path must refuse a dirty tree.
  #
  #     `npm pack` reads the WORKING TREE, not git, so on a machine that also
  #     holds the closed overlay it packs those files into a public tarball.
  #     The bundle path was given a `git archive` staging step; the npm path
  #     never was, which leaves the same door open one room over.
  #
  #     The guard lives on npm's own prepack hook so it cannot be forgotten.
  #     This checks that it is wired AND that it actually refuses here, where
  #     the overlay is present. On a clean clone it passes and publishing works.
  local prepack_wired
  prepack_wired=$(node -e 'try{process.stdout.write(String((require("./package.json").scripts||{}).prepack||""))}catch(e){}' 2>/dev/null)
  case "$prepack_wired" in
    *prepack-guard*) pass "npm prepack guard is wired" ;;
    *) fail "package.json has no prepack guard: npm publish would pack the working tree" ;;
  esac
  # The guard must be asking npm what it packs, not git what is untracked. The
  # first version asked git and called this tree clean, because the overlay is
  # listed in .git/info/exclude, which git honours and npm ignores. So this
  # check confirms the guard's verdict against npm's own file list.
  local pack_extra
  pack_extra=$(TROTH_ALLOW_DIRTY_PACK=1 npm pack --dry-run --ignore-scripts 2>&1 \
    | sed -E 's/^npm notice[[:space:]]+//; s/^[0-9.]+[[:space:]]?[kMG]?B[[:space:]]+//' \
    | grep -E '^(bin|shared-core|proxy|adapters|scripts|plugin|tests|benchmarks|docs)/' \
    | while IFS= read -r f; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 || echo "$f"; done \
    | wc -l | tr -d ' ')
  if node scripts/prepack-guard.js >/dev/null 2>&1; then
    [ "$pack_extra" -eq 0 ] \
      && pass "npm prepack guard allows this tree, and npm would pack only tracked files" \
      || fail "prepack guard PASSED while npm would pack $pack_extra untracked file(s) — the guard is not looking where npm looks"
  else
    [ "$pack_extra" -gt 0 ] \
      && pass "npm prepack guard refuses this tree ($pack_extra untracked file(s) would otherwise be published)" \
      || fail "prepack guard refuses a tree npm would pack cleanly"
  fi

  # 9. The suite and the standards must be green.
  #
  #    The export run above already drove the FULL suite over the tracked
  #    tree. When the working tree is exactly HEAD, running it again here
  #    re-tests the same code — and a gate invocation is two of the heaviest
  #    things this machine does back to back, which is how five gate runs in
  #    an afternoon became ten all-core suite passes and a hot lap. The
  #    working-tree run earns its cost only when the tree differs from what
  #    the export saw.
  if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
    echo "$suite_out" | grep -qE '(^|[^0-9])0 failed' \
      && pass "test suite green (export run covers the identical clean tree)" \
      || fail "test suite is not green"
  else
    node tests/test-all.js >/dev/null 2>&1 && pass "test suite green" || fail "test suite is not green"
  fi
  npm run --silent test:standards >/dev/null 2>&1 && pass "standards green" || fail "standards are not green"

  # 10. Every version a user can see says the same thing. Three manifests
  #     drifted apart on a release commit and the CLI printed one of the
  #     stale ones back at people.
  local vpkg vlock vplug
  vpkg=$(node -p "require('./package.json').version" 2>/dev/null)
  vlock=$(node -p "require('./package-lock.json').version" 2>/dev/null)
  vplug=$(node -p "require('./plugin/.claude-plugin/plugin.json').version" 2>/dev/null)
  if [ -n "$vpkg" ] && [ "$vpkg" = "$vlock" ] && [ "$vpkg" = "$vplug" ]; then
    pass "every manifest reports the same version ($vpkg)"
  else
    fail "version drift: package.json=$vpkg lock=$vlock plugin=$vplug"
  fi

  # 10b. The honesty page is re-read every release, or it stops being honest.
  #      Its "Audited against" line must name the version the manifests
  #      report; a page describing an older tree's limits undersells the
  #      current one exactly where a careful reader looks first.
  local audited
  audited=$(grep -oE 'Audited against: [0-9]+\.[0-9]+\.[0-9]+' docs/HONEST-LIMITS.md 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
  if [ -n "$audited" ] && [ "$audited" = "$vpkg" ]; then
    pass "HONEST-LIMITS audited against the shipping version ($audited)"
  else
    fail "HONEST-LIMITS says audited against '${audited:-nothing}', manifests say '$vpkg': re-read the page, then move the line"
  fi

  # 11. Internal planning vocabulary. The identifier list is operator-supplied
  #     because it is personal; this list is not, because it is the same
  #     everywhere: roadmap milestones and phase codes that mean nothing to a
  #     reader and tell a competitor how the work was sequenced. Three
  #     separate sweeps missed some of these by getting the case wrong.
  local jargon
  # -P, not -E: BSD grep's ERE silently treats \b as a literal 'b', so the
  # first version of this check matched nothing and passed on every machine
  # that mattered. Anything relying on a word boundary must use PCRE here.
  # The vocabulary itself is NOT here. This check has to hold every internal
  # word that must not appear, and such a list, published, hands a reader the
  # roadmap, the milestone codes, the design-document names and the workstream
  # names in a single line: it leaks strictly more than it hunts. The file is
  # not excluded from its own search either, since a check exempted from itself
  # is a check that cannot see its own mistake.
  # Same reasoning as the identifiers and the closed-module paths above.
  #   ~/.troth/gate-jargon   (one PCRE alternative per line, # starts a comment)
  local _jre=""
  if [ -r "$HOME/.troth/gate-jargon" ]; then
    _jre=$(grep -v '^#' "$HOME/.troth/gate-jargon" | grep -v '^$' | paste -sd '|' -)
  fi
  if [ -z "$_jre" ]; then
    fail "no jargon list at ~/.troth/gate-jargon: the vocabulary check did not run"
    jargon=""
  else
    jargon=$(git grep -lniP "$_jre" -- . ':!CHANGELOG.md' ':!LICENSE' ':!plugin/LICENSE' 2>/dev/null | head -3)
  fi
  [ -z "$jargon" ] && pass "no internal roadmap vocabulary in the tree" \
    || { fail "internal planning vocabulary is still here:"; note "$jargon"; }

  # 11b. An ignore rule that matches a TRACKED file. git keeps honouring the
  #      index, so nothing breaks here and nothing warns; but `git add -A` in
  #      a fresh clone of the same tree silently drops the file, which is how
  #      a published export lost one: a broad `*-probe.js` rule added
  #      hours earlier ate it. The export is built from this tree, so the tree is
  #      where it has to be caught.
  local ignored_tracked
  # --no-index is load-bearing: without it check-ignore honours the index and
  # reports nothing for a tracked file, so the check would have been green for
  # the exact case it exists to catch. Proven by planting the rule and watching
  # it stay silent.
  ignored_tracked=$(git ls-files | git check-ignore --no-index --stdin 2>/dev/null | head -3)
  [ -z "$ignored_tracked" ] && pass "no ignore rule matches a tracked file" \
    || { fail "these tracked files are matched by an ignore rule:"; note "$ignored_tracked"; }

  # 12. Code that reads a file the repository does not contain. The dashboard
  #     served its icon from a path present in no checkout, so every visitor
  #     got a 404 and nothing noticed for months. Resolved the way node
  #     resolves it, from each FILE's directory: doing it from the repo root
  #     reports half the tree missing, which is how a check that answers the
  #     wrong question passes for a real one.
  local missing_ref
  missing_ref=$(node -e '
    const fs = require("fs"), path = require("path"), cp = require("child_process");
    const files = cp.execSync("git ls-files \"*.js\" \"*.mjs\" \"*.cjs\"", {encoding:"utf8"}).split("\n").filter(Boolean);
    const rx = /path\.join\(\s*__dirname\s*((?:,\s*(?:"[^"]*"|\x27[^\x27]*\x27))+)\s*\)/g;
    const missing = new Set();
    for (const f of files) {
      let src = ""; try { src = fs.readFileSync(f, "utf8"); } catch (_) { continue; }
      let m;
      while ((m = rx.exec(src)) !== null) {
        const parts = (m[1].match(/(?:"[^"]*"|\x27[^\x27]*\x27)/g) || [])
          .map(s => s.slice(1, -1));
        if (!parts.length) continue;
        // Only literal, extension-bearing leaves: a directory or a computed
        // name is not something this check can honestly resolve.
        const leaf = parts[parts.length - 1];
        if (!/\.[a-z0-9]{2,5}$/i.test(leaf)) continue;
        const abs = path.resolve(path.dirname(path.resolve(f)), ...parts);
        if (!fs.existsSync(abs)) missing.add(f + " -> " + path.relative(process.cwd(), abs));
      }
    }
    process.stdout.write([...missing].slice(0, 5).join("\n"));
  ' 2>/dev/null)
  # The open/closed seam is deliberate and documented in LICENSING.md: the
  # engine names overlay modules and fails closed when they are absent. Those
  # are the ONE class of missing path that is correct, so they are excluded by
  # the same CLOSED_PROBES list the gate already uses. Without this the check
  # passes on a machine that HAS the overlay and fails on the clone a stranger
  # gets, which is backwards from what it is for.
  local probes_re
  probes_re=$(printf '%s\n' "${CLOSED_PROBES[@]}" | paste -sd'|' -)
  missing_ref=$(printf '%s\n' "$missing_ref" | grep -vE "(${probes_re})$" | grep -v '^$' | head -5)
  [ -z "$missing_ref" ] && pass "every literal path the code reads exists, or is a declared closed-tier seam" \
    || { fail "code reads files that are not in this repository:"; note "$missing_ref"; }
}

check_dmg() {
  local dmg="$1"
  echo
  echo "BUNDLE GATE: $(basename "$dmg")"
  [ -f "$dmg" ] || { fail "no such file: $dmg"; return; }

  local mnt; mnt="$(mktemp -d "${TMPDIR:-/tmp}/gate.XXXXXXXX")/m"
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null 2>&1 \
    || { fail "cannot mount the image"; return; }
  local app core; app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)"
  core="$app/Contents/Resources/core"

  # 1. Nothing in the bundle may be absent from the open repo. The bundle is
  #    staged with `git archive`, so this should hold by construction; it is
  #    checked anyway, because that staging step is one line away from being
  #    a working-tree copy again.
  local extra=0 first=""
  while IFS= read -r f; do
    git ls-files --error-unmatch "$f" >/dev/null 2>&1 || { extra=$((extra+1)); [ -z "$first" ] && first="$f"; }
  done < <(cd "$core" 2>/dev/null && find bin shared-core proxy adapters plugin scripts tools -type f 2>/dev/null | grep -v node_modules)

  # 1b. The check above walks named directories under core/, so anything the
  #     bundler places NEXT to core/ is invisible to it. The closed sandbox
  #     payload stages beside core/, so a build that forgot the open-build
  #     flag would ship it past an otherwise green gate.
  #     Naming the payload's files here would publish the closed manifest in
  #     the script written to protect it, the same way the module probe list
  #     once did. So assert the shape instead: Resources holds core/, icons and
  #     the app's own scripts, and nothing else. Anything new there is reported
  #     without this file having to know what it is called.
  local body_extra=""
  body_extra=$(find "$app/Contents/Resources" -maxdepth 1 -mindepth 1 \
    ! -name 'core' ! -name '*.icns' ! -name '*.png' ! -name 'scripts' \
    ! -name 'body' \
    ! -name 'Assets.car' ! -name '*.lproj' -exec basename {} \; 2>/dev/null | head -5 | tr '\n' ' ')
  [ -z "$body_extra" ] && pass "nothing beside core/ in Resources" \
    || { fail "unexpected payload beside core/:"; note "$body_extra"; }

  #     body/ is a slot, not a payload: Tauri needs the directory to exist,
  #     and an open build leaves it holding one empty .keep. Naming it above
  #     without checking it would trade a real assertion for a name, so the
  #     slot is asserted EMPTY here. This is the check that has to go red if
  #     a build ever forgets the flag and stages the sandbox body again,
  #     which is the incident this pair of checks exists for.
  local body_dir="$app/Contents/Resources/body"
  if [ -d "$body_dir" ]; then
    local body_payload=""
    body_payload=$(find "$body_dir" -mindepth 1 ! -name '.keep' -exec basename {} \; 2>/dev/null | head -5 | tr '\n' ' ')
    [ -z "$body_payload" ] && pass "the body slot is empty" \
      || { fail "the body slot carries a payload:"; note "$body_payload"; }
  else
    pass "the body slot is empty"
  fi

  #     And the same assertion one level in. The walk below covers named
  #     directories under core/, so a payload dropped into a directory nobody
  #     named would sit between the two checks untouched.
  local core_extra=""
  core_extra=$(find "$core" -maxdepth 1 -mindepth 1 -type d \
    ! -name 'bin' ! -name 'shared-core' ! -name 'proxy' ! -name 'adapters' \
    ! -name 'plugin' ! -name 'tools' ! -name 'node_modules' ! -name 'scripts' \
    ! -name '.claude-plugin' \
    -exec basename {} \; 2>/dev/null | head -5 | tr '\n' ' ')
  [ -z "$core_extra" ] && pass "no unnamed directory inside core/" \
    || { fail "unexpected directory inside core/:"; note "$core_extra"; }
  [ "$extra" -eq 0 ] && pass "every bundled source file is published in the open repo" \
                     || fail "$extra bundled files are NOT in the open repo (first: $first)"

  # 2. Named closed modules, belt and braces.
  local cl=""
  for p in "${CLOSED_PROBES[@]}"; do [ -e "$core/$p" ] && cl="$cl $p"; done
  [ -z "$cl" ] && pass "no closed module in the bundle" || fail "closed modules bundled:$cl"

  # 3. Shipped source must be build output, not source.
  local comments
  comments=$(grep -c '^\s*//' "$core"/shared-core/*.js 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
  [ "${comments:-0}" -eq 0 ] && pass "shipped source carries no comments (minified)" \
                             || fail "$comments comment lines survived: the bundle is raw source"

  # 4. No user data and no environment files, ever.
  #     .env was missing from this list until a planted one rode a test image
  #     all the way through a green bundle gate. The repo-side check has caught
  #     env files since day one; the bundle-side one only looked for databases.
  local data
  data=$(find "$app" \( -name '*.db' -o -name '*.sqlite*' -o -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.p12' -o -name '*.key' -o -iname '*transcript*' -o -iname '*meeting*' -o -iname '*recording*' \) 2>/dev/null | grep -v 'backfill-mind' | head -3)
  [ -z "$data" ] && pass "no databases, transcripts or recordings" || { fail "data in the bundle:"; note "$data"; }

  # 5. OUR build machine's paths in the native binary. Third-party prebuilt
  #    libraries carry their own CI paths (ONNX Runtime ships hundreds of
  #    hundreds of hits under their CI runner home); those identify the
  #    upstream builder,
  #    not this one, and cannot be remapped from here.
  local bin_leak
  bin_leak=$(strings "$app/Contents/MacOS/"* 2>/dev/null \
             | grep -oE '/Users/[A-Za-z0-9_.-]+' \
             | grep -vE '^/Users/(runner|distiller|builder|travis|jenkins|circleci|vsts)$' \
             | sort -u | head -3)
  [ -z "$bin_leak" ] && pass "no paths from this build machine in the binary" \
                     || { fail "build-machine paths in the binary:"; note "$bin_leak"; }

  # 6. Signed and notarised, or it does not go out.
  spctl -a -t open --context context:primary-signature "$dmg" >/dev/null 2>&1 \
    && pass "notarised and accepted by Gatekeeper" || fail "Gatekeeper rejects this image"

  # 7. It has to WORK, not merely be well-formed. Every check above this line
  #    is hygiene — right files, right signature, no leaked paths — and a
  #    build shipped past all of them with its engine menu offering two of the
  #    five engines the operator had paid for, because nothing here had ever
  #    started the thing and read what it said. The journey scenarios drive
  #    the bundle's own core through the surfaces a person uses. They run on
  #    the runtime the bundle ships, against a throwaway HOME.
  if [ -f tests/journey/run.js ]; then
    local jout jcode
    jout="$(node tests/journey/run.js --target "path:$core" 2>&1)"; jcode=$?
    if [ "$jcode" -eq 0 ]; then
      pass "journey scenarios pass against this bundle ($(printf '%s' "$jout" | grep -oE '[0-9]+ passed' | tail -1))"
    else
      fail "the bundle does not behave:"
      printf '%s\n' "$jout" | sed -n '/^failing:/,$p' | head -12 | while IFS= read -r l; do note "$l"; done
    fi
  else
    fail "tests/journey/run.js is missing — behaviour is unverified"
  fi

  hdiutil detach "$mnt" >/dev/null 2>&1
}

# ── open-repo parity ─────────────────────────────────────────────────────────
# The inverse hole to a bundle carrying files the open repo does not
# contain: a release can close with the OPPOSITE gap — DMG, CDN and site all shipped
# while the open repo still showed the previous version, because the publish
# step lived in nobody's file and one context window's memory. A release is
# not closed until the code the world reads IS the code that shipped, and
# that sentence is now a check, not a recollection.
check_open_parity() {
  echo "OPEN-REPO PARITY"
  local url="${TROTH_OPEN_REPO_URL:-https://github.com/xgre1/troth.git}"
  if ! git fetch -q "$url" main 2>/dev/null; then
    fail "cannot reach the open repo ($url) — a release cannot close unverified"
    return
  fi
  local ours theirs
  ours="$(git ls-tree -r HEAD | sort)"
  theirs="$(git ls-tree -r FETCH_HEAD | sort)"
  if [ "$ours" = "$theirs" ]; then
    pass "open repo main matches HEAD file-for-file ($(git rev-parse --short FETCH_HEAD))"
  else
    fail "open repo main does not match HEAD — the world reads different code than we shipped"
    note "$(diff <(printf '%s' "$ours") <(printf '%s' "$theirs") | grep -c '^[<>]') differing tree entries; publish the open repo, then re-run"
  fi
}

# ── outgoing history hygiene ─────────────────────────────────────────────────────────────
# A publish transfers whole COMMITS, not trees: author identities and every
# historical diff travel with the push and stay readable forever. Tree-level
# checks cannot see either class. This walks the exact range a publish
# would transfer — the commits the open repo does not have yet.
check_outgoing_history() {
  echo "OUTGOING HISTORY"
  local url="${TROTH_OPEN_REPO_URL:-https://github.com/xgre1/troth.git}"
  if ! git fetch -q "$url" main 2>/dev/null; then
    fail "cannot reach the open repo ($url) — outgoing range unknown"
    return
  fi
  local range="FETCH_HEAD..HEAD"
  local bad_authors
  bad_authors="$(git log --format='%ae' "$range" | grep -vE '^(greg@troth\.one|[0-9]+\+xgre1@users\.noreply\.github\.com)$' | sort -u)"
  if [ -z "$bad_authors" ]; then
    pass "every outgoing commit is authored as the project identity"
  else
    fail "outgoing commits carry non-project author emails — identity travels with the push"
    note "$bad_authors"
  fi
  local badsubj
  badsubj="$(git log --format='%s' "$range" | grep -vE '^v[0-9]+\.[0-9]+(\.[0-9]+)?(: .+)?$|^[a-z0-9 .+-]+: .+' | head -5)"
  if [ -z "$badsubj" ]; then
    pass "every outgoing subject follows the commit convention (scoped or version-first)"
  else
    fail "outgoing subjects break the commit convention"
    note "$badsubj"
  fi
  local idents hits
  # History scans exclude the retired brand token: it appears legitimately in
  # old diffs (the product was renamed) and removing it would rewrite
  # historical trees. Tree-level checks keep the full identifier list. The
  # token is spelled with a bracket so the tree-level scan never matches its
  # own exclusion.
  idents="$(tr ',' '|' < "$HOME/.troth/gate-identifiers" 2>/dev/null | sed -E 's/(^|\|)g[e]mclaw(\||$)/\1\2/; s/\|\|/|/g; s/^\|//; s/\|$//')"
  if [ -n "$idents" ]; then
    hits="$(git log -p "$range" 2>/dev/null | grep -icE "$idents" || true)"
    if [ "${hits:-0}" -eq 0 ]; then
      pass "outgoing history diffs carry none of the gate identifiers"
    else
      fail "gate identifiers found inside outgoing history diffs ($hits lines)"
      note 'inspect: git log -p FETCH_HEAD..HEAD | grep -inE "$(tr , "|" < ~/.troth/gate-identifiers)"'
    fi
  else
    note "no gate-identifiers file — identifier history scan skipped"
  fi
}

# ── ship reality ──────────────────────────────────────────────────────────────
# The release as STRANGERS receive it. Nothing here reads a local build
# product: the appcast is fetched live, the artifact is downloaded from the
# CDN and hashed, the public CI verdict is read off the open repo's HEAD.
# Every inside-facing check can be green while the
# outside is wrong twice over (open repo a version behind; package.json a
# version behind the site) — so the outside is read directly.
check_ship() {
  echo "SHIP REALITY"
  local appcast site_ver repo_ver dmg_url site_sha
  appcast="$(curl -sSf --max-time 30 https://troth.one/api/appcast 2>/dev/null || true)"
  if [ -z "$appcast" ]; then
    fail "the appcast does not answer — the release cannot be verified from outside"
    return
  fi
  site_ver=$(printf '%s' "$appcast" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).version))" 2>/dev/null)
  repo_ver=$(node -p "require('$ROOT/package.json').version" 2>/dev/null)
  if [ "$site_ver" = "$repo_ver" ]; then
    pass "the site serves the version this tree carries ($site_ver)"
  else
    fail "version drift: the site serves $site_ver, the tree says $repo_ver"
  fi
  dmg_url=$(printf '%s' "$appcast" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).dmg_url))" 2>/dev/null)
  site_sha=$(printf '%s' "$appcast" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sha256))" 2>/dev/null)
  local tmp got
  tmp="$(mktemp "${TMPDIR:-/tmp}/gate.XXXXXXXX")"
  if curl -sSfL --max-time 300 -o "$tmp" "$dmg_url" 2>/dev/null; then
    got=$(shasum -a 256 "$tmp" | awk '{print $1}')
    if [ "$got" = "$site_sha" ]; then
      pass "the CDN returns byte-for-byte the artifact the appcast promises"
    else
      fail "the CDN bytes do not match the published sha256"
    fi
  else
    fail "the download link does not deliver"
  fi
  rm -f "$tmp"
  if command -v gh >/dev/null 2>&1; then
    local open_sha ci
    open_sha=$(git ls-remote "${TROTH_OPEN_REPO_URL:-https://github.com/xgre1/troth.git}" main 2>/dev/null | awk '{print $1}')
    ci=$(gh run list -R xgre1/troth --limit 8 --json conclusion,headSha --jq "[.[] | select(.headSha==\"$open_sha\") | .conclusion] | unique | join(\",\")" 2>/dev/null || true)
    case "$ci" in
      success) pass "public CI is green on the open repo's HEAD" ;;
      "")      fail "no public CI runs found for the open repo's HEAD — the platforms have not spoken" ;;
      *)       fail "public CI on the open repo's HEAD: $ci" ;;
    esac
  else
    fail "gh is not available — public CI cannot be verified"
  fi
}

# ── bundle tree ───────────────────────────────────────────────────────────────────
# The image carries whatever the staged bundle carries, and creating or
# mounting an image is a device operation session walls refuse — so the
# bundle is judged as a TREE, before it is ever wrapped. Same stoppers as
# the image checks: a closed module, a database, an env file or an operator
# identifier inside the bundle ships to every customer.
check_bundle_tree() {
  echo "BUNDLE TREE"
  local app="$1"
  [ -d "$app" ] || { fail "no such bundle: $app"; return; }
  local core="$app/Contents/Resources/core"
  [ -d "$core" ] || { fail "no staged core inside the bundle"; return; }
  local present=0 total=0 p
  for p in "${CLOSED_PROBES[@]:-}"; do
    [ -n "$p" ] || continue
    total=$((total+1))
    [ -e "$core/$p" ] && { present=$((present+1)); note "present: $p"; }
  done
  if [ "$total" -eq 0 ]; then fail "no closed-overlay probes to judge the bundle against"
  elif [ "$present" -eq 0 ]; then pass "no closed-overlay module inside the bundle ($total probed)"
  else fail "closed-overlay modules inside the bundle: $present"; fi
  local junk; junk=$(find "$core" \( -name '.env*' -o -name '*.db' -o -name '*.local.*' \) 2>/dev/null | head -3)
  [ -z "$junk" ] && pass "no databases or env files inside the bundle" \
    || { fail "databases or env files inside the bundle:"; note "$junk"; }
  if [ -n "$IDENTIFIERS" ]; then
    local w hits=""
    IFS=',' read -ra BWORDS <<< "$IDENTIFIERS"
    for w in "${BWORDS[@]}"; do
      w="$(echo "$w" | xargs)"; [ -z "$w" ] && continue
      grep -rqiIE "(^|[^A-Za-z0-9_])${w}([^A-Za-z0-9_]|$)" "$core" 2>/dev/null && hits="$hits $w"
    done
    [ -z "$hits" ] && pass "no operator identifiers inside the bundle" || fail "operator identifiers inside the bundle:$hits"
  else
    fail "TROTH_GATE_IDENTIFIERS unset: the bundle identifier check did not run"
  fi
  # Third-party package metadata carries its maintainers' own inboxes;
  # only OUR files must carry none, so the mail sweep alone skips
  # node_modules while every other bundle check keeps them in scope.
  local pm; pm=$(grep -rlIiE --exclude-dir=node_modules '@(gmail|yahoo|hotmail|outlook|icloud)\.' "$core" 2>/dev/null | head -3)
  [ -z "$pm" ] && pass "no personal mail domains inside the bundle" \
    || { fail "personal mail domains inside the bundle:"; note "$pm"; }
}

MODE="${1:-all}"
case "$MODE" in
  repo) check_repo ;;
  dmg)  check_dmg "${2:?usage: release-gate.sh dmg <path-to-dmg>}" ;;
  bundle) check_bundle_tree "${2:?usage: release-gate.sh bundle <path-to-.app>}" ;;
  ship) check_ship ;;
  release) check_repo; check_open_parity; check_outgoing_history; check_ship; [ -n "${2:-}" ] && check_dmg "$2" ;;
  --refresh-probes)
        # The stored list is what gates an export, which carries no overlay to
        # derive from. This rewrites it from the disk that does.
        { printf '# Closed-overlay module paths. DERIVED, not remembered: on the machine that\n'
          printf '# carries the overlay, a file under a source directory that git does not\n'
          printf '# track IS the overlay. Refresh with: scripts/release-gate.sh --refresh-probes\n'
          printf '# A hand-kept version of this list had 18 entries while the disk had 47.\n'
          derive_probes
        } > "$HOME/.troth/gate-closed-probes"
        echo "wrote $(grep -vc '^#' "$HOME/.troth/gate-closed-probes") probe paths to ~/.troth/gate-closed-probes"
        exit 0 ;;
  all)  check_repo; [ -n "${2:-}" ] && check_dmg "$2" ;;
  *)    echo "usage: release-gate.sh [repo|dmg <path>|bundle <app>|all <path>|ship|release [dmg]]"; exit 2 ;;
esac

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mGATE PASSED\033[0m\n'
else
  printf '\033[31mGATE FAILED. Nothing ships until every line above is PASS.\033[0m\n'
fi
exit "$FAILED"
