# dsh 深度分析（DeepSeek Harness 0.1.2-alpha.5）

> dsh 是"everything is a plugin"的通用 agent 运行时：Cordis 插件框架 + 事件溯源会话 + 多 provider LLM 层 + WebUI。本文是接手者开发和适配 StriX-DH 时的 dsh 完整参考。
> 信息来源优先级：运行时实物（npx 缓存 `@deepseek-ai/dsh` 包树，223 个 `@deepseek-ai/*` 包）> monorepo 源码（`upstream/deepseek-harness/`，注意 master 可能超前于基线）> 生成目录（tool/persistence/config-catalog）> 官方文档 > 本文。
> **版本现实**：developer preview，无 CHANGELOG，alpha 版本数天一发且可能破坏兼容。版本演进史与适配演练见 `DEVELOPMENT.md` 3.11 与 3.9。

## 1. 组成模型：Cordis + 三层清单

dsh 的运行时是一棵 **Cordis 插件树**。三个核心概念：

| 概念 | 载体 | 清单字段 | 回答的问题 |
|---|---|---|---|
| **bundle** | npm 包（可 link 本地目录） | `package.json` 的 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` | 这个包贡献什么（一层 patch） |
| **profile** | `$DSH_HOME/profiles/<name>/` | `dsh.profile.bundles`（有序）+ 自身 `cordis.patch.yml` | 一次启动用哪些 bundle、什么顺序 |
| **patch** | YAML 文件 | `- insert: [- id, name, config?, disabled?, isolate?]` | 往组合里插/替插件行 |

加载顺序：dsh-base → 各 bundle（按加入序）→ profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` 参数层。**后层对同名 id 整行替换（不深合并）**；行替换必须重述该行全部需要的键。

`cordis.patch.yml` 行语法要点：`name` 可指向包名（Node 解析）、包内路径（`pkg/sub`）、绝对文件路径；`disabled: true` 保留行但不激活；`disabled: !!js <js 表达式>` 运行时判定（官方 preset 用它做平台门控，如 `process.platform === 'win32'`）；`isolate` 创建子 realm（agent 私有服务，如 PTY 注册表）；`cordis:group` 行把一组行打包成一个 realm；`config` 的值可用 `!!js ctx.<service>.xxx ?? fallback` 在装载期求值（依赖经 inject 保证先就绪）。

**启动入口**：`dsh --profile <name>`（`web` 是 `--profile web` 的别名）；`dsh plugin --profile <name> add/remove <src>` 内部转发 pnpm 管理 profile 依赖；`--dump-config` 打印合成树（验证 bundle 层是否生效的第一手段）；headless 一次性任务：`dsh --profile <name> "任务"`。

## 2. 启动流程与 import 重定向

`dsh-app-boot` 的 `mountRootInclude(ctx, configPath, patches, bareModuleBaseUrl)`：

1. 以根 Include 装载合成配置
2. **覆写 `builtins.include`** 为 `HostResolvedRootInclude`：其 `import()` 对所有 **bare specifier**（非相对、非 `cordis:`）改走 `internal.import(specifier, bareModuleBaseUrl, {})` ——即**重定向到运行时自身的 node_modules**

推论（StriX-DH 的实战依据）：

- 插件声明的 `@deepseek-ai/*` 依赖仅服务本地 tsc/IDE；执行时统一用运行时副本 → **无双实例问题**，但本地 pin 应对齐运行时实际版本以保证类型一致
- 查运行时实际版本：`node -e "require('<npx缓存>/@deepseek-ai/<pkg>/package.json').version"`
- npx 按 spec 哈希缓存：`@deepseek-ai/dsh@0.1.2-alpha.3` 与无版本调用是两个缓存目录

## 3. Agent 循环与 turn 生命周期（`agent-lifecycle.md`）

一次 turn 的流水线（每一步都有对应 session 事件）：

1. **entry**：`followup(content)` 入队；`agent/inbox/*` 通知
2. **wake & claim**：status→running，`turn/start`，认领待处理输入
3. **pre-step 闸门**：`agent/pre-step` 瀑布——hook 可"权威拒绝"（本 turn 不消耗 step）
4. **prompt 组装**：`system-prompt/assemble` 瀑布（**StriX-DH 方法论注入点**）
5. **LLM 请求**：`agent/request` → `llm/stream` 瀑布；块落为 `assistant/chunk`；闭合为 `assistant/message`
6. **工具执行**：按 `executionMode` 分类进"屏障 + 有界滚动池"；ordered pre → concurrent execute → ordered post，发 `tool/call`/`tool/result`
7. **错误路径**：`agent/request-error` 瀑布可重试；compaction 借此做上下文超限剪枝
8. **finish**：`step/end` → 可选 `agent/turn-stopping` 检查点 → `turn/end` → status idle

持久化分两层：**durable 事实**在 session 事件日志（可回放），**live 控制**在 `agent/*`（队列/状态/steering）。

## 4. 工具系统（`@deepseek-ai/dsh-tools`）

`defineTool` 完整契约见 `DEVELOPMENT.md` 3.5。要点补充：

- `parameters` 每属性 spec：`string|number|integer|boolean|null|array|object|json|oneOf`；**object 必须显式 `additionalProperties: boolean`**（推断：true→`Record<string,JsonValue>`，false→仅声明属性）
- `output.schema` 是 canonical 值契约（校验每个成功结果）；`render` 纯函数转模型内容；`presentationMeta` 供 WebUI 卡片
- `timeoutMs` 协作式超时；`isConcurrencySafe(args)` 决定能否进并行组
- `execute(args, exec)`：`exec.signal`（取消）、`exec.agent`、`deferContext()`（把附加上下文挂到本结果之后）、`concludeTurn()`（标记本结果终结本 turn）
- 中止常量 `TOOL_ABORTED`；错误经 `HarnessError`（`@deepseek-ai/dsh-llm`）
- 前台结果带 stdout/stderr 截断 + spill（`dsh-spill` 落盘大输出）；后台执行统一注册 `ctx.jobs`（`JobKindMap` 模块增强声明 kind）
- 官方工具实现范式（`tool-pwsh`）：注入 `['tools','shell','systemPrompt','shellEnv']`；`Config` schemastery；execute 内做 schema 外的值校验；`ctx.systemPrompt.section` 挂使用说明

## 5. 子代理与团队

- `tool-subagent`：`description` + `prompt`（fork 变体继承已完成 turn；spawn 变体需要**自包含** prompt）+ `provider/model/reasoning_effort`（alpha.1+）+ `run_in_background`（后台返回持久 id，完成时父收到通知；`send_message` 可对运行中/空闲的子代理定向发消息）+ `toolFilter`（按能力裁剪子代理工具集，未知名启动即失败）
- `tool-subagent-fork`：fork 现场上下文；`tool-subagent-control`：`interrupt_agent`/`list_agents` 等
- `workflow` 工具：JS 脚本编排**子代理群**（无 fs/network/timer 的纯编排运行时）；alpha.4 起 Web PTC 默认不暴露
- **子代理加入父组合**：继承父的工具、prompt section、skills——这是 StriX-DH 多 agent 方法论"子代理天然带全套渗透工具"的机制基础
- 团队（team_*，实验性）：Team Lead Session 持有团队记录（持久化为 session 事件）

## 6. 技能系统

四包分层：`skill`（注册表，`ctx.skills`）+ `skill-filesystem`（项目/用户目录发现）+ `skill-badge`（bundled provider 范例）+ `tool-skill`（目录发布 + `skill` 加载工具 + `/命令`）。

- 发现路径：项目 `.dsh/skills/`（rank 高）→ `.agents/skills/` → 自定义 roots → 用户 `~/.dsh/skills/` → `~/.agents/skills/`
- 格式：目录式或扁平 Markdown + YAML frontmatter（`name` **kebab-case 强校验** + `description`）
- 插件内注册：`ctx.skills.register({name, description, content, source:'bundled'})`（同步、懒 content 亦可经 provider）；StriX-DH 用直注模式装载 75 个改编知识包
- 调用策略：`modelInvocable`/`userInvocable` 分离

## 7. LLM 适配器

- 适配器接口：`class LlmAdapter { async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> }`；`ctx.llm.registerAdapter(['route'], adapter)`（effect 化，同路由重复注册抛 `DUPLICATE_ADAPTER`）
- 协议铁律：`usage` 必须先于 `finish`、finish 后不发任何块；tool-call `arguments` 端到端是**原始 JSON 字符串**（流式增量 `argumentsDelta`）；错误只有 `LlmError` 或 `finish{kind:'error'|'aborted'}` 两种；必须 honoring `options.signal`
- 内置：`llm-deepseek`（route `deepseek-official`；`apiKeyEnv` 凭证引用按请求解析；thinking/reasoningEffort/Files API；目录 flash/pro/vision）与 `llm-pi-ai`（providers 字典；目录路由继承 pi-ai 端点与目录；**手声明路由** = OpenAI 兼容网关仅需配置；settings `llm-pi-ai:` 节热激活，路由集变更原地重注册）
- key 全走凭证引用（`apiKeyEnv: XXX_API_KEY`），存储在 `dsh-credentials-local`（`~/.dsh/.credentials.yaml`，version:1，`refs:` 键值 + `records:` 记录；解析顺序 启动环境 > 存储文件 > 项目/用户 .env）
- 重试：`llm-retry`（策略可配）；计量：`token-meter`（`ctx.tokenMeter`，回放感知，供预算/压力显示）

## 8. 持久化（会话事件日志）

- 单一基底：**追加式 session 事件日志**（`SESSION_FORMAT_VERSION = 0`，pre-release）；每个事件 = `{type, seq(单调), time, data, ignorable?, surfaceOp?, sourceEventSeqs?}`
- 仅三类 **surface** 事件（`user/message`、`assistant/message`、`tool/result`）进入派生消息历史；其余 log-only（可回放不进历史）
- 插件通过 **declaration merging** 扩展 `SessionEventMap`（StriX-DH 路线图：coverage/notes/threat-model 迁入自定义事件）；快照类用 latest-wins 语义；配对类（`command/run`↔`done`）靠 id 关联
- 历史重建：`deriveMessages()` 投影；compaction 以 `surfaceOp: {op:'replace'}` 剪枝
- **alpha.4 破坏性变更**：`Session.events` 移除 → `seq`/`eventAt()`/`snapshotEvents()`；`SessionSeq`/`SessionLogOffset` 强类型
- 持久化后端默认 JSONL（`session-persistence-jsonl`）；SQLite 后端 alpha.3 移除

## 9. 安全栈

- `sandbox`（能力）+ `sandbox-policy` + `bash-sandbox`/`pwsh-sandbox`（收窄执行器）：每命令新鲜 `bash -c`，经 `ctx.sandbox` 收窄文件权限；无 runner 能执行收窄模式时**fail closed**（`SANDBOX_UNAVAILABLE`）；结果携带实际执行模式与拒绝事实
- 升级路径：工具暴露 `sandbox_permissions` + `justification` 字段 → `ctx.approval` 审批（HITL）→ 会话内生效
- Windows：`sandbox-windows-acl`；Linux：`node-addon-landlock-run`
- `permission-presets`：审批策略预设
- 官方安全声明（SAFETY.md）：未做安全审计；沙箱/审批/权限**不保证隔离**；不要当作不可信工作负载的唯一安全控制

## 10. WebUI 与宿主面

- `dsh-web-app` bundle：`dsh-host-webserver`（默认 127.0.0.1:3080，一次性 token URL）+ 前端（chat/settings/sidebar/trajectory/jobs/goal/plan/preset 选择器等 client-ui-* 模块）
- 设置：`dsh-settings-file`（`~/.dsh/settings.yaml` 热更新，namespace 化，YAML 写回保留注释）+ 各插件的 schemastery schema
- agent presets：`dsh-agent-presets` 维护 roster（shipped：standard/cordis/minimal/ptc；用户：`~/.dsh/.agent-presets/<id>/`——`preset.yml` 元数据 + `agent.cordis.yml` 组合 + `skills/` 目录）；会话选择 preset 即选择该会话的工具/人设/技能；子代理继承父组合
- StriX-DH 派生预设：`~/.dsh/.agent-presets/strix/`（standard 底座 + `dsh-persona` 渗透人设 + `strix-dsh-tools` 行）

## 11. CLI 速查

```sh
dsh --version
dsh --profile <name> [--patch <yml>] [--dump-config]      # 启动组合
dsh web [--no-open]                                        # = --profile web
dsh --profile <name> "任务"                                 # headless 一次性
dsh plugin --profile <name> add|remove <src|pkg|git|tgz>   # bundle 管理（转发 pnpm）
dsh --profile <name> --dump-default-config                 # 无用户层合成树
```

## 12. 对接手者的适配心法

1. **一切能力的接缝都是"service + row"**：想加能力 = 写一个导出 `name/inject/apply/Config` 的插件模块 + 一行 patch；想换能力 = 同 id 的行在后层覆盖
2. **读三类生成目录**判断 API 现状：tool-catalog（工具形状）、persistence-catalog（事件契约）、config-catalog（配置面）——它们由脚本生成且有 verify 命令，是唯一不会撒谎的文档
3. **破坏面侦察顺序**：CLI 依赖 diff → 相关包 `.d.ts` diff → 启动日志 → dump-config → headless 冒烟
4. **插件永不过度信任宿主版本**：本地类型 pin 对齐运行时实物；执行行为以运行时为准（import 重定向）
5. 设计笔记（`.agents/notes/implemented/`，带日期）是理解"为什么"的最快路径——比读代码省一个数量级
