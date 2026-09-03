# Backlog

> Living document: landed items move to the version history in `DEVELOPMENT.md`; this file keeps **open items only**. Each item carries background, plan, and acceptance criteria.
> Status: 🟡 open / 🔵 in progress / ✅ landed (moved out).

## A. Vulnerability database (currently missing)

Status quo: `strix-dsh` ships no vulnerability database. The 29 `skills/vulnerabilities/` packs are **methodology** (how to test a class), not a searchable CVE store; `strix_finding` records your own discoveries; the `dependency_cve` type is an empty shell with no data source.

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
