# StriX-DH Tools Reference

> Full contract of all 15 tools: parameters, outputs, real-run examples, error modes, and config interactions.
> Every sample output below comes from a real verification run of this project (2026-09-03, dsh 0.1.2-alpha.5).
>
> ⚠️ Each tool's `description` is itself a behavioral rule injected into the model — read `docs/prompt-design.md` before rewording any of them.

Shared conventions:

- **Workspace**: all artifacts land in the shared workspace (default `~/.dsh/strix-workspace/`, configurable via `workspaceDir`). The main agent and subagents share one directory — the physical basis of cross-agent collaboration.
- **Output truncation**: model-facing text is length-bounded; over-limit output is explicitly marked `[... truncated: showing N of M characters ...]`; full artifacts go to disk as documented per tool.
- **Authorization**: use every tool only against targets you own or have written permission to test.

---

## strix_runs — workspace overview

**Strix origin**: new (no upstream counterpart; serves the "survey prior work before joining an engagement" discipline).

| Parameter | Type | Required | Notes |
|---|---|---|---|
| (none) | | | |

**Output**: per-line listing of finding count plus one detail line per finding (`F-001 [critical] (rce) title — target`, so children see filed reports with no second call), coverage ledger rows, note count, threat-model presence, report path, reconned domains, pybox runs, saved responses, and budget ledger status (zero records prompts `strix_budget action=record` — an empty ledger means "unrecorded", not "unspent").

**Real output example**:

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

**When to use it**: the first action when joining an engagement; before resuming interrupted work; before deciding "which surfaces are still untested".

**Error modes**: none (read-only).

---

## strix_http — raw HTTP client

**Strix origin**: v1 replacement for the Caido proxy replay workflow (interception proxy arrived in Phase 2).

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `url` | string | either-or | Target URL (omissible with `raw_request` if the request line is absolute-form or carries a Host header) |
| `method` | string | no | HTTP method, default GET |
| `headers` | object | no | Key/value pairs (schema requires explicit `additionalProperties: true`) |
| `body` | string | no | Request body, sent as-is |
| `raw_request` | string | no | **Complete raw HTTP request text** (request line + headers + blank line + body). Overrides all structured fields above when given |
| `follow_redirects` | boolean | no | Default true; false returns 3xx as-is |
| `timeout_ms` | number | no | Defaults to config `httpTimeoutMs` (30s) |
| `save_to` | string | no | Full response body saved to `workspace/responses/<save_to>` (output stays truncated; must be a relative path inside responses — `..`/absolute paths refuse the write but not the request) |

**Output format**: status line (with duration and final URL, post-redirect) → all response headers → truncation marker (if triggered) → blank line → body.

**Real output example**:

```
HTTP 200 OK — 427ms — https://example.com/
content-type: text/html; charset=UTF-8
age: 245897
...

<!doctype html>
<html><head><title>Example Domain</title>...
```

**Error modes** (output doubles as remediation guidance, by design):

- Timeout → `"Request failed: timeout after Nms (aborted). The host may be filtered, down, or the port/scheme wrong — fix the target rather than retrying blindly."`
- Connection failure → ships DNS/port/protocol troubleshooting hints; **treating "unreachable" as a finding is a methodology error** (mirrors the Strix discipline on Caido error pages)

**Config interactions**: `httpTimeoutMs`, `httpMaxBodyChars`.

---

## strix_finding — evidence-bound vulnerability registry

**Strix origin**: `reporting` module's create/update_vulnerability_report + create_dependency_report.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `action` | string | ✅ | create / update / list / get / dedupe-check |
| `id` | string | update/get | e.g. `F-001` (dedupe-check takes id to exclude self from comparison) |
| `title` | string | create | Short descriptive title |
| `vulnerability_type` | string | create | `idor` `sqli` `ssrf` `xss` `xxe` `rce` `csrf` `race_condition` `business_logic` `auth_jwt` `dependency_cve` `other` |
| `severity` | string | create | `info` `low` `medium` `high` `critical` |
| `target` | string | create | Affected target (URL/host/code path) |
| `evidence` | string | **required in strict mode** | **Concrete proof**: full request/response pair, PoC output, or a complete reachable exploit trace. The qualifying field that "makes it a finding" |
| `cvss_vector` | string | no | CVSS v3.1 vector; **every non-None metric must map to demonstrated content in evidence** |
| `counterevidence` | string | no (strongly recommended) | Counter-case: the strongest argument against this finding and why it does not hold |
| `confidence` | string | no | high/medium/low; static-only traces rate medium at best |
| `poc_script` | string | no | PoC script path (workspace-relative) |
| `remediation` | string | no | Fix recommendation |
| `code_locations` | array | white-box | `[{file, fix_before, fix_after}]` — fixes ship once, at report time |
| `fix_pr_body` | string | white-box | PR description for the inline fix |
| `update_reason` | string | update | Revision reason (goes into update_history) |
| `package_name` / `cve` / `package_ecosystem` / `manifest_path` | string | dedupe-check (dependency_cve) | Identity: same CVE + package is a duplicate; a different manifest_path means two findings |

**Real output example**:

```
Registered F-001 [info] Toolchain verification entry — local-verification.
```

**Rejection behavior (design core)**:

- Strict mode (default) without `evidence` → `"REJECTED: no evidence. A finding without a demonstrated PoC ... is at best an open_proof_gap. Record it in strix_coverage with needs_follow_up instead..."`
- Illegal severity/type → enum error
- Dedup discipline: revise the same issue with `update` (carrying `update_reason`), never re-create; run `dedupe-check` before create — same type + endpoint + overlapping target text yields `DUPLICATE of F-NNN` (dependency_cve keys on CVE + package; different manifests count as two), deterministic with no LLM. Verified live: a ThinkPHP RCE re-check returned `DUPLICATE of F-001`, an unrelated target returned `NOT A DUPLICATE`

**Storage**: `workspace/findings/F-NNN.json` (with created_at/updated_at/update_history).

---

## strix_report — report generation

**Strix origin**: `report/` module (writer + sarif + finish_scan semantics).

| Parameter | Type | Required |
|---|---|---|
| `action` | string | no (default report; sarif / finish) |
| `engagement_title` | string | no (default Security Assessment Report) |
| `scope_summary` | string | no (authorization & scope summary paragraph) |
| `sarif_file` | string | sarif (default findings.sarif, a `.sarif` filename inside the workspace) |
| `caller_role` | string | finish (`root` passes; an `operator` child is refused) |
| `executive_summary` / `methodology` / `technical_analysis` / `recommendations` | string | finish, all four required |

**Output**: writes `workspace/report.md`, returns path + stats. Structure: Scope & Authorization → Executive Summary (counts by severity) → Findings (each: severity/CVSS/type/target/confidence/description/evidence code block/PoC script/counterevidence/remediation/white-box diff) → **Coverage Ledger (including reviewed-clean surfaces)** → Methodology.

- `action=sarif`: writes `workspace/findings.sarif` (SARIF 2.1.0: rules keyed `strix/<type>` + coverage zones `strix/coverage/<area>`; severities collapse to three levels with raw label + CVSS kept in `properties.strix`; sourceless DAST findings anchor on a flagged synthetic SECURITY.md location; `code_locations` become fixes; coverage rides as pass/open non-failing results). Verified live: `3 rules, 4 results: 1 findings, 3 coverage`, ready for `upload-sarif` into CI.
- `action=finish`: orchestrator-only engagement close (`caller_role=operator` is refused with a pointer to `send_message`; missing sections are named one by one), appending `## Engagement Close (finish)` with the four sections to report.md.

**Real output example**:

```
Report written to ...\strix-workspace\report.md (1 findings, 0 coverage entries).
SARIF 2.1.0 sidecar written to ...\strix-workspace\findings.sarif (3 rules, 4 results: 1 findings, 3 coverage). Upload with github/codeql-action/upload-sarif or filter kind == "fail" for alerts only.
REFUSED: finish closes the whole engagement and is root/orchestrator-only. ...
```

---

## strix_coverage — attack-surface ledger

**Strix origin**: `record_coverage` / `update_coverage` / `list_coverage`.

| Parameter | Notes |
|---|---|
| `action` | record / update / list |
| `id` | required for update (`C-NNN`) |
| `surface` | The assessed surface: URL, endpoint, host:port, file, code area |
| `risk_area` | Vulnerability class tested (SQLi, IDOR, auth bypass…) |
| `outcome` | `clean` / `finding` / `needs_follow_up` / `blocked` |
| `evidence_note` | Short note: what was tested, what was observed, why blocked |

**Discipline** (baked into the description, model-visible): **record every assessed surface, including clean ones** — a report listing only findings cannot say what was reviewed and cleared; move one surface with update, never double-record; `needs_follow_up` maps to open_proof_gap.

**Real output example**:

```
Recorded C-001: https://example.com — baseline reachability → clean.
```

**Storage**: `workspace/coverage/ledger.jsonl` (JSON Lines, append-only, source of truth) + session-log mirror (`strix/coverage` event, best-effort appended after successful record/update, carries the entry snapshot; reads go to the file only).

---

## strix_notes — cross-agent scratchpad

**Strix origin**: `create_note` family.

| Parameter | Notes |
|---|---|
| `action` | create / list / get / update / delete |
| `id` / `title` / `body` | per action |

**Purpose**: durable facts that are "neither findings nor coverage" — working credentials, endpoint inventories, tenant lists, rate-limit quirks. List before starting work to avoid re-mapping.

**Real output example**: `Saved N-001: verification-note.`

**Storage**: `workspace/notes/N-NNN.json` (source of truth) + session-log mirror (`strix/note` event, best-effort appended after successful create/update/delete; delete carries the id only, no body).

---

## strix_threat_model — shared threat model

**Strix origin**: `get/amend/save_threat_model`.

| Parameter | Notes |
|---|---|
| `action` | get / amend / save |
| `text` | save: full model text; amend: correction content |

**Discipline**: get before testing (derive + save a baseline first if none exists); when testing disproves part of the model (a "trusted" boundary is actually reachable, an unlisted role/host) → amend is mandatory. "Amending is not politeness: a model nobody corrects turns the first agent's guesses into everyone's assumptions." save replaces the whole document and clears amendments (normally the orchestrator folding amendments into a baseline).

**Storage**: `workspace/threat-model.md` (amendments appended as timestamped sections).

---

## strix_authorization — authorization attestation

**Strix counterpart**: none directly (Strix assumes the CLI operator is the authorizing party; dsh as a multi-session agent runtime needs authorization facts carried in the prompt).

| Parameter | Notes |
|---|---|
| `action` | set / get / clear |
| `targets` | In-scope target array (required for set, at least one) |
| `granted_by` | Granting person/team/program (required for set) |
| `scope_ref` | Program or ticket reference, e.g. a Butian program id |
| `valid_until` | Permission expiry (ISO-8601) |
| `notes` | Constraints, e.g. "no DoS payloads, business hours only" |

**Semantics**: set writes `workspace/authorization.json` (first recorded_at preserved, overwrites stamped updated_at); get reads; clear revokes (deletes the file, agent returns to passive-only). set without targets/granted_by is REJECTED.

**Dynamic injection**: the `strix:authorization` section (order 101, provider-function form, re-evaluated on every assembly) renders three states — no attestation: a one-line passive-only reminder; live attestation: facts plus the refusal-avoidance passage (in-scope validation is authorized security work: no self-classifying it as unauthorized/harmful, no generic policy warnings, continue with the most useful in-scope step when in doubt — upstream REFUSAL AVOIDANCE in conditional form, present only while a live attestation covers the work, never widening stay-inside); expired `valid_until`: facts kept plus an expiry warning with fallback to passive-only. Effective on the very next turn after set, no restart needed.

**Real output** (headless smoke test):

```
No authorization attestation recorded yet. Use action=set when the operator states permission.
Authorization recorded: 1 target(s), granted by smoke test. Re-injected into the system prompt from now on.
Authorization attestation revoked. The agent is back to passive-only until a new one is recorded.
```

---

## strix_shell — containerized command execution

**Strix origin**: Kali sandbox `exec_command` (restores the isolation property; full Kali tool inventory is on the roadmap).

| Parameter | Notes |
|---|---|
| `command` | Command run inside the container via bash -c |
| `timeout_ms` | Default 120s (config); background jobs share this timeout |
| `image` | Per-call container image override (e.g. a Kali toolset). Attended: the image name rides the approval prompt for the operator to decide. Unattended (approvalGate off): default `shellImage` + `shellAllowedImages` only |
| `network` | Per-call network toggle |
| `workdir` | Working directory inside the container, default /workspace |
| `background` | `true` runs as a background dsh job returning the job id immediately; read streaming output with `job_output`, stop with `job_kill` |

**Semantics**: one-shot container (`docker run --rm`), workspace mounted read-only at `/workspace` — **every call is stateless**, durable state goes to workspace files. Engines run inside the container, isolated from the host by construction.

**Background mode**: with `background=true` the approved command registers as a `strix-shell-N` job (managed by dsh's own `job_output`/`job_list`/`job_kill`, no plugin-side tooling needed). Built for long scans: the call returns immediately, the model works on something else in parallel, then polls with `job_output`. Kill sends SIGKILL; a record that still has not exited after 5 seconds is force-settled (no zombie entries).

**Real background output** (headless smoke test, `echo bg-smoke-ok && sleep 2 && echo bg-done` + `background=true`):

```
Background job started: strix-shell-1. Read streaming output with job_output, list jobs with job_list, stop it with job_kill.
```

Then `job_output strix-shell-1`:

```
bg-smoke-ok
bg-done
[status: completed, exit code: 0]
```

Starting `sleep 120` in the background and then `job_kill`: `requested cancellation of job strix-shell-1`, job terminated.

**Real output example** (`uname -a && python3 --version && whoami`):

```
[exit code: 0]
--- stdout ---
Linux acea1e82ea7f 6.18.33.2-microsoft-standard-WSL2 ... x86_64
Python 3.12.14
root
```

**Error modes**: Docker unavailable → install guidance; timeout → `[timed out and killed]`.

**Approval gate (HITL)**: every call first asks the operator through dsh's ApprovalService; only `allowed-once` executes; `rejected` / `cancelled` / `unavailable` all fail closed. Real denial output (headless, no answerer):

```
DENIED: strix_shell was not approved by the operator (outcome: unavailable). Nothing was executed.
If this work should proceed, the operator can approve the pending request in the dsh UI (approval
policy 'ask'), or set the plugin's approvalGate config to 'off' for fully autonomous runs they
accept responsibility for.
```

---

## strix_pybox — Python exploit sandbox

**Strix origin**: custom exploit runtime (Python sandbox).

| Parameter | Notes |
|---|---|
| `script` | Python source (saved as `workspace/pybox/<run>/main.py`) |
| `files` | Sidecar files (dict: filename→content; path separators rejected) |
| `install_packages` | pip install before running (needs network) |
| `arguments` | JSON written to `args.json` for the script to read (avoids complex quoting) |
| `timeout_ms` / `network` | Defaults 60s / on |

**Methodology binding**: payload sprays (SQLi/XSS/SSRF/fuzzing) **must** run as batched pybox scripts — manual iteration is forbidden. The default image is stdlib-only; third-party packages go through `install_packages` or config. Same approval gate as strix_shell (a denied call writes **no files**, zero side effects).

**Real output example** (args.json injection round-trip):

```
Run dir: ...\pybox\run-1788...
[exit code: 0]
--- stdout ---
pybox-ok sandbox-verification
```

---

## strix_browser — browser automation

**Strix origin**: `agent-browser --session` (session-isolation discipline, ported).

| Parameter | Notes |
|---|---|
| `action` | navigate / click / fill / evaluate / screenshot / content / close |
| `session` | Session name (default default; letters/digits/dash/underscore/dot only) — **concurrent agents must each use their own session**, or navigation invalidates each other; sessions live in plugin process memory shared across engagements in one process, so name them per-engagement |
| `url` / `selector` / `value` / `wait_until` / `full_page` | per action |

**Output**: navigate returns the page title; screenshot saves to `workspace/screenshots/<session>-<ts>.png` and returns the path (view with dsh's native `read_image`); content returns truncated HTML.

**Real output example**:

```
Navigated https://example.com — title: Example Domain
Screenshot saved: ...\screenshots\verify-1788387776891.png
Session "verify" closed.
```

**Dependency**: `playwright` npm package + matching Chromium (`npx playwright install chromium`, version must match the bundled playwright).

---

## strix_recon — reconnaissance orchestration

**Strix origin**: black-box Phase 1 (recon & mapping first).

| Parameter | Notes |
|---|---|
| `domain` | Base domain (no scheme, auto-normalized) |
| `skip_httpx` | Enumerate subdomains only, skip live probing |
| `timeout_ms` | Per-engine timeout (default 300s) |

**Flow**: subfinder passive enumeration → `recon/<domain>/subs.txt` → httpx (`-title -status-code -tech-detect`) → `recon/<domain>/live.txt` → summary returned.

**Real output example**:

```
[subfinder] 24948 subdomain(s) → C:\Users\20327\.dsh\strix-workspace\recon\example.com\subs.txt
```

**Dependency**: subfinder/httpx in `~/.dsh/bin`, on PATH, or via the `binariesDir` config.

---

## strix_sast — template scanning & static analysis

**Strix origin**: nuclei/semgrep usage discipline.

| Parameter | Notes |
|---|---|
| `engine` | nuclei / semgrep |
| `target` | nuclei: target URL; semgrep: local source dir (absolute path triggers the container fallback) |
| `severity` | nuclei severity filter (info/low/medium/high/critical/unknown allowlist, default all) |
| `extra_args` | Extra arguments (space-split; template selection, output formats, and proxy routing fully open; only three classes barred: retargeting `-u -target -l`, rate-limit/concurrency `-rl -c`, engine config `-config -update`) |

**Execution strategy**:

- **nuclei container-first** (`projectdiscovery/nuclei` image ships its own template library; avoids the Access-denied hang of sandboxed child processes writing config dirs), host binary only as a no-Docker fallback
- **semgrep container fallback** (`returntocorp/semgrep` image mounting `/src` where Windows has no native support)
- Rate limit defaults to `nucleiRateLimit: 50`/s — do not raise it for targets you do not own

**Real output example**:

```
nuclei scan via container (projectdiscovery/nuclei) (rate limit 50/s):
[exit code: 0]
Remember: these are template matches, not validated findings.
```

**Budget gate**: consults the `workspace/budget.json` ledger before running; over budget with `budgetAction='block'` refuses (`BUDGET EXCEEDED ... Nothing was executed.`), with `'warn'` prepends a warning and proceeds. No check when the cap is 0 (default).

---

## strix_proxy — mitmproxy sidecar interception & replay

**Strix origin**: the `proxy` module (Caido: list_requests HTTPQL + repeat + Python bindings). v1 covered the core use case with `strix_http` raw replay; this tool closes the intercept→query→replay loop.

| Parameter | Notes |
|---|---|
| `action` | start / status / list / get / replay / stop |
| `port` | start: localhost listen port, default 8080 (1024–65535) |
| `filter` / `limit` | list: substring filter over method/url/status; max rows shown, default 20 |
| `id` | get/replay: flow id (`F-…`) |

**Architecture**: `mitmdump` runs in the official `mitmproxy/mitmproxy` container (workspace mounted at `/workspace`, addon mounted read-only at `/addon.py`); `assets/mitmproxy/strix_addon.py` logs every completed flow as one summary line in `workspace/proxy/flows.jsonl` plus raw `flows/<id>.req` / `.rsp` messages. Replay re-sends through the shared `sendHttpRequest` (same fetch path and output format as strix_http).

**Honest limits**: HTTPS bodies need the client to trust the sidecar CA (`workspace/proxy/.mitmproxy/mitmproxy-ca-cert.pem`); without it only CONNECT metadata is captured and replay explicitly refuses ("has no replayable URL"). One sidecar per workspace at a time. stop has two paths: same-process pid kill + cross-process `docker stop` (pid dies with the headless process, the latter covers it — fixed after a real misprediction).

**SCOPE (honest difference from upstream Caido scope)**: upstream Caido filters targets with scope get/list/create/update/delete; this build has **no scope allow/deny lists** — one sidecar per workspace captures everything through the proxy port. The operator scopes the engagement by pointing only the authorized client at that port; the rule is written into the tool description so the model sees it on every call.

**Real output** (headless smoke test: start :18080 → curl GET example.com through the proxy → list/replay → stop):

```
Sidecar listening on http://localhost:18080 (container mitmdump, addon logging to workspace/proxy/).
F-1788397575-0001 GET 200 http://example.com/ (req 105B / rsp 858B)
Replay of F-1788397575-0001:
HTTP 200 OK — 234ms — http://example.com/
Sidecar stopped. 2 flow(s) remain queryable (list/get/replay).
```

---

## strix_depcheck — dependency vulnerability database (AI-tooling vuln DB)

**Strix counterpart**: the data source for the `dependency_cve` type (previously an empty shell); research verdict in `docs/en/backlog.md` A-0 (free OSV/KEV/EPSS trio wins, MCP is a dead end).

| Parameter | Notes |
|---|---|
| `action` | check / kev-refresh / status |
| `packages` | check: `[{ecosystem, name, version}]` (ecosystem e.g. npm/PyPI/Go/Maven; max 50 per call) |

**Chain**: OSV `querybatch` primary (package+version → vuln ids) → `vulns/{id}` detail (summary/CVSS_V3/fixed versions/CVE aliases) → KEV cache hit (`workspace/vulndb/kev.json`, 24h TTL, auto-refreshed when missing/stale) → per-CVE EPSS scores → KEV hits first, EPSS desc. Results feed `strix_finding create vulnerability_type=dependency_cve` directly (`dedupe-check` keys on CVE + package). **Prove reachability before filing**: a vulnerable dependency is a lead.

**Real output** (headless, lodash@4.17.20):

```
5 known vuln(s) in 1 package(s) (KEV-hit first, then EPSS):
- lodash@4.17.20 [npm] GHSA-35jh-r3h4-6jhm: Command Injection in lodash (epss=0.213 CVE-2021-23337 cvss=CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H fixed=4.17.21)
- lodash@4.17.20 [npm] GHSA-29mw-wpgm-hmr9: Regular Expression Denial of Service (ReDoS) in lodash (epss=0.073 CVE-2020-28500 ...)
```

**Nuclei template library (backlog A-1, landed together)**: scan containers mount the `strix-nuclei-templates` named volume so templates survive `--rm`; refresh with `docker run --rm -v strix-nuclei-templates:/root/nuclei-templates projectdiscovery/nuclei -update-templates` (upstream merges daily).

---

## strix_budget — LLM spend ledger

**Background**: dsh's token-meter measures context pressure, not dollars, and alpha.5 has no pricing API — so this ledger prices usage with operator-configured per-1K rates (code defaults: DeepSeek V3.2 official, input $0.00027/1K, output $0.0004/1K; this machine's three profiles override to muse-spark-1.3-contributor via opencodego: input $0.0001/1K, output $0.0002/1K), accumulated in `workspace/budget.json`. The ledger is only as honest as its records: the agent faithfully `record`s its own per-turn usage. When dsh opens a usage subscription, recording can switch to automatic; the ledger format already allows for it.

| Parameter | Notes |
|---|---|
| `action` | record / status / reset |
| `input_tokens` / `output_tokens` | This turn's usage (record, non-negative) |
| `note` | What the spend was for (record) |

**Real output** (headless smoke test):

```
Budget: spent $0.0000 — no cap set (budgetLimitUsd=0).
Tokens: 0 in / 0 out across 0 records.
Rates: $0.0003/1K in, $0.0004/1K out (mode: warn).
Recorded +50000 in / +10000 out → total $0.0175 (smoke test).
```

**block-mode refusal evidence** (recon called after setting the cap to $0.0001):

```
BUDGET EXCEEDED: strix_recon refused — spent $0.0175 of $0.0001 cap (50000 in / 10000 out tokens across 1 records). Raise budgetLimitUsd, reset the ledger (strix_budget action=reset), or switch budgetAction to warn. Nothing was executed.
```

---

## Config quick reference

| Config | Default | Affects |
|---|---|---|
| `workspaceDir` | `''` → `~/.dsh/strix-workspace` | All artifact roots |
| `httpTimeoutMs` / `httpMaxBodyChars` | 30000 / 20000 | strix_http |
| `shellImage` / `shellNetwork` / `shellTimeoutMs` | python:3.12-slim / true / 120s | strix_shell |
| `pyboxImage` / `pyboxExtraPackages` / `pyboxNetwork` / `pyboxTimeoutMs` | python:3.12-slim / [] / true / 60s | strix_pybox |
| `binariesDir` | `''` | recon/sast binary discovery (`~/.dsh/bin` is always searched) |
| `reconTimeoutMs` / `nucleiRateLimit` | 300s / 50 | strix_recon / strix_sast |
| `browserHeadless` | true | strix_browser |
| `strictEvidence` | true | strix_finding rejects evidence-less filings |
| `approvalGate` | `'always'` | strix_shell / strix_pybox ask ApprovalService per call; `'off'` disables (unattended runs the operator accepts responsibility for only) |
| `budgetLimitUsd` | `0` (uncapped) | strix_budget spend cap (USD); recon/sast consult the ledger, over-budget behavior follows budgetAction |
| `budgetInputPer1k` / `budgetOutputPer1k` | `0.00027` / `0.0004` | Ledger pricing (code defaults are DeepSeek V3.2 official; this machine's profiles override to 0.0001/0.0002; change the profile overlay when switching models) |
| `budgetAction` | `'warn'` | Over-budget heavy-tool behavior: `'warn'` prepends a warning and proceeds, `'block'` refuses |

---

## Approval gate (HITL) & evidence ledger

strix_shell and strix_pybox are the suite's only tools that execute arbitrary commands/code in containers, so they are bound to dsh's ApprovalService (`@deepseek-ai/dsh-user-approval`, since alpha.5) for per-call approval:

1. Before executing, the tool first checks `approvalAutoAllow` pre-approval (regex list, default empty = no loosening): a summary matching any pattern runs immediately and is logged as `auto-allowed`. Only unmatched calls reach `ctx.approval.request({ agent, toolName, callId, reason, signal })`, where `reason` is a human-readable command summary (first 160 chars of the command / script first line + size + pip packages + network toggle). Typical pre-approval: read-only commands `^strix_shell: run "(echo|uname|whoami|id|ls|cat|head|tail|grep|jq)`.
2. Four outcomes: `allowed-once` (the only grant), `rejected`, `cancelled`, `unavailable`. **Everything but the grant refuses execution** (matching dsh's fail-closed rule on `unavailable`).
3. The service auto-appends the `approval/asked` + `approval/decided` audit pair to the session event log; the plugin additionally writes an **operator-side ledger** at `<workspace>/evidence/log.jsonl`:

```jsonl
{"ts":"...","kind":"decision","tool":"strix_shell","outcome":"unavailable","callId":"call_00_...","command":"strix_shell: run \"echo gate-test\" in python:3.12-slim (network: on)"}
{"ts":"...","kind":"result","tool":"strix_shell","callId":"call_00_...","exitCode":0,"durationMs":3946}
```

Behavior per surface (dsh answerer waterfall):

| Surface | Approval experience |
|---|---|
| WebUI (`--profile web`/strix) | Interactive approval dialog (allow-once / reject) |
| ACP client | `session/request_permission` round-trip |
| headless one-shot | No answerer → `unavailable` → fail-closed denial (no blocking, no execution) |
| Session policy `never` | Every request deterministically `rejected` |

Disabling (only for local ranges / unattended runs at your own responsibility): override the plugin entry's config in the profile's `cordis.patch.yml` — note the **id is the plugin entry id (`strix-tools`), not the package name**:

```yaml
- id: strix-tools
  config:
    approvalGate: 'off'
```

Implementation: `src/lib/approval.ts` (`createApprovalGate` / `logEvidence`).
