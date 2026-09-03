# StriX-DH

**DeepSeek Harness as the brain, Strix's offensive-security capabilities as native tools.**

StriX-DH takes the offensive-security methodology of [Strix](https://github.com/usestrix/strix) (Apache-2.0) — its evidence-bound reporting pipeline, sandboxed execution model, 75 knowledge packages, and behavioral discipline — and re-hosts it **natively** inside [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) (MIT) as a plugin bundle. The dsh agent loop, subagent orchestration, durable session memory, and Web UI directly grow pentest capabilities; there is no second program being remote-controlled.

> ⚠️ **Authorized use only.** Only run the tools against systems you own or have explicit, written permission to test. You are responsible for compliance. See [docs/safety.md](docs/safety.md).

## Tools (16)

| Tool | Strix origin | Purpose |
|---|---|---|
| `strix_runs` | run overview | Engagement orientation: what already exists in the workspace |
| `strix_http` | Caido replay workflow | Raw HTTP client: any method/headers/body or full raw-request replay; bounded output, save-to-disk |
| `strix_finding` | `create_vulnerability_report` | **Evidence-bound** finding registry: strict mode rejects evidence-less filings; CVSS metrics must map to demonstrated PoC results; white-box inline fixes (`code_locations` + `fix_pr_body`); dependency CVEs; update-with-dedup semantics |
| `strix_report` | report generation | Markdown engagement report from findings + coverage ledger |
| `strix_coverage` | `record_coverage` | Attack-surface ledger — including surfaces that came back clean; `needs_follow_up` marks open proof gaps |
| `strix_notes` | shared notes | Cross-agent scratchpad (credentials, endpoint inventories, target quirks) |
| `strix_threat_model` | threat model | Shared model: establish before testing, amend when disproven |
| `strix_authorization` | authorization attestation | Engagement permission record (targets, granter, scope ref, expiry) re-injected into the system prompt every turn |
| `strix_budget` | spend ledger | LLM cost ledger (record/status/reset) with per-1K pricing; recon/sast consult it and warn or refuse over budget |
| `strix_shell` | Kali sandbox `exec_command` | One-shot command execution in a disposable Docker container (workspace mounted), configurable image — **operator approval per call**; `background=true` runs as a dsh background job (`job_output`/`job_kill`) |
| `strix_pybox` | Python exploit runtime | Python scripts in a disposable sandbox: bulk payload sprays, PoC execution; hard timeout, optional network isolation — **operator approval per call** |
| `strix_browser` | `agent-browser --session` | Playwright Chromium sessions isolated per name: navigate/click/fill/evaluate/screenshot |
| `strix_recon` | recon phase | subfinder → httpx orchestration (status/title/tech), results on disk |
| `strix_sast` | nuclei/semgrep | Rate-limited template scanning + static analysis; scanner output is a lead, never a finding |
| `strix_proxy` | Caido proxy workflow | Mitmproxy sidecar (Docker): intercept, query flows, replay via strix_http path |
| `strix_depcheck` | — (new in 0.10.0) | Dependency CVE lookup: OSV.dev → CISA KEV (exploited in the wild) → EPSS (priority), all keyless; 24h-cached KEV catalog; emits the exact fields `strix_finding create vulnerability_type=dependency_cve` needs |

Beyond the tools, `strix:methodology` and `strix:authorization` sections are contributed to the system
prompt (closure discipline, CVSS-evidence binding, ten primary vulnerability
classes; per-turn authorization facts) and **75 adapted knowledge packages** ship as bundled skills the model
loads on demand. See [docs/prompt-design.md](docs/prompt-design.md).

Every `strix_shell`/`strix_pybox` call passes a human-in-the-loop approval gate
(dsh ApprovalService): nothing executes without an explicit operator grant, and
every decision is recorded to `evidence/log.jsonl` in the workspace.

## Install

Prerequisites: Node.js ≥ 20, dsh (`npx @deepseek-ai/dsh` or global install).

```sh
dsh plugin --profile web add ./packages/strix-tools
npx -y @deepseek-ai/dsh web --no-open
# boot log line 1: [strix-dsh-tools] registered 16 tool modules + methodology + authorization sections + 75 skills
# WebUI: http://127.0.0.1:3080/?token=<from boot log>
```

Configure your model in the WebUI settings (dsh ships a DeepSeek adapter; keys
are stored by name in the credential store). Optional: Docker Desktop for
`strix_shell`/`strix_pybox`; subfinder/httpx/nuclei/semgrep binaries on PATH
(or `binariesDir` config) for recon/SAST; `npm i playwright && npx playwright
install chromium` for `strix_browser`.

## Documentation

- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — the developer handbook: full Strix/dsh analysis, compatibility surface, upgrade drill (start here)
- [docs/tools-reference.md](docs/tools-reference.md) — full contract of all 15 tools with verified outputs
- [docs/walkthrough.md](docs/walkthrough.md) — from boot to your first report, step by step
- [docs/strix-analysis.md](docs/strix-analysis.md) / [docs/en/strix-analysis.md](docs/en/strix-analysis.md) / [docs/dsh-analysis.md](docs/dsh-analysis.md) / [docs/en/dsh-analysis.md](docs/en/dsh-analysis.md) — deep upstream analyses (ZH/EN both)
- [docs/skills-catalog.md](docs/skills-catalog.md) / [docs/en/skills-catalog.md](docs/en/skills-catalog.md) — the 75 adapted knowledge packages (ZH/EN)
- [docs/architecture.md](docs/architecture.md) — runtime mechanics, version pins, migration map
- [docs/prompt-design.md](docs/prompt-design.md) — where every Strix prompt asset lives now
- [docs/safety.md](docs/safety.md) — authorized-use rules
- [docs/en/tools-reference.md](docs/en/tools-reference.md) / [docs/en/walkthrough.md](docs/en/walkthrough.md) / [docs/en/DEVELOPMENT.md](docs/en/DEVELOPMENT.md) / [docs/en/architecture.md](docs/en/architecture.md) / [docs/en/prompt-design.md](docs/en/prompt-design.md) — English versions of the tool contract, tutorial, developer handbook, architecture doc, and prompt-design map
- [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md) — vulnerability reporting, contribution rules
- [README.zh.md](README.zh.md) — 中文说明

## License & Attribution

Apache-2.0. See [NOTICE](NOTICE): methodology, prompts, and skill packages are
adapted from Strix (Apache-2.0); StriX-DH is a plugin bundle for dsh (MIT).
