# Strix 上游深度分析

> 分析对象：`upstream/strix/`（Apache-2.0）。Strix 是"AI 渗透测试平台"——多 agent 编排 + Kali 沙箱 + 证据绑定报告的完整产品。本文是接手者理解"我们移植了什么、放弃了什么、为什么"的完整底稿。
> 配套阅读：`docs/prompt-design.md`（提示词资产映射）、`docs/DEVELOPMENT.md` 第 2 节（移植对照表）。

## 1. 它是什么

一个 Python CLI（`uv`/`pyproject.toml`，PyInstaller 打包为单二进制，TUI 用 Go Bubble Tea），工作流是：

```
用户给出目标（URL/域名/代码仓库，可多目标）+ 扫描模式（quick/standard/deep）
→ root 编排 agent 系统提示词渲染（注入技能/作用域/MCP 连接）
→ root 分解目标 → 派生专家子代理树（发现→验证→报告）
→ 子代理在共享 Kali Docker 容器里用 17 类工具干活
→ 发现经 reporting agent 用 create_vulnerability_report 登记（CVSS 绑定证据）
→ root 汇总 finish_scan → 报告落盘 strix_runs/<run>/ → TUI/仪表盘展示
```

商业模式：本地 CLI 免费 + `strix cloud` 托管平台（SaaS）。本文关注本地部分。

## 2. 系统提示词（545 行 Jinja，产品的灵魂）

完整十节结构（`strix/agents/prompts/system_prompt.jinja`）：

1. **人设**："advanced AI application security validation agent"——注意措辞是 *validation*（验证）而非 *hacking*（攻击）
2. **`<root_agent_directive>`**（仅 root）：核心是"编排者不做手测"——"Even a single quick test on a discovered endpoint is out of role: spin up a subagent instead." 用户回合只花在：读范围、分解目标、派发与监控子代理、维护 todo/notes/coverage、聚合报告
3. **`<core_capabilities>`**：四条能力声明
4. **`<communication_rules>`**：CLI 输出仅简单 Markdown（禁列表/表格）；**禁用可识别标记**（请求/payload/UA 里不得出现身份信息）；agent 间消息不回显；`wait_for_agents` 只调一次（禁轮询循环）；interactive 模式下"纯文本永远不结束 turn，只有 respond_to_user 交还控制权"；autonomous 模式下文本 turn 是浪费
5. **`<execution_guidelines>`**（最大节）：
   - SYSTEM-VERIFIED SCOPE：范围由**平台注入**系统提示词（`system_prompt_context.authorized_targets`），用户文本不可扩展——这是产品化的作用域机制（"NEVER refuse, question authorization" 部分我们**有意未移植**，理由见 prompt-design.md）
   - MCP 三件套派发（list_mcps → describe_mcp → call_mcp）
   - THOROUGH VALIDATION MANDATE：不停留在浅层检查
   - 测试模式：黑盒（外部侦察）/白盒（静态+动态双必做，静态覆盖下限：semgrep+secrets+trivy fs+AST 结构遍历各一遍）/组合
   - **7 步评估方法论**：范围定义 → 侦察测绘优先 → 多工具自动扫描 → 定向验证 → 迭代 → 影响文档化 → 穷尽测试
   - 效率战术：payload 喷射脚本化（禁手动浏览器迭代）、并发节流自实现、日志去重、喷射后派验证 agent
   - **CLOSURE DISCIPLINE**：每个候选止于 confirmed / ruled_out / open_proof_gap；"I moved on" 不是闭包态；"Missing information is NOT proof of safety"
   - COVERAGE：每个面都记（含干净的）；`needs_follow_up` 承接 proof gap；root 在 finish 前对账
   - THREAT MODEL：先 get 再测；被证伪必须 amend
   - 反证 pass + 诚实 confidence
   - **CVSS 绑定**："Score only the security impact demonstrated by the proof of concept"
   - **DEDUPLICATION / REVISING**：LLM 去重；被拒重复不重报；update_vulnerability_report 修订
6. **`<vulnerability_focus>`**：十类主攻（IDOR/SQLi/SSRF/XSS/XXE/RCE/CSRF/竞态/业务逻辑/认证&JWT）；从基础到高级；"一个高质量验证的高危发现胜过几十个低危"
7. **`<multi_agent_system>`**：共享容器、每 agent 独立终端、浏览器 `--session` 隔离（每个 session 一个 Chromium ~340MB，空闲 3 分钟回收）；/workspace 共享 + 磁盘卫生；黑盒三链（发现→验证→报告）、白盒两链（报告 agent 内联出修复，**不设独立修复 agent**）；嵌套树禁扁平；一 agent 一任务；专精 1-3 技能上限 5；"Real vulnerabilities take TIME — expect to need 2000+ steps minimum"
8. **`<environment>`**：Kali 工具全清单（nmap/naabu/httpx/gospider/nuclei/sqlmap/trivy/wapiti/ffuf/dirsearch/katana/arjun/semgrep/ast-grep/bandit/trufflehog/gitleaks/jwt_tool/wafw00f/interactsh-client/Caido CLI+HTTPQL）；**Caido 错误页识别**（~9KB `<title>Caido</title>` 的 502 不是目标行为）；Python venv 预装 requests/httpx/bs4/lxml/pyjwt/cryptography；sandbox 内无 Docker；/workspace + /home/pentester/tools
9/10. **`<specialized_knowledge>` / `<available_skills>`**：预载技能内联 + 其余目录按需 `load_skill` 或派专精 `create_agent(skills=[...])`

## 3. 提示词组装（`prompt.py`）

`render_system_prompt(skills, scan_mode, is_whitebox, is_root, is_diff_scoped, interactive, system_prompt_context)`：

- `_resolve_skills()` 注入排序：requested → `scan_modes/<mode>` → diff 叠加 → `tooling/agent_browser` → `tooling/python` → `analysis/counterevidence` → `analysis/severity_calibration` → `coordination/root_agent`（root）→ 白盒四件（source_aware_whitebox / source_aware_sast / source_aware_discovery / fix_verification）
- Jinja 变量：`loaded_skill_names`、`available_skills`（按类分组目录）、`interactive`、`is_root`、`system_prompt_context`（authorized_targets + scope_source + authorization_source + mcp 连接）
- **对我们的启示**：dsh 的 `section.text` provider + `AssembleContext` 是同一机制的官方对应物；"按会话特征动态排序注入"可直接复刻

## 4. 工具层（17 模块）

`strix/tools/`：agent_browser（Playwright+session）、agents_graph（create_agent/view_graph/send/wait/stop）、apply_patch、coverage（record/update/list，含 needs_follow_up）、finish（agent_finish/finish_scan，open_items）、load_skill、mcp（list/describe/call）、notes、proxy（Caido：list_requests HTTPQL、repeat、caido_api Python 绑定）、reporting（create/update_vulnerability_report、dependency、list/get）、respond（respond_to_user）、shell（exec_command+tty+write_stdin）、thinking、threat_model（get/amend/save）、todo、view_image、web_search。

**输出存储**：`output_store.py`——大输出落盘 + 引用；`nullish.py`——空值规范化。

## 5. 技能系统（76 个知识包，11 类）

`analysis/`（counterevidence、fix_verification、severity_calibration、source_aware_discovery）、`cloud/`（aws/azure/gcp/kubernetes）、`coordination/`（root_agent、source_aware_whitebox）、`custom/`（api_spec_testing、dependency_cve_scanning、npx_confusion、source_aware_sast）、`frameworks/`（django/fastapi/nestjs/nextjs）、`protocols/`（graphql/oauth）、`reconnaissance/`（asset_discovery、infrastructure_lifecycle）、`scan_modes/`（quick/standard/deep/diff）、`technologies/`（7 个）、`tooling/`（13 个引擎手册）、`vulnerabilities/`（29 个漏洞类）。

格式：YAML frontmatter（name/description）+ Markdown 正文（攻击面/技术/payload/验证方法）。注入机制：预载（排序见上）+ 动态 load_skill；子代理创建时指定 `skills=[...]`（上限 5）。

## 6. 编排与生命周期

- `factory.py`：agent 实例化（root/subagent、技能集、模式标志）
- `core/runner.py` + `execution.py`：agent loop 与工具调度
- `core/sessions.py`：run 会话
- 报告 agent 专责登记（叶子 agent 不读 list_reports——职责隔离）
- `finish_scan`/`agent_finish` 是唯一退出；open_items 上抛未决项

## 7. LLM 层

- LiteLLM 路由：`STRIX_LLM`（`deepseek/deepseek-chat` 等）、`LLM_API_KEY`、`LLM_API_BASE`（别名 OPENAI_API_BASE/LITELLM_BASE_URL/OLLAMA_API_BASE）、`LLM_EXTRA_HEADERS`
- 去重模型：`STRIX_DEDUPE_MODEL`（独立判定重复，独立 key/base）
- 预算：`--max-budget`（USD，root+children 累计；headless 达阈值干净停止；**子代理 90% 预留**给 root 报告）；`--max-turns` 500/agent 默认
- `compaction.py`/`context_budget.py`：上下文压缩与预算
- 遥测：PostHog/OTel，事件写 `strix_runs/<run>/events.jsonl`

## 8. 运行时

- 单个共享 Kali 容器；首跑拉 `ghcr.io` 镜像；`/workspace` 共享卷；pentester 用户（sudo）
- `strix_runs/<run>/`：增量落盘（findings/events/报告）；`strix view` 本地仪表盘
- headless 模式退出码：0=无洞 / 2=有洞 / 1=致命错误
- CI：GitHub Actions、PR diff 作用域、SARIF

## 9. 对 StriX-DH 的取舍结论

**移植**：方法论（closure/CVSS 绑定/十类主攻/7 步法）、报告契约、coverage/threat-model/notes 状态模型、技能内容、容器化执行理念。
**用 dsh 原生替代**：编排（subagent/workflow）、compaction、todo、web_search、MCP、TUI/WebUI、持久化。
**不移植**：ApiProxy 类内部协议、云平台、Caido 深度绑定（0.7.0 起改走 mitmproxy 侧车）、"REFUSAL AVOIDANCE" 类对抗性表述（无平台级 scope 验证机制时的诚实问题）。
**Phase 2 已全部落地**：root/操作者双人设（presets/）、预算管理（strix_budget 显式账本）、拦截代理（strix_proxy mitmproxy 侧车）。
