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
| `<root_agent_directive>` (orchestrator-not-hands-on) | ✅ **Landed (presets/ dual personas)**: the `strix` preset persona is now the Orchestrator (plan/delegate/adjudicate/report), `strix-operator` is the pure-executor persona (hands-on, no planning, no delegation, scope changes reported up). Note: alpha.5 subagents inherit the parent composition, so the split only takes effect for manually opened parallel sessions |
| `<communication_rules>` | dropped as a section — dsh owns turn/communication semantics natively; BUT its autonomy core is re-implemented as the AUTONOMY discipline (see below), because dsh semantics are inverted vs Strix (plain text ENDS the turn here) |
| AUTONOMOUS BEHAVIOR | ✅ **Landed (dsh-equivalent translation)**: methodology + all three personas (orchestrator/operator/dispatch row) carry the rule — ending a turn with a question/summary hands control over and halts the engagement, so always close with a tool call; competing options advance autonomously by priority (① issued test accounts → ② in-scope low-rate validation → ③ new baselines), deferred items filed as `needs_follow_up` rather than asked; only missing/expired authorization or unresolvable targets legitimately stop. `methodologySection` regression test pins the key sentences; a real-workspace headless run advanced 11 surfaces with zero questions |
| SYSTEM-VERIFIED SCOPE / AUTHORIZATION / REFUSAL AVOIDANCE | ✅ **Landed (conditional form)**: the `strix:authorization` section renders three states — no attestation: passive reminder; live attestation: facts + the refusal-avoidance passage (in-scope validation is authorized security work, no self-classifying it as unauthorized/harmful, no generic policy warnings, continue with the most useful in-scope step when in doubt); expired `valid_until`: facts kept + expiry warning with fallback to passive-only. The difference from upstream's unconditional "never question your authority" is deliberate: a local tool has no platform-grade scope verification, so avoidance appears only while a live attestation covers the work and never widens "stay inside targets". See `src/tools/authorization.ts` (`renderAuthorizationSection` + `isAuthorizationExpired`). |
| THOROUGH VALIDATION / closure discipline | ported: confirmed / ruled_out / open_proof_gap triad, "missing information is NOT proof of safety" |
| ASSESSMENT METHODOLOGY (7 steps) | ported (recon-first, iterate, impact documentation) |
| VALIDATION REQUIREMENTS / CVSS binding | ported: every non-None CVSS metric maps to demonstrated PoC evidence; enforced structurally by `strix_finding` (strict mode rejects evidence-less filings) |
| counterevidence pass | ported (field + prompt rule) |
| COVERAGE / THREAT MODEL state rules | ported as tool usage rules (`strix_coverage`, `strix_threat_model`) |
| `<vulnerability_focus>` ten primary targets | ported verbatim (IDOR, SQLi, SSRF, XSS, XXE, RCE, CSRF, race conditions, business logic, auth/JWT) |
| `<multi_agent_system>` workflow rules | ✅ **Partially landed**: persona split done (orchestrator dispatches via dsh native subagent, operator sessions run manually in parallel); Strix's fixed workflow rules not ported — dsh's workflow/ralph machinery is invoked on demand by orchestrator sessions |
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
