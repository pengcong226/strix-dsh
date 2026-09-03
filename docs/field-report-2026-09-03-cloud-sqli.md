# 实战复盘：云靶场 SQL 注入端到端验证（2026-09-03）

> 目标：`http://hbc2.haobachang.com:46609/`（课程云靶场，"好靶场SQL注入练习平台"，nginx/1.18.0 + PHP/7.4.27 + MariaDB 10.5.19）。
> 模型：muse-spark-1.3-contributor（经 opencodego 渠道），单价 input $0.0001/1K、output $0.0002/1K（profile 覆盖层）。
> 结论：全流程打通，PoC 验证→F-001（critical）登记→coverage 关闭→report 生成，零代码改动。

## 时间线（均为 headless 真实调用输出）

1. `strix_runs` → 工作区干净（之前已清冒烟残留），从零开始。
2. `strix_authorization action=set` → `Authorization recorded: 1 target(s), granted by user course cloud-range membership.`
3. `strix_threat_model action=save` → `Threat model saved (204 chars).`（单主机、外部未授权攻击者、HTTP 边界、flag 为关键资产）
4. `strix_http url=... save_to=baseline-index.html` → `HTTP 200 OK — 149ms`，标题暴露"SQL注入练习平台"，JS 暴露 `POST index.php` + `username` 参数（见 responses/baseline-index.html）。
5. `strix_coverage action=record` → `Recorded C-001: .../index.php — SQLi → needs_follow_up.`
6. `strix_pybox` 第一批 5 探针 → 关键发现：**后端 MariaDB**，回显拼接输入（`执行的SQL语句：<br>admin`），引号未转义。连纯数字 `1` 都报语法错误 → 推断输入被当**完整 SQL 语句**执行，而非 WHERE 拼接。
7. `strix_pybox` 第二批（完整语句）→ `SELECT 1 → 1`；`SELECT version() → 10.5.19-MariaDB`；`SHOW TABLES → flag/news/users`；`SELECT * FROM flag → id=1 flag=REDACTED description=flag`。**PoC 确认，closure=confirmed。**
8. `strix_finding action=create` → `Registered F-001 [critical] Arbitrary SQL execution via unsanitized username parameter`（CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N，含反证段：无 WAF/过滤/认证）。
9. `strix_coverage action=update id=C-001 outcome=finding` → `Moved C-001 ... → finding.`
10. `strix_report` → `Report written to .../report.md (1 findings, 1 coverage entries).`（内容已逐行验证：标题/严重度/CVSS/证据代码块/反证/修复/台账齐全）

## 过程中暴露的真问题（已修 1 项，待定 2 项）

1. **ORDER BY 探针判断逻辑写错**（已当场修正）：回显正文自带 "ORDER BY" 字样，用 `in body` 判断永远 FAIL。教训：回显型注入的判定必须只看错误标记（`error in your SQL syntax`），不能看 payload 关键字。后续 pybox 探针脚本应沉淀这个模式。
2. **headless 跑 pybox 需临时关审批门**：headless 无应答器，`approvalGate:'always'` 下一律 fail-closed。本次用临时 profile 补丁（+`approvalGate:'off'`）跑 PoC，跑完已恢复。长期看：云靶场这种"已授权+低风险"场景值得一个 per-engagement 的审批白名单，而不是全局开关——记为后续设计项。
3. **预算账本本次是空跑**：`budget.json` 无记录（agent 没调 `record`，headless 单次调用链不自动记账）。账本机制本身之前已验证，但"自动喂数"（dsh 开放 usage 订阅后）仍是缺口——与路线图一致。

## 模型侧观察（muse-spark-1.3-contributor）

- 工具调用链零变形：15 工具一次性注册成功，pybox 脚本（含中文注释/转义）执行 5 次全 exit 0。
- 拒绝行为：PoC 前模型主动要求先确认授权状态（authorization section 生效）；replay/注入动作本身无拒绝。
- 成本：全程约 10 次 headless 调用，按新单价估算不足 $0.01。

## 残留与清理

- headless profile 补丁已恢复（仅保留 muse-spark 价格覆盖）。
- workspace 保留本次 engagement 全产物（findings/F-001.json、coverage ledger、report.md、pybox runs、responses/baseline-index.html）作为实战证据；下次 engagement 前用 `strix_runs` 确认后归档。
- 第一轮产物已归档至 `workspace/_archive/2026-09-03-sqli-first/`（F-001.json、coverage ledger、report.md、pybox runs、responses、threat-model）。

## 第二轮：编排者自主决策 e2e（2026-09-03，同日）

- 前置：归档第一轮、清空工作区（`strix_runs` 确认 findings/coverage 全空），授权保持有效（targets 不变）。
- 指令：只给目标 + 全流程目标（recon→PoC→登记→台账→报告），明确"编排者自己决定直接做还是派发 `strix_operator` 子代理"。
- 编排者决策：**直接做，不派发**——单端点、无并行子任务，派发只会加开销。决策本身即自主性的证据（不是"不会派"，是"判断没必要派"）。
- 全流程：`strix_runs`→threat-model→`strix_http` recon（GET / 暴露练习平台 + JS 的 `action=test&username` 流程；`test123`→MariaDB 语法错误回显；`SELECT 1`/`SELECT database()`→`1`/`web`）→PoC 批量（`SHOW TABLES`→flag/news/users；`version()`→10.5.19；`user()`→root@localhost；`SELECT * FROM flag`→flag 行）→`strix_finding` F-001 [high]（CVSS S:U，只计已证实的读影响，含"疑似故意训练功能"的反证与驳回）→`strix_coverage` C-001/C-002→`strix_report`（1 finding，2 coverage）。
- 降级记录：`strix_pybox` 本机 `spawn docker ENOENT`（Windows Git Bash 下无 docker CLI），PoC 批量改走 `strix_http` 顺序重放（仅 username 片段不同），证据链等价。教训：pybox 的 docker 依赖在 Windows 本机即缺口，vulhub 本地 e2e 同样受阻——M4 本地 lab 演示需 Docker Desktop CLI 进 PATH 或改走云靶场。
- 产物归档：`workspace/_archive/2026-09-03-e2e-orchestrated/`（F-001.json、ledger.jsonl、report.md、threat-model.md）。
- 派发链路强制验证（同补丁另起调用，强制 `strix_operator` 派发复验 PoC1/PoC2）：子代理复现 YES/YES，closure=confirmed，并自证工具清单 34 项、无任何 subagent/workflow/goal 派发工具。派发链路本身全功能，待多端点/多并行 engagement 再由编排者自主启用。

## 后续：框架级操作员分派验证（2026-09-03）

- 在 `presets/strix/agent.cordis.yml` 增加 `tool-strix-operator` 行（同 spawn provider + Operator 人设 + toolFilter），headless `--patch` 双胞胎（`strix-operator.patch.yml`）三轮实测：
  1. `default.*` 前缀名 → `restrict()` 直接抛错（注册表按无前缀名校验），假设证伪。
  2. 无前缀 deny（不含自deny）→ 子代理工具清单 36 项，7 项 delegation/workflow/goal 全部 NO，`strix_operator` 自身 YES（可再分派，叶子未闭合）。
  3. 补上 `strix_operator` 自deny → 8 项全部 ABSENT，仅保留动手工具 + `send_message`（向父汇报）。叶子闭合确认。
- 最终 deny：`[subagent, subagent_fork, strix_operator, workflow, ralph, create_goal, get_goal, update_goal]`。`subagent_codex/claude` 行默认 disabled、裸 `goal` 是斜杠命令非工具——写错名派发时抛错，已在注释中说明。
- preset 已同步到 `~/.dsh/.agent-presets/strix/`，`presets/README.md` 重写为"编排者 + 框架级操作员分派"说明；discovery：`strix | healthy`，`strix-operator | healthy`。
- 结论：编排者会话内可自主派发操作员子代理（何时派发、派发几个、分配什么任务均由模型按任务决定），无需人工开会话——补上了"融合项目缺自动树"的关键一块。
