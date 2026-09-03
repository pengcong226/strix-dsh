# StriX-DH Architecture & Runtime Mechanics

## Runtime baseline

| Component | Version | Notes |
|---|---|---|
| dsh CLI (runtime) | **0.1.2-alpha.5** | Dev baseline (upgraded from alpha.3 on 2026-09-03, plugin passed the full smoke suite with zero changes), invoked via `npx @deepseek-ai/dsh@0.1.2-alpha.5` |
| @deepseek-ai/dsh-tools | **0.1.2-alpha.5** | Aligned with the copy the runtime actually carries (the CLI's `^0.1.2-alpha.3`+ range resolves to alpha.5) |
| @deepseek-ai/dsh-jobs | **0.1.2-alpha.5** | Pinned exactly (background-mode producer); same alignment rule |
| @deepseek-ai/cordis | ^4.0.2 | |
| @deepseek-ai/schemastery | ^3.18.2 | |

> ⚠️ dsh is a developer preview: every CLI upgrade must re-verify all interface contracts in this document.

## Key mechanism 1: bare-import runtime redirection (no dual instances)

`dsh-app-boot` (app-boot/src/index.ts, `mountRootInclude`) overrides plugin module resolution: **every bare-specifier import in plugins (e.g. `@deepseek-ai/dsh-tools`) is redirected to the runtime's own copies** (`bareModuleBaseUrl`); only relative paths and the `cordis:` prefix resolve locally.

Meaning:
- Framework deps declared in our package.json serve **local tsc type-checking and IDE only**; execution always uses the runtime's copies.
- Bundles neither need to (nor should) chase the runtime's exact versions for runtime alignment — but to keep **type-checking consistent with the execution environment**, pins should still track the versions the runtime actually carries (check with `node -e "require('<npx-cache>/@deepseek-ai/dsh-tools/package.json').version"`).
- After a dsh upgrade, if tool registration shows shape mismatches, suspect runtime-alpha vs local-type drift first.

## Key mechanism 2: system-prompt injection

- seam: `inject = ['systemPrompt']` → `ctx.systemPrompt.section({ name, order, text })`
- `text` accepts a static string or a **provider function** (evaluated per assembly with the `AssembleContext`) — the official channel for "dynamic injection by target traits"; `{{variable}}` interpolation is handled by `renderPrompt`
- section order (measured on alpha.3): HARNESS_IDENTITY -1000 / DEPLOYMENT_PERSONA 0 / PLAN_POLICY 500 / TOOL_BASH 1000 / TOOL_PWSH 1010 / … / TOOL_SUBAGENT 2800 / TOOL_REPORT 2900 / STRUCTURED_OUTPUT 9900
- The StriX-DH methodology section uses **order 100** (after persona, before tool docs), name `strix:methodology`; the authorization section uses **order 101** as a provider function re-evaluated every turn

## Key mechanism 3: bundle & profile

- bundle = package.json declaring `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` + a patch layer (rows referencing plugins **by package name**) + compiled `dist/`
- Install: `dsh plugin --profile <name> add ./packages/strix-tools` (pnpm-links into the profile)
- Assembly order: dsh-base → bundles in join order → the profile's own cordis.patch.yml → `--patch` overlays
- Verify: `dsh --profile <name> --dump-config` shows the `# == strix-dsh-tools` layer; the boot log shows the `[strix-dsh-tools] registered …` line
- The `web` subcommand is an alias of `--profile web`; **the profile flag lives at top level**, `web` does not accept `--profile`

## Key mechanism 4: skill discovery paths (skill-filesystem provider)

- Project level: `<projectRoot>/.dsh/skills/` (rank: project-dsh), `<projectRoot>/.agents/skills/`
- User level: `$DSH_HOME/skills/` (default `~/.dsh/skills`), `~/.agents/skills/`
- Format: directory-style or flat Markdown + YAML frontmatter (name/description)
- StriX-DH's adapted knowledge packages ship **bundled** in the package (`assets/skills/`, registered via `ctx.skills.register`), so no `.dsh/skills` setup is needed

## State-tracking storage decision

Strix's coverage/notes/threat_model are shared mutable ledgers. StriX-DH keeps **workspace files** as the source of truth (findings/*.json, coverage/ledger.jsonl, notes/*.json, threat-model.md) — cross-agent sharing via the same workspace, cross-session survival via disk. Since v0.6.0, successful coverage/notes mutations additionally append a best-effort log-only mirror (`strix/coverage`, `strix/note` session events via `SessionEventMap` extension); reads still go to files only. See `src/lib/session-mirror.ts`.

## Deltas: workspace anchoring & binary discovery

- **Workspace default anchor**: empty `workspaceDir` resolves to `<DSH_HOME>/strix-workspace` (`~/.dsh/strix-workspace`), fully free of boot-directory dependence; explicit config overrides (relative paths still resolve against cwd).
- **Binary search order**: `binariesDir` config → `~/.dsh/bin` → PATH. `~/.dsh/bin` is the standard operator drop-point for engines (subfinder/httpx/nuclei are deployed there).
- **semgrep container fallback**: no native semgrep on Windows; `strix_sast engine=semgrep` automatically switches to the `returntocorp/semgrep` container with the target dir mounted at /src when no host binary exists (requires an absolute local target path).
- **nuclei container-first**: measured finding — nuclei inside dsh's sandboxed child processes cannot write its own config dir (`could not create config file: Access is denied`) and hangs to timeout. So `strix_sast engine=nuclei` is **container-first** (the official `projectdiscovery/nuclei` image ships its template library, no config-dir problem on Windows), host binary only as the no-Docker fallback. semgrep follows the same container-fallback pattern.

## Deltas: strix agent presets (session-level composition, everything-is-a-plugin)

Shipped in-repo under `presets/` (installed to `~/.dsh/.agent-presets/`), derived from the shipped standard preset:

- `presets/strix/` ("StriX-DH Orchestrator"): full composition — `dsh-persona` row (orchestrator discipline: plan/delegate/adjudicate/report, `{{model}}`/`{{cwd}}` interpolation) + `strix-tools` row + everything inherited from standard (fs/skill/jobs/delegation/compaction)
- `presets/strix-operator/` ("StriX-DH Operator"): hands-on composition — same tools, minus delegation/workflow/goal/plan; executes assigned tasks without planning or delegating
- Measured alpha.5 constraint: subagents **inherit the parent session's composition** (dispatch cannot pick a preset), so the split takes effect for manually opened parallel sessions only. See `presets/README.md`.

Pick the preset in the session selector to enter the corresponding mode. If a preset fails to load after a dsh upgrade, the roster reports the reason in the WebUI picker (discovery health — the same check scripted in `presets/README.md`).

## Verified boot checklist

```sh
cd packages/strix-tools && npm install && npm run build
dsh plugin --profile web add ./packages/strix-tools   # install into the web profile
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open > dsh-boot.log 2>&1
# boot log line 1 should read: [strix-dsh-tools] registered 15 tool modules (15 tools) + methodology + authorization sections + 75 skills
# WebUI: http://127.0.0.1:3080/?token=<token from the boot log>
```

Note: on Windows, TaskStop/killing the npx shell can leave an orphaned node process holding port 3080 — check with `netstat -ano | findstr :3080` and `taskkill /F /PID <pid>` before restarting.
