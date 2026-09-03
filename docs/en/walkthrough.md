# Walkthrough: from Boot to Your First Report

> Every output in this walkthrough was captured from real runs on this machine (2026-09-03, dsh 0.1.2-alpha.5 + StriX-DH) and is directly reproducible.
> Two operating modes run through the whole text: **CLI** (headless one-shot tasks, good for scripting) and **WebUI** (human-in-the-loop, good for real engagements).
>
> ⚠️ The walkthrough uses benign targets (example.com) and local verification. Confirm authorization before touching any third-party target.

## Part 0 — Boot

```sh
cd packages/strix-tools && npm install && npm run build
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open > dsh-boot.log 2>&1 &
sleep 25 && head -2 dsh-boot.log
```

The first two boot-log lines are the health check:

```
[strix-dsh-tools] registered 15 tool modules (15 tools) + methodology + authorization sections + 75 skills; workspace: C:\Users\20327\.dsh\strix-workspace
dsh web: http://127.0.0.1:3080/?token=<random per boot>
```

Line 1 = plugin loaded; line 2 = the WebUI address with a one-time token (open it in a browser). Model keys are configured on the **Settings → Models** page (stored in the credential store, hot-applied).

Windows note: if 3080 is held by a leftover process, find the PID with `netstat -ano | findstr :3080` then `taskkill /F /PID <pid>`.

## Part 1 — Claim the workspace (strix_runs)

**CLI**:

```sh
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 --profile headless "Call strix_runs once and quote its full output."
```

**Real output**:

```
Engagement workspace: C:\Users\20327\.dsh\strix-workspace
findings: 1 registered (F-001.json)
coverage: empty
notes: 0
threat-model: not established
report: C:\Users\20327\.dsh\strix-workspace\report.md
recon: none
pybox runs: 0
saved responses: 0
```

**WebUI**: tell the agent "call strix_runs and summarize" in a fresh session.

Why this step matters: before joining any engagement (or resuming an interrupted one), look at the stock — findings/coverage/notes are shared across sessions.

## Part 2 — Threat model & authorization context (strix_threat_model + strix_authorization)

**Tell the agent**: "Before testing, save a threat model for this engagement: the target is our own local lab, the attacker profile is an external unauthenticated user, trust boundary is the HTTP endpoint, and critical assets are the workspace files. Also record the authorization: targets=[our lab URL], granted_by=me."

**Real output**:

```
Threat model saved (88 chars). Amendments cleared — this is now the baseline.
Authorization recorded: 1 target(s), granted by me. Re-injected into the system prompt from now on.
```

Once the attestation lands in `workspace/authorization.json`, the `strix:authorization` section (order 101, re-evaluated on every assembly) carries it into every turn's system prompt — later agents know the scope without digging through chat history; revoke with `action=clear` when the engagement ends or the scope changes.

When a later agent finds the model contradicting reality (a "trusted" boundary is actually reachable), it appends a correction with `action=amend` — timestamped into the document, inherited by every later agent.

## Part 3 — Recon (strix_recon)

**Tell the agent**: "Run strix_recon with domain=example.com, skip_httpx first if you want a quick map."

**Real output** (excerpt):

```
[subfinder] 24948 subdomain(s) → C:\Users\20327\.dsh\strix-workspace\recon\example.com\subs.txt
```

A full run (without skip_httpx) follows with httpx `-title -status-code -tech-detect` live probing into `recon/<domain>/live.txt`. Note: passive sources include masses of historical records — live probing is the watershed.

## Part 4 — HTTP validation (strix_http)

**Tell the agent**: "Send a baseline GET to https://example.com via strix_http and report the status."

**Real output** (excerpt):

```
HTTP 200 OK — 427ms — https://example.com/
content-type: text/html; charset=UTF-8
...
```

The `raw_request` parameter takes a complete raw request text (the Burp Repeater equivalent) — the workhorse of validation: every suspicious request found during recon should be replayed here for confirmation.

## Part 5 — Browser evidence (strix_browser)

**Tell the agent**: "Use strix_browser: navigate to https://example.com with session=lab, take a screenshot, then close the session."

**Real output**:

```
Navigated https://example.com — title: Example Domain
Screenshot saved: ...\screenshots\lab-1788387776891.png (view it with the read_image tool)
Session "lab" closed.
```

Sessions are isolated by name — concurrent agents each use their own session name so page state never interferes.

## Part 6 — Containerized exploitation (strix_shell / strix_pybox)

Requires Docker Desktop running.

**Both tools need operator approval per call** (the dsh approval gate, see Part 6.5):

- **WebUI**: an approval dialog pops up (Allow once / Reject) — execution only on Allow;
- **headless one-shot**: no answerer, always fail-closed denial (no blocking, no execution);
- on denial the tool returns `DENIED: ... (outcome: ...)`, and methodology discipline forbids the agent from **retrying the identical call**.

**shell** (compound command in a container):

```
[exit code: 0]
--- stdout ---
Linux acea1e82ea7f 6.18.33.2-microsoft-standard-WSL2 ... x86_64
Python 3.12.14
root
```

**pybox** (the correct payload-spraying posture — batched scripts, never manual iteration):

Tell the agent: "Write a strix_pybox script that requests https://example.com 5 times, records status codes, and prints a summary."

Scripts and parameters land in `workspace/pybox/<run>/`; the args.json mechanism removes complex quoting pain. A denied pybox call writes **no files**.

### Part 6.5 — Approval gate & evidence ledger

- Every decision + every run outcome is appended to `<workspace>/evidence/log.jsonl` (ts / tool / outcome / callId / command summary / exitCode / duration), independent of the session log, inspectable by the operator at any time.
- The session event log carries the dsh service's automatic `approval/asked` + `approval/decided` audit pair.
- Unattended runs (at your own responsibility): add `- id: strix-tools` + `config: { approvalGate: 'off' }` to the profile's `cordis.patch.yml` (note the id is the plugin entry id, not the package name `strix-dsh-tools`). See tools-reference "Approval gate (HITL) & evidence ledger".

## Part 7 — Scanners (strix_sast)

**Tell the agent**: "Run strix_sast engine=nuclei target=https://example.com severity=high,critical."

**Real output** (excerpt):

```
nuclei scan via container (projectdiscovery/nuclei) (rate limit 50/s):
[exit code: 0]
Remember: these are template matches, not validated findings.
```

The first run pulls the image (nuclei template library included); the rate limit defaults to 50/s — **scan output is leads only**, any match must return to strix_http/pybox for human-grade validation before it can become a finding.

## Part 8 — Ledger & registry (coverage / finding)

**Tell the agent**: "Record the baseline fetch in coverage, then register a finding only if you have real evidence."

**Real output**:

```
Recorded C-001: https://example.com — baseline reachability → clean.
```

When registering a finding (strict mode):

```
Registered F-001 [info] Toolchain verification entry — local-verification.
```

A create without an `evidence` field is **rejected outright**:

```
REJECTED: no evidence. A finding without a demonstrated PoC ... is at best an
open_proof_gap. Record it in strix_coverage with needs_follow_up instead...
```

The rejection is the feature: it hardens Strix's "unproven is not a finding" discipline into the tool layer.

## Part 9 — Report (strix_report)

**Tell the agent**: "Generate the engagement report titled 'Lab Baseline Assessment'."

**Real output**:

```
Report written to C:\Users\20327\.dsh\strix-workspace\report.md (1 findings, 0 coverage entries).
```

Report structure: Scope & Authorization → Executive Summary → Findings (each with evidence code block, counterevidence, remediation, white-box diff) → Coverage Ledger → Methodology.

## Recommended rhythm for a full engagement

```
strix_runs (claim) → strix_threat_model (baseline) → strix_recon (map)
→ per-surface loop: strix_http/browser/pybox validation → strix_coverage records (incl. clean)
→ solid proof → strix_finding registry → strix_report → human review → platform submission
```

Multi-agent mode (alpha.4+ two-way messaging): the lead agent dispatches focused work with `subagent` (one agent per task); children inherit the same tools and persona and coordinate through the shared workspace; the lead can course-correct mid-flight with `send_message`.
