# StriX-DH 开发者手册

> **本文档的目标读者**：接手本项目的开发者或 AI 助手。读完本文你应当：(1) 理解 Strix 上游的设计与资产；(2) 掌握 dsh 当前版本的架构与"一切皆插件"的扩展方式；(3) 了解 StriX-DH 的现状、代码约定与验证状态；(4) 能够在 dsh 发新版本时快速完成适配。
>
> **阅读顺序**：第 1 节速览全局 → 做开发前精读第 4 节（dsh 兼容面）和第 5 节（本项目现状）→ 升级 dsh 时执行第 3.9 节的升级演练。
>
> **配套深度文档**：[strix-analysis.md](strix-analysis.md)（Strix 上游完整解析）、[dsh-analysis.md](dsh-analysis.md)（dsh 运行时完整解析）、[tools-reference.md](tools-reference.md)（15 工具完整契约与实测输出）、[walkthrough.md](walkthrough.md)（从启动到第一份报告的实战走查）、[skills-catalog.md](skills-catalog.md)（75 技能目录）、[prompt-design.md](prompt-design.md)（提示词资产映射）。
>
> **信息权威级**（冲突时以高者优先）：运行时实物（npx 缓存里的 node_modules）> 上游仓库对应 tag 的源码 > 生成目录（tool-catalog / persistence-catalog / config-catalog，由 `pnpm run verify-*` 保证与代码一致）> README/设计笔记 > 本手册。
>
> 基线版本：dsh CLI **`0.1.5-rc.2`**（0.12.2 升级实测通过；0.12.8 起 peer 双版本范围同时兼容 **`0.1.6-alpha.1`**——上游该版把 `dsh-code-runtime` 更名为 `dsh-ptc-runtime`，插件面 API/preset/校验规则零变化，仅包名与版本适配；0.12.10 起 peer 三版本范围同时兼容 **`0.1.6-alpha.2`**——该版删除桌面端 peer 版本硬校验改运行时 moduleFallback 解析，插件面 API 零变化，真机 CLI 启动注册行完整）。dsh 处于 developer preview，**几天一个大幅改动是常态**，第 3.9 节是为此准备的。

---

## 1. 项目定位与架构总览

**一句话**：StriX-DH 把 [Strix](https://github.com/usestrix/strix)（Apache-2.0，AI 渗透测试平台）的能力——工具、方法论提示词、知识包——拆解为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)（MIT，通用 agent 运行时）的**原生插件**，使 dsh 的 agent 循环、子代理编排、持久化记忆和 WebUI 直接具备渗透测试能力。

**设计原则**：不做"两个进程互相遥控"。dsh 是唯一的大脑；Strix 只作为代码与内容的移植来源，运行时零依赖。渗透能力不是旁路服务，而是注册进 dsh 能力注册表的普通插件行——这就是"一切皆插件"。

**三层移植**：

| 层 | 内容 | dsh 挂载机制 | 代码位置 |
|---|---|---|---|
| 工具层 | 12 个 `strix_*` 工具 | `ctx.tools.register(defineTool(...))` | `packages/strix-tools/src/tools/*.ts` |
| 提示词层 | 方法论纪律（closure 三态、CVSS 证据绑定、侦察优先） | `ctx.systemPrompt.section({ name:'strix:methodology', order:100 })` | `src/index.ts` |
| 知识层 | 75 个攻击技术知识包（改编自 Strix skills） | `ctx.skills.register({ name, description, content })` | `src/skills-provider.ts` + `assets/skills/` |

**目录地图**：

```
strix-dsh/
├── README.md / README.zh.md     # 中英双语说明
├── LICENSE (Apache-2.0) / NOTICE # 许可与 Strix/dsh 出处声明
├── AGENTS.md                     # dsh agent-instructions 自动加载的工作区指令
├── docs/
│   ├── architecture.md           # 运行时机制（import 重定向、版本 pin、section 序）
│   ├── safety.md                 # 授权使用红线
│   ├── prompt-design.md          # Strix 提示词资产 → 本项目的映射表（含"有意不移植"清单）
│   └── DEVELOPMENT.md            # 本手册
├── packages/strix-tools/         # dsh bundle（唯一可发布包）
│   ├── package.json              # dsh.bundle 清单声明
│   ├── cordis.patch.yml          # patch 层（按包名引用插件行）
│   ├── src/
│   │   ├── index.ts              # 插件入口：注册全部工具 + 方法论 section
│   │   ├── config.ts             # schemastery 配置 schema（所有可调项）
│   │   ├── skills-provider.ts    # 75 个知识包的注册逻辑
│   │   ├── lib/util.ts           # 工作区解析、进程封装、dockerRun、二进制发现
│   │   └── tools/                # 12 个工具模块（每文件一个 register(ctx,config)）
│   └── assets/skills/            # 改编后的知识包 + manifest.json（脚本产物）
├── scripts/adapt_skills.py       # Strix 知识包机械改编脚本
├── upstream/                     # 开发期参考克隆（gitignore，不发布）
│   ├── strix/                    # Strix 全源码
│   └── deepseek-harness/         # dsh 全源码（master，注意可能超前于基线版本）
└── dsh-boot.log                  # 最近一次启动日志（含 WebUI token）
```

---

## 2. Strix 上游完整分析

源码：`upstream/strix/`（Python，PyInstaller 打包为 CLI，Bubble Tea TUI）。上游迭代活跃，本节基于移植时（2026-09）的 master 快照。

### 2.1 包结构（`strix/` 下 11 个子目录）

| 目录 | 职责 | 移植状态 |
|---|---|---|
| `agents/` | agent 构造：`prompts/system_prompt.jinja`（545 行系统提示词）、`prompt.py`（Jinja 渲染 + 技能注入排序）、`factory.py`（agent 实例化） | 提示词与注入逻辑改编至 methodology section + prompt-design.md |
| `tools/` | 17 个工具模块（见 2.3） | 12 个原生重建（dsh 已覆盖的用原生），详见 2.3 表 |
| `skills/` | 11 类 76 个知识包（YAML frontmatter + Markdown） | 75 个机械改编为 bundled skills（README 除外） |
| `core/` | `agents.py`/`runner.py`/`execution.py`/`sessions.py`——Graph of Agents 编排与执行 | **不移植**——dsh 的 agent-loop/subagent/workflow 原生承接 |
| `llm/` | `compaction.py`、`context_budget.py`、`warmup.py` | **不移植**——dsh 内置 `compaction-basic`、`token-meter` |
| `report/` | 报告生成 | 逻辑参考，重写为 `strix_report` |
| `runtime/` | Docker 沙箱生命周期 | 参考后简化：`strix_shell`/`strix_pybox` 一次性容器 |
| `config/` | 扫描配置 | 参考后简化进 plugin Config |
| `interface/` | TUI（Go Bubble Tea） | **不移植**——用 dsh WebUI |
| `telemetry/` | PostHog/OTel | 不移植（StriX-DH 关遥测） |
| `utils/` | 杂项 | 按需 |

仓库根还有 `containers/`（Kali 沙箱镜像，内含 nmap/subfinder/naabu/httpx/gospider/nuclei/sqlmap/trivy/wapiti/ffuf/dirsearch/katana/arjun/semgrep/ast-grep/tree-sitter/bandit/trufflehog/gitleaks/jwt_tool/wafw00f/interactsh-client/Caido CLI 全清单）和根级 `skills/`（给编码 agent 用的 9 个 SKILL.md，与 `strix/skills` 不同物，未移植）。

### 2.2 系统提示词（最重要的单一资产）

`system_prompt.jinja` 十节结构（移植对照详见 `docs/prompt-design.md`）：

1. 人设声明（"authorized security validation agent"）
2. `<root_agent_directive>`——root 只编排不亲测（**未移植**，需双人设，见路线图）
3. `<core_capabilities>`
4. `<communication_rules>`——含 interactive/autonomous 分支（**不移植**，dsh 自有 turn 语义）
5. `<execution_guidelines>`（最大节）——SYSTEM-VERIFIED SCOPE、授权/拒绝规避（**有意不移植**，见 prompt-design.md 的理由）、THOROUGH VALIDATION、测试模式（黑盒/白盒/组合）、7 步评估方法论、效率战术（payload 喷射脚本化、技能预载）、VALIDATION REQUIREMENTS（**CVSS 指标必须映射到 PoC 已演示的证据**）、closure 三态、coverage/threat model 状态规则、状态工具使用契约
6. `<vulnerability_focus>`——十类主攻漏洞 + 验证升级阶梯
7. `<multi_agent_system>`——3-agent 链（发现→验证→报告）、一 agent 一任务、≤5 技能专精、嵌套树、2000+ 步持久性
8. `<environment>`——Kali 工具清单、Caido HTTPQL、错误页识别
9/10. `<specialized_knowledge>` / `<available_skills>`——技能动态注入

`prompt.py` 的 `_resolve_skills()` 是注入排序的权威：requested → `scan_modes/<mode>` → `scan_modes/diff`（diff 作用域时叠加）→ `tooling/agent_browser` → `tooling/python` → `analysis/counterevidence` → `analysis/severity_calibration` → `coordination/root_agent`（root 限定）→ 白盒集。**StriX-DH 的对应物**：方法论 section（always-on）+ 75 个技能经 dsh `skill` 工具按需加载；"按目标特征动态选择注入集"是路线图项（dsh 的 section `text` 支持 provider 函数，官方通道已确认）。

### 2.3 工具层 17 模块 → StriX-DH 12 工具对照

| Strix 模块 | 功能 | StriX-DH 去向 |
|---|---|---|
| `shell` | exec_command + tty/write_stdin（Kali 容器内） | `strix_shell`（一次性 Docker 容器）+ dsh 原生 bash/pwsh/terminal_* |
| `agent_browser` | Playwright，`--session` 隔离 | `strix_browser`（session 参数隔离，ctx.effect 清理） |
| `proxy` | Caido 拦截代理 + HTTPQL + `caido_api` | v1 用 `strix_http`（raw 重放）覆盖核心用例；**Phase2** mitmproxy/Caido 集成 |
| `apply_patch` | 白盒修复 | dsh 原生 edit/str_replace_editor |
| `agents_graph` | create_agent/view_agent_graph/wait/stop | dsh 原生 subagent/subagent-control/workflow |
| `reporting` | create/update_vulnerability_report、dependency、list/get | `strix_finding`（create/update/list/get）+ `strix_report` |
| `coverage` | record/update/list_coverage | `strix_coverage`（ledger.jsonl） |
| `notes` | 共享便签 | `strix_notes` |
| `threat_model` | get/amend/save | `strix_threat_model` |
| `todo` / `thinking` / `finish` / `respond` / `view_image` / `web_search` / `load_skill` / `mcp` / `coverage` 之外的编排 | | dsh 原生（todo_write、skill、web_search、read_image、subagent、MCP 客户端）；`finish` 生命周期由 dsh turn 语义取代 |
| （无对应模块） | | `strix_runs`（工作区总览，新加）、`strix_sast`（nuclei/semgrep 封装）、`strix_pybox`（Python 沙箱） |

### 2.4 报告契约（移植时必须保真的部分）

- 漏洞**只有**经 `strix_finding` 登记才存在；对话里提到不算
- 每个非 None 的 CVSS C/I/A 指标必须映射到 PoC 已演示的证据；scanner 标签、可达性、理论后续攻击不构成指标依据
- `counterevidence`（反证陈述）与 `confidence`（诚实分级，纯静态 trace 至多 medium）是一等字段
- 白盒：修复随报告一次性产出（`code_locations` fix_before/fix_after + `fix_pr_body`），不派"修复 agent"重复推导
- 去重：重复被拒后用 update 修订（带 update_reason），不重复登记
- closure 三态：`confirmed` / `ruled_out`（必须能指出具体控制点）/ `open_proof_gap`；"没信息"≠安全

---

## 3. dsh 深度分析（基线 0.1.2-alpha.5）

### 3.1 发布模型与版本现实

- monorepo（pnpm workspace），npm 发布 `@deepseek-ai/*` 包；CLI 包 `@deepseek-ai/dsh` 的依赖全部是 `^0.1.2-alpha.x` 范围 → **装 CLI 时内部包会解析到该 alpha 线的最新版**（alpha.3 CLI 实际携带 dsh-tools alpha.5）。
- **没有 CHANGELOG**。版本间差异要靠：GitHub release notes、commit 历史、三份生成目录（`docs/tool-catalog.md`、`docs/persistence-catalog.md`、`docs/config-catalog.md`，由 `pnpm run verify-*` 脚本保证与代码同步）。
- `.agents/notes/implemented/` 下有带日期的设计笔记（Agent Note），是"为什么这么设计"的权威来源。
- 实测漂移数据：**dsh-tools alpha.3 ↔ alpha.5 的全部类型定义 diff 为零**；CLI alpha.3→alpha.5 仅内部依赖 floor 提升。结论（截至目前）：同 alpha 线内插件可见 API 稳定，破坏性变化发生在 rc→alpha 或 alpha 大版本间。

### 3.2 组成模型：profile / bundle / patch

- **bundle**：npm 包，`package.json` 声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；patch 是 `- insert: [- id, name(按包名), config?, disabled?]` 行列表。
- **profile**：`$DSH_HOME/profiles/<name>/`，由 `dsh plugin --profile <name> add <来源>` 维护（内部走 pnpm；git 来源需要 `prepare` 构建脚本 + 用户在 profile 的 `pnpm-workspace.yaml` `allowBuilds` 放行）。profile 的 `dsh.profile.bundles` 记录有序 bundle 栈。
- **加载顺序**：dsh-base → 各 bundle（按加入顺序）→ profile 自身 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。**后层整行替换前层同名 id 的行**（不深合并）。
- **CLI 语义**：`--profile` 是顶层标志；`web` 只是 `--profile web` 的别名，**不接受** `--profile`；一次性任务：`dsh --profile <name> "任务文本"`（headless preset 语义）。
- 验证：`dsh --profile <name> --dump-config` 看合成层；启动日志看插件 console 输出。

### 3.3 启动流程与 import 重定向（防双实例的关键）

`dsh-app-boot` 的 `mountRootInclude` 覆写 Include 的 `import()`：**插件模块里所有 bare specifier（如 `@deepseek-ai/dsh-tools`）都重定向到运行时自身的 node_modules**（`bareModuleBaseUrl`），仅相对路径与 `cordis:` 前缀走本地解析。含义：

- 插件 package.json 里的框架依赖**只服务本地 tsc 类型检查与 IDE**；执行时永远用运行时副本。
- 因此本地 pin 应对齐**运行时实际携带的版本**（查法：`node -e "require('<npx缓存>/@deepseek-ai/dsh-tools/package.json').version"`）。
- 升级 dsh 后若出现注册形状不兼容，第一怀疑对象是"本地类型版本 vs 运行时版本"漂移。

### 3.4 能力 seam 全景（ctx.* 一览）

| seam（inject 键） | 用途 | StriX-DH 使用 |
|---|---|---|
| `tools` | `ctx.tools.register(defineTool)`；`schemas()` 可枚举 | ✅ 15 工具 |
| `systemPrompt` | `section({name, order, text})`；`text` 可为 provider 函数（每次组装求值，支持 `{{var}}` 插值）；`getSectionOrder(name)` | ✅ 方法论 section；动态注入在路线图 |
| `skills` | `register(skill)`（直接注入）/`registerProvider`（懒加载目录）/`registerRuntime` | ✅ 75 技能直注 |
| `shell` + `tool-bash`/`tool-pwsh`（含 persistent/terminal_*） | 宿主命令执行；bash-sandbox 变体提供收窄+升级（sandbox_permissions/justification） | 未直接用（我们走自管 Docker） |
| `jobs`（tool-jobs） | 后台任务注册、`job_output`/`job_kill`/`job_list` | ✅ **已接入（0.5.0）**：`strix_shell background=true` 走 `ctx.jobs.start`（kind `strix-shell`，inject 需 `'jobs'`，`@deepseek-ai/dsh-jobs` 精确 pin 运行时版本）；dsh 自带管理工具，无需自写 |
| `subprocess`/`fs`/`fs-sandbox` | 进程与文件能力 seam | 间接 |
| `credentials`（credentials-local） | `$DSH_HOME/.credentials.yaml`（version:1，`refs:` 键值 + `records:` 记录）；解析顺序 启动环境 > 存储文件 > 项目/用户 .env | ✅ DEEPSEEK_API_KEY |
| `settings`（settings-file） | `~/.dsh/settings.yaml` 热更新文档，namespace 化 | 路线图（attestation 可迁入） |
| `llm` + `llm-deepseek` + `llm-pi-ai` | 路由注册；deepseek-official 直连路由；pi-ai 多 provider/手声明网关（settings `llm-pi-ai:` 节热激活） | ✅（用户侧配置） |
| `token-meter` | 回放感知的 token/上下文计量（`ctx.tokenMeter`） | 只给 token 数、不给美元价，无 pricing API（已核对源码）→ 预算账本走显式记账，详见 tools-reference 预算节 |
| `sandbox`/`sandbox-policy`/`approval` | 收窄执行 + 审批升级。`approval`：`ctx.approval.request({agent, toolName, callId?, reason?, signal?})` → `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`；策略 `'ask'`（默认，走应答器瀑布，无应答器 → `unavailable` fail-closed）/ `'never'`（headless 严态，一律 `rejected`）；服务自动落 `approval/asked`+`approval/decided` 审计对；WebUI/ACP 表面自带交互应答器 | ✅ **v1.1 已接入**：strix_shell/strix_pybox 逐调用审批门（`inject` 数组必须含 `'approval'`，否则 `ctx.approval` 抛 without-inject）；`approvalGate` 配置 `'always'\|'off'`；插件侧台账 `evidence/log.jsonl`（详见 tools-reference 审批门一节） |
| `mcp-client` | 外部 MCP 服务器接入 | 未评估 |
| `agent-presets` + `persona` | 每会话组合（`agent.cordis.yml`：persona 行 + 工具行 + skills）；自有预设放 `~/.dsh/.agent-presets/<id>/` | ✅ 已派生 strix 预设（见 5.4） |
| `workspace`（dsh-workspace） | **宿主侧 UI 分组**，模型不可见 | 不适用 |

### 3.5 工具系统契约（defineTool 精确签名）

```ts
defineTool({
  name: string                      // 全局唯一
  description: string               // 会进模型系统提示——写行为规则而非功能列表
  parameters: ParameterSchemaSpec   // 每属性一个 spec；根为隐式开放对象
  output: {
    schema: ValueSchemaSpec         // 对成功结果做校验的 canonical schema
    render(args, value): ContentBlock[]  // 纯函数渲染为模型可见内容
    presentationMeta?(args, value)  // 可选：WebUI 卡片元数据
  }
  timeoutMs?: number                // 协作式超时预算
  isConcurrencySafe?(args): boolean // 是否可入并行组
  async execute(args, exec: ToolRunContext): Promise<InferValue<output.schema>>
})
```

易错点（全部实测踩过）：

1. **object 类型参数必须显式 `additionalProperties: true|false`**，漏写直接类型错误（`ObjectValueSchemaSpec` 强制）。
2. `execute(args)` 的 args 类型由 parameters **推断**；对象参数推断为 `Record<string, JsonValue>`，复杂数据在 execute 内部收窄（`raw as unknown as X` 模式）。
3. `ToolRunContext`（第二参数）提供 `signal`（取消）、`rootCallId`/`token`、`deferContext()`、`concludeTurn()`。
4. `TOOL_ABORTED` 从 `@deepseek-ai/dsh-tools` 导入，用于中止态。
5. NodeNext ESM：**本地相对 import 必须 `.js` 后缀**。
6. 后台任务需 `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { ... } }` 增强。

### 3.6 system-prompt 精确契约

- `section({ name(唯一), order(有限数), text: string | ((ctx: AssembleContext) => string), complete? })`
- `SECTION_ORDERS`（alpha.3 实测）：HARNESS_IDENTITY -1000 / HARNESS_SOURCE -900 / WEB_SURFACE -800 / **DEPLOYMENT_PERSONA 0** / PLAN_POLICY 500 / TEAM_POLICY 600 / PTC_ONLY 800 / FILE_REFERENCE 900 / TOOL_BASH 1000 / TOOL_PWSH 1010 / TOOL_READ 1100 … TOOL_JOBS 1600 / TOOL_WEB_SEARCH 2000 / TOOL_WORKFLOW 2600 / TOOL_SUBAGENT 2800 / TOOL_REPORT 2900 / TOOLS_SDK 5000 / STRUCTURED_OUTPUT 9900
- 同名重复注册抛错；scoped（agent preset 作用域）可遮蔽全局同名
- preset 里的 `dsh-persona` 行以 `deployment:persona` 遮蔽全局人设，`complete: true` 可使 persona 成为**完整**系统提示词（抑制其它 section）
- 升级核对：`SECTION_ORDERS` 表在 `@deepseek-ai/dsh-system-prompt/lib/index.js`

### 3.7 skills 精确契约

- 注册：`ctx.skills.register({ name(kebab-case，`/^[a-z0-9]+(-[a-z0-9]+)*$/`, 不接受下划线), description, content, source?: 'bundled'|... })`
- 发现（skill-filesystem provider）：项目 `.dsh/skills/`、`.agents/skills/`；用户 `~/.dsh/skills/`、`~/.agents/skills/`
- 模型侧经 `skill` 工具加载；frontmatter 格式（YAML `name`/`description` + Markdown 正文）与 Strix 兼容

### 3.8 LLM 配置（用户视角）

- `llm-deepseek`（dsh-base 默认挂载）：route=`deepseek-official`，`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`，模型 `deepseek-v4-flash`（快）/`deepseek-v4-pro`（强），解析顺序=启动环境 → credential store → .env
- `llm-pi-ai`（同时挂载，零路由休眠）：第三方路由从 WebUI **Settings→Models** 全程配置（含手声明 OpenAI 兼容网关卡片），或写 `~/.dsh/settings.yaml` 的 `llm-pi-ai:` 节；key 存 credential store，`settings.yaml` 永不含密钥本体；热生效
- 默认模型行（`agent-default-model`）当前为 `deepseek-official/deepseek-v4-flash`

### 3.9 升级演练清单（dsh 发新版时执行）

```sh
# 1. 差异预判（不安装）
diff <(npm view @deepseek-ai/dsh@<旧> dependencies --json) \
     <(npm view @deepseek-ai/dsh@<新> dependencies --json)
npm view @deepseek-ai/dsh-tools@<新线> versions   # 框架包是否跨线

# 2. 安装新 CLI（npx 缓存隔离，互不污染）
npx -y @deepseek-ai/dsh@<新> --version

# 3. 兼容面核对（对照 3.5–3.7 的签名；地面真值=新版运行时 node_modules 里的 .d.ts）
#    - defineTool / ParameterSchemaSpec（object 的 additionalProperties 是否仍强制）
#    - ctx.systemPrompt.section 签名与 SECTION_ORDERS
#    - ctx.skills.register 的 SkillRegistration 形状
#    - app-boot 的 import 重定向是否仍在（搜 mountRootInclude / bareModuleBaseUrl）
#    - llm-deepseek 的 apiKeyEnv 解析顺序

# 4. 冒烟（第 4.5 节的验证矩阵按序跑）
npx -y @deepseek-ai/dsh@<新> --profile web --dump-config | grep strix
npx -y @deepseek-ai/dsh@<新> web --no-open        # 启动日志看注册行
dsh --profile headless "call strix_runs and quote its first line"

# 5. 生成目录对比（若从源码工作）
#    tool-catalog / persistence-catalog / config-catalog 的旧新 diff 就是破坏面清单
```

**升级决策规则**：类型零漂移 → 只更新本手册版本号；类型漂移但 shape 兼容 → 更新 pin 与本手册签名；shape 破坏 → 按 3.5/3.6/3.7 重对齐 + 全量冒烟。

### 3.10 失败模式速查（全部实测踩过）

| 症状 | 根因 | 处置 |
|---|---|---|
| 启动即崩 `EADDRINUSE 127.0.0.1:3080` | 旧实例 node 孤儿（TaskStop 只杀了 npx 外壳） | `netstat -ano \| findstr :3080` → `taskkill /F /PID` |
| 插件 ENOENT `assets/skills/manifest.json` | `import.meta.url` 相对层级错误（dist/ 下应为 `../assets/`） | 核对 URL 相对路径 |
| `Property 'skills' does not exist on type 'Context'` | 缺 `import type {} from '@deepseek-ai/dsh-skill'` 类型增强 | 补 side-effect type import |
| object 参数类型报错 | `additionalProperties` 未显式 | schema 强制要求 |
| 工具注册成功但 headless 里"工具不存在" | index.ts 漏挂 register 函数 | 对照 5.2 清单 |
| nuclei 挂起到超时 | 沙箱化子进程写不了其配置目录（Access denied） | 容器优先（已实现） |
| 多行字符串语法错 | 相邻字符串字面量缺 `+` | TS 不支持续行拼接 |
| GBK/编码、PATH 不生效 | Git Bash 会话 PATH 安装后不刷新 | 绝对路径或重开 shell |

### 3.11 版本历史与差异（npm latest `0.1.1-rc.2` → alpha 线）

> npm `latest` 标签仍指向 `0.1.1-rc.2`；`npx @deepseek-ai/dsh` 默认装 rc.2。alpha 线需要显式指定版本。来源：GitHub releases 官方说明 + [dshseek 追踪站](https://dshseek.com/news/dsh-v0-1-2-alpha-1-released/) + Discussions #5397（第三方插件影响）。

| 版本 | 关键变更 | 对 StriX-DH 的影响 |
|---|---|---|
| **0.1.2-alpha.1**（08-27，rc.2 后首个） | Code Mode 改名 **PTC**；**ApiProxy 移除**（迁 `@Remote` 网关）；PTC SDK 能力收进 `run_code`；web_fetch 默认开启（内置 SSRF 防护）；**WebUI 改一次性 token 鉴权**；subagent 支持 provider/model/reasoning_effort 选择；Python SDK Windows x64；ACP 补全；**破坏：`SessionEvent.ignorable` 移除**（alpha.2 恢复）；dsh-tools 跳到 0.1.2-alpha.1 导致 pin `^0.1.1-rc.2` 的第三方插件 import `CallId` 失败 | 我们 pin 运行时对齐版本恰好规避了 CallId 类事故；方法论提到的 "subagent 派发" 语义增强（可选模型） |
| **0.1.2-alpha.2**（08-30） | 恢复 `SessionEvent.ignorable`；连接失败状态+自动重连 UI；会话标题区显示定时计划；多模态（图片输入、Trajectory 图片）；Claude Code/Codex 适配器并入 subagent 体系；Windows 终端体验改进 | 无代码影响 |
| 0.1.2-alpha.3（08-31） | 长会话分页导航/内存优化；运行中图片排队投递修复；**移除可选 SQLite session 持久化后端**（数据不删，需旧版导出）；权限标签本地化 | 我们用 JSONL 默认后端，不受影响；接手者若有 SQLite 会话数据须先用旧版导出 |
| **0.1.2-alpha.4**（09-01） | **主/子代理通信改为双向 `send_message`（取代单向 report 工具）**；`Session.events` 移除 → `seq`/`eventAt()`/`snapshotEvents()` 按需读 API；`SessionSeq`/`SessionLogOffset` 强类型；headless/ACP/自定义 profile 默认开启 web_fetch；**Web PTC Mode 默认不再暴露 workflow 工具**；自定义模型发现复用 Profile 请求头 + 目录搜索 | **方法论/技能需跟进**：编排语义以 send_message 双向通信为准；**路线图第 5 项（session 事件持久化）必须用新 API**（`snapshotEvents()` 而非 events 读取）；workflow 引用需检查可见性 |
| **0.1.2-alpha.5**（09-02，纯修复） | 仅修复：从 0.1.1-rc.2 或 alpha.3 升级可能导致应用无法启动/会话标题消失 | 无影响；**基线已于 2026-09-03 迁移至 alpha.5**（历史：本表成文时基线为 alpha.3） |

**给接手者的版本策略**：基线升级时优先跳到该线最新 alpha（alpha.5 修复了升级路径 bug）；对照上表"影响"列逐条过；第三方插件事故（CallId）的教训 = **框架依赖版本永远对齐运行时实际携带版本**（见 3.3）。

---

## 4. StriX-DH 现状

**插件版本史**（`packages/strix-tools` 的 package.json version）：

| 插件版本 | 内容 |
|---|---|
| **0.12.11**（09-21） | **全量 review 修复批（P1×1 + P2×2 + P3×4）**：(P1) **0.12.9 的 finish 收敛在真实运行时静默空转**——`convergeJobsAtFinish` 调 `ctx.jobs.list/wait/kill` 未传 caller，而 dsh-jobs-local 的 `list(caller)` 只返回无主 job（我们所有后台 shell 都有 owner）→ 恒报"no live jobs"；单测没抓到是因为 fake 没实现 owner 围栏（忠于假设而非真实契约）。修复：`exec.agent` 穿透为 caller（list/wait/kill 三处），`jobs.ts` 新增模块级 `trackedShellJobs` 簿记（start 记录 id/label/owner、settle 移除、进程内全 agent 共享），finish 对**其他 agent 所有的存活 job** 以 `NOT convergable` 行点名 owner 诚实报告（注册表设计性禁止跨 agent kill）；测试重写为 owner-围栏 fake（list 按 caller 过滤、kill 断言）+ 新增「caller 自己的 job 可收敛」「他人 job 诚实报告」两例；(P2) `strix_proxy` 端口改绑 `127.0.0.1:${port}:8080`（此前 `-p` 全接口发布与"localhost-only"描述不符，0.12.7 只修了检测没修绑定），`dockerPsLineMatchesPort` 补 `127.0.0.1:PORT->` 形式（兼容旧版启动的容器）；(P2) `files` 白名单加 `LICENSE`/`NOTICE`（npm pack 实证 NOTICE 此前不在 tarball，Apache-2.0 §4(d) 分发要求）；(P3) architecture.md 版本 pin 对齐 0.12.10 三版本范围、`parseRawRequest` 格式修正 + raw_request 描述注明 Host 形式默认明文 http、browser screenshot/content 排空 guardNotes（裁决不再延迟显示）。vitest 191（188+3 环境性 skip）。 |
| **0.12.10**（09-21） | **dsh 0.1.6-alpha.2 适配（三版本 peer 范围）**：上游 alpha.1→alpha.2 逐面核对——插件 peer 的 7 个包（cordis/dsh-agent/dsh-jobs/dsh-skill/dsh-tools/dsh-user-approval/schemastery）**只有版本号 bump + cordis logger 一处无关的 exporter disposer 闭包修复**，defineTool/ToolRunContext/approval/jobs/skills/systemPrompt/preset 行格式零变化。**结构性变更：alpha.2 删除了桌面端 `validateDesktopPluginGraph` peer 版本硬校验**（profile-packages.ts/project-manager.ts 净删 726 行），改为 `packages/boot/app-boot` 的运行时 moduleFallback 解析——peerDependencies 只声明插件 import 什么（BFS 建宿主副本链接），**不再做 semver 门槛**；配套新增桌面插件管理页（安装/改配置/实时启停）与运行时卸载。适配：5 个 dsh-* peer 加 `\|\| 0.1.6-alpha.2`（三版本范围），devDeps 全量升 alpha.2（tsc 对新版类型零错），vitest 190（187+3 环境性 skip）。**真机验证**：`npx @deepseek-ai/dsh@0.1.6-alpha.2 --profile strix web` 启动，注册行完整打出 `registered 16 tool modules + methodology + authorization sections + 75 skills`。运行时卸载/启用循环：插件模块级零资源持有（无定时器/监听器/常驻进程，注册均为纯注册），禁用重载风险面为零，桌面 UI 实测留待桌面端升级（alpha.2 无官方安装包，仍需源码构建）。 |
| **0.12.9**（09-21） | **阶段三落地：结构化证据 + finish 终态收敛**：① `strix_finding` 新增 `evidence_refs`（`[{artifact, source, note?}]` 结构化工件引用）：artifact 必须是工作区内**已存在**的文件（safeWorkspacePath 越界拒收 + existsSync 缺失拒收，整单 fail-closed），**sha256/registered_at 由插件登记时计算盖戳**（模型自报哈希不作数），报告生成时重算哈希、被改/丢失工件以 ⚠ 漂移行如实标出——证据链防篡改；② `cvss_vector` 语法校验（新纯函数 `validateCvssVector`：`CVSS:3.1/` 前缀 + 指标键白名单 + 单字母值 + 八项基础指标齐全，create/update 双侧拒收畸形向量；指标与证据的对应关系仍属提示词纪律）；③ `strix_report finish` 从"追加四段"升级为真终态：关闭前收敛存活 strix-shell job（新 `convergeJobsAtFinish`：`ctx.jobs.list` → `wait` 有限等待，新配置 `finishJobWaitMs` 默认 10s → 超时 `kill` 并逐条记录进关闭段 `### Convergence`，registry 不可用时如实注明跳过），未决项诚实盘点（`### Loose Ends`：needs_follow_up/blocked 表面逐条列出，上限 10 条+溢出行），写冻结副本 `report-final.md`，已有 SARIF 边车同步刷新（交付对一致）；④ `strix_runs` 显示 `engagement: CLOSED`（report-final.md 存在即已关闭，防止对已收尾 engagement 静默续测）。**不做** finish 后硬写锁（信任边界类，按既定决定搁置）。vitest 190（187 pass + 3 环境性 skip，净增 13 例：refs 归一化/漂移/创建+报告集成、CVSS、finish 收敛含 settle-不杀/超时-kill/SARIF 刷新/幂等）。 |
| **0.12.8**（09-17） | **dsh 0.1.6-alpha.1 适配（双版本过渡）**：上游 rc.2→0.1.6-alpha.1 共 800 提交，逐面核对结论——插件使用的 API（defineTool/ToolRunContext/ctx.approval.request/ctx.jobs.start/ctx.skills.register/ctx.systemPrompt.section）**全部仅增量变化**（ToolExecutionInput 加可选 schema 字段、PromptSection 加可选 interpolate、approval/jobs/persona/tool-subagent/preset 行格式零变化）；唯一破坏性变更是**包更名 `@deepseek-ai/dsh-code-runtime` → `@deepseek-ai/dsh-ptc-runtime`** 与全体版本号 0.1.6-alpha.1。适配：peerDependencies 精简为 7 个实际导入包（cordis/dsh-agent/dsh-jobs/dsh-skill/dsh-tools/dsh-user-approval/schemastery——8 个未导入的传递类型依赖移回 devDependencies，从 peer 面彻底消失，更名问题随之消解），dsh-* peer 全部改双版本范围 `0.1.5-rc.2 \|\| 0.1.6-alpha.1`（桌面校验用标准 semver.satisfies，`\|\|` 范围两宿主都满足——过渡期两代桌面端同时可用）；devDependencies 升 0.1.6-alpha.1 并换名 ptc-runtime（tsc 直接对新版类型编译验证兼容）。验证：tsc 零错（对 0.1.6 类型）+ vitest 177（174 pass + 3 环境性 skip，Docker Desktop 未运行）；**用 0.1.6-alpha.1 真实的 validateDesktopPluginGraph 源码（从 tag 抽取编译）模拟校验：rc.2 与 0.1.6-alpha.1 两个宿主版本均 PASS，阴性对照（旧精确 pin peers 对 0.1.6 宿主）按预期 FAIL 并报出 peer 版本不满足**；宿主驱动验证 0.12.8 在当前 rc.2 桌面三 preset 会话创建全通过。本机桌面端更新到 0.1.6 后无需再动插件。 |
| **0.12.7**（09-13） | **全量 review 修复批（上游 0.1.5-rc.2 适配性核对通过后的遗留项）**：(P1) `strix_depcheck` check 的 OSV 明细+EPSS 补全改为 6 泳道有界并发池（新纯函数 `runPool`）+ 整体 `depcheckTimeoutMs` 预算（默认 120s，新配置项），预算耗尽后领取的行诚实降级为 vuln-id-only 并在输出注明——此前串行无界，是全套件唯一能把一次工具调用拖住几分钟的工具；(P1) `strix_http` save_to 描述与输出行诚实化：`sendHttpRequest` 新返回 `byteCapped` 标志，落盘被 `httpMaxBodyBytes` 截断时输出明确注明"保存副本受上限约束"，不再谎称"完整响应体"；(P3) `dockerPsLineMatchesPort` 纯函数同时匹配 `0.0.0.0:PORT->` 与 `[::]:PORT->` 两种 docker ps 发布行（IPv6-only 守护进程此前漏配）；(P3) sidecar 存活判定：pid 活着还需 `pidOwnedByDockerCli` 验证才信（防 pid 复用把死 sidecar 报成 running），失败回落 docker ps；(P3) strix preset 的 plan-mode 段落改写为 pentest 语境（不再引用本 preset 未挂载的 `ask_user_question`，探索手段改为 strix_runs/coverage/finding/notes/threat-model）；(P3) 补齐上游 standard preset 的 `present` 工具行（声明 report.md/findings.sarif 为会话交付物），operator 子代理 deny 列表加 `present`（交付物声明归编排者），`strix_report finish` 输出提示用 present 呈报。vitest 177（176+1 平台跳过）。 |
| **0.12.6**（09-13） | **桌面端 peerDependencies 契约修复**：桌面启动校验（validateDesktopPluginGraph）要求宿主保留包（@deepseek-ai/cordis 等 sharedPackages）不得出现在插件 `dependencies`——必须声明为 `peerDependencies`（宿主链接提供实例，peer 版本需 satisfy）。插件 15 个框架依赖全部移入 `peerDependencies`（版本约束原样保留），同时加入 `devDependencies` 供本地 tsc/vitest 解析；`dependencies` 清空。配套修复桌面 profile 的 241 个宿主包 junction（此前被误变为实体目录，触发 "duplicate or aliased host package"）。vitest 172 全绿。 |
| **0.12.5**（09-13） | **会话日志兼容性事故修复（desktop「历史加载失败：network error (gateway/internal)」根因）**：session-mirror 曾向会话日志追加自定义事件类型 `strix/coverage`、`strix/note`——`Session.append()` 无 ignorable 参数，自定义类型落盘不带 `ignorable: true` 标记，dsh 0.1.5-rc.2 的 v0→v1 格式迁移器对未知非 ignorable 事件直接拒绝，34 个继承这些事件的会话全部无法加载（报错被 gateway 折叠成 gateway/internal）。修复：数据面——脚本从 34 个受影响会话的 zstd 日志剔除全部 213 个 strix 事件行，重编所有事件 seq（普通行 seq=n++、packed chunks 行占 n..n+len-1 全区间映射），同步重写 sourceEventSeqs（区间展开→逐 seq 映射→重新打包）与 surfaceOp.replace 的 startSeq/endSeq，按 dsh 容器格式（header 独立一帧 + 事件一帧、带 checksum）重压缩写回；原文件备份于 sessions-backup-strix-fix；宿主同款 JsonlSessionPersistence 链路全量重扫 149/149 可打开。插件面——mirrorEvent 改为显式 no-op（模块头注释完整记录事故与契约原因），coverage/notes 调用点与测试保持不变（测试钉死 no-op 契约），防止新会话再写入非法事件类型。vitest 172（171+1 平台跳过）。 |
| **0.12.4**（09-13） | **审查遗留修复批（授权/信任边界类按用户决定跳过）**：CI——dockerReady 探测只查 daemon 应答，GitHub windows runner 是 Windows 原生守护进程（无 linux/amd64 清单，python:3.12-slim exit 125），两个新容器集成测试在 windows 腿必挂 → 改探测 `docker info --format '{{.OSType}}'`==linux（Docker Desktop Linux 容器照常跑，Windows 原生自跳）。预算——`budgetAction:'block'` 此前只有 recon/sast/depcheck/proxy-start 查账，执行类三件套 shell/pybox/browser 无视超限照跑（配置承诺大于实际执行）→ 三工具入口统一接 checkBudget（block 拒止 + warn 前缀；browser 的 close 永不拦截，超预算也能清理）。POST cap——check-then-bump 在并发下软上限（两个写手都读到 seen<cap 双双放行）→ 改 claim-then-check：先占位后回读，越 cap 的占位追加 `{void:true}` 行对冲（tally 对 void 行减一、不低于零），任意时刻每 path 有效占位 ≤ cap；拒绝信息同步更新。HTTP——response.text() 把整个 body 缓冲进内存后才截断显示副本，多 GB 响应可 OOM 宿主 → 新配置 `httpMaxBodyBytes`（默认 2MB，0 不限），流式 reader 读取、达限 cancel 连接、输出盖 `[body reception stopped at N bytes]` 戳。browser——evaluate 的 `includes('=>')` 启发式误包（裸表达式被 IIFE 包成 undefined、语句串原样发必然语法错）→ 先按表达式直发，SyntaxError 时回退 `(() => { ... })()` 并标注；同名 session 并发首调用各自起浏览器、输者泄漏（close/unload 均不可达）→ sessionPromises 单飞缓存，并发调用 await 同一次 launch。技能——python.md 教 `install_packages: ["requests"]`（数组）但工具契约是字符串 → 改为字符串示例并注明空格分隔，新增契约 lint 测试防回归。vitest 169+（新增 claim 硬上限/void 对冲/字节上限两例/预算三工具拒止/browser evaluate 回退与并发单飞/技能 lint）。 |
| **0.12.3**（09-13） | **三路并行 review 修复批（执行类/数据面/工程三 subagent 全量深读 + 人工复核）**：P0×3——`finding` dedupe 词重叠在同 endpoint 同 type 下**恒真**（URL 结构词 scheme/host/首段互含，第二个真实漏洞被静默判重劝退）→ 改为比较 endpoint 前缀之后的**细节 token**（query 参数/深路径段）交集，bare-vs-detailed 视为歧义放行登记；`coverage` update 全量重写**吞并发 record 行**（读快照→重写窗口）→ 改 append 版本行（`readLedger` 按 id 取末条，原始文件保留完整修改史）；`proxy stop` 杀 docker CLI 后 `stopped=true` **短路跳过 docker stop**（幽灵容器继续监听+捕获）→ 抽出可注入效果的 `stopSidecarWith`，容器停止独立于 CLI kill。P1——`targetCoveredByAuth` 双向 substring 无词边界（`example.com` 授权覆盖 `notexample.com`，recon/sast 对无关域发越权流量）→ host 边界匹配 + 端口语义（无端口 scope 盖任意端口/钉端口 scope 只盖该端口）；`evaluatePostPolicy`（http/browser/replay 三处共用）新增分支 (0)：活授权下**写请求打到 targets 外直接拒**，预批同样绑定 host；POST cap 计数键规范化 `normalizePathKey`（尾斜杠/重复斜杠/矩阵参数/大小写变体共享预算，堵换写法绕 cap）；browser spray-guard 三重缺口（guardNotes 闭包第二次调用起失明/route 安装失败 fail-open 照跑/`page.route` 不盖 popup 与 SW）→ notes 入 Session 逐调用排干 + 安装失败即拒 + `context.route` + `serviceWorkers:'block'` + navigate 限 http(s)（堵 `file://` 本地读）；`shell` image 全模式拒 `-` 前缀/空白（auto-allow 前缀模式下 `--privileged` 走私面）+ 空 image 回退默认；addon `.req` 改 absolute-form 请求行（HTTPS replay 不再降级明文）+ replay 按 flows.jsonl 补齐旧捕获 scheme；`writeFileAtomic` rename EPERM/EBUSY 短暂重试（Windows 并发读场景，修正不成立的 EXDEV 注释）；`pybox` files 全量预校验（审批门前，堵部分写入残留与非 string 崩溃）；`depcheck` 拒 null 元素；config `httpPostCapPerPath`/`budgetLimitUsd` 加 `min(0)`（负值静默关保护→启动即报）；`finding` update 拒空白 title/target；`runs` coverage 计数改 readLedger 口径（不再把版本行/撕裂行计入）。工程：包内补 README/LICENSE/NOTICE（npm 发布合规）、CI `timeout-minutes: 20`、CONTRIBUTING 测试计数 36+→154、根目录孤儿 lockfile 删除、README.zh 安装 profile 名对齐 en。注：0.12.2 行提到的 `--legacy-peer-deps` 已被 d58be81 取代（三个 peer 提升为直接依赖，裸 `npm ci` 通过）。vitest 154（+15 回归用例，含 dedupe 同 endpoint 异参数/host 边界/路径变体预算/幽灵容器/版本行并发五组 P0-P1 回归）。 |
| **0.12.2**（09-12） | **dsh 基线升级 0.1.2-alpha.5 → 0.1.5-rc.2（实测通过）**：上游把单体包拆成了细粒度服务包——插件补齐 `dsh-system-prompt`/`dsh-user-approval`/`dsh-agent`/`dsh-session`/`dsh-scope`/`dsh-llm`/`dsh-util-values` 七个新直接依赖（`dsh-tools`/`dsh-jobs`/`dsh-skill` 升 0.1.5-rc.2）；`defineTool`/`inject` 五服务/`preset.yml` 三键/`cordis.patch.yml` 机制全兼容零改动；peer 链需 `--legacy-peer-deps` 安装。验证：tsc 零错、vitest 139 过、`npx @deepseek-ai/dsh@0.1.5-rc.2 web` 真机加载 16 工具+75 skills 启动日志确认。上游新增 Electron 桌面端（`apps/desktop`），插件机制不变，桌面端可直接复用本套件 |
| **0.12.1**（09-12） | **交接文档 P0/P1 修复批（WorkBuddy 静态审查驱动）**：P0-1 浏览器持久会话——session 改为 BrowserContext+长生命周期 Page（导航/cookie/localStorage 跨调用保持，登录→fill→click→screenshot 链路可用），spray-guard 每页一次安装，evaluate 语义修复（IIFE 包装+undefined 渲染）；新增真实 Chromium 集成测试 2 例（状态保持+会话隔离+close 重置），CI 装 Chromium。P0-2 技能契约——重写 agent-browser.md/python.md（上游 CLI/Caido SDK 教学与真实工具完全脱节，中文短语曾泄入 Python 代码），manifest 描述同步，全量扫描无坏引用。adapt_skills.py——self-test exit code 传播（断言失败不再 CI 绿）、missing-source 守卫（空上游非零退出）、映射 ASCII 回归测试（抓出并修复 8 条中文短语映射）。P1——http 超时覆盖 body 接收阶段（clearTimeout 挪到 body 读完，慢速 body 按时 abort+专属错误文案）+ 慢滴 body 回归测试。vitest 139 过（+1 平台 skip） |
| **0.12.0**（09-04） | **四组 review 修复批（16 工具全量深读）**：P0——`recon` httpx 补 `-l subs.txt` 显式输入（此前空转报 Live hosts）+ 回归单测；`proxy stop` pid 经 OS 校验确为 docker CLI 才 kill（工作区伪造 pid 永不到 `process.kill`）+ nonce 落盘；审批摘要拆全文匹配/截断展示（sha256 戳，`splitApprovalSummary`，`gate-off` 也记 decision）；`dockerRun`/后台 job 全走 `--cidfile` + 超时/cancel `docker rm -f` 删 daemon 侧容器 + 后台完成补 evidence result。授权与执行——`targetCoveredByAuth` 共享 helper 接入 recon/sast（无有效授权拒绝主动扫描；nuclei 限 http(s)）；预批 body 改精确匹配；POST 政策抽 `evaluatePostPolicy` 供 proxy replay 共用（动词覆盖 POST/PUT/PATCH/DELETE，verb 检查收进 helper 内部成单一 choke point，计数四动词共享）；`strix_browser` 每页挂 route 拦截自动执行同一政策（超 cap abort，无人介入，可配 `browserEnforcePostPolicy` 关）；sast 黑名单双表 + 归一化（`=值`/`--长式`/`-rl100` 粘连）+ semgrep 工作区约束 + 挂载 `:ro`；depcheck 补预算门；recon 域名白名单。存储——coverage record 改 append-only + 坏行容错 + update `safeId`/原子写；budget 改 `budget-records.jsonl` append + reset 审计行；finding update/report/threat-save 原子写 + amend 追加化 + finish 幂等 + report 保留 Close 段 + `listFindings`/`readNotes`/`readLedger` 坏文件容错。契约——`code_locations` 改 array schema + `confidence` 两处枚举校验；`pyboxExtraPackages` 接线 + pip 白名单 + files `safeId` + runDir 随机后缀；SARIF 版本读 package.json；`clampTimeoutMs` 接全部超时入口；authorization set 畸形条目计数回执。配置新增 `sastNucleiImage`/`sastSemgrepImage`/`sastNetwork`/`sastExtraMountRoots`/`proxyImage`。单测 130+ 例，vitest 136 过（+1 平台 skip） |
| **0.11.1**（09-04） | **审查修复批**：ID 分配撞号——`finding`/`notes`/`coverage` 三处 create 从「文件数+1」改为「最大号+1」（`nextIdAmong`/`nextSequentialId`）+ `writeExclusive` O_EXCL 排他写 + 撞号重试（归档/删除中间项后新 ID 会静默覆写现存 finding，复现实证）；`strix_report` 空 `''` 占位被 filter 全滤导致 report.md 零空行（列表惰性续行 + `---` 成 setext H2），改 `join` + 可选字段条件 push；`strix_finding update` 补 severity/type 枚举校验 + strict 下拒清空 evidence；`validateFinding` 纯空白 evidence 放行修复（trim 后判）；POST 计数改**追加式 JSONL**（`http-post-counts.jsonl`，消 read-modify-write 窗口，旧 `.json` 只读合并不重置预算）；`checkDuplicate` manifest 不一致 `return`→`continue`（不再短路后续 findings，reason 保留 manifest 信息）；`skills-provider` fail-soft（manifest 损坏 warn + 返回 0，坏条目/重复名跳过，不再拖垮 profile）；`runProcess` 超时真杀进程树（POSIX `detached`+`kill(-pid)`，Windows `taskkill /T /F` **spawnSync**——异步版输给 `child.kill()` 兜底，cmd 先死导致 /T 到不了孙进程，实测 settle 29.4s→1.1s）；`readKevCache` 死分支删除 + `fetched_at` NaN/`cves` 数组防御。单测 21 例，vitest 100 例（+1 平台 skip） |
| **0.11.0**（09-04） | **实战复盘五项（jxnu 120 站会话导出分析）**：coverage 加 `ruled_out`（分诊收敛：纯资讯站 1–2 GET 后关闭并具名理由，不再开新批）+ 方法论 TRIAGE/BLOCKED-SECOND-PATH/ENGAGEMENT-ISOLATION 三段 + `strix_http` POST 三分支（预批直发 / live 授权下非预批直发+审计戳+`http-post-counts.json` 按 path 计数 + `httpPostCapPerPath`=5 熔断）+ `authorization.json` 加 `test_accounts` vault（get 自取，prompt/report 全掩码）+ report 追加授权摘要段与 workspace 路径 + preset 单层委托纪律（`strix_operator` 叶子、每波 ≤6、禁轮询）。单测 8 例，vitest 79 例 |
| **0.10.2**（09-04） | **"你定"根治（Strix 五层机制 dsh 翻译）**：用户截图"三选一你定"两现行——根因是 0.10.1 只给了"不要问"，没给"遇到需批准事项时先找预批"。方法论加 APPROVAL-OR-ACT 决策树（预批四源：已发账号/范围内低速/预批 POST/预批 shell，有即用，无才记 block 且同 turn 继续次优）+ TURN-CLOSE 模板（收尾工具清单）；operator 交差 HANDOFF FORMAT（agent_finish 等价：Tested/Findings/Open items/Recommendations，被阻项永不停机）；`authorization.json` 加 `pre_approved_post_paths`（POST-only 证明预批），`strix_http` POST 命中出 clearance 行。单测 3 例，vitest 70 例；预批链 headless 实测（set→get→POST clearance 行） |
| **0.10.1**（09-04） | **完全自动化（Strix 方案 dsh 翻译）**：研读上游 `system_prompt.jinja`（AUTONOMOUS BEHAVIOR + 纯文本不结束 turn 的 lifecycle 语义）后定位根因——dsh 语义相反（纯文本即交权），删 ask 工具不够。方法论 + 三 persona 统一注入 AUTONOMY 纪律（永远工具调用收尾；三选项优先级自主推进；合法停机仅授权/目标问题）。`methodologySection` 回归单测，vitest 67 例；真实工作区 headless 验证零提问推进 11 面 |
| **0.10.0**（09-03） | **AI 漏洞库**：新工具 `strix_depcheck`（OSV querybatch 主查 → vulns/{id} 明细 → KEV 缓存命中 → EPSS 排序；KEV 全量 workspace/vulndb/kev.json 24h TTL；结果直喂 `strix_finding dependency_cve` + `dedupe-check` 身份）；`strix_sast` nuclei 容器挂 `strix-nuclei-templates` 命名卷（模板日更不断层）。单测 4 例，vitest 66 例；headless 实测 lodash@4.17.20 查出 5 洞（CVE/EPSS/fixed 全）+ KEV 1694 缓存 + dedupe 链 |
| **0.9.0**（09-03） | **渗透手感放开**：`strix_shell` image allowlist 只在无人值守（approvalGate off）时强制，有人审批时镜像名进审批摘要由人定；`strix_sast` extra_args 黑名单缩到三类（重定向目标/限速并发/引擎配置），模板选择/输出格式/代理路由全放开；新增 `approvalAutoAllow`（正则预批，默认空=行为不变，命中记 `auto-allowed` 审计）。单测 3 例，vitest 62 例；`-t cves/` 放行 + `-rl` 照拦 headless 实测 |
| **0.8.2**（09-03） | **全项目 review 安全修复**：`safeId`/`safeWorkspacePath`（util.ts）堵四处路径遍历（http save_to 写出 workspace、finding get/update 坏 id、notes get/update/delete 坏 id、browser session 名进截图文件名）；`strix_shell` image allowlist（`shellAllowedImages` 配置，默认仅 shellImage）；`strix_sast` extra_args 危险 flag 黑名单 + nuclei severity 白名单；browser sessions 进程级共享文档化。单测 6 例，vitest 59 例；四守卫 headless 真实触发验证（REJECTED 逐字引用） |
| **0.8.1**（09-03） | **REFUSAL AVOIDANCE 条件版**：`strix:authorization` section 三态渲染（无授权=被动提醒；有效授权=事实+ refusal-avoidance 段；过期=警告+退回被动），`isAuthorizationExpired` 纯函数；上游无条件版"never question authority"仍不出——差异故意（本地无平台级 scope 验证）。单测 3 例，vitest 53 例，真实渲染验证 |
| **0.8.0**（09-03） | **报告管线三件 + runs 可见性**：`strix_report action=sarif`（SARIF 2.1.0 sidecar：规则/结果/coverage/ fixes，`src/tools/sarif.ts`， headless 实测 3 rules 4 results 落盘）；`strix_finding action=dedupe-check`（确定性去重：同类型+端点+文本 / 同 CVE+包，manifest 区分，实测判 DUPLICATE of F-001）；`strix_report action=finish`（仅 root 关闭 engagement，四段必填，operator 拒绝指路 send_message）；`strix_runs` 追加逐条 filed-reports + budget 状态行；proxy description 写明无 scope 名单（与上游 Caido scope 的如实差异）；vitest 50 例 |
| **0.7.0**（09-03） | **mitmproxy 侧车**：`strix_proxy`（start/status/list/get/replay/stop）+ mitmdump 容器 + addon 落盘（flows.jsonl + .req/.rsp）；replay 复用共享 `sendHttpRequest`（http.ts 重构抽出）；stop 双路径修过跨进程误报；vitest 36 例 |
| **0.6.0**（09-03） | **会话事件镜像**：`src/lib/session-mirror.ts` 扩展 `SessionEventMap`（`strix/coverage` + `strix/note`，log-only），coverage record/update 与 notes create/update/delete 成功后 best-effort append（失败吞掉，文件仍是主存储）；vitest 32 例 |
| **0.5.0**（09-03） | **后台模式**：`strix_shell background=true` 走 dsh jobs（kind `strix-shell`，`src/lib/jobs.ts` producer + 流式输出 + kill 链路），管理用 dsh 自带 `job_output`/`job_list`/`job_kill`；inject 增 `'jobs'`，`@deepseek-ai/dsh-jobs` 精确 pin；vitest 28 例 |
| **0.4.0**（09-03） | **预算账本**：`strix_budget` 工具（record/status/reset，台账 `workspace/budget.json`，单价默认 DeepSeek V3.2 官价）+ recon/sast 执行前预算门（warn 前缀/block 拒止）；14 工具；vitest 25 例 |
| **0.3.0**（09-03） | **授权证明层**：`strix_authorization` 工具（set/get/clear，声明存 `workspace/authorization.json`）+ `strix:authorization` section（order 101，provider 函数每 turn 动态注入"简短事实版"，无声明时注入被动限制提醒）；方法论节增"授权纪律"条目；13 工具；vitest 18 例 + CI（node 20/22 × ubuntu/windows） |
| **0.2.0**（09-03） | **HITL 审批门**：strix_shell/strix_pybox 逐调用经 dsh ApprovalService 审批（fail-closed），`approvalGate: 'always'\|'off'` 配置，插件 inject 增 `'approval'`，新增 `src/lib/approval.ts` 与 `<workspace>/evidence/log.jsonl` 台账；方法论节增"审批门纪律"条目 |
| 0.1.0 | 12 工具初版 + 方法论 section + 75 技能（alpha.3 → alpha.5 适配完成） |

### 4.1 工具契约与验证矩阵（16/16 已注册；V=真实 LLM 调用验证，D=直接调用验证，-=待二进制/目标）

| 工具 | 参数要点 | 验证 |
|---|---|---|
| `strix_runs` | 无参 | V（LLM 逐字引用输出） |
| `strix_http` | url/method/headers/body/raw_request/follow_redirects/timeout_ms/save_to | V（example.com 200；427ms） |
| `strix_finding` | action=create/update/list/get/**dedupe-check**；**strict 模式无 evidence 拒收**；severity/type 枚举校验；dedupe-check 确定性判定（同类型+端点+文本 / CVE+包） | V（F-001 登记；headless 实测判 DUPLICATE of F-001 与 NOT A DUPLICATE） |
| `strix_report` | engagement_title/scope_summary → report.md；**action=sarif** → findings.sarif（SARIF 2.1.0）；**action=finish**（仅 root，四段必填） | V（1 finding 汇总；headless 实测 sarif 3 rules 4 results 落盘；finish operator 拒绝 + root 缺段拒绝） |
| `strix_coverage` | record（append-only）/update（原子写）/list；outcome ∈ clean/finding/needs_follow_up/blocked/ruled_out；坏行容错 | V（C-001） |
| `strix_notes` | create/list/get/update/delete | V（N-001） |
| `strix_threat_model` | get/amend/save | V（基线保存） |
| `strix_authorization` | set/get/clear；声明存 `workspace/authorization.json`；`strix:authorization` section（order 101，provider 动态注入） | V（headless：get 空态 → set 落盘 → clear 撤销；单测 3 例：空态渲染/round-trip/坏文件 fail-safe） |
| `strix_shell` | command/timeout_ms/image/network/workdir/**background**；一次性容器、workspace 挂 /workspace；**审批门** | V（uname/python3.12.14/whoami；审批门两路实测；后台三路实测：job 启动 → job_output 读到输出 exit 0 → job_kill 终止） |
| `strix_pybox` | script/files/install_packages/arguments/timeout_ms/network；**审批门同 shell** | V（args.json 注入回读；门逻辑与 shell 共用 `createApprovalGate`） |
| `strix_browser` | action=navigate/click/fill/evaluate/screenshot/content/close；session 隔离 | V（导航+截图落盘+关闭） |
| `strix_recon` | domain/skip_httpx/timeout_ms；**预算门** | V（subfinder 24,948 子域落盘；httpx 相同机制未单独测；block 拒止实证见预算行） |
| `strix_sast` | engine=nuclei/semgrep；nuclei 容器优先（宿主二进制回退）；semgrep 容器回退；**预算门（warn 前缀/block 拒止）** | V（nuclei 容器扫描 exit 0；semgrep 容器对自身源码 exit 0） |
| `strix_budget` | record（append-only `budget-records.jsonl`）/status/reset（审计行）；台账 `workspace/budget.json` 基线；`budgetLimitUsd`/`budgetInputPer1k`/`budgetOutputPer1k`/`budgetAction` | V（headless：status 空态 → record $0.0175 → cap $0.0001 下 recon 被拒 `BUDGET EXCEEDED` → reset 清零；单测 7 例） |
| `strix_proxy` | start/status/list/get/replay/stop；mitmdump 容器侧车 + addon 落盘；replay 经共享 sender | V（headless：start :18080 → curl 走代理 GET example.com → flows.jsonl + .req/.rsp 落盘 → list/replay `HTTP 200 OK` → stop 跨进程 `docker stop`；单测 4 例） |
| `strix_depcheck` | action=check（预算门）/kev-refresh/status；packages `[{ecosystem,name,version}]`；OSV 主查 + KEV 缓存（vulndb/kev.json 24h TTL）+ EPSS 排序 | V（headless：status 缺缓存 → kev-refresh 1694 → check lodash@4.17.20 查出 5 洞 CVE/EPSS/fixed 全 → dedupe-check NOT A DUPLICATE 链；单测 4 例） |

### 4.2 配置全表（`src/config.ts`）

`workspaceDir`（默认空=锚 `~/.dsh/strix-workspace`）、`httpTimeoutMs` 30s、`httpMaxBodyChars` 20k、`httpPostCapPerPath` 5（台账 `.jsonl`）、`shellImage` python:3.12-slim、`shellAllowedImages[]`（仅无人值守 approvalGate off 时强制；有人审批时镜像名进审批摘要由人定）、`shellNetwork` true、`shellTimeoutMs` 120s、`pyboxImage`、`pyboxExtraPackages[]`（与单次 `install_packages` 合并安装）、`pyboxNetwork` true、`pyboxTimeoutMs` 60s、`binariesDir`（空=查 `~/.dsh/bin` 再 PATH）、`reconTimeoutMs` 300s、`nucleiRateLimit` 50、`sastNucleiImage`/`sastSemgrepImage`（默认 `:latest` 官方镜像）、`sastNetwork` true、`sastExtraMountRoots[]`（工作区外允许 semgrep 的根）、`proxyImage` mitmproxy/mitmproxy:latest、`browserHeadless` true、`strictEvidence` true、`approvalGate` `'always'`（HITL 审批门，`'off'`=无人值守自担责任，`gate-off` 也记 decision）、`approvalAutoAllow[]`（正则预批，默认空=不放宽，**匹配全文**、展示截断+sha256 戳，命中记 `auto-allowed` 审计）、`finishJobWaitMs` 10s（finish 收敛时对存活 strix-shell job 的有限等待，超时 kill）。授权声明**不在 config 里**——它是每个 engagement 的事实，存 `workspace/authorization.json`（见 tools-reference 授权节）。所有 per-call `timeout_ms` 经 `clampTimeoutMs` 钳制 (0, 1h]。

### 4.3 已知缺陷与技术债（诚实清单）

1. ~~`strix_recon` 的 httpx 相未独立验证（机制同 runProcess，风险低）~~ ✅ **已修复（0.12.0）**：httpx 经 `-l subs.txt` 显式投喂（`buildHttpxArgs`，回归单测锁定），此前是空转报数
2. `strix_shell` 每次调用是新容器——无持久会话；持久状态靠 workspace 文件（Strix 有 PTY 持久会话）
3. `strix_browser` 的 session 存 plugin 进程内存，仅靠 ctx.effect 兜底清理；无空闲回收（Strix 3 分钟回收）
4. ~~预算控制只有任务级约束，无跨 turn 美元预算（dsh token-meter 集成在路线图）~~ ✅ **已落地（0.4.0，显式记账模式）**：`strix_budget` + recon/sast 超限 warn/block
6. ~~Caido/mitmproxy 拦截代理未集成（v1 用 strix_http 重放覆盖）~~ ✅ **已落地（0.7.0）**：`strix_proxy` + mitmdump Docker 侧车（见路线图第 6 项）
7. 改编技能为机械映射，未逐篇人工审校工具名上下文
8. 审批门的 WebUI 交互对话框未在本机实测（应答器代码 dsh-acp/api-remotes 已核对；headless 两路径已实测）

### 4.4 本机部署状态（2026-09-03）

Docker Desktop 29.7.2（WSL2）✅；`~/.dsh/bin/{subfinder,httpx,nuclei}.exe` ✅；Chromium（playwright 1.62.1 配套）✅；credential store 含 DEEPSEEK_API_KEY ✅；profiles：web/strix/headless（均挂 strix-tools）✅；preset：`~/.dsh/.agent-presets/strix/` ✅；WebUI 运行中（token 见 `dsh-boot.log`）。

### 4.5 冒烟验证命令（每次改动后跑）

```sh
cd packages/strix-tools && npm run build        # 零 error 才继续
dsh --profile web --dump-config | grep strix     # bundle 层在
npx -y @deepseek-ai/dsh@0.1.5-rc.2 web --no-open > dsh-boot.log 2>&1 &
# 启动日志第一行应为: [strix-dsh-tools] registered 16 tool modules + methodology + authorization sections + 75 skills
DEEPSEEK_API_KEY=... npx -y @deepseek-ai/dsh@0.1.5-rc.2 --profile headless \
  "Call strix_runs once and quote its first line."
# 审批门回归（默认应 DENIED）：
#   ... --profile headless "Call strix_shell once with command 'echo t'. Quote its output verbatim."
#   预期: DENIED ... (outcome: unavailable)   ← headless 无应答器，fail-closed
```

---

## 5. 路线图

**Phase 2（设计已就绪）**
1. ~~**双人设**：strix preset 拆 root（编排者，借鉴 root_agent_directive）与 operator（动手）两个 preset，用 `dsh-persona` 遮蔽；子代理继承父组合~~ ✅ **已落地（presets/ 目录）**：`strix`（编排者，全量）+ `strix-operator`（执行者，去 delegation/workflow/goal/plan）。实测结论：alpha.5 子代理继承父组合、派发时选不了 preset，所以拆分只对手动开的并行会话生效（详见 presets/README.md）
2. ~~**美元预算**：`ctx.tokenMeter` 计量 + 预算配置，超限降级/暂停~~ ✅ **已落地（0.4.0）**；剩余：dsh 开放 usage 订阅后改自动喂数
3. ~~**`strix_shell` 后台模式**：注册 JobKindMap，`job_output`/`job_kill` 管理~~ ✅ **已落地（0.5.0）**：`background` 参数 + `src/lib/jobs.ts` producer（kind `strix-shell`，流式 readOutput，cancel 发 SIGKILL + 5s 兜底 settle 防僵尸条目）
4. ~~**attestation 动态注入**：`strix_authorization` 工具 + section provider（简短事实版；含拒绝率 A/B 实测）~~ ✅ **已落地（0.3.0）**；剩余：拒绝率 A/B 实测
5. ~~**session 事件持久化**：coverage/notes 迁到自定义 SessionEvent（保留文件版做兼容）~~ ✅ **已落地（0.6.0，镜像模式）**：`src/lib/session-mirror.ts` 扩展 `SessionEventMap`（`strix/coverage` + `strix/note`，log-only），record/update/create/delete 成功后 best-effort append；文件仍是主存储（读路径不变），镜像失败吞掉不炸调用
6. ~~**mitmproxy 侧车**：拦截代理 + 流量查询工具~~ ✅ **已落地（0.7.0）**：`strix_proxy`（start/status/list/get/replay/stop）+ mitmdump 容器侧车 + `assets/mitmproxy/strix_addon.py`（flows.jsonl 摘要 + .req/.rsp 落盘）；replay 经共享 `sendHttpRequest`（http.ts 重构抽出）；stop 双路径（同进程 pid kill + 跨进程 docker stop，实测修过一次误报 bug）

**Phase 3**：CI/CD 集成（PR diff 扫描）、技能人工审校全覆盖、更多改编语言文档。

---

## 6. 发布前清单（开源准备）

- [x] vitest 单测（70 例，`packages/strix-tools/test/core.test.ts`）+ kebab/adapt 自测（7 例，`scripts/adapt_skills.py --self-test`，CI 内）
- [x] `.github/workflows/ci.yml`（build + test + adapt 自测，node 20/22，windows+ubuntu）
- [x] SECURITY.md / CONTRIBUTING.md（根目录；safety.md 的"to be added"已指向 SECURITY.md）
- [x] 英文版 docs（`docs/en/` 全覆盖：tools-reference + walkthrough + DEVELOPMENT + architecture + prompt-design + skills-catalog + 双 analysis；safety 本身即英文原文）
- [x] 确认 `upstream/` 不在任何发布物中（.gitignore + package files 双保险，2026-09-03 核对）；NOTICE 与改编头部齐全
- [x] 移除仓库内 `dsh-boot.log`、`strix-workspace/` 等运行痕迹（2026-09-03 核对，4 处皆无）

---

## 7. 给接手 AI 的三条操作建议

1. **改动前先跑 4.5 冒烟**建立基线；任何"工具不存在/形状不对"先查第 3.9 节失败模式表
2. **永远以运行时实物为地面真值**：本手册初版写于 0.1.2-alpha.3、基线迁移至 alpha.5；dsh 迭代极快，执行 `3.9 升级演练` 后再信手册
3. **方法论是产品的灵魂**：改工具时同步检查 `prompt-design.md` 的映射是否仍成立——工具名重映射散落在 75 个技能文件里（`scripts/adapt_skills.py` 的 MAPPINGS 表是唯一来源，改映射要重新生成）
