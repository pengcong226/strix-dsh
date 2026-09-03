# Prompt Design: how the Strix methodology lives in StriX-DH

This document maps every prompt/methodology asset from upstream Strix to its
StriX-DH location, and explains the assembly mechanics. It is the review
surface for anyone auditing how the agent is instructed to behave.

## Layer 1 — always-present methodology (system prompt section)

`packages/strix-tools/src/index.ts` → `methodologySection()` registers a
`systemPrompt.section({ name: 'strix:methodology', order: 100 })`, which lands
after the deployment persona (order 0) and before plan/tool sections (500+).

Content adapted from upstream `strix/agents/prompts/system_prompt.jinja`
(545 lines):

| Strix section | StriX-DH treatment |
|---|---|
| persona statement | condensed into the section opener ("authorized security validation agent") |
| `<root_agent_directive>` (orchestrator-not-hands-on) | ✅ **已落地（presets/ 双人设）**：`strix` preset persona 改为 Orchestrator 定位（规划/派发/裁决/汇总），`strix-operator` 为纯执行 persona（动手、不规划、不派发、范围变更上报）。注：alpha.5 子代理继承父组合，拆分只对手动并行会话生效 |
| `<communication_rules>` | dropped — dsh owns turn/communication semantics natively |
| SYSTEM-VERIFIED SCOPE / AUTHORIZATION / REFUSAL AVOIDANCE | ✅ **已落地（条件版）**：`strix:authorization` section 三态渲染——无授权=被动提醒；有未过期授权=事实+ refusal-avoidance 段（范围内验证是已授权安全工作，不自我归类为未授权/有害，不做通用政策警告，拿不准时继续最有用的范围内步骤）；`valid_until` 过期=事实保留+过期警告并退回被动。与上游无条件版"never question your authority"的差异是故意的：本地工具无平台级 scope 验证，avoidance 只在有效授权存续期内出现、且永不放宽 "stay inside targets"。见 `src/tools/authorization.ts`（`renderAuthorizationSection` + `isAuthorizationExpired`）。 |
| THOROUGH VALIDATION / closure discipline | ported: confirmed / ruled_out / open_proof_gap triad, "missing information is NOT proof of safety" |
| ASSESSMENT METHODOLOGY (7 steps) | ported (recon-first, iterate, impact documentation) |
| VALIDATION REQUIREMENTS / CVSS binding | ported: every non-None CVSS metric maps to demonstrated PoC evidence; enforced structurally by `strix_finding` (strict mode rejects evidence-less filings) |
| counterevidence pass | ported (field + prompt rule) |
| COVERAGE / THREAT MODEL state rules | ported as tool usage rules (`strix_coverage`, `strix_threat_model`) |
| `<vulnerability_focus>` ten primary targets | ported verbatim (IDOR, SQLi, SSRF, XSS, XXE, RCE, CSRF, race conditions, business logic, auth/JWT) |
| `<multi_agent_system>` workflow rules | ✅ **部分落地**：persona 拆分完成（编排者用 dsh 原生 subagent 派发，执行者会话手动并行）；Strix 的固定 workflow 规则未移植——dsh 的 workflow/ralph 机制由编排者会话按需调用 |
| `<environment>` sandbox inventory | replaced by reality: dsh host composition (bash/pwsh/read/edit/...) + StriX-DH tools + configurable container images |
| `<specialized_knowledge>` / `<available_skills>` | replaced by dsh's native skill system (Layer 3) |

## Layer 2 — workspace instructions (AGENTS.md)

dsh's `dsh-agent-instructions` (on by default) loads `$DSH_HOME/AGENTS.md` and
the project chain of `AGENTS.md`/`CLAUDE.md` into the first request, within a
64 KiB budget. The repository root `AGENTS.md` carries engagement-level
operating instructions (workspace layout, tool etiquette, reporting flow) that
belong to the *project* rather than to the agent runtime.

## Layer 3 — on-demand knowledge (bundled skills)

`scripts/adapt_skills.py` mechanically adapts all 75 upstream Strix skill
packages (`strix/skills/**`, YAML frontmatter + Markdown) into
`packages/strix-tools/assets/skills/`:

- skill names normalized to dsh's kebab-case grammar
- 18 tool/lifecycle identifier mappings applied (e.g.
  `create_vulnerability_report` → `strix_finding`,
  `exec_command` → `strix_shell`, `caido_api` → `strix_http`,
  `load_skill` → dsh's native `skill` tool, `finish_scan` → plain engagement
  wrap-up semantics)
- per-file adaptation + license header injected

At plugin load, `src/skills-provider.ts` registers every skill through
`ctx.skills.register({ name, description, content, source: 'bundled' })`, so
the model sees them in its skill catalog and loads any of them on demand via
the native `skill` tool — the same dynamic-injection idea as Strix's
`load_skill`, on dsh's registry.

Adapted categories: analysis (4), cloud (4), coordination (2), custom (4),
frameworks (4), protocols (2), reconnaissance (2), scan_modes (4),
technologies (7), tooling (13), vulnerabilities (29).

## Dynamic assembly (roadmap)

`PromptSection.text` accepts a provider evaluated at each assembly with an
`AssembleContext`. The authorization section (`strix:authorization`, order 101)
already uses this to inject per-turn attestation facts; making the methodology
section itself target-aware (e.g. black-box vs white-box emphasis derived from
the target types the agent has recorded) remains open, mirroring Strix's
`_resolve_skills()` ordering (scan mode → tooling → analysis discipline →
coordination).

## What was deliberately NOT ported

- "NEVER wait for approval", "operate with full autonomy": inappropriate for a
  local tool without platform-verified scope. (Refusal-avoidance framing has
  since landed in conditional form — see the mapping table above; only the
  unconditional "never question your authority" stays out.)
- Caido/HTTPQL prompt material: covered since v0.7.0 by the `strix_proxy`
  sidecar (mitmproxy); only Caido-specific query-syntax text stays unported.
- Kali-inventory prompt text: replaced by actual composition reality.
