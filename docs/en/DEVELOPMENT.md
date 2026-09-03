# StriX-DH Developer Handbook

> **Who this is for**: developers or AI assistants taking over this project. After reading you should: (1) understand the Strix upstream's design and assets; (2) master the current dsh version's architecture and its "everything is a plugin" extension model; (3) know StriX-DH's current state, code conventions, and verification status; (4) be able to re-adapt quickly when dsh ships a new version.
>
> **Reading order**: §1 for the big picture → before doing development work, read §4 (dsh compatibility surface) and §5 (project status) closely → when upgrading dsh, run the upgrade drill in §3.9.
>
> **Companion deep-dives**: [strix-analysis.md](strix-analysis.md) (full Strix upstream analysis), [dsh-analysis.md](dsh-analysis.md) (full dsh runtime analysis), [tools-reference.md](tools-reference.md) (full contract of all tools with verified outputs), [walkthrough.md](walkthrough.md) (hands-on walkthrough from boot to first report), [skills-catalog.md](skills-catalog.md) (75-skill catalog), [prompt-design.md](prompt-design.md) (prompt asset map).
>
> **Authority ranking for information** (higher wins on conflict): runtime artifacts (node_modules in the npx cache) > upstream repo source at the matching tag > generated catalogs (tool-catalog / persistence-catalog / config-catalog, kept in sync with code by `pnpm run verify-*`) > README/design notes > this handbook.
>
> Baseline: dsh CLI **`0.1.2-alpha.5`** (released 2026-09-02, upgraded from alpha.3 on 2026-09-03 with zero code changes passing the full smoke suite). dsh is in developer preview — **a heavily changed release every few days is normal**, and §3.9 exists for exactly that.
>
> *Translator's note: where the Chinese edition's tool counts lagged behind the suite's growth, this translation uses current numbers (16 tools as of plugin v0.10.0).*

---

## 1. Project positioning & architecture overview

**In one sentence**: StriX-DH decomposes the capabilities of [Strix](https://github.com/usestrix/strix) (Apache-2.0, AI pentest platform) — tools, methodology prompts, knowledge packages — into **native plugins** for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) (MIT, general-purpose agent runtime), so dsh's agent loop, subagent orchestration, persistent memory, and WebUI gain pentest capabilities directly.

**Design principle**: no "two processes remote-controlling each other". dsh is the only brain; Strix serves purely as the porting source for code and content, with zero runtime dependency. Pentest capability is not a sidecar service but an ordinary plugin row registered into dsh's capability registries — that is what "everything is a plugin" means.

**Three porting layers**:

| Layer | Content | dsh mount mechanism | Code location |
|---|---|---|---|
| Tools | 15 `strix_*` tools | `ctx.tools.register(defineTool(...))` | `packages/strix-tools/src/tools/*.ts` |
| Prompts | Methodology discipline (closure triad, CVSS-evidence binding, recon-first) | `ctx.systemPrompt.section({ name:'strix:methodology', order:100 })` | `src/index.ts` |
| Knowledge | 75 attack-technique knowledge packages (adapted from Strix skills) | `ctx.skills.register({ name, description, content })` | `src/skills-provider.ts` + `assets/skills/` |

**Directory map**:

```
strix-dsh/
├── README.md / README.zh.md     # bilingual docs (EN/ZH)
├── LICENSE (Apache-2.0) / NOTICE # license + Strix/dsh attribution
├── AGENTS.md                     # workspace instructions auto-loaded by dsh agent-instructions
├── docs/
│   ├── architecture.md           # runtime mechanics (import redirection, version pins, section order)
│   ├── safety.md                 # authorized-use red lines
│   ├── prompt-design.md          # Strix prompt assets → project map (incl. "deliberately not ported" list)
│   └── DEVELOPMENT.md            # this handbook
├── packages/strix-tools/         # the dsh bundle (only publishable package)
│   ├── package.json              # dsh.bundle manifest declaration
│   ├── cordis.patch.yml          # patch layer (plugin row referenced by package name)
│   ├── src/
│   │   ├── index.ts              # plugin entry: registers all tools + methodology section
│   │   ├── config.ts             # schemastery config schema (every tunable)
│   │   ├── skills-provider.ts    # registration logic for the 75 knowledge packages
│   │   ├── lib/util.ts           # workspace resolution, process wrapper, dockerRun, binary discovery
│   │   └── tools/                # tool modules (one register(ctx,config) per file)
│   └── assets/skills/            # adapted knowledge packages + manifest.json (script output)
├── scripts/adapt_skills.py       # mechanical Strix knowledge-package adapter
├── upstream/                     # dev-time reference clones (gitignored, never published)
│   ├── strix/                    # full Strix source
│   └── deepseek-harness/         # full dsh source (master — may run ahead of the baseline)
└── dsh-boot.log                  # latest boot log (with the WebUI token)
```

---

## 2. Full Strix upstream analysis

Source: `upstream/strix/` (Python, packaged as a CLI via PyInstaller, Bubble Tea TUI). Upstream moves fast; this section is based on the master snapshot at porting time (2026-09).

### 2.1 Package layout (11 subdirectories under `strix/`)

| Directory | Responsibility | Porting status |
|---|---|---|
| `agents/` | agent construction: `prompts/system_prompt.jinja` (545-line system prompt), `prompt.py` (Jinja rendering + skill-injection ordering), `factory.py` (agent instantiation) | Prompts + injection logic adapted into the methodology section + prompt-design.md |
| `tools/` | 17 tool modules (see 2.3) | Natively rebuilt where dsh already covers them, see the 2.3 table |
| `skills/` | 11 categories, 76 knowledge packages (YAML frontmatter + Markdown) | 75 mechanically adapted as bundled skills (excluding README) |
| `core/` | `agents.py`/`runner.py`/`execution.py`/`sessions.py` — Graph-of-Agents orchestration & execution | **Not ported** — dsh's agent-loop/subagent/workflow natively take over |
| `llm/` | `compaction.py`, `context_budget.py`, `warmup.py` | **Not ported** — dsh ships `compaction-basic`, `token-meter` |
| `report/` | report generation | Logic referenced, rewritten as `strix_report` |
| `runtime/` | Docker sandbox lifecycle | Referenced then simplified: `strix_shell`/`strix_pybox` one-shot containers |
| `config/` | scan configuration | Referenced then simplified into the plugin Config |
| `interface/` | TUI (Go Bubble Tea) | **Not ported** — dsh WebUI instead |
| `telemetry/` | PostHog/OTel | Not ported (StriX-DH disables telemetry) |
| `utils/` | misc | As needed |

The repo root also holds `containers/` (Kali sandbox image with the full nmap/subfinder/naabu/httpx/gospider/nuclei/sqlmap/trivy/wapiti/ffuf/dirsearch/katana/arjun/semgrep/ast-grep/tree-sitter/bandit/trufflehog/gitleaks/jwt_tool/wafw00f/interactsh-client/Caido CLI inventory) and root-level `skills/` (9 SKILL.md files for coding agents — a different artifact from `strix/skills`, not ported).

### 2.2 The system prompt (the single most important asset)

`system_prompt.jinja`'s ten-section structure (porting map in `docs/prompt-design.md`):

1. Persona statement ("authorized security validation agent")
2. `<root_agent_directive>` — root orchestrates, never hands-on (**ported via the dual-preset split, see roadmap**)
3. `<core_capabilities>`
4. `<communication_rules>` — with interactive/autonomous branches (**not ported**, dsh owns turn semantics)
5. `<execution_guidelines>` (largest section) — SYSTEM-VERIFIED SCOPE, authorization/refusal-avoidance (**deliberately not ported**, see the rationale in prompt-design.md), THOROUGH VALIDATION, test modes (black-box/white-box/combined), 7-step assessment methodology, efficiency tactics (scripted payload sprays, skill preloading), VALIDATION REQUIREMENTS (**CVSS metrics must map to PoC-demonstrated evidence**), the closure triad, coverage/threat-model state rules, state-tool usage contracts
6. `<vulnerability_focus>` — ten primary vulnerability classes + validation escalation ladder
7. `<multi_agent_system>` — 3-agent chain (discovery→validation→reporting), one-agent-one-task, ≤5-skill specialization, nested trees, 2000+ step persistence
8. `<environment>` — Kali tool inventory, Caido HTTPQL, error-page recognition
9/10. `<specialized_knowledge>` / `<available_skills>` — dynamic skill injection

`prompt.py`'s `_resolve_skills()` is authoritative for injection ordering: requested → `scan_modes/<mode>` → `scan_modes/diff` (layered on diff scope) → `tooling/agent_browser` → `tooling/python` → `analysis/counterevidence` → `analysis/severity_calibration` → `coordination/root_agent` (root only) → white-box set. **StriX-DH's counterpart**: the methodology section (always-on) + 75 skills loaded on demand through dsh's `skill` tool; "dynamically selecting the injection set by target traits" is a roadmap item (dsh section `text` supports provider functions — the official channel is confirmed).

### 2.3 Tool layer: 17 Strix modules → StriX-DH tools

| Strix module | Function | StriX-DH destination |
|---|---|---|
| `shell` | exec_command + tty/write_stdin (inside Kali container) | `strix_shell` (one-shot Docker container) + dsh native bash/pwsh/terminal_* |
| `agent_browser` | Playwright, `--session` isolation | `strix_browser` (session-parameter isolation, ctx.effect cleanup) |
| `proxy` | Caido intercept proxy + HTTPQL + `caido_api` | `strix_proxy` (mitmproxy sidecar + flow queries + replay); v1 covered the core use case with `strix_http` raw replay |
| `apply_patch` | white-box fixes | dsh native edit/str_replace_editor |
| `agents_graph` | create_agent/view_agent_graph/wait/stop | dsh native subagent/subagent-control/workflow |
| `reporting` | create/update_vulnerability_report, dependency, list/get | `strix_finding` (create/update/list/get) + `strix_report` |
| `coverage` | record/update/list_coverage | `strix_coverage` (ledger.jsonl) + session-log mirror |
| `notes` | shared scratchpad | `strix_notes` + session-log mirror |
| `threat_model` | get/amend/save | `strix_threat_model` |
| `todo` / `thinking` / `finish` / `respond` / `view_image` / `web_search` / `load_skill` / `mcp` / orchestration beyond coverage | | dsh native (todo_write, skill, web_search, read_image, subagent, MCP client); the `finish` lifecycle is replaced by dsh turn semantics |
| (no counterpart) | | `strix_runs` (workspace overview, new), `strix_sast` (nuclei/semgrep wrapper), `strix_pybox` (Python sandbox), `strix_authorization` (authorization attestation), `strix_budget` (spend ledger) |

### 2.4 Report contract (must stay faithful when porting)

- A vulnerability exists **only** once registered via `strix_finding`; mentioning it in conversation does not count
- Every non-None CVSS C/I/A metric must map to PoC-demonstrated evidence; scanner labels, reachability, and theoretical follow-on attacks justify no metric by themselves
- `counterevidence` (the counter-case) and `confidence` (honest grading, static-only traces rate medium at best) are first-class fields
- White-box: fixes ship once, at report time (`code_locations` fix_before/fix_after + `fix_pr_body`) — no "fix agent" re-deriving them
- Dedup: after a rejection, revise with update (carrying update_reason), never re-file
- Closure triad: `confirmed` / `ruled_out` (must name the specific control) / `open_proof_gap`; "no information" ≠ safety

---

## 3. dsh deep dive (baseline 0.1.2-alpha.5)

### 3.1 Release model & version reality

- Monorepo (pnpm workspace), `@deepseek-ai/*` packages on npm; the CLI package `@deepseek-ai/dsh` pins all its deps to the `^0.1.2-alpha.x` range → **installing the CLI resolves internal packages to the newest of that alpha line** (the alpha.3 CLI actually carries dsh-tools alpha.5).
- **No CHANGELOG**. Cross-version diffs come from: GitHub release notes, commit history, and three generated catalogs (`docs/tool-catalog.md`, `docs/persistence-catalog.md`, `docs/config-catalog.md`, kept in sync with code by `pnpm run verify-*` scripts).
- `.agents/notes/implemented/` holds dated design notes (Agent Notes) — authoritative for "why it was designed this way".
- Measured drift: **the full type-definition diff of dsh-tools alpha.3 ↔ alpha.5 is zero**; CLI alpha.3→alpha.5 only raised internal dependency floors. Conclusion (so far): plugin-visible APIs are stable within one alpha line; breaking changes happen at rc→alpha or major-alpha boundaries.

### 3.2 Composition model: profile / bundle / patch

- **bundle**: an npm package declaring `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` in package.json; the patch is a row list of `- insert: [- id, name(by package name), config?, disabled?]`.
- **profile**: `$DSH_HOME/profiles/<name>/`, maintained by `dsh plugin --profile <name> add <source>` (pnpm under the hood; git sources need a `prepare` build script + the user allowing builds in the profile's `pnpm-workspace.yaml` `allowBuilds`). The profile's `dsh.profile.bundles` records the ordered bundle stack.
- **Load order**: dsh-base → bundles (in join order) → the profile's own `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. **A later layer replaces a whole same-id row from earlier layers** (no deep merge).
- **CLI semantics**: `--profile` is a top-level flag; `web` is just an alias of `--profile web` and **does not accept** `--profile`; one-shot tasks: `dsh --profile <name> "task text"` (headless preset semantics).
- Verification: `dsh --profile <name> --dump-config` shows the composed layers; the boot log shows plugin console output.

### 3.3 Boot flow & import redirection (the key to no dual instances)

`dsh-app-boot`'s `mountRootInclude` overrides Include's `import()`: **every bare specifier in plugin modules (e.g. `@deepseek-ai/dsh-tools`) is redirected to the runtime's own node_modules** (`bareModuleBaseUrl`); only relative paths and the `cordis:` prefix resolve locally. Meaning:

- Framework deps in the plugin's package.json serve **local tsc type-checking and IDE only**; execution always uses the runtime's copies.
- So local pins must match **the versions the runtime actually carries** (check with `node -e "require('<npx-cache>/@deepseek-ai/dsh-tools/package.json').version"`).
- After a dsh upgrade, if registration shapes mismatch, the first suspect is "local type version vs runtime version" drift.

### 3.4 Capability seam panorama (ctx.* at a glance)

| seam (inject key) | Purpose | StriX-DH usage |
|---|---|---|
| `tools` | `ctx.tools.register(defineTool)`; `schemas()` enumerable | ✅ 16 tools |
| `systemPrompt` | `section({name, order, text})`; `text` may be a provider function (evaluated per assembly, supports `{{var}}` interpolation); `getSectionOrder(name)` | ✅ methodology section + authorization section (provider-form dynamic injection) |
| `skills` | `register(skill)` (direct) / `registerProvider` (lazy dir) / `registerRuntime` | ✅ 75 skills direct-registered |
| `shell` + `tool-bash`/`tool-pwsh` (incl. persistent/terminal_*) | host command execution; bash-sandbox variant offers narrowing + elevation (sandbox_permissions/justification) | Not used directly (we run self-managed Docker) |
| `jobs` (tool-jobs) | background job registry, `job_output`/`job_kill`/`job_list` | ✅ **Wired (0.5.0)**: `strix_shell background=true` goes through `ctx.jobs.start` (kind `strix-shell`, inject must include `'jobs'`, `@deepseek-ai/dsh-jobs` pinned exactly to the runtime version); dsh ships the management tools, nothing self-built |
| `subprocess`/`fs`/`fs-sandbox` | process & file capability seams | Indirect |
| `credentials` (credentials-local) | `$DSH_HOME/.credentials.yaml` (version:1, `refs:` keys + `records:` entries); resolution order: launch env > stored file > project/user .env | ✅ DEEPSEEK_API_KEY |
| `settings` (settings-file) | `~/.dsh/settings.yaml` hot-update docs, namespaced | Roadmap (attestation could move in) |
| `llm` + `llm-deepseek` + `llm-pi-ai` | route registration; deepseek-official direct route; pi-ai multi-provider/hand-declared gateway (hot-activated via the `llm-pi-ai:` settings section) | ✅ (user-side config) |
| `token-meter` | replay-aware token/context metering (`ctx.tokenMeter`) | Token counts only, no dollar prices, no pricing API (verified in source) → the spend ledger uses explicit bookkeeping, see the budget section of tools-reference |
| `sandbox`/`sandbox-policy`/`approval` | narrowed execution + approval elevation. `approval`: `ctx.approval.request({agent, toolName, callId?, reason?, signal?})` → `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`; policies `'ask'` (default, answerer waterfall, no answerer → fail-closed `unavailable`) / `'never'` (strict headless, every request `rejected`); the service auto-appends the `approval/asked`+`approval/decided` audit pair; WebUI/ACP surfaces ship interactive answerers | ✅ **Wired**: strix_shell/strix_pybox per-call approval gate (the `inject` array must contain `'approval'`, otherwise `ctx.approval` throws without-inject); `approvalGate` config `'always'\|'off'`; plugin-side ledger `evidence/log.jsonl` (see the approval-gate section of tools-reference) |
| `mcp-client` | external MCP server access | Not evaluated |
| `agent-presets` + `persona` | per-session composition (`agent.cordis.yml`: persona row + tool rows + skills); own presets live in `~/.dsh/.agent-presets/<id>/` | ✅ Shipped strix + strix-operator presets (see presets/README.md) |
| `workspace` (dsh-workspace) | **host-side UI grouping**, invisible to the model | N/A |

### 3.5 Tool-system contract (exact defineTool signature)

```ts
defineTool({
  name: string                      // globally unique
  description: string               // lands in the model system prompt — write behavioral rules, not feature lists
  parameters: ParameterSchemaSpec   // one spec per property; the root is an implicit open object
  output: {
    schema: ValueSchemaSpec         // canonical schema validating successful results
    render(args, value): ContentBlock[]  // pure function rendering model-visible content
    presentationMeta?(args, value)  // optional: WebUI card metadata
  }
  timeoutMs?: number                // cooperative timeout budget
  isConcurrencySafe?(args): boolean // whether it may join a parallel group
  async execute(args, exec: ToolRunContext): Promise<InferValue<output.schema>>
})
```

Pitfalls (every one verified by hitting it):

1. **Object-typed parameters must declare `additionalProperties: true|false` explicitly** — omission is a hard type error (`ObjectValueSchemaSpec` enforces it).
2. `execute(args)` arg types are **inferred** from parameters; object params infer as `Record<string, JsonValue>` — narrow complex data inside execute (the `raw as unknown as X` pattern).
3. `ToolRunContext` (second parameter) provides `signal` (cancellation), `rootCallId`/`token`, `deferContext()`, `concludeTurn()`.
4. `TOOL_ABORTED` is imported from `@deepseek-ai/dsh-tools` for abort states.
5. NodeNext ESM: **local relative imports must carry the `.js` suffix**.
6. Background jobs need `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { ... } }` augmentation.

### 3.6 system-prompt exact contract

- `section({ name(unique), order(finite number), text: string | ((ctx: AssembleContext) => string), complete? })`
- `SECTION_ORDERS` (measured on alpha.3): HARNESS_IDENTITY -1000 / HARNESS_SOURCE -900 / WEB_SURFACE -800 / **DEPLOYMENT_PERSONA 0** / PLAN_POLICY 500 / TEAM_POLICY 600 / PTC_ONLY 800 / FILE_REFERENCE 900 / TOOL_BASH 1000 / TOOL_PWSH 1010 / TOOL_READ 1100 … TOOL_JOBS 1600 / TOOL_WEB_SEARCH 2000 / TOOL_WORKFLOW 2600 / TOOL_SUBAGENT 2800 / TOOL_REPORT 2900 / TOOLS_SDK 5000 / STRUCTURED_OUTPUT 9900
- Duplicate-name registration throws; scoped (agent-preset scope) may shadow a global same-name section
- A preset's `dsh-persona` row shadows the global persona as `deployment:persona`; `complete: true` makes the persona the **complete** system prompt (suppressing other sections)
- Upgrade check: the `SECTION_ORDERS` table lives in `@deepseek-ai/dsh-system-prompt/lib/index.js`

### 3.7 skills exact contract

- Registration: `ctx.skills.register({ name(kebab-case, `/^[a-z0-9]+(-[a-z0-9]+)*$/`, underscores rejected), description, content, source?: 'bundled'|... })`
- Discovery (skill-filesystem provider): project `.dsh/skills/`, `.agents/skills/`; user `~/.dsh/skills/`, `~/.agents/skills/`
- The model loads them via the `skill` tool; frontmatter format (YAML `name`/`description` + Markdown body) is Strix-compatible

### 3.8 LLM configuration (user view)

- `llm-deepseek` (mounted by dsh-base by default): route=`deepseek-official`, `apiKeyEnv` defaults to `DEEPSEEK_API_KEY`, models `deepseek-v4-flash` (fast) / `deepseek-v4-pro` (strong), resolution order = launch env → credential store → .env
- `llm-pi-ai` (mounted alongside, zero routes while dormant): third-party routes are fully configured from WebUI **Settings→Models** (including hand-declared OpenAI-compatible gateway cards), or by writing the `llm-pi-ai:` section of `~/.dsh/settings.yaml`; keys live in the credential store, `settings.yaml` never holds key material; hot-applied
- The default model row (`agent-default-model`) is currently `deepseek-official/deepseek-v4-flash`

### 3.9 Upgrade drill (run when dsh ships a new version)

```sh
# 1. Predict the diff (no install)
diff <(npm view @deepseek-ai/dsh@<old> dependencies --json) \
     <(npm view @deepseek-ai/dsh@<new> dependencies --json)
npm view @deepseek-ai/dsh-tools@<new-line> versions   # did framework packages cross lines?

# 2. Install the new CLI (npx cache isolation, no cross-contamination)
npx -y @deepseek-ai/dsh@<new> --version

# 3. Check the compatibility surface (§3.5–3.7 signatures; ground truth = the .d.ts files in the new runtime's node_modules)
#    - defineTool / ParameterSchemaSpec (is additionalProperties on objects still mandatory?)
#    - ctx.systemPrompt.section signature and SECTION_ORDERS
#    - ctx.skills.register SkillRegistration shape
#    - is app-boot's import redirection still there (search mountRootInclude / bareModuleBaseUrl)
#    - llm-deepseek's apiKeyEnv resolution order

# 4. Smoke (§4.5 verification matrix, in order)
npx -y @deepseek-ai/dsh@<new> --profile web --dump-config | grep strix
npx -y @deepseek-ai/dsh@<new> web --no-open        # watch the registration line in the boot log
dsh --profile headless "call strix_runs and quote its first line"

# 5. Generated-catalog diff (when working from source)
#    old-vs-new diffs of tool-catalog / persistence-catalog / config-catalog ARE the breakage list
```

**Upgrade decision rule**: zero type drift → bump only this handbook's version number; type drift but shape-compatible → update pins + handbook signatures; shape breakage → re-align per 3.5/3.6/3.7 + full smoke.

### 3.10 Failure-mode cheat sheet (every entry earned the hard way)

| Symptom | Root cause | Fix |
|---|---|---|
| Instant crash `EADDRINUSE 127.0.0.1:3080` | orphaned node from an old instance (TaskStop only killed the npx shell) | `netstat -ano \| findstr :3080` → `taskkill /F /PID` |
| Plugin ENOENT `assets/skills/manifest.json` | wrong `import.meta.url` relative depth (under dist/ it must be `../assets/`) | check the URL relative path |
| `Property 'skills' does not exist on type 'Context'` | missing `import type {} from '@deepseek-ai/dsh-skill'` type augmentation | add the side-effect type import |
| Type error on an object parameter | `additionalProperties` not explicit | schema mandates it |
| Tool registers but headless says "no such tool" | index.ts forgot to mount the register function | check against the §5.2 list |
| nuclei hangs to timeout | sandboxed child process cannot write its config dir (Access denied) | container-first (implemented) |
| Multi-line string syntax error | adjacent string literals missing `+` | TS has no continuation concatenation |
| GBK/encoding, PATH not taking effect | Git Bash session PATH not refreshed after install | absolute paths or a fresh shell |

### 3.11 Version history & diffs (npm latest `0.1.1-rc.2` → the alpha line)

> The npm `latest` tag still points at `0.1.1-rc.2`; bare `npx @deepseek-ai/dsh` installs rc.2. The alpha line needs an explicit version. Sources: GitHub releases + community tracker + Discussions #5397 (third-party plugin impact).

| Version | Key changes | Impact on StriX-DH |
|---|---|---|
| **0.1.2-alpha.1** (08-27, first after rc.2) | Code Mode renamed **PTC**; **ApiProxy removed** (moved to `@Remote` gateway); PTC SDK capabilities folded into `run_code`; web_fetch on by default (built-in SSRF guard); **WebUI switched to one-time token auth**; subagents accept provider/model/reasoning_effort; Python SDK Windows x64; ACP completion; **breakage: `SessionEvent.ignorable` removed** (restored in alpha.2); dsh-tools jumped to 0.1.2-alpha.1 so third-party plugins pinned to `^0.1.1-rc.2` failed importing `CallId` | Our runtime-aligned pins dodged the CallId-class incident exactly; methodology's "subagent dispatch" semantics gained (optional models) |
| **0.1.2-alpha.2** (08-30) | Restored `SessionEvent.ignorable`; connection-failure state + auto-reconnect UI; timed-plan display in the session title area; multimodality (image input, Trajectory images); Claude Code/Codex adapters folded into the subagent system; Windows terminal UX | No code impact |
| 0.1.2-alpha.3 (08-31) | Long-session pagination/memory optimization; queued-image delivery fix for running sessions; **optional SQLite session-persistence backend removed** (data kept, export with the old version first); permission-label localization | We use the JSONL default backend, unaffected; anyone with SQLite session data must export with the old version first |
| **0.1.2-alpha.4** (09-01) | **Main/sub-agent messaging switched to two-way `send_message` (replacing the one-way report tool)**; `Session.events` removed → on-demand `seq`/`eventAt()`/`snapshotEvents()` read APIs; `SessionSeq`/`SessionLogOffset` strong types; headless/ACP/custom profiles enable web_fetch by default; **web PTC Mode no longer exposes workflow tools by default**; custom model discovery reuses Profile request headers + directory search | **Methodology/skills must follow**: orchestration semantics follow two-way send_message; **roadmap item 5 (session-event persistence) must use the new API** (`snapshotEvents()`, not events reads); workflow references need visibility checks |
| **0.1.2-alpha.5** (09-02, pure fix) | Fixes only: upgrading from 0.1.1-rc.2 or alpha.3 could leave the app unbootable / session titles missing | No impact; **baseline migrated to alpha.5 on 2026-09-03** (this table was written when the baseline was alpha.3) |

**Version strategy for whoever takes over**: when upgrading the baseline, jump to the line's newest alpha first (alpha.5 fixed the upgrade-path bug); walk the "impact" column row by row; the third-party plugin incident (CallId) teaches = **framework dependency versions always track the versions the runtime actually carries** (see 3.3).

---

## 4. StriX-DH current state

**Plugin version history** (`packages/strix-tools` package.json version):

| Plugin version | Content |
|---|---|
| **0.11.1** (09-04) | **Review fix batch**: ID allocation collisions — `finding`/`notes`/`coverage` create switched from "file count + 1" to "max existing id + 1" (`nextIdAmong`/`nextSequentialId`) plus `writeExclusive` O_EXCL claims with collision retry (archiving/deleting a middle entry made the next id silently overwrite a live finding — reproduced); `strix_report` dropped every blank `''` separator line, collapsing report.md into lazy list continuations with `---` parsed as a setext H2 — fixed with `join` + conditional pushes for optional fields; `strix_finding update` now validates severity/type enums and refuses to empty evidence under strict mode; `validateFinding` accepted whitespace-only evidence (`!'   '` is false) — trimmed check; POST counting moved to an **append-only JSONL** ledger (`http-post-counts.jsonl`, removes the read-modify-write window; the legacy `.json` is merged read-only so budgets survive the upgrade); `checkDuplicate` manifest mismatch `return`→`continue` (no longer short-circuits later findings, reason keeps the manifest context); `skills-provider` is fail-soft (corrupt manifest warns and registers 0, bad/duplicate entries skipped — no more profile-killing bundle assets); `runProcess` timeouts reap the whole process tree (POSIX `detached` + `kill(-pid)`, Windows `taskkill /T /F` via **spawnSync** — the async version lost a race against the `child.kill()` fallback, cmd died before taskkill could enumerate, verified settle 29.4s→1.1s); `readKevCache` dead branch removed + `fetched_at` NaN / `cves` array guards. 21 unit cases, vitest 100 cases (+1 platform skip) |
| **0.11.0** (09-04) | **Five field-retro items (jxnu 120-site session-export analysis)**: coverage gains `ruled_out` (triage closure: pure info-only sites close after 1–2 baseline GETs with a named reason, no new batches) + methodology TRIAGE / BLOCKED-SECOND-PATH / ENGAGEMENT-ISOLATION sections + `strix_http` POST three branches (pre-approved direct / live-authorization non-preapproved direct with audit stamp + per-path counter with `httpPostCapPerPath`=5 circuit breaker) + `authorization.json` `test_accounts` vault (get to fetch, masked in prompt/report) + report gains authorization summary section and workspace path + preset single-layer delegation discipline (`strix_operator` leaf, ≤6 per wave, no polling). 8 unit cases, vitest 79 cases |
| **0.10.2** (09-04) | **"You decide" eradication (five Strix layers, dsh translation)**: user screenshots showed two live "pick one of three, you decide" stalls — 0.10.1 said "don't ask" but not "check pre-approvals first when blocked". Methodology gains the APPROVAL-OR-ACT tree (four pre-approval sources: issued accounts / in-scope low-rate / pre-approved POST / pre-approved shell — use if any, file block + continue next-best in the same turn otherwise) + TURN-CLOSE template (closing tool list); operator HANDOFF FORMAT (agent_finish equivalent: Tested/Findings/Open items/Recommendations, blocked items never halt); `authorization.json` gains `pre_approved_post_paths` (POST-only proof pre-clearance), `strix_http` POST hits stamp a clearance line. 3 unit cases, vitest 70 cases; pre-approval chain verified live (set→get→POST clearance) |
| **0.10.1** (09-04) | **Full autonomy (Strix approach, dsh translation)**: after reading upstream `system_prompt.jinja` (AUTONOMOUS BEHAVIOR + plain-text-never-ends-turn lifecycle semantics), root-caused the stalls — dsh semantics are inverted (plain text hands control over), so removing the ask tool was insufficient. AUTONOMY discipline injected uniformly into the methodology + all three personas (always close with a tool call; three-option priority self-advance; only authorization/target stops are legitimate). `methodologySection` regression test, vitest 67 cases; real-workspace headless run advanced 11 surfaces with zero questions |
| **0.10.0** (09-03) | **AI-tooling vulnerability database**: new `strix_depcheck` tool (OSV querybatch primary → vulns/{id} detail → KEV cache hit → EPSS ordering; KEV snapshot in workspace/vulndb/kev.json with 24h TTL; results feed `strix_finding dependency_cve` + `dedupe-check` identity); `strix_sast` nuclei containers mount the `strix-nuclei-templates` named volume (daily upstream merges survive `--rm`). 4 unit cases, vitest 66 cases; lodash@4.17.20 returned 5 vulns (CVE/EPSS/fixed) + 1694-entry KEV cache + dedupe chain verified live |
| **0.9.0** (09-03) | **Pentest ergonomics loosening**: `strix_shell` image allowlist enforced only when unattended (approvalGate off); with human approval the image name rides the approval summary for the operator to decide. `strix_sast` extra_args blocklist narrowed to three classes (retargeting / rate-limit-concurrency / engine config); template selection, output formats, and proxy routing fully open. New `approvalAutoAllow` (regex pre-approval, default empty = unchanged behavior, hits logged as `auto-allowed`). 3 unit cases, vitest 62 cases; `-t cves/` pass + `-rl` still-blocked verified live |
| **0.8.2** (09-03) | **Full-project review security fixes**: `safeId`/`safeWorkspacePath` (util.ts) close four path traversals (http save_to writing outside the workspace, finding get/update bad ids, notes get/update/delete bad ids, browser session names into screenshot filenames); `strix_shell` image allowlist (`shellAllowedImages` config, default shellImage only); `strix_sast` extra_args dangerous-flag blocklist + nuclei severity allowlist; browser sessions' process-global sharing documented. 6 unit cases, vitest 59 cases; all four guards verified live via headless (verbatim REJECTED quotes) |
| **0.8.1** (09-03) | **REFUSAL AVOIDANCE, conditional form**: the `strix:authorization` section renders three states (no attestation: passive reminder; live attestation: facts + the refusal-avoidance passage; expired: warning + passive fallback), with the `isAuthorizationExpired` pure helper; upstream's unconditional "never question authority" stays out — deliberately (no platform-grade scope verification locally). 3 unit cases, vitest 53 cases, live render verified |
| **0.8.0** (09-03) | **Reporting pipeline trio + runs visibility**: `strix_report action=sarif` (SARIF 2.1.0 sidecar: rules/results/coverage/fixes, `src/tools/sarif.ts`, verified live at 3 rules 4 results on disk); `strix_finding action=dedupe-check` (deterministic dedup: same type + endpoint + text / same CVE + package, manifest-aware, verified `DUPLICATE of F-001` live); `strix_report action=finish` (root-only engagement close, four sections required, operator refusals point to send_message); `strix_runs` adds per-finding filed-report lines + budget status line; proxy description documents the no-scope-list difference from upstream Caido scope; vitest 50 cases |
| **0.7.0** (09-03) | **mitmproxy sidecar**: `strix_proxy` (start/status/list/get/replay/stop) + mitmdump container + addon persistence (flows.jsonl + .req/.rsp); replay reuses the shared `sendHttpRequest` (extracted via http.ts refactor); stop's two paths fixed a cross-process false negative; vitest 36 cases |
| **0.6.0** (09-03) | **Session-event mirror**: `src/lib/session-mirror.ts` extends `SessionEventMap` (`strix/coverage` + `strix/note`, log-only), best-effort append after successful coverage record/update and notes create/update/delete (swallowed on failure, files stay the source of truth); vitest 32 cases |
| **0.5.0** (09-03) | **Background mode**: `strix_shell background=true` via dsh jobs (kind `strix-shell`, `src/lib/jobs.ts` producer + streaming output + kill chain), managed by dsh's own `job_output`/`job_list`/`job_kill`; inject gains `'jobs'`, `@deepseek-ai/dsh-jobs` pinned exactly; vitest 28 cases |
| **0.4.0** (09-03) | **Spend ledger**: `strix_budget` tool (record/status/reset, ledger `workspace/budget.json`, DeepSeek V3.2 official default rates) + pre-execution budget gates on recon/sast (warn prefix / block refusal); 14 tools; vitest 25 cases |
| **0.3.0** (09-03) | **Authorization attestation layer**: `strix_authorization` tool (set/get/clear, attestation in `workspace/authorization.json`) + `strix:authorization` section (order 101, provider function dynamically injecting the "short factual version" every turn, passive-only reminder when unattested); methodology gains an "authorization discipline" entry; 13 tools; vitest 18 cases + CI (node 20/22 × ubuntu/windows) |
| **0.2.0** (09-03) | **HITL approval gate**: strix_shell/strix_pybox ask dsh ApprovalService per call (fail closed), `approvalGate: 'always'\|'off'` config, plugin inject gains `'approval'`, new `src/lib/approval.ts` with the `<workspace>/evidence/log.jsonl` ledger; methodology gains an "approval-gate discipline" entry |
| 0.1.0 | 12-tool first release + methodology section + 75 skills (alpha.3 → alpha.5 adaptation complete) |

### 4.1 Tool contract & verification matrix (16/16 registered; V = real LLM-call verified, D = direct-call verified, - = binary/target pending)

| Tool | Parameter highlights | Verification |
|---|---|---|
| `strix_runs` | no params | V (LLM quoted output verbatim) |
| `strix_http` | url/method/headers/body/raw_request/follow_redirects/timeout_ms/save_to | V (example.com 200; 427ms) |
| `strix_finding` | action=create/update/list/get/**dedupe-check**; **strict mode rejects evidence-less filings**; severity/type enum checks; deterministic dedupe-check (same type + endpoint + text / CVE + package) | V (F-001 registered; live `DUPLICATE of F-001` and `NOT A DUPLICATE` verdicts) |
| `strix_report` | engagement_title/scope_summary → report.md; **action=sarif** → findings.sarif (SARIF 2.1.0); **action=finish** (root-only, four sections required) | V (1-finding rollup; live sarif 3 rules 4 results on disk; finish operator refusal + root missing-section rejection) |
| `strix_coverage` | record/update/list; outcome ∈ clean/finding/needs_follow_up/blocked | V (C-001) |
| `strix_notes` | create/list/get/update/delete | V (N-001) |
| `strix_threat_model` | get/amend/save | V (baseline saved) |
| `strix_authorization` | set/get/clear; attestation in `workspace/authorization.json`; `strix:authorization` section (order 101, provider dynamic injection) | V (headless: get empty → set persisted → clear revoked; 3 unit cases: empty render/round-trip/corrupt-file fail-safe) |
| `strix_shell` | command/timeout_ms/image/network/workdir/**background**; one-shot container, workspace mounted at /workspace; **approval gate** | V (uname/python3.12.14/whoami; two approval paths verified; three background paths: job start → job_output reads output exit 0 → job_kill terminates) |
| `strix_pybox` | script/files/install_packages/arguments/timeout_ms/network; **same approval gate as shell** | V (args.json injection round-trip; gate logic shares `createApprovalGate` with shell) |
| `strix_browser` | action=navigate/click/fill/evaluate/screenshot/content/close; session isolation | V (navigate + screenshot to disk + close) |
| `strix_recon` | domain/skip_httpx/timeout_ms; **budget gate** | V (subfinder 24,948 subdomains to disk; httpx same mechanism, not separately tested; block-refusal evidence on the budget row) |
| `strix_sast` | engine=nuclei/semgrep; nuclei container-first (host-binary fallback); semgrep container fallback; **budget gate (warn prefix / block refusal)** | V (nuclei container scan exit 0; semgrep container exit 0 against own source) |
| `strix_budget` | record/status/reset; ledger `workspace/budget.json`; `budgetLimitUsd`/`budgetInputPer1k`/`budgetOutputPer1k`/`budgetAction` | V (headless: status empty → record $0.0175 → recon refused `BUDGET EXCEEDED` under a $0.0001 cap → reset zeroed; 7 unit cases) |
| `strix_proxy` | start/status/list/get/replay/stop; mitmdump container sidecar + addon persistence; replay via the shared sender | V (headless: start :18080 → curl GET example.com through proxy → flows.jsonl + .req/.rsp on disk → list/replay `HTTP 200 OK` → cross-process `docker stop`; 4 unit cases) |
| `strix_depcheck` | action=check/kev-refresh/status; packages `[{ecosystem,name,version}]`; OSV primary + KEV cache (vulndb/kev.json 24h TTL) + EPSS ordering | V (headless: status missing → kev-refresh 1694 → lodash@4.17.20 check returned 5 vulns with CVE/EPSS/fixed → dedupe-check NOT A DUPLICATE chain; 4 unit cases) |

### 4.2 Full config table (`src/config.ts`)

`workspaceDir` (empty = anchored at `~/.dsh/strix-workspace`), `httpTimeoutMs` 30s, `httpMaxBodyChars` 20k, `shellImage` python:3.12-slim, `shellAllowedImages[]` (enforced only when unattended with approvalGate off; attended runs show the image in the approval prompt for the operator to decide), `shellNetwork` true, `shellTimeoutMs` 120s, `pyboxImage`, `pyboxExtraPackages[]`, `pyboxNetwork` true, `pyboxTimeoutMs` 60s, `binariesDir` (empty = look in `~/.dsh/bin` then PATH), `reconTimeoutMs` 300s, `nucleiRateLimit` 50, `browserHeadless` true, `strictEvidence` true, `approvalGate` `'always'` (HITL approval gate, `'off'` = unattended at your own responsibility), `approvalAutoAllow[]` (regex pre-approval, default empty = no loosening, hits logged as `auto-allowed`). The authorization attestation is **not in config** — it is per-engagement fact, stored in `workspace/authorization.json` (see the authorization section of tools-reference).

### 4.3 Known defects & tech debt (honest list)

1. `strix_recon`'s httpx phase not independently verified (same runProcess mechanism, low risk)
2. Every `strix_shell` call is a fresh container — no persistent sessions; durable state via workspace files (Strix has PTY persistent sessions)
3. `strix_browser` sessions live in plugin-process memory, cleaned up only by the ctx.effect backstop; no idle reaping (Strix reaps after 3 minutes)
4. ~~Spend control was task-level only, no cross-turn dollar budget (dsh token-meter integration on the roadmap)~~ ✅ **Landed (0.4.0, explicit-bookkeeping mode)**: `strix_budget` + recon/sast over-budget warn/block
6. ~~Caido/mitmproxy interception not integrated (v1 covers replay with strix_http)~~ ✅ **Landed (0.7.0)**: `strix_proxy` + mitmdump Docker sidecar (see roadmap item 6)
7. Adapted skills are mechanical mappings, not yet hand-reviewed file by file for tool-name context
8. The WebUI interactive approval dialog not verified on this machine (answerer code in dsh-acp/api-remotes reviewed; both headless paths verified)

### 4.4 Local deployment state (2026-09-03)

Docker Desktop 29.7.2 (WSL2) ✅; `~/.dsh/bin/{subfinder,httpx,nuclei}.exe` ✅; Chromium (matching playwright 1.62.1) ✅; credential store holds DEEPSEEK_API_KEY ✅; profiles: web/strix/headless (all mount strix-tools) ✅; preset: `~/.dsh/.agent-presets/strix/` ✅; WebUI running (token in `dsh-boot.log`).

### 4.5 Smoke commands (run after every change)

```sh
cd packages/strix-tools && npm run build        # zero errors before continuing
dsh --profile web --dump-config | grep strix     # bundle layer present
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open > dsh-boot.log 2>&1 &
# boot log line 1 should read: [strix-dsh-tools] registered 16 tool modules + methodology + authorization sections + 75 skills
DEEPSEEK_API_KEY=... npx -y @deepseek-ai/dsh@0.1.2-alpha.5 --profile headless \
  "Call strix_runs once and quote its first line."
# approval-gate regression (default should DENY):
#   ... --profile headless "Call strix_shell once with command 'echo t'. Quote its output verbatim."
#   expected: DENIED ... (outcome: unavailable)   ← headless has no answerer, fail-closed
```

---

## 5. Roadmap

**Phase 2 (designs ready)**
1. ~~**Dual personas**: split the strix preset into root (orchestrator, borrowing root_agent_directive) and operator (hands-on), shadowed via `dsh-persona`; child agents inherit the parent composition~~ ✅ **Landed (presets/ directory)**: `strix` (orchestrator, full) + `strix-operator` (executor, minus delegation/workflow/goal/plan). Measured conclusion: alpha.5 children inherit the parent composition and dispatch cannot pick a preset, so the split only takes effect for manually opened parallel sessions (see presets/README.md)
2. ~~**Dollar budget**: `ctx.tokenMeter` metering + budget config, degrade/pause on breach~~ ✅ **Landed (0.4.0)**; remaining: automatic feeding once dsh opens a usage subscription
3. ~~**`strix_shell` background mode**: register a JobKindMap, manage with `job_output`/`job_kill`~~ ✅ **Landed (0.5.0)**: `background` parameter + `src/lib/jobs.ts` producer (kind `strix-shell`, streaming readOutput, cancel sends SIGKILL + 5s backstop settle against zombie entries)
4. ~~**attestation dynamic injection**: `strix_authorization` tool + section provider (short factual version; includes refusal-rate A/B measurement)~~ ✅ **Landed (0.3.0)**; remaining: refusal-rate A/B measurement
5. ~~**session-event persistence**: move coverage/notes to custom SessionEvents (keep file versions for compatibility)~~ ✅ **Landed (0.6.0, mirror mode)**: `src/lib/session-mirror.ts` extends `SessionEventMap` (`strix/coverage` + `strix/note`, log-only), best-effort append after record/update/create/delete; files stay the source of truth (read paths unchanged), mirror failures swallowed so they never break a call
6. ~~**mitmproxy sidecar**: intercept proxy + traffic query tool~~ ✅ **Landed (0.7.0)**: `strix_proxy` (start/status/list/get/replay/stop) + mitmdump container sidecar + `assets/mitmproxy/strix_addon.py` (flows.jsonl summaries + .req/.rsp persistence); replay via the shared `sendHttpRequest` (extracted in the http.ts refactor); stop's two paths (same-process pid kill + cross-process docker stop, fixed after one verified false negative)

**Phase 3**: CI/CD integration (PR diff scanning), full hand-review of adapted skills, more translated-language docs.

---

## 6. Pre-release checklist (open-source readiness)

- [x] vitest unit tests (70 cases, `packages/strix-tools/test/core.test.ts`) + kebab/adapt self-test (7 cases, `scripts/adapt_skills.py --self-test`, inside CI)
- [x] `.github/workflows/ci.yml` (build + test + adapt self-test, node 20/22, windows+ubuntu)
- [x] SECURITY.md / CONTRIBUTING.md (repo root; safety.md's "to be added" now points at SECURITY.md)
- [x] English docs (`docs/en/` complete coverage: tools-reference + walkthrough + DEVELOPMENT (this translation) + architecture + prompt-design + skills-catalog + dual analyses; safety is English-native)
- [x] Confirmed `upstream/` is in no published artifact (.gitignore + package files double cover, checked 2026-09-03); NOTICE and adaptation headers complete
- [x] Removed in-repo run traces (`dsh-boot.log`, `strix-workspace/`, etc. — 4 locations checked, all absent on 2026-09-03)

---

## 7. Three operating tips for the AI taking over

1. **Run the 4.5 smoke first** to establish a baseline before changing anything; for any "tool missing / wrong shape" symptom, check the §3.9 failure-mode table first
2. **Runtime artifacts are always ground truth**: this handbook was first written on 0.1.2-alpha.3 with the baseline migrated to alpha.5; dsh iterates extremely fast — run the `3.9 upgrade drill` before trusting the handbook
3. **Methodology is the product's soul**: when changing tools, re-check whether the mapping in `prompt-design.md` still holds — tool-name remappings are scattered across the 75 skill files (`scripts/adapt_skills.py`'s MAPPINGS table is the single source; changing a mapping means regenerating)
