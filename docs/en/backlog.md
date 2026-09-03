# Backlog

> Living document: landed items move to the version history in `DEVELOPMENT.md`; this file keeps **open items only**. Each item carries background, plan, and acceptance criteria.
> Status: 🟡 open / 🔵 in progress / ✅ landed (moved out).

## A. Vulnerability database (currently missing)

Status quo: `strix-dsh` ships no vulnerability database. The 29 `skills/vulnerabilities/` packs are **methodology** (how to test a class), not a searchable CVE store; `strix_finding` records your own discoveries; the `dependency_cve` type is an empty shell with no data source.

### A-0. Search findings (2026-09-03, no subagents, direct WebFetch + live curl)

**Bottom line: nothing beats the free OSV/KEV/EPSS trio; the MCP route is empty.**

| Rank | Option | Evidence | Verdict |
|---|---|---|---|
| 1 | OSV.dev (`POST /v1/query` + `/v1/querybatch` + `GET /v1/vulns/{id}`) | Official docs confirm endpoint shape; live curl on lodash@4.17.20 returned GHSA-29mw-wpgm-hmr9 in full; keyless, authless | Primary source, no substitute |
| 2 | CISA KEV (`known_exploited_vulnerabilities.json`) | Live curl: catalogVersion 2026.09.02, count 1694; keyless | "Exploited in the wild" filter, severity uplift basis |
| 3 | EPSS (`api.first.org/data/v1/epss?cve=`) | Live curl: Log4Shell epss 0.99999/percentile 1.0; public, keyless | Priority ordering |
| 4 | deps.dev API v3 | Search-confirmed free and keyless (strongest dependency graph, covers transitive deps); live probe deferred to A-2 implementation | OSV companion, not replacement |
| 5 | NVD API 2.0 | Docs page JS-blocked, numbers unread; known to need a key, laggy, bloated responses | Fallback enrichment, not primary |
| 6 | GitHub Advisory | Numbers unread from docs; needs a token; duplicates OSV (which already ingests GHSA) | Skip for now (`gh` already authed, zero cost if ever needed) |
| — | Generic vuln-data MCP server | mcp.so category: "No servers in this category yet"; glama.ai search across Shodan/VirusTotal/Censys/NVD/CVE/OSV/nuclei/exploit: **zero hits**; web-wide Bing search for OSV/NVD/KEV MCP: nothing | Dead end: write our own `strix_depcheck` calling REST directly |
| — | Official nuclei MCP | Web-wide search yields only the nuclei repo/site/docs, no official MCP | Same; consume via A-1 (named volume + template updates) |
| — | Exploit-DB official API | Search does not confirm one exists (one second-hand "ready API" claim, no path/spec) | Excluded; exploit side rides nuclei templates + hand PoCs |
| — | Snyk/Vulners API | Search confirms no free-tier endpoint/auth/quota; both need keys | Skip while the free trio covers ~90% of cases |

Honest search log: DuckDuckGo bot-check-blocked direct fetching; Bing RSS worked but snippets were thin; NVD/GitHub/EPSS doc pages are JS-rendered or 404 to WebFetch — anything unread is labeled "known/unconfirmed", never invented. Decisive evidence is the three live curls (OSV/KEV/EPSS all green), matching the original A-2 plan: **one `strix_depcheck` tool querying OSV→KEV→EPSS in order, deps.dev for transitive deps, all keyless**.

### A-1. Pinned, self-updating Nuclei template library ✅ (landed in 0.10.0)

- **Landed**: `sast.ts` nuclei containers mount the `strix-nuclei-templates` named volume (`ensureNucleiTemplateVolume`, best-effort create); refresh with `docker run --rm -v strix-nuclei-templates:/root/nuclei-templates projectdiscovery/nuclei -update-templates`. Documented at the end of the `strix_depcheck` section in tools-reference.

### A-2. Dependency CVE lookup (OSV.dev) ✅ (landed in 0.10.0)

- **Landed**: new `strix_depcheck` tool (`src/tools/depcheck.ts`, 16/16 tools): `check` (OSV querybatch → vulns/{id} detail → KEV cache → EPSS ordering) / `kev-refresh` / `status`; KEV snapshot in `workspace/vulndb/kev.json` with 24h TTL; 4 unit cases; lodash@4.17.20 returned 5 vulns (CVE/EPSS/fixed) + 1694-entry KEV cache + dedupe chain verified live. Transitive deps via deps.dev not wired — OSV covers direct versions; add on demand.

## B. Known deferrals (Phase-2 / external)

### B-1. Engagement-scoped approval allowlist 🟡

- **Background**: 0.9.0 `approvalAutoAllow` is global regex; per-engagement scoping is still a design item.
- **Plan**: bind the allowlist to the `authorization.json` scope (authorized targets + pre-approval mode together), expiring with the engagement.
- **Acceptance**: clearing the authorization disables pre-approval too; unit-covered.

### B-2. Automatic budget-ledger feed 🟡

- **Background**: `strix_budget` relies on manual `record`; blocked on dsh exposing a usage-subscription API.
- **Plan**: drive `record` from the subscription once available; the ledger format already reserves for it, no migration needed.
- **Acceptance**: a full engagement with zero manual records and a non-empty ledger.

### B-3. Cloud-range scoreboard integration 🟡

- **Background**: the range-API skill (`~/.dsh/skills/bachang-api-caller/`) is installed but its SKILL.md uses example.com placeholders.
- **Blocked on**: user-supplied real Base URL + HBC_TOKEN + target code.

## C. Field issues (user fills in)

> Record real-usage problems here one by one as: symptom → repro steps → expected behavior. I (the AI) fill in plan + acceptance criteria and implement.

### C-1. Agent stops to ask the user what to do next ✅ (fixed in 0.10.1)

- **Symptom**: with popups gone, the agent ended turns with plain-text "pick one of three, you decide" summaries (e.g. test accounts / low-rate POST batch / fourth baseline batch), stalling the engagement. Against the Strix workflow.
- **Root cause** (after reading upstream `system_prompt.jinja` + `factory.py`): Strix autonomy rests on three layers — ① turn-ending semantics: plain text NEVER ends a turn, only lifecycle tool calls (`finish_scan`/`agent_finish`/`respond_to_user`) stop it, so a "pick one of three" text gets nudged onward; ② AUTONOMOUS BEHAVIOR mandate + a tool call nearly every turn; ③ the high bar of `finish_scan` (four sections + full closure). dsh semantics are inverted: **a plain-text reply ends the turn and returns control to the user**. Removing the `tool-ask-user` row only killed the popup tool, not plain-text questions — a session-semantics problem, not a persona problem.
- **Fix** (Strix approach translated to dsh equivalents): AUTONOMY discipline injected uniformly into the methodology + all three personas (orchestrator/operator/dispatch row) — ending a turn with a question/summary hands control over and halts the engagement, so always close with a tool call; with competing options, advance the highest-value one autonomously (① issued test accounts → ② in-scope low-rate validation → ③ new baselines) and file deferred items as `needs_follow_up` coverage, never as questions; only missing/expired authorization or unresolvable targets legitimately stop (declared via `strix_authorization`).
- **Acceptance**: `methodologySection` regression test (key sentences survive); both presets healthy; headless spot-check called tools plus a next step (note: headless one-shots end in replies by nature; the real arena is multi-turn WebUI. In one spot-check the model picked B over A among hypothetical options — correct, since A's "issued accounts" precondition did not exist in the workspace).
- **Live evidence (headless background job, real workspace at 51 coverage/18 notes)**: facing test-accounts / low-rate POST / new-baseline options, the model asked zero questions and reasoned down the priority itself — A unavailable (no issued accounts in N-001–N-018), B banned by threat-model constraints, C actionable; then chained tool calls (`strix_threat_model get` + `notes list` + `coverage list` → `strix_recon jxnu.edu.cn`, 192 subs → 11-surface HTTP baselines → `notes create N-019` + `amend` + `strix_report`, 62 coverage), closing with the report tool rather than "you decide". Strix-style autonomous advance holds under dsh.
- **Remaining**: multi-turn WebUI observation ("N consecutive rounds, zero questions") still needs user-side confirmation.
