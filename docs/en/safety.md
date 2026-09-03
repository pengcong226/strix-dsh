# Safety & Authorized Use

## The one rule

**Only run StriX-DH tools against systems you own, or systems you have explicit, written permission to test.** Everything else follows from this.

StriX-DH is an offensive-security tool suite. The tools are real: `strix_http` sends real requests, `strix_shell` and `strix_pybox` execute real code, `strix_browser` drives a real browser, `strix_recon` enumerates real attack surfaces. You are responsible for every action the agent takes through them.

## Why the design keeps pushing authorization at you

- The `strix_methodology` system-prompt section (adapted from Strix) ends with an authorization reminder that the model sees on every request.
- `strix_finding` refuses findings without evidence — an unverified claim is not a finding.
- `strix_coverage` forces you to record what you tested and what you left open, so engagement scope is auditable after the fact.
- **Execution tools require human approval per call.** `strix_shell` and `strix_pybox` route every command/script through dsh's ApprovalService before anything runs; only an explicit operator grant executes, and every decision + run outcome lands in `<workspace>/evidence/log.jsonl` (fail-closed: `rejected`/`cancelled`/`unavailable` all deny). Autonomous mode is opt-in via the `approvalGate: 'off'` config — the operator owns that decision.
- Nothing in the suite "phones home": scan outputs, findings, and reports live only in your workspace directory.
- Test-account passwords in `authorization.json` are workspace-local secrets: never commit the workspace, never paste passwords into notes/findings/reports/chat — prompt injection and report summaries render them masked (`password: ***`).

## Platform authorization for bug-bounty work

If you hunt bugs on bug-bounty platforms (e.g. Butian public SRC, EDUSRC):

1. **Confirm the target is in scope for the program you are working under before the first request.** Out-of-scope testing is not "aggressive research", it is unauthorized access.
2. **Keep request volume humane.** Rate limits in `strix_sast` (nuclei `-rl`) default low on purpose. A dropped-connection WAF response is a signal to stop, not to escalate.
3. **Never exfiltrate data.** Demonstrating an IDOR with one record you do not save is evidence; downloading the table is a breach.
4. **Report through the platform.** `strix_report` produces your draft — the platform's submission is the deliverable, and platform rules (AI-assistance disclosure, evidence standards) apply to it.

## Things StriX-DH deliberately does not do

- No stealth/evasion features. No fingerprint spoofing beyond ordinary browser automation. If your engagement requires evasion, it is out of scope for this project.
- No persistence, no C2, no post-exploitation tooling. StriX-DH stops at validated findings and fixes — by design. (See the migration map in `docs/architecture.md`: Strix's C2/WebShell-adjacent surfaces were intentionally not ported.)
- No data leaves your machine: findings, workspace artifacts, and telemetry-off LLM calls stay local (the only network calls are your LLM provider and your targets).

## Incident handling

If a tool call causes unexpected impact on a target (crashed service, data modified):

1. Stop testing that target immediately.
2. Preserve evidence of what happened (workspace files are your record).
3. Disclose to the target owner / program operator promptly and accurately.

## Reporting vulnerabilities in StriX-DH itself

See [`SECURITY.md`](../../SECURITY.md) — report privately, do not open public issues for exploitable-for-attack findings in the tool suite.
