# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (bootstrap) | yes |

## Reporting a vulnerability

Please do not open public issues for security reports.

- Preferred: GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Email: hello@troth.one

You will get an acknowledgment within 72 hours. Coordinated disclosure is appreciated; credit is given unless you ask otherwise.

## Design notes relevant to reports

- troth is local-first: the substrate (`~/.troth/state.db`) and config live on the machine it runs on. At-rest encryption of the substrate is on the roadmap and is documented as a current limit.
- The proxy binds `127.0.0.1` by default. Non-loopback requests require the auto-generated bearer token (`~/.troth/config.json`, file mode `0600`).
- Filesystem tool access is capability-scoped with realpath containment; the shell tool runs commands directly in interactive use (no container by default); Docker isolation applies to the autonomous step engine only; destructive commands are refused by a taxonomy unless acknowledged.
- High-irreversibility actions append to a signed audit chain (`troth audit verify` walks it end-to-end).

Reports that bypass any of the walls above are exactly what we want to hear about.
