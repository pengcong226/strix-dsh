# StriX-DH 开发者手册

> **本文档的目标读者**：接手本项目的开发者或 AI 助手。读完本文你应当：(1) 理解 Strix 上游的设计与资产；(2) 掌握 dsh 当前版本的架构与"一切皆插件"的扩展方式；(3) 了解 StriX-DH 的现状、代码约定与验证状态；(4) 能够在 dsh 发新版本时快速完成适配。
>
> **阅读顺序**：第 1 节速览全局 → 做开发前精读第 4 节（dsh 兼容面）和第 5 节（本项目现状）→ 升级 dsh 时执行第 3.9 节的升级演练。
>
> **配套深度文档**：[strix-analysis.md](strix-analysis.md)（Strix 上游完整解析）、[dsh-analysis.md](dsh-analysis.md)（dsh 运行时完整解析）、[tools-reference.md](tools-reference.md)（15 工具完整契约与实测输出）、[walkthrough.md](walkthrough.md)（从启动到第一份报告的实战走查）、[skills-catalog.md](skills-catalog.md)（75 技能目录）、[prompt-design.md](prompt-design.md)（提示词资产映射）。
>
> **信息权威级**（冲突时以高者优先）：运行时实物（npx 缓存里的 node_modules）> 上游仓库对应 tag 的源码 > 生成目录（tool-catalog / persistence-catalog / config-catalog，由 `pnpm run verify-*` 保证与代码一致）> README/设计笔记 > 本手册。
>
> 基线版本：dsh CLI **`0.1.2-alpha.5`**（2026-09-02 发布，2026-09-03 自 alpha.3 升级，零代码改动通过全量冒烟）。dsh 处于 developer preview，**几天一个大幅改动是常态**，第 3.9 节是为此准备的。

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
| `strix_coverage` | record/update/list；outcome ∈ clean/finding/needs_follow_up/blocked | V（C-001） |
| `strix_notes` | create/list/get/update/delete | V（N-001） |
| `strix_threat_model` | get/amend/save | V（基线保存） |
| `strix_authorization` | set/get/clear；声明存 `workspace/authorization.json`；`strix:authorization` section（order 101，provider 动态注入） | V（headless：get 空态 → set 落盘 → clear 撤销；单测 3 例：空态渲染/round-trip/坏文件 fail-safe） |
| `strix_shell` | command/timeout_ms/image/network/workdir/**background**；一次性容器、workspace 挂 /workspace；**审批门** | V（uname/python3.12.14/whoami；审批门两路实测；后台三路实测：job 启动 → job_output 读到输出 exit 0 → job_kill 终止） |
| `strix_pybox` | script/files/install_packages/arguments/timeout_ms/network；**审批门同 shell** | V（args.json 注入回读；门逻辑与 shell 共用 `createApprovalGate`） |
| `strix_browser` | action=navigate/click/fill/evaluate/screenshot/content/close；session 隔离 | V（导航+截图落盘+关闭） |
| `strix_recon` | domain/skip_httpx/timeout_ms；**预算门** | V（subfinder 24,948 子域落盘；httpx 相同机制未单独测；block 拒止实证见预算行） |
| `strix_sast` | engine=nuclei/semgrep；nuclei 容器优先（宿主二进制回退）；semgrep 容器回退；**预算门（warn 前缀/block 拒止）** | V（nuclei 容器扫描 exit 0；semgrep 容器对自身源码 exit 0） |
| `strix_budget` | record/status/reset；台账 `workspace/budget.json`；`budgetLimitUsd`/`budgetInputPer1k`/`budgetOutputPer1k`/`budgetAction` | V（headless：status 空态 → record $0.0175 → cap $0.0001 下 recon 被拒 `BUDGET EXCEEDED` → reset 清零；单测 7 例） |
| `strix_proxy` | start/status/list/get/replay/stop；mitmdump 容器侧车 + addon 落盘；replay 经共享 sender | V（headless：start :18080 → curl 走代理 GET example.com → flows.jsonl + .req/.rsp 落盘 → list/replay `HTTP 200 OK` → stop 跨进程 `docker stop`；单测 4 例） |
| `strix_depcheck` | action=check/kev-refresh/status；packages `[{ecosystem,name,version}]`；OSV 主查 + KEV 缓存（vulndb/kev.json 24h TTL）+ EPSS 排序 | V（headless：status 缺缓存 → kev-refresh 1694 → check lodash@4.17.20 查出 5 洞 CVE/EPSS/fixed 全 → dedupe-check NOT A DUPLICATE 链；单测 4 例） |

### 4.2 配置全表（`src/config.ts`）

`workspaceDir`（默认空=锚 `~/.dsh/strix-workspace`）、`httpTimeoutMs` 30s、`httpMaxBodyChars` 20k、`shellImage` python:3.12-slim、`shellAllowedImages[]`（仅无人值守 approvalGate off 时强制；有人审批时镜像名进审批摘要由人定）、`shellNetwork` true、`shellTimeoutMs` 120s、`pyboxImage`、`pyboxExtraPackages[]`、`pyboxNetwork` true、`pyboxTimeoutMs` 60s、`binariesDir`（空=查 `~/.dsh/bin` 再 PATH）、`reconTimeoutMs` 300s、`nucleiRateLimit` 50、`browserHeadless` true、`strictEvidence` true、`approvalGate` `'always'`（HITL 审批门，`'off'`=无人值守自担责任）、`approvalAutoAllow[]`（正则预批，默认空=不放宽，命中记 `auto-allowed` 审计）。授权声明**不在 config 里**——它是每个 engagement 的事实，存 `workspace/authorization.json`（见 tools-reference 授权节）。

### 4.3 已知缺陷与技术债（诚实清单）

1. `strix_recon` 的 httpx 相未独立验证（机制同 runProcess，风险低）
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
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open > dsh-boot.log 2>&1 &
# 启动日志第一行应为: [strix-dsh-tools] registered 16 tool modules (16 tools) + methodology + authorization sections + 75 skills
DEEPSEEK_API_KEY=... npx -y @deepseek-ai/dsh@0.1.2-alpha.5 --profile headless \
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

- [x] vitest 单测（67 例，`packages/strix-tools/test/core.test.ts`）+ kebab/adapt 自测（7 例，`scripts/adapt_skills.py --self-test`，CI 内）
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
