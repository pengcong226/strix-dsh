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

### A-1. Pinned, self-updating Nuclei template library 🟡

- **Background**: `strix_sast` runs the nuclei container (`projectdiscovery/nuclei` image, `--rm` one-shot), so template versions freeze at image-pull time; upstream (`projectdiscovery/nuclei-templates`) merges new CVE detection templates daily.
- **Plan**: mount a named `nuclei-templates` volume into scan containers (volume flag in `sast.ts` + one-shot `docker volume create`); document the `nuclei -update-templates` refresh flow.
- **Acceptance**: a new CVE template is callable on consecutive days; unit test covers the volume-arg construction.

### A-2. Dependency CVE lookup (OSV.dev) 🟡

- **Background**: the `dependency_cve` type has no source; maintaining our own DB is out of the question.
- **Plan**: new `strix_depcheck` tool (or folded into sast): query OSV.dev (free, keyless, covers npm/PyPI/Go/Maven, minute-level freshness) for `package+version → CVE`, file results via `strix_finding dedupe-check` (CVE + package identity). Metadata queries go over host fetch, not attack traffic.
- **Acceptance**: `lodash@4.17.20` resolves to CVE-2021-23337 and files as F-NNN; re-checking the same package returns DUPLICATE.

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

1. (to be added)
