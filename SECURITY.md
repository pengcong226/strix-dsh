# Security Policy

## The one rule

**Only run StriX-DH tools against systems you own, or systems you have explicit, written permission to test.** See `docs/safety.md` for the full authorized-use guide — it is normative for this project, not advisory.

## Scope of this policy

This policy covers the StriX-DH repository itself: the `strix-dsh-tools` plugin (`packages/strix-tools/`), the bundled skills and presets, the `adapt_skills.py` generator, and the CI workflow. Reports about third-party components (dsh runtime, Strix upstream, mitmproxy, nuclei, Playwright) should go to their own maintainers unless the issue is in how StriX-DH integrates them.

## Reporting a vulnerability

- **Do not open a public issue** for anything that could be exploited against other users of this suite (command injection via tool parameters, workspace path traversal, credential leakage, approval-gate bypass, container escape vectors in our Docker usage).
- Contact the maintainers privately (see the repository's contact addresses once published; during pre-release, use the private channel you received this code through). Include: affected version (`packages/strix-tools/package.json`), steps to reproduce, and the impact you see.
- We aim to acknowledge within 72 hours and to ship a fix before any public disclosure. If you plan a deadline (e.g. conference talk), tell us up front and we will coordinate.

## What we consider in scope

- Approval-gate bypass: any path that executes `strix_shell`/`strix_pybox` commands without an operator grant while `approvalGate` is `'always'`.
- Budget-gate bypass: heavy tools (`strix_recon`/`strix_sast`/`strix_proxy` start) executing despite a `block`-mode over-budget ledger.
- Workspace escape: tool parameters (file names, save paths, flow ids, workdirs) that read or write outside the engagement workspace.
- Evidence integrity: ledger/report/evidence-log writes that can be forged or silently dropped by a tool call.
- Container boundary: our `docker run` invocations mounting more of the host than the workspace, or running with privileges they do not need.
- Credential exposure: API keys or workspace secrets appearing in logs, reports, or model-visible output.

## What we consider out of scope

- Findings that require the operator to deliberately misconfigure the suite (`approvalGate: 'off'` plus a malicious prompt is operator action, not a vulnerability).
- Upstream vulnerabilities in dsh, Strix, mitmproxy, nuclei, or Playwright themselves — report those upstream, then tell us if our integration needs a pin bump.
- Social engineering of the operator (approving a malicious command at the approval dialog is a human decision; the gate's job is to ask, not to judge).

## Hardening notes for operators

- Keep `approvalGate` at `'always'` for any engagement beyond your own lab. `'off'` exists for unattended local ranges only.
- Set `budgetLimitUsd` + `budgetAction: 'block'` so a runaway agent cannot burn money unattended.
- The mitmproxy sidecar CA (`workspace/proxy/.mitmproxy/`) is engagement-local: do not install it in a daily-use browser profile; use a dedicated test profile and remove it afterwards.
- Review `evidence/log.jsonl` and `budget.json` after long autonomous runs — they are the audit trail.
