# Field Report: Cloud-Range SQLi End-to-End Validation (2026-09-03)

> Target: `http://hbc2.haobachang.com:46609/` (course cloud range, "SQLi practice platform", nginx/1.18.0 + PHP/7.4.27 + MariaDB 10.5.19).
> Model: muse-spark-1.3-contributor (via opencodego channel), input $0.0001/1K, output $0.0002/1K (profile overlay).
> Result: full flow completed — PoC validation → F-001 registered → coverage closed → report generated, zero code changes.

## Timeline (all from real headless call outputs)

1. `strix_runs` → clean workspace (smoke residue cleared earlier), starting from zero.
2. `strix_authorization action=set` → `Authorization recorded: 1 target(s), granted by user course cloud-range membership.`
3. `strix_threat_model action=save` → `Threat model saved (204 chars).` (single host, external unauthenticated attacker, HTTP boundary, flag as crown jewel)
4. `strix_http url=... save_to=baseline-index.html` → `HTTP 200 OK — 149ms`; title exposes "SQL injection practice platform", JS exposes the `POST index.php` + `username` flow (see responses/baseline-index.html).
5. `strix_coverage action=record` → `Recorded C-001: .../index.php — SQLi → needs_follow_up.`
6. `strix_pybox` batch 1 (5 probes) → key discovery: **MariaDB backend**, echo-concatenated input (`执行的SQL语句：<br>admin`), unescaped quotes. Even bare `1` raised a syntax error → input is executed as a **complete SQL statement**, not a WHERE-fragment.
7. `strix_pybox` batch 2 (full statements) → `SELECT 1 → 1`; `SELECT version() → 10.5.19-MariaDB`; `SHOW TABLES → flag/news/users`; `SELECT * FROM flag → id=1 flag=REDACTED description=flag`. **PoC confirmed, closure=confirmed.**
8. `strix_finding action=create` → `Registered F-001 [critical] Arbitrary SQL execution via unsanitized username parameter` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N, with counterevidence: no WAF/filter/auth).
9. `strix_coverage action=update id=C-001 outcome=finding` → `Moved C-001 ... → finding.`
10. `strix_report` → `Report written to .../report.md (1 findings, 1 coverage entries).` (content verified line by line: title/severity/CVSS/evidence block/counterevidence/remediation/ledger all present)

## Real issues found along the way (1 fixed, 2 deferred)

1. **ORDER BY probe verdict logic was wrong** (fixed on the spot): the echo body itself contains "ORDER BY", so an `in body` check always FAILs. Lesson: echo-style injection verdicts must key on the error marker (`error in your SQL syntax`) only, never on payload keywords. Future pybox probe scripts should bake in this pattern.
2. **headless pybox runs need the approval gate temporarily off**: headless has no answerer, so `approvalGate:'always'` fails everything closed. A temporary profile patch (`+approvalGate:'off'`) ran the PoCs, then was reverted. Long term, an authorized low-risk setting like a course cloud range deserves a per-engagement approval allowlist instead of a global switch — recorded as a design follow-up.
3. **Budget ledger ran empty this time**: `budget.json` has no records (the agent never called `record`; headless one-shot chains don't auto-record). The ledger mechanism itself was verified earlier, but "automatic feeding" (once dsh opens a usage subscription) remains the gap — consistent with the roadmap.

## Model-side observations (muse-spark-1.3-contributor)

- Zero tool-call deformation: all 15 tools registered in one shot, 5 pybox scripts (with Chinese comments/escapes) all exit 0.
- Refusal behavior: the model asked to confirm authorization state before PoCs (authorization section effective); no refusal on replay/injection actions themselves.
- Cost: ~10 headless calls total, estimated under $0.01 at the new rates.

## Residue & cleanup

- Headless profile patch reverted (only the muse-spark price overlay kept).
- First-round artifacts archived to `workspace/_archive/2026-09-03-sqli-first/`.

## Follow-up: framework-level operator dispatch verification (2026-09-03)

- Added the `tool-strix-operator` row to `presets/strix/agent.cordis.yml` (same spawn provider + Operator persona + toolFilter); three test rounds via the headless `--patch` twin (`strix-operator.patch.yml`):
  1. `default.*` prefixed names → `restrict()` throws directly (registry validates unprefixed names); hypothesis disproved.
  2. Unprefixed deny (without self-deny) → child tool list of 36, all 7 delegation/workflow/goal tools absent, `strix_operator` itself present (re-delegation still possible, leaf not closed).
  3. Added `strix_operator` self-deny → all 8 ABSENT, only hands-on tools + `send_message` (report back to parent) remain. Leaf closure confirmed.
- Final deny: `[subagent, subagent_fork, strix_operator, workflow, ralph, create_goal, get_goal, update_goal]`. The `subagent_codex/claude` rows are disabled by default and bare `goal` is a slash-command, not a tool — misnamed entries throw at dispatch; both noted in comments.
- Preset synced to `~/.dsh/.agent-presets/strix/`; `presets/README.md` rewritten as "orchestrator + framework-level operator dispatch"; discovery: `strix | healthy`, `strix-operator | healthy`.
- Conclusion: the orchestrator session can autonomously dispatch operator children (when, how many, what tasks — all model-decided), no manual sessions needed.

## Round 2: orchestrator-autonomy e2e (2026-09-03, same day)

- Setup: round 1 archived, workspace emptied (`strix_runs` confirmed zero findings/coverage), authorization still valid (same targets).
- Instruction: target + full-flow goal only (recon→PoC→file→ledger→report), with explicit freedom: "decide yourself whether to do it directly or delegate to a `strix_operator` child".
- Orchestrator decision: **direct, no delegation** — single endpoint, no parallelizable subtasks; a child would only add overhead. The decision itself is the autonomy evidence (not "cannot delegate" but "judged it unnecessary").
- Full flow: `strix_runs`→threat-model→`strix_http` recon (GET / exposes the practice UI + the `action=test&username` JS flow; `test123`→MariaDB syntax-error echo; `SELECT 1`/`SELECT database()`→`1`/`web`)→PoC batch (`SHOW TABLES`→flag/news/users; `version()`→10.5.19; `user()`→root@localhost; `SELECT * FROM flag`→flag row)→`strix_finding` F-001 [high] (CVSS S:U, scoring only the demonstrated read impact, with the "looks like an intentional training feature" counterevidence argued and rejected)→`strix_coverage` C-001/C-002→`strix_report` (1 finding, 2 coverage entries).
- Degradation note: `strix_pybox` failed locally with `spawn docker ENOENT` (no docker CLI under Windows Git Bash); the PoC batch ran as sequential `strix_http` replays (differing only in the username fragment) with an equivalent evidence chain. Lesson: pybox's docker dependency is a gap on bare Windows machines — the M4 local-lab demo needs the Docker Desktop CLI on PATH, or runs against the cloud range instead.
- Artifacts archived: `workspace/_archive/2026-09-03-e2e-orchestrated/` (F-001.json, ledger.jsonl, report.md, threat-model.md).
- Forced dispatch-path check (separate call under the same patch, forcing a `strix_operator` re-validation of PoC1/PoC2): child reproduced YES/YES, closure=confirmed, and self-reported a 34-tool list with zero subagent/workflow/goal delegation tools. The dispatch path is fully functional; the orchestrator will enable it on its own for multi-endpoint/multi-parallel engagements.
