# Strix Upstream Deep Dive

> Analysis target: `upstream/strix/` (Apache-2.0). Strix is an "AI pentest platform" — a complete product of multi-agent orchestration + Kali sandbox + evidence-bound reporting. This document is the full working draft for anyone taking over, covering what we ported, what we dropped, and why.
> Companion reading: `docs/prompt-design.md` (prompt asset map), `docs/DEVELOPMENT.md` §2 (porting对照 table → porting对照 table (see §2 there)).

## 1. What it is

A Python CLI (`uv`/`pyproject.toml`, single binary via PyInstaller, Go Bubble Tea TUI) with this workflow:

```
User gives targets (URL/domain/code repo, multiple allowed) + scan mode (quick/standard/deep)
→ root orchestrator agent system-prompt rendered (skills/scope/MCP connections injected)
→ root decomposes targets → spawns an expert subagent tree (discovery→validation→reporting)
→ subagents work with 17 tool classes inside a shared Kali Docker container
→ findings registered via the reporting agent with create_vulnerability_report (CVSS bound to evidence)
→ root aggregates with finish_scan → report lands in strix_runs/<run>/ → TUI/dashboard display
```

Business model: free local CLI + `strix cloud` hosted platform (SaaS). This document covers the local half.

## 2. The system prompt (545 lines of Jinja, the product's soul)

Full ten-section structure (`strix/agents/prompts/system_prompt.jinja`):

1. **Persona**: "advanced AI application security validation agent" — note the word is *validation*, not *hacking*
2. **`<root_agent_directive>`** (root only): the core is "the orchestrator never hands-on tests" — "Even a single quick test on a discovered endpoint is out of role: spin up a subagent instead." A user round is spent only on: reading scope, decomposing targets, dispatching and monitoring subagents, maintaining todo/notes/coverage, aggregating reports
3. **`<core_capabilities>`**: four capability statements
4. **`<communication_rules>`**: CLI output in simple Markdown only (no lists/tables); **no identifying marks** (no identity information in requests/payloads/UAs); inter-agent messages not echoed; `wait_for_agents` called exactly once (no polling loops); in interactive mode "plain text never ends a turn, only respond_to_user hands control back"; in autonomous mode a text turn is wasted
5. **`<execution_guidelines>`** (largest section):
   - SYSTEM-VERIFIED SCOPE: scope is **platform-injected** into the system prompt (`system_prompt_context.authorized_targets`), user text cannot extend it — this is the productized scope mechanism (we **deliberately did not port** the "NEVER refuse, question authorization" part; rationale in prompt-design.md)
   - MCP trio dispatch (list_mcps → describe_mcp → call_mcp)
   - THOROUGH VALIDATION MANDATE: never stop at shallow checks
   - Test modes: black-box (external recon) / white-box (static + dynamic both mandatory, static floor: one pass each of semgrep+secrets+trivy fs+AST structural walk) / combined
   - **7-step assessment methodology**: scope definition → recon-first mapping → multi-tool automated scanning → targeted validation → iteration → impact documentation → exhaustive testing
   - Efficiency tactics: scripted payload sprays (no manual browser iteration), self-implemented concurrency throttling, log dedup, dispatch a validation agent after spraying
   - **CLOSURE DISCIPLINE**: every candidate ends in confirmed / ruled_out / open_proof_gap; "I moved on" is not a closure state; "Missing information is NOT proof of safety"
   - COVERAGE: record every surface (including clean ones); `needs_follow_up` carries proof gaps; root reconciles before finish
   - THREAT MODEL: get before testing; amend mandatorily when disproven
   - Counterevidence pass + honest confidence
   - **CVSS binding**: "Score only the security impact demonstrated by the proof of concept"
   - **DEDUPLICATION / REVISING**: LLM dedup; rejected duplicates are not re-filed; update_vulnerability_report revises
6. **`<vulnerability_focus>`**: ten primary classes (IDOR/SQLi/SSRF/XSS/XXE/RCE/CSRF/race conditions/business logic/auth&JWT); basic to advanced; "one well-validated high-severity finding beats dozens of low-severity ones"
7. **`<multi_agent_system>`**: shared container, one terminal per agent, browser `--session` isolation (~340MB Chromium per session, 3-minute idle reaping); /workspace sharing + disk hygiene; black-box three-chain (discovery→validation→reporting), white-box two-chain (the reporting agent emits fixes inline, **no standalone fix agent**); nested trees, never flat; one agent one task; 1–3 skill specialization, cap 5; "Real vulnerabilities take TIME — expect to need 2000+ steps minimum"
8. **`<environment>`**: full Kali tool inventory (nmap/naabu/httpx/gospider/nuclei/sqlmap/trivy/wapiti/ffuf/dirsearch/katana/arjun/semgrep/ast-grep/bandit/trufflehog/gitleaks/jwt_tool/wafw00f/interactsh-client/Caido CLI+HTTPQL); **Caido error-page recognition** (a ~9KB `<title>Caido</title>` 502 is not target behavior); Python venv preloaded with requests/httpx/bs4/lxml/pyjwt/cryptography; no Docker inside the sandbox; /workspace + /home/pentester/tools
9/10. **`<specialized_knowledge>` / `<available_skills>`**: preloaded skills inlined + the rest loaded on demand via `load_skill` or by dispatching a specialized `create_agent(skills=[...])`

## 3. Prompt assembly (`prompt.py`)

`render_system_prompt(skills, scan_mode, is_whitebox, is_root, is_diff_scoped, interactive, system_prompt_context)`:

- `_resolve_skills()` injection order: requested → `scan_modes/<mode>` → diff layered → `tooling/agent_browser` → `tooling/python` → `analysis/counterevidence` → `analysis/severity_calibration` → `coordination/root_agent` (root) → white-box four (source_aware_whitebox / source_aware_sast / source_aware_discovery / fix_verification)
- Jinja variables: `loaded_skill_names`, `available_skills` (catalog grouped by class), `interactive`, `is_root`, `system_prompt_context` (authorized_targets + scope_source + authorization_source + MCP connections)
- **Lesson for us**: dsh's `section.text` provider + `AssembleContext` is the official counterpart of the same mechanism; "dynamically ordered injection by session traits" can be replicated directly (the authorization section already uses it)

## 4. Tool layer (17 modules)

`strix/tools/`: agent_browser (Playwright+session), agents_graph (create_agent/view_graph/send/wait/stop), apply_patch, coverage (record/update/list with needs_follow_up), finish (agent_finish/finish_scan, open_items), load_skill, mcp (list/describe/call), notes, proxy (Caido: list_requests HTTPQL, repeat, caido_api Python bindings), reporting (create/update_vulnerability_report, dependency, list/get), respond (respond_to_user), shell (exec_command+tty+write_stdin), thinking, threat_model (get/amend/save), todo, view_image, web_search.

**Output storage**: `output_store.py` — large outputs to disk + references; `nullish.py` — null normalization.

## 5. Skill system (76 knowledge packages, 11 classes)

`analysis/` (counterevidence, fix_verification, severity_calibration, source_aware_discovery), `cloud/` (aws/azure/gcp/kubernetes), `coordination/` (root_agent, source_aware_whitebox), `custom/` (api_spec_testing, dependency_cve_scanning, npx_confusion, source_aware_sast), `frameworks/` (django/fastapi/nestjs/nextjs), `protocols/` (graphql/oauth), `reconnaissance/` (asset_discovery, infrastructure_lifecycle), `scan_modes/` (quick/standard/deep/diff), `technologies/` (7), `tooling/` (13 engine handbooks), `vulnerabilities/` (29 vulnerability classes).

Format: YAML frontmatter (name/description) + Markdown body (attack surface/techniques/payloads/validation methods). Injection: preloaded (order above) + dynamic load_skill; subagent creation pins `skills=[...]` (cap 5).

## 6. Orchestration & lifecycle

- `factory.py`: agent instantiation (root/subagent, skill sets, mode flags)
- `core/runner.py` + `execution.py`: agent loop and tool dispatch
- `core/sessions.py`: run sessions
- The reporting agent owns registration exclusively (leaf agents never read list_reports — separation of duties)
- `finish_scan`/`agent_finish` is the only exit; open_items escalates pending items

## 7. LLM layer

- LiteLLM routing: `STRIX_LLM` (`deepseek/deepseek-chat` etc.), `LLM_API_KEY`, `LLM_API_BASE` (aliases OPENAI_API_BASE/LITELLM_BASE_URL/OLLAMA_API_BASE), `LLM_EXTRA_HEADERS`
- Dedup model: `STRIX_DEDUPE_MODEL` (independent duplication judge, independent key/base)
- Budget: `--max-budget` (USD, root+children cumulative; headless stops cleanly at the threshold; **90% reserved for subagents**, leaving root enough to report); `--max-turns` 500/agent default
- `compaction.py`/`context_budget.py`: context compression and budgeting
- Telemetry: PostHog/OTel, events written to `strix_runs/<run>/events.jsonl`

## 8. Runtime

- One shared Kali container; first run pulls the `ghcr.io` image; `/workspace` shared volume; pentester user (sudo)
- `strix_runs/<run>/`: incremental persistence (findings/events/reports); `strix view` local dashboard
- Headless exit codes: 0=no findings / 2=findings / 1=fatal error
- CI: GitHub Actions, PR-diff scoping, SARIF

## 9. Porting verdicts for StriX-DH

**Ported**: methodology (closure/CVSS binding/ten primary classes/7-step method), report contract, coverage/threat-model/notes state models, skill content, containerized-execution philosophy.
**Replaced with dsh native**: orchestration (subagent/workflow), compaction, todo, web_search, MCP, TUI/WebUI, persistence.
**Not ported**: ApiProxy-class internal protocols, the cloud platform, deep Caido binding (covered since v0.7.0 by the mitmproxy sidecar instead), "REFUSAL AVOIDANCE"-style adversarial wording (an honesty problem without platform-grade scope verification).
**Phase 2 items, all landed**: root/operator dual personas (agent presets), budget management (explicit ledger on top of token-meter), interception proxy (mitmproxy sidecar).
