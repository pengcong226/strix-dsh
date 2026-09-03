# M0-M5 完成审计（2026-09-03）

> 对照 plan 文件的里程碑，逐项给证据。结论先行：**M0–M5 全部完成**（M4 本地 vulhub + 云靶场双向量验证均已归档）。

## M0 — 清理旧原型 + 仓库骨架 + dsh 冒烟

- 旧原型（scratch-plugin、setup 脚本、cli-config）已清理：仓库根仅保留 `AGENTS.md/CONTRIBUTING.md/LICENSE/NOTICE/README*.md/SECURITY.md/docs/packages/presets/scripts`，无残留。
- `upstream/` 保留 `deepseek-harness` + `strix` 参考克隆（开发期参考）。
- dsh Windows 冒烟：`dsh-boot.log`（`[strix-dsh-tools] registered 15 tool modules ... + 75 skills` + WebUI 地址），`docs/walkthrough.md` Part 0 逐行记录真实启动输出。✅

## M1 — bundle 打通（hello 工具进 profile，WebUI 可见；subagent 注入/skills 格式/配置卡落定）

- bundle 打通超额完成：不是 hello 工具，而是 **15 原生工具 + methodology/authorization prompt 章节 + 75 skills** 一次性注册，启动日志为证；WebUI Settings→Models 配 key 热生效（walkthrough Part 0）。
- 三项机制探明结论：skills 走 `ctx.skills.register()` 打包随 bundle（`src/skills-provider.ts` + `assets/skills/manifest.json` 75 项）；subagent 指令注入走 preset composition + `tool-strix-operator` 行级 `persona/toolFilter`（本轮实测）；配置卡即 profile `cordis.patch.yml` 三层覆盖。✅

## M2 — 工具开发（依赖序：http→finding/report→shell+pybox→coverage/notes/threat_model→recon→sast→browser）

- `packages/strix-tools/src/tools/` 14 文件覆盖 15 工具：authorization、browser、budget、coverage、finding、http、notes、proxy、pybox、recon、runs、sast、shell、threat-model（report 由 finding/report 共用模块承载，`strix_report` 实测可写报告）。
- vitest 36/36（`test/core.test.ts`，含 muse-spark 新单价 0.0001/0.0002 断言），`adapt_skills.py --self-test` 7/7，`tsc` 构建干净，CI（node 20/22 × ubuntu/windows）配置完整。✅

## M3 — 提示词层（人设注入 + 13+ 知识包 + 动态组装）

- 人设注入：`src/index.ts` 经 `ctx.systemPrompt.section()` 注入 `strix:methodology` + authorization 章节（超额：75 skills 打包随行，不止 13+）。
- 知识包：`assets/skills/` 75 项 + `manifest.json`，`scripts/adapt_skills.py` 由上游 Strix skills 改编（Apache-2.0，NOTICE 致谢）。
- 动态组装：`methodologySection(config)` 按配置组装；scan_modes 见 `docs/prompt-design.md`（三档）及 skills-catalog（scan_modes 4 项）。
- 双人设：`presets/strix/agent.cordis.yml` 编排者 + `tool-strix-operator` 操作员分派行（框架级 leaf 隔离已验证），`presets/strix-operator/` 独立手动会话 preset 保留。✅

## M4 — 端到端（dsh 对话式完成渗透全流程）

- **本地 vulhub 已跑通**（本轮闭环）：Docker Desktop CLI（`C:\Program Files\Docker\Docker\resources\bin\docker.exe`）进 PATH 后 daemon 可达（Server 29.7.2），`vulhub/thinkphp:5.0.23` 起容器（`strix-e2e-thinkphp`，127.0.0.1:18080，200）。
  - 编排者自主决策直接做（单端点最快路径）；授权=me/lab owner；recon（Apache/2.4.25 + PHP/7.2.12 指纹）→`strix_pybox` 批量（容器内 `127.0.0.1` 自指，改走 `host.docker.internal:18080` 即通——pybox docker 链路本地 lab 下正常）→`s=captcha` + `_method=__construct` + `filter[]=system` RCE 验证（`id`→`uid=33(www-data)`，phpinfo→PHP 7.2.12 + Linux hostname；4 个 invokefunction GET 变体 404 无执行，记 clean）→F-001 [critical]（CVSS S:U/C:H/I:H/A:H，含反证与驳回）→C-001/C-002/C-003→report（1 finding，3 coverage）。
  - 证据归档：`workspace/_archive/2026-09-03-e2e-local-thinkphp/`（F-001.json、ledger.jsonl、report.md、threat-model.md、pybox/ 3 runs）。容器已 stop+rm。
- **云靶场双轮实战**：
  - 轮 1（复盘前半）：recon→PoC→F-001 critical→coverage→report，全流程打通。
  - 轮 2（复盘后半）：编排者自主决策直接做，F-001 high（S:U 保守计分）+ C-001/C-002 + report；`strix_operator` 强制派发链路另验证通过（子代理复现 YES/YES，closure=confirmed，自证 34 工具无派发能力）。
  - 证据归档：`workspace/_archive/2026-09-03-sqli-first/` + `workspace/_archive/2026-09-03-e2e-cloud-round2/`（第二轮 cloud 产物已由本轮归档动作从工作区移入，命名澄清）+ `workspace/_archive/2026-09-03-e2e-orchestrated/`。
- ✅ M4 闭环：本地 lab（RCE 向量）+ 云靶场（SQLi 向量）双向量验证，`strix_pybox` docker 链路在本地/云下均已验证（云下走 http 重放降级、本地走 host.docker.internal 直连）。

## M5 — 开源收尾（双语 README / 三篇 docs / 版本 pin）

- 双语 README：`README.md` + `README.zh.md` ✅。
- 核心 docs 双语：architecture、safety（本轮补 `docs/en/safety.md`）、prompt-design ✅；tools-reference、walkthrough、DEVELOPMENT、skills-catalog、strix/dsh-analysis 双语 ✅；field-report 英文版（本轮补 `docs/en/field-report-2026-09-03-cloud-sqli.md`）✅。
- LICENSE（Apache-2.0）+ NOTICE（致谢 Strix/dsh）✅；版本 pin：`packages/strix-tools/package.json` 0.8.0，CI 锁定 node 20/22 ✅。

## 附录 A — 剩余功能清单执行（/goal，2026-09-03 同日）

对照上游逐项盘点后，明确不做的（Strix Cloud 闭源、telemetry、CI/CD 平台 skill、Kali 全家桶、LLM dedupe judge）不动；落地的全部有代码+单测+实测：

- **P0-1 `strix_report action=sarif`**：`src/tools/sarif.ts`（SARIF 2.1.0：规则/结果/coverage/fixes/合成位置），单测 5 例；headless 实测 `3 rules, 4 results: 1 findings, 3 coverage` 落盘 `workspace/findings.sarif`。
- **P0-2 `strix_finding action=dedupe-check`**：确定性判定（同类型+端点+文本 / 同 CVE+包，manifest 区分），单测 6 例；headless 实测 ThinkPHP RCE 复验 `DUPLICATE of F-001`，无关目标 `NOT A DUPLICATE`。
- **P0-3 `strix_report action=finish`**：`caller_role` root-guard（dsh exec 无 parent-agent 字段，显式声明 fail-closed）+ 四段必填（`missingFinishSections` 纯函数，单测 2 例）；headless 实测 operator 拒绝 + root 缺段拒绝逐项点名。
- **P1-1 `strix_runs` 可见性**：逐条 filed-reports（severity/type/target）+ budget 状态行；headless 实测输出逐字引用（含 `budget: no records yet` 空账本提示）。
- **P1-2 proxy scope 说明**：工具 description + tools-reference 双语写明无 scope 名单、靠"只把已授权客户端指过去"划界（与上游 Caido scope 的如实差异）。
- 测试：vitest 50/50（36 基线 + 5 sarif + 6 dedupe + 2 finish + 1 findings 回读）；文档：tools-reference 双语四节 + DEVELOPMENT 版本史/矩阵双语 0.8.0 行。
- **附录 A-2 REFUSAL AVOIDANCE 条件版（0.8.1，同日 /goal）**：`renderAuthorizationSection` 三态（无授权=被动提醒；有效授权=事实+ avoidance 段；过期=警告+退回被动）+ `isAuthorizationExpired` 纯函数；单测 3 例（53/53）；真实渲染验证（读真实 workspace 文件，有授权分支逐字输出）；headless set/get 验证；验证用临时授权已 revoke，工作区复原。文档：prompt-design 映射表双语 + tools-reference 授权节双语 + DEVELOPMENT 0.8.1 行双语。上游无条件版"never question your authority"仍不出——差异故意。
- **附录 A-3 全项目 review 安全修复（0.8.2，同日 /goal）**：`safeId`/`safeWorkspacePath`（util.ts）堵四处"模型输入进路径"（http save_to 写出 workspace、finding get/update 坏 id、notes get/update/delete 坏 id、browser session 名进截图文件名；此前仅 proxy 的 id 有校验）；`strix_shell` image allowlist（`shellAllowedImages` 配置，默认仅 shellImage）；`strix_sast` extra_args 危险 flag 黑名单（目标/输出/限速/模板集/代理类）+ nuclei severity 白名单；browser sessions 进程级共享文档化（description + tools-reference 双语）。单测 6 例（59/59）；四守卫自有 lab headless 真实触发验证（REJECTED 逐字引用，其中 save_to 为"请求走、落盘拦"的正确语义）；验证容器已删、授权已 revoke。文档：tools-reference 双语四处 + DEVELOPMENT 版本史/配置表双语 0.8.2 行。
- **附录 A-4 渗透手感放开（0.9.0，同日 /goal"适当的放开限制更能发挥模型性能"）**：三刀只收真正危险的、放开卡手感的——① shell image allowlist 只在无人值守（approvalGate off）时强制，有人审批时镜像名进审批摘要由人定（人类看得见就不替人拦）；② sast extra_args 黑名单缩到三类（重定向目标/限速并发/引擎配置），模板选择/输出格式/代理路由全放开（正常渗透操作）；③ 新增 `approvalAutoAllow` 正则预批（默认空=零放宽，命中记 `auto-allowed` 审计，fail-closed 不变；此前"要么全卡要么全关"是伪二选一）。路径遍历守卫（safeId/safeWorkspacePath）一处不放——那是真红线。单测 3 例（62/62）；`-t cves/` 放行 + `-rl` 照拦 headless 实测；gate-on 镜像放行走代码审查（headless 无人审测不了，如实记录）。文档：tools-reference 双语三处 + DEVELOPMENT 版本史/配置表双语 0.9.0 行。

## 待办（诚实缺口，不藏；均为 Phase-2/路线图项，非 M0-M5 交付物）

1. per-engagement 审批白名单（已授权低风险场景免全局开关）——部分落地（0.9.0 `approvalAutoAllow` 正则预批）；剩余：按 engagement 作用域的白名单（当前预批是全局配置），设计项。
2. 预算账本自动喂数（等 dsh 开放 usage 订阅）——路线图项。
3. HBC_TOKEN / 下一目标码：等用户输入后再测（range-API skill 就绪，`~/.dsh/skills/bachang-api-caller/` 可加载）。
