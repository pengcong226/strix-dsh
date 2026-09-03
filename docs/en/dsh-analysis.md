# dsh Deep Dive (DeepSeek Harness 0.1.2-alpha.5)

> dsh is an "everything is a plugin" general-purpose agent runtime: the Cordis plugin framework + event-sourced sessions + a multi-provider LLM layer + WebUI. This document is the complete dsh reference for anyone developing and adapting StriX-DH.
> Source priority: runtime artifacts (the npx-cached `@deepseek-ai/dsh` package tree, 223 `@deepseek-ai/*` packages) > monorepo source (`upstream/deepseek-harness/` — note master may run ahead of the baseline) > generated catalogs (tool/persistence/config-catalog) > official docs > this document.
> **Version reality**: developer preview, no CHANGELOG, alpha releases land every few days and may break compatibility. Version history and the adaptation drill live in `DEVELOPMENT.md` §§3.11 and 3.9.

## 1. Composition model: Cordis + three inventories

The dsh runtime is a **Cordis plugin tree**. Three core concepts:

| Concept | Vehicle | Manifest field | Question it answers |
|---|---|---|---|
| **bundle** | npm package (may link a local dir) | package.json `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` | what this package contributes (one patch layer) |
| **profile** | `$DSH_HOME/profiles/<name>/` | `dsh.profile.bundles` (ordered) + its own `cordis.patch.yml` | which bundles, in what order, for one boot |
| **patch** | YAML file | `- insert: [- id, name, config?, disabled?, isolate?]` | insert/replace plugin rows into the composition |

Load order: dsh-base → bundles (in join order) → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` argument layer. **Later layers replace whole same-id rows (no deep merge)**; a replacing row must restate every key the row needs.

`cordis.patch.yml` row-syntax essentials: `name` may point at a package name (Node resolution), an in-package path (`pkg/sub`), or an absolute file path; `disabled: true` keeps the row without activating it; `disabled: !!js <js expression>` decides at runtime (official presets use it for platform gates like `process.platform === 'win32'`); `isolate` creates a child realm (agent-private services such as the PTY registry); a `cordis:group` row packs a row set into one realm; `config` values may evaluate at mount time via `!!js ctx.<service>.xxx ?? fallback` (dependencies guaranteed ready first via inject).

**Boot entry**: `dsh --profile <name>` (`web` is an alias of `--profile web`); `dsh plugin --profile <name> add/remove <src>` forwards to pnpm to manage profile deps; `--dump-config` prints the composed tree (first resort for verifying a bundle layer took effect); headless one-shot tasks: `dsh --profile <name> "task"`.

## 2. Boot flow & import redirection

`dsh-app-boot`'s `mountRootInclude(ctx, configPath, patches, bareModuleBaseUrl)`:

1. Mounts the composed config with a root Include
2. **Overrides `builtins.include`** with `HostResolvedRootInclude`: its `import()` reroutes every **bare specifier** (non-relative, non-`cordis:`) through `internal.import(specifier, bareModuleBaseUrl, {})` — i.e. **redirected into the runtime's own node_modules**

Corollaries (StriX-DH's field basis):

- A plugin's declared `@deepseek-ai/*` deps serve local tsc/IDE only; execution uniformly uses the runtime's copies → **no dual-instance problem**, but local pins should track the runtime's actual versions for type consistency
- Check the runtime's actual versions with: `node -e "require('<npx-cache>/@deepseek-ai/<pkg>/package.json').version"`
- npx caches by spec hash: `@deepseek-ai/dsh@0.1.2-alpha.3` and a versionless invocation are two separate cache dirs

## 3. Agent loop & turn lifecycle (`agent-lifecycle.md`)

One turn's pipeline (every step has a matching session event):

1. **entry**: `followup(content)` enqueued; `agent/inbox/*` notifications
2. **wake & claim**: status→running, `turn/start`, claim pending input
3. **pre-step gate**: the `agent/pre-step` waterfall — hooks may "authoritatively refuse" (the turn consumes no step)
4. **prompt assembly**: the `system-prompt/assemble` waterfall (**StriX-DH's methodology injection point**)
5. **LLM request**: `agent/request` → `llm/stream` waterfall; chunks land as `assistant/chunk`; closure as `assistant/message`
6. **Tool execution**: classified by `executionMode` into "barriers + bounded rolling pool"; ordered pre → concurrent execute → ordered post, emitting `tool/call`/`tool/result`
7. **Error path**: the `agent/request-error` waterfall may retry; compaction hooks in here for over-context pruning
8. **finish**: `step/end` → optional `agent/turn-stopping` checkpoint → `turn/end` → status idle

Persistence splits in two: **durable facts** in the session event log (replayable), **live control** in `agent/*` (queues/state/steering).

## 4. Tool system (`@deepseek-ai/dsh-tools`)

Full `defineTool` contract in `DEVELOPMENT.md` §3.5. Key supplements:

- `parameters`, one spec per property: `string|number|integer|boolean|null|array|object|json|oneOf`; **objects must declare `additionalProperties: boolean` explicitly** (inference: true→`Record<string,JsonValue>`, false→declared properties only)
- `output.schema` is the canonical value contract (validates every successful result); `render` is a pure function to model content; `presentationMeta` feeds WebUI cards
- `timeoutMs` cooperative timeout; `isConcurrencySafe(args)` decides parallel-group eligibility
- `execute(args, exec)`: `exec.signal` (cancellation), `exec.agent`, `deferContext()` (attach extra context after this result), `concludeTurn()` (mark this result as ending the turn)
- Abort constant `TOOL_ABORTED`; errors via `HarnessError` (`@deepseek-ai/dsh-llm`)
- Foreground results carry stdout/stderr truncation + spill (`dsh-spill` persists large outputs); background execution uniformly registers `ctx.jobs` (`JobKindMap` module-augmentation declares the kind)
- Official tool implementation paradigm (`tool-pwsh`): inject `['tools','shell','systemPrompt','shellEnv']`; `Config` in schemastery; value checks beyond the schema inside execute; usage notes mounted via `ctx.systemPrompt.section`

## 5. Subagents & teams

- `tool-subagent`: `description` + `prompt` (fork variant inherits completed turns; spawn variant needs a **self-contained** prompt) + `provider/model/reasoning_effort` (alpha.1+) + `run_in_background` (returns a durable id in the background, the parent is notified on completion; `send_message` can message a running/idle child directly) + `toolFilter` (trims the child's toolset by capability, unknown names fail at start)
- `tool-subagent-fork`: forks live context; `tool-subagent-control`: `interrupt_agent`/`list_agents` etc.
- `workflow` tool: JS-script orchestration of **subagent groups** (a pure orchestration runtime with no fs/network/timer); hidden from web PTC by default since alpha.4
- **Children join the parent composition**: inheriting the parent's tools, prompt sections, skills — the mechanical basis for StriX-DH's multi-agent methodology "subagents natively carry the full pentest toolset"
- Teams (team_*, experimental): a Team Lead Session holds team records (persisted as session events)

## 6. Skill system

Four-package layering: `skill` (registry, `ctx.skills`) + `skill-filesystem` (project/user dir discovery) + `skill-badge` (bundled-provider example) + `tool-skill` (catalog publishing + `skill` loading tool + `/commands`).

- Discovery paths: project `.dsh/skills/` (high rank) → `.agents/skills/` → custom roots → user `~/.dsh/skills/` → `~/.agents/skills/`
- Format: directory-style or flat Markdown + YAML frontmatter (`name` with **strong kebab-case validation** + `description`)
- In-plugin registration: `ctx.skills.register({name, description, content, source:'bundled'})` (sync; lazy content also possible via provider); StriX-DH direct-registers its 75 adapted knowledge packages
- Invocation policy: `modelInvocable`/`userInvocable` separation

## 7. LLM adapters

- Adapter interface: `class LlmAdapter { async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> }`; `ctx.llm.registerAdapter(['route'], adapter)` (effect-scoped, duplicate registration on one route throws `DUPLICATE_ADAPTER`)
- Protocol iron laws: `usage` must precede `finish`, nothing after finish; tool-call `arguments` are end-to-end a **raw JSON string** (streaming increments as `argumentsDelta`); only two error shapes, `LlmError` or `finish{kind:'error'|'aborted'}`; `options.signal` must be honored
- Built in: `llm-deepseek` (route `deepseek-official`; `apiKeyEnv` credential references resolved per request; thinking/reasoningEffort/Files API; flash/pro/vision catalog) and `llm-pi-ai` (providers dict; catalog routes inherit pi-ai endpoints and catalog; **hand-declared routes** = OpenAI-compatible gateways need config only; hot-activated via the settings `llm-pi-ai:` section, route-set changes re-register in place)
- Keys always travel as credential references (`apiKeyEnv: XXX_API_KEY`), stored in `dsh-credentials-local` (`~/.dsh/.credentials.yaml`, version:1, `refs:` keys + `records:` entries; resolution order: launch env > stored file > project/user .env)
- Retries: `llm-retry` (configurable policy); metering: `token-meter` (`ctx.tokenMeter`, replay-aware, feeds budget/pressure displays)

## 8. Persistence (session event log)

- Single substrate: an **append-only session event log** (`SESSION_FORMAT_VERSION = 0`, pre-release); each event = `{type, seq(monotonic), time, data, ignorable?, surfaceOp?, sourceEventSeqs?}`
- Only three **surface** event types (`user/message`, `assistant/message`, `tool/result`) enter the derived message history; everything else is log-only (replayable, not historical)
- Plugins extend `SessionEventMap` via **declaration merging** (StriX-DH landed this in v0.6.0: `strix/coverage` + `strix/note` mirror events, files stay the source of truth); snapshot kinds use latest-wins semantics; paired kinds (`command/run`↔`done`) correlate by id
- History reconstruction: `deriveMessages()` projection; compaction prunes with `surfaceOp: {op:'replace'}`
- **alpha.4 breaking change**: `Session.events` removed → `seq`/`eventAt()`/`snapshotEvents()`; `SessionSeq`/`SessionLogOffset` strong types
- Default persistence backend is JSONL (`session-persistence-jsonl`); the SQLite backend was removed in alpha.3

## 9. Safety stack

- `sandbox` (capability) + `sandbox-policy` + `bash-sandbox`/`pwsh-sandbox` (narrowing executors): fresh `bash -c` per command, file permissions narrowed via `ctx.sandbox`; when no runner can execute a narrowed mode it **fails closed** (`SANDBOX_UNAVAILABLE`); results carry the actual execution mode and refusal facts
- Elevation path: tools expose `sandbox_permissions` + `justification` fields → `ctx.approval` approval (HITL) → effective within the session
- Windows: `sandbox-windows-acl`; Linux: `node-addon-landlock-run`
- `permission-presets`: approval-policy presets
- Official safety statement (SAFETY.md): no security audit performed; sandbox/approval/permissions **do not guarantee isolation**; do not treat them as the sole security control for untrusted workloads

## 10. WebUI & host surface

- `dsh-web-app` bundle: `dsh-host-webserver` (default 127.0.0.1:3080, one-time token URL) + frontend (chat/settings/sidebar/trajectory/jobs/goal/plan/preset-picker and other client-ui-* modules)
- Settings: `dsh-settings-file` (`~/.dsh/settings.yaml` hot updates, namespaced, YAML round-trip preserves comments) + each plugin's schemastery schema
- Agent presets: `dsh-agent-presets` maintains the roster (shipped: standard/cordis/minimal/ptc; user: `~/.dsh/.agent-presets/<id>/` — `preset.yml` metadata + `agent.cordis.yml` composition + `skills/` dir); picking a preset for a session picks that session's tools/persona/skills; children inherit the parent composition
- StriX-DH derived presets: `presets/strix/` (orchestrator) + `presets/strix-operator/` (executor), installed to `~/.dsh/.agent-presets/` — see `presets/README.md`

## 11. CLI cheat sheet

```sh
dsh --version
dsh --profile <name> [--patch <yml>] [--dump-config]      # boot a composition
dsh web [--no-open]                                        # = --profile web
dsh --profile <name> "task"                                 # headless one-shot
dsh plugin --profile <name> add|remove <src|pkg|git|tgz>   # bundle management (forwards to pnpm)
dsh --profile <name> --dump-default-config                 # composed tree without the user layer
```

## 12. Adaptation mindset for whoever takes over

1. **Every capability joint is "service + row"**: adding capability = writing a plugin module exporting `name/inject/apply/Config` + one patch row; swapping capability = a later-layer row with the same id overriding it
2. **Read the three generated catalogs** to judge API state: tool-catalog (tool shapes), persistence-catalog (event contracts), config-catalog (config surface) — script-generated with verify commands, the only docs that cannot lie
3. **Breakage reconnaissance order**: CLI dep diff → relevant packages' `.d.ts` diff → boot log → dump-config → headless smoke
4. **Plugins never over-trust the host version**: local type pins track the runtime artifacts; runtime behavior wins (import redirection)
5. Design notes (`.agents/notes/implemented/`, dated) are the fastest path to "why" — an order of magnitude cheaper than reading code
