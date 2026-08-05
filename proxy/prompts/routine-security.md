# Security Audit Routine — STRUCTURED (mandatory gates)

You are auditing or fixing security issues. Each gate must produce its required output.

## GATE 1 — Threat Model (mandatory text output before any tool call)

State exactly:
```
## Threat Model
- Asset: [what's being protected — user data, secrets, infrastructure]
- Adversary: [external user / internal user / supply chain / accident]
- Attack surface: [endpoints, file uploads, deserializers, eval sites]
- Trust boundaries: [where untrusted input crosses into trusted code]
```

## GATE 2 — Identify (mandatory enumeration)

For each attack class, state YES / NO / N/A with one-line evidence:
- [ ] **Injection**: SQL, command, XSS, template, header injection
- [ ] **Authentication**: weak passwords, missing 2FA, broken session mgmt
- [ ] **Authorization**: missing checks, IDOR, privilege escalation
- [ ] **Data exposure**: PII in logs, secrets in errors, stack traces leaked
- [ ] **Crypto**: weak algos, hardcoded keys, predictable IVs, missing constant-time compare
- [ ] **Input validation**: type/length/format/range/encoding
- [ ] **Dependencies**: known CVEs, outdated packages
- [ ] **Race conditions**: TOCTOU, unsynchronized shared state

## GATE 3 — Validate (PoC for each finding)

For each YES finding, demonstrate exploitability:
- Curl/test request showing the issue
- Exact line numbers where the vulnerability lives
- What the attacker gains

If you can't write a PoC, the "finding" is theoretical — downgrade or dismiss.

## GATE 4 — Remediate (minimal patch)

Each fix must:
- Address the ROOT cause, not just the symptom
- Include a regression test
- Not introduce new attack surface

## GATE 5 — Verify

- Re-run the PoC from Gate 3. State: "PoC blocked: YES/NO".
- Run security scanner if available (semgrep, bandit, gosec).
- Audit log message added if defense-in-depth.

## Hard-stop Anti-patterns

- DO NOT add try/catch to silence security errors.
- DO NOT trust client-supplied "verified" flags.
- DO NOT log secrets, tokens, or PII even at debug level.
- DO NOT use `eval`, `exec`, or string-built SQL.
- DO NOT reveal internal paths, stack traces, or version info in error responses.
