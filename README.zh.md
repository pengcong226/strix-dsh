# StriX-DH

**dsh 为核心、Strix 能力原生化融合的 AI 渗透测试工具套件。**

StriX-DH 把 [Strix](https://github.com/usestrix/strix)（Apache-2.0）的攻击性安全能力——方法论提示词、证据绑定报告管线、沙箱化执行模型——拆解重构为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)（MIT）的原生工具插件，让 dsh 的 agent 循环、子agent编排、持久化记忆和 WebUI 直接"长出"渗透测试能力，而不是遥控另一个独立的渗透程序。

> ⚠️ **仅用于授权测试。** 只对你拥有、或已获得明确书面许可的系统使用本工具套件。使用者对合规性负全部责任。详见 [docs/safety.md](docs/safety.md)。

## 工具清单（16 个）

| 工具 | 对应 Strix 能力 | 说明 |
|---|---|---|
| `strix_runs` | 任务概览 | 进场定向：工作区里已有什么（filed 报告逐条 + 预算状态），避免多 engagement 混账 |
| `strix_http` | Caido 代理重放流 | 原始 HTTP 客户端：任意方法/头/体/完整 raw 请求重放，响应截断可控、可存盘 |
| `strix_shell` | Kali 沙箱 exec_command | 一次性 Docker 容器内执行命令（workspace 挂载 /workspace），镜像可配置；**每次调用需操作者批准**；`background=true` 进后台 job（`job_output`/`job_kill` 管理） |
| `strix_pybox` | Python 漏洞利用沙箱 | Python 脚本沙箱：批量 payload 喷射、PoC 执行，硬超时 + 可断网；**每次调用需操作者批准** |
| `strix_browser` | agent-browser --session | Playwright Chromium 会话（按名隔离），导航/点击/填充/执行JS/截图 |
| `strix_recon` | 侦察阶段 | subfinder → httpx 编排（状态/标题/技术栈），结果落盘 |
| `strix_sast` | nuclei/semgrep 扫描 | 低频默认值；扫描结果只是线索，不是发现 |
| `strix_proxy` | 代理拦截与重放 | mitmproxy 侧车（Docker）：拦截流量、查询、经 strix_http 路径重放 |
| `strix_finding` | create_vulnerability_report | **证据绑定**：strict 模式下无 evidence 拒收；CVSS 指标必须对应已演示的 PoC 证据；支持白盒内联修复（code_locations + fix_pr_body）、dependency CVE、update 去重修订 |
| `strix_report` | 报告生成 | 汇总 findings + coverage 生成 Markdown 报告 |
| `strix_coverage` | record/list_coverage | 攻击面台账：**包括测过没洞的**，needs_follow_up 标记 open_proof_gap |
| `strix_notes` | create_note 等 | 跨 agent 共享便签（凭据、端点清单、目标怪癖） |
| `strix_threat_model` | get/amend/save_threat_model | 共享威胁模型：测试前建立，被证伪时必须修正 |
| `strix_authorization` | 授权证明 | 授权声明（目标/授权方/引用/有效期），每 turn 动态注入系统提示 |
| `strix_budget` | 花费台账 | LLM 花费账本（record/status/reset），可配单价；recon/sast 超限警告或拒止 |
| `strix_depcheck` | —（0.10.0 新增） | 依赖 CVE 查询：OSV.dev → CISA KEV（野外已利用）→ EPSS（优先级排序），全部免 key；KEV 目录按 24h TTL 缓存本地；输出字段直接喂给 `strix_finding create vulnerability_type=dependency_cve` |

系统提示词注入（`ctx.systemPrompt`）：Strix 的核心方法论——侦察优先、closure 三态纪律（confirmed / ruled_out / open_proof_gap）、CVSS 证据绑定、十类主攻漏洞、"没信息≠安全"——逐条改编后注入 dsh agent。

审批门（HITL）：`strix_shell` / `strix_pybox` 每次调用都经过 dsh ApprovalService 请求操作者批准，除显式放行外一律 fail-closed 拒绝执行；决策与运行结果记录在工作区 `evidence/log.jsonl` 台账。

## 安装

前置：Node.js ≥ 20；dsh（`npx @deepseek-ai/dsh` 或全局安装）。

```sh
# 从本仓库目录把 bundle 装进一个 dsh profile
dsh plugin --profile strix add ./packages/strix-tools

# 验证 + 启动
dsh --profile strix --dump-config   # 应看到 strix-dsh-tools 层
dsh --profile strix                 # WebUI: http://127.0.0.1:3080
```

可选组件：

- **Docker Desktop** — `strix_shell` / `strix_pybox` 需要（容器沙箱）
- **subfinder / httpx / nuclei / semgrep** — 侦察与扫描引擎；放入 PATH 或配置 `binariesDir`
- **playwright**（浏览器下载另计）— `strix_browser` 需要：`npm i playwright && npx playwright install chromium`

模型配置在 dsh 侧完成（官方内置 `llm-deepseek` 适配器，支持 DeepSeek 等多家 API）。

## 配置

所有可调项走 bundle 配置（cordis.patch.yml 的 `config:` 块或 profile 覆盖）：workspaceDir、httpTimeoutMs、shellImage、pyboxNetwork、nucleiRateLimit、strictEvidence 等。完整清单见 [packages/strix-tools/src/config.ts](packages/strix-tools/src/config.ts)。

## 方法论 skills

Strix 的漏洞知识包改编为 **75 个 dsh skills**，随插件包一起发布在 `packages/strix-tools/assets/skills/`，由 `ctx.skills.register()` 在插件加载时注册（`src/skills-provider.ts`），经 `skill` 工具按需加载——**不需要手工拷贝任何目录到 `.dsh/skills/`**。上游变更时用 `python scripts/adapt_skills.py` 重新生成。详见 [docs/prompt-design.md](docs/prompt-design.md) 与 [docs/skills-catalog.md](docs/skills-catalog.md)。

## 文档

- 开发者手册与完整文档导航：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（工具参考 / 实战走查 / Strix 与 dsh 深度分析 / 技能目录）

## 致谢与许可

- [Strix](https://github.com/usestrix/strix)（Apache-2.0）——方法论提示词、技能知识包、沙箱模型的上游来源，详见 [NOTICE](NOTICE)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）——运行时核心

本项目 Apache-2.0。
