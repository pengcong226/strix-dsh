# StriX-DH 架构与运行时机制

## 运行时基线

| 组件 | 版本 | 说明 |
|---|---|---|
| dsh CLI（运行时） | **0.1.2-alpha.5** | 开发基线（2026-09-03 自 alpha.3 升级，插件零改动通过全量冒烟），经 `npx @deepseek-ai/dsh@0.1.2-alpha.5` 调用 |
| @deepseek-ai/dsh-tools | **0.1.2-alpha.5** | 与运行时实际携带的副本对齐（CLI 依赖用 `^0.1.2-alpha.3`+ 范围拉取，解析到 alpha.5） |
| @deepseek-ai/cordis | ^4.0.2 | |
| @deepseek-ai/schemastery | ^3.18.2 | |

> ⚠️ dsh 是 developer preview：升级 CLI 版本时必须重新核查本文档中的全部接口约定。

## 关键机制 1：bare import 的运行时重定向（防双实例）

`dsh-app-boot`（app-boot/src/index.ts, `mountRootInclude`）覆写了插件的模块解析：**插件里所有 bare specifier 的 import（如 `@deepseek-ai/dsh-tools`）都会被重定向到运行时自身携带的副本**（`bareModuleBaseUrl`），只有相对路径和 `cordis:` 前缀走本地解析。

含义：
- 我们 package.json 里声明的框架依赖 **只服务于本地 tsc 类型检查和 IDE**；执行时永远是运行时的副本。
- bundle 不需要（也不应该）追逐运行时的精确版本做运行时对齐——但为了**类型检查与执行环境一致**，仍建议把 pin 对齐运行时实际携带的版本（可用 `node -e "require('<npx缓存>/@deepseek-ai/dsh-tools/package.json').version"` 查证）。
- 升级 dsh 后若工具注册出现形状不兼容，优先怀疑运行时 alpha 版本与本地类型版本漂移。

## 关键机制 2：system prompt 注入

- seam：`inject = ['systemPrompt']` → `ctx.systemPrompt.section({ name, order, text })`
- `text` 支持静态字符串或 **provider 函数**（每次组装时以 `AssembleContext` 求值）——这是"按目标特征动态注入"的官方通道；`{{variable}}` 插值由 `renderPrompt` 处理
- section order（alpha.3 实测）：HARNESS_IDENTITY -1000 / DEPLOYMENT_PERSONA 0 / PLAN_POLICY 500 / TOOL_BASH 1000 / TOOL_PWSH 1010 / … / TOOL_SUBAGENT 2800 / TOOL_REPORT 2900 / STRUCTURED_OUTPUT 9900
- StriX-DH 方法论 section 用 **order 100**（人设之后、工具说明之前），name `strix:methodology`

## 关键机制 3：bundle 与 profile

- bundle = package.json 声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` + patch 层（行按**包名**引用插件）+ 编译后的 `dist/`
- 安装：`dsh plugin --profile <name> add ./packages/strix-tools`（pnpm link 进 profile）
- 组装顺序：dsh-base → 依加入顺序的各 bundle → profile 自身 cordis.patch.yml → `--patch` 覆盖层
- 验证：`dsh --profile <name> --dump-config` 看 `# == strix-dsh-tools` 层；启动日志看 `[strix-dsh-tools] registered 11 tool modules`
- `web` 子命令 = `--profile web` 的别名；**profile 标志在顶层**，`web` 不接受 `--profile`

## 关键机制 4：skills 发现路径（skill-filesystem provider）

- 项目级：`<projectRoot>/.dsh/skills/`（rank: project-dsh）、`<projectRoot>/.agents/skills/`
- 用户级：`$DSH_HOME/skills/`（默认 `~/.dsh/skills`）、`~/.agents/skills/`
- 格式：目录式或扁平 Markdown + YAML frontmatter（name/description）
- StriX-DH 的改编知识包随仓库发布在 `.dsh/skills/`

## 状态追踪的存储决策

Strix 的 coverage/notes/threat_model 是共享可变台账。StriX-DH v1 用 **workspace 文件**（findings/*.json、coverage/ledger.jsonl、notes/*.json、threat-model.md）而非 session 事件：跨 agent 共享靠同一 workspace，跨会话存活靠磁盘。session 自定义事件合并（persistence-catalog 机制）留作 Phase 2 精化。

## 增量：工作区锚定与二进制发现（第二轮）

- **工作区默认锚**：`workspaceDir` 默认空串 → 解析为 `<DSH_HOME>/strix-workspace`（`~/.dsh/strix-workspace`），彻底摆脱 boot 目录依赖；显式配置可覆盖（相对路径仍按 cwd 解析）。
- **二进制搜索顺序**：`binariesDir` 配置 → `~/.dsh/bin` → PATH。`~/.dsh/bin` 是操作员放引擎的标准位置（subfinder/httpx/nuclei 已部署于此）。
- **semgrep 容器回退**：Windows 无原生 semgrep；`strix_sast engine=semgrep` 在宿主无二进制时自动改用 `returntocorp/semgrep` 容器，把目标目录挂载到 /src（要求 target 为绝对本地路径）。
- **nuclei 容器优先**：实测发现 nuclei 在 dsh 沙箱化的子进程里无法写自己的配置目录（`could not create config file: Access is denied`），会挂起直到超时。因此 `strix_sast engine=nuclei` 改为**容器优先**（`projectdiscovery/nuclei` 官方镜像自带模板库，Windows 免配置目录问题），宿主二进制仅在无 Docker 时作为回退。semgrep 同理采用容器回退模式。

## 增量：strix agent preset（一切皆插件的会话级组合）

`~/.dsh/.agent-presets/strix/`（从 shipped standard 预设派生）：

- `preset.yml`：名称"StriX-DH 渗透测试"
- `agent.cordis.yml`：
  - `persona` 行（`dsh-persona`）：Strix 编排者纪律 + closure 三态 + CVSS 绑定 + 十类主攻漏洞，支持 `{{model}}`/`{{cwd}}` 插值
  - `strix-tools` 行：按包名挂载我们的 bundle（preset 行即会话组合）
  - 其余继承 standard（fs/skill/jobs/delegation/compaction 全套）

会话选择器里选"StriX-DH 渗透测试"即进入渗透模式；子 agent（subagent）继承父会话组合，天然共享同一工具与人设。升级 dsh 时若 preset 无法加载，roster 会在 WebUI 选择器里给出原因。

## 已验证的启动清单

```sh
cd packages/strix-tools && npm install && npm run build
dsh plugin --profile web add ./packages/strix-tools   # 装进 web profile
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open > dsh-boot.log 2>&1
# 启动日志第一行应为: [strix-dsh-tools] registered 11 tool modules
# WebUI: http://127.0.0.1:3080/?token=<启动日志中的token>
```

注意：Windows 下 TaskStop/杀 npx 外壳可能留下持有 3080 端口的 node 孤儿进程，重启前 `netstat -ano | findstr :3080` 检查并 `taskkill /F /PID <pid>`。
