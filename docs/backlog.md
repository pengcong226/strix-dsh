# 开发清单（backlog）

> 活文档：已落地的项移入 `DEVELOPMENT.md` 版本史；本文件只保留**待办**。每项含背景、方案、验收标准。
> 状态：🟡 待做 / 🔵 进行中 / ✅ 已落地（移出）。

## A. 漏洞库（当前缺失）

现状：`strix-dsh` 没有漏洞数据库。`skills/vulnerabilities/` 29 包是**方法论**（某类漏洞怎么测），不是可检索的 CVE 库；`strix_finding` 登记的是自己打出的发现；`dependency_cve` 类型是空架子，无数据源。

### A-0. 搜索引擎调研结论（2026-09-03，无子代理，直调 WebFetch + curl 实测）

**结论先行：没有比 OSV/KEV/EPSS 免费三件套更优的方案；MCP 这条路是空的。**

| 排名 | 方案 | 证据 | 结论 |
|---|---|---|---|
| 1 | OSV.dev（`POST /v1/query` + `/v1/querybatch` + `GET /v1/vulns/{id}`） | OSV 官方文档站确认端点形态；curl 实测 lodash@4.17.20 返回 GHSA-29mw-wpgm-hmr9 全文；无 key、无 auth | 主源，无可替代 |
| 2 | CISA KEV（`known_exploited_vulnerabilities.json`） | curl 实测 catalogVersion 2026.09.02、count 1694；无 key | "被野外利用"过滤器，提级依据 |
| 3 | EPSS（`api.first.org/data/v1/epss?cve=`） | curl 实测 Log4Shell epss 0.99999/percentile 1.0；public 无 key | 优先级排序 |
| 4 | deps.dev API v3 | 搜索确认存在且免费无 key（依赖图谱最强，补传递依赖）；本轮未 curl，由 A-2 实现时实测为准 | OSV 搭档，非替代 |
| 5 | NVD API 2.0 | 文档站被 JS 挡住未读到数字；已知要 key、延迟大、返回臃肿 | 兜底 enrichment，不做主源 |
| 6 | GitHub Advisory | 文档页未读到数字；要 token；与 OSV（含 GHSA 源）重复建设 | 暂不接（`gh` 已登录，真要用时零成本） |
| — | 通用漏洞 MCP server | mcp.so 该分类 "No servers in this category yet"；glama.ai 搜 Shodan/VirusTotal/Censys/NVD/CVE/OSV/nuclei/exploit **零命中**；Bing 全网搜 OSV/NVD/KEV MCP 无结果 | 此路不通：自己写 `strix_depcheck` 直调 REST |
| — | Nuclei 官方 MCP | 全网搜只有 nuclei 仓库/官网/文档，无官方 MCP | 同上；消费方式=A-1（命名卷+模板更新） |
| — | Exploit-DB 官方 API | 搜索未证实官方 API 存在（只有"备好 API 接口"的二手说法，无路径无 spec） | 不纳入；exploit 侧靠 nuclei 模板 + 手工 PoC |
| — | Snyk/Vulners API | 搜索未证实免费档 endpoint/auth/quota；都要 key | 免费三件套覆盖 90% 场景后暂不碰 |

搜索过程诚实记录：DuckDuckGo 直接 bot-check 拦截；Bing RSS 可用但摘要稀疏；NVD/GitHub/EPSS 官方文档页多为 JS 渲染或 404，WebFetch 读不到数字——凡未读到数字的一律标"已知/未证实"而不编造。决定性证据是三条亲手 curl（OSV/KEV/EPSS 全通），与 A-2 原方案一致：**一个 `strix_depcheck` 工具按 OSV→KEV→EPSS 顺序查，deps.dev 补传递依赖，全部无 key**。

### A-1. Nuclei 模板库常驻更新 ✅（0.10.0 已落地）

- **落地**：`sast.ts` nuclei 容器挂 `strix-nuclei-templates` 命名卷（`ensureNucleiTemplateVolume` best-effort 建卷）；刷新：`docker run --rm -v strix-nuclei-templates:/root/nuclei-templates projectdiscovery/nuclei -update-templates`。文档见 tools-reference `strix_depcheck` 节尾。

### A-2. 依赖 CVE 查询（OSV.dev） ✅（0.10.0 已落地）

- **落地**：新工具 `strix_depcheck`（`src/tools/depcheck.ts`，16/16 工具）：`check`（OSV querybatch → vulns/{id} 明细 → KEV 缓存 → EPSS 排序）/ `kev-refresh` / `status`；KEV 全量 `workspace/vulndb/kev.json` 24h TTL；单测 4 例；headless 实测 lodash@4.17.20 查出 5 洞（CVE/EPSS/fixed 全）+ KEV 1694 + dedupe 链。deps.dev 传递依赖未接——OSV 主链已覆盖直接版本，传递依赖待后续按需加。

## B. 已知待办（Phase-2/等外部）

### B-1. 审批白名单 engagement 作用域 🟡

- **背景**：0.9.0 `approvalAutoAllow` 是全局正则；per-engagement 白名单仍是设计项。
- **方案**：白名单随 `authorization.json` 作用域走（授权Targets + 预批模式绑定），engagement 结束自动失效。
- **验收**：授权 clear 后预批同步失效；单测覆盖。

### B-2. 预算账本自动喂数 🟡

- **背景**：`strix_budget` 靠手动 `record`；等 dsh 开放 usage 订阅 API。
- **方案**：dsh 有 API 后，`record` 改为订阅驱动；账本格式已预留，无需迁移。
- **验收**：一次 engagement 全程零手动 record 且账本非空。

### B-3. 云靶场 scoreboard 对接 🟡

- **背景**：range-API skill（`~/.dsh/skills/bachang-api-caller/`）就绪，但 SKILL.md 是 example.com 占位。
- **阻塞**：等用户提供真实 Base URL + HBC_TOKEN + 目标码。

## C. 实际使用问题（用户填写）

> 使用中遇到的问题逐条记在这里，格式：现象 → 复现步骤 → 期望行为。我（AI）负责补方案与验收标准并执行。

### C-1. Agent 停下来问用户下一步怎么做 ✅（0.10.1 已修）

- **现象**：无弹窗后，agent 改以纯文本"三选一，你定"收尾（如"测试账号 / 批单发低速 POST 枚举 / 再挑第四批，你定"），turn 结束、engagement 停滞。不符合 Strix 工作流。
- **根因**（研读上游 `system_prompt.jinja` + `factory.py` 后定位）：Strix 的完全自动化靠三层——① turn 结束语义：纯文本**不结束** turn，只有 lifecycle 工具调用（`finish_scan`/`agent_finish`/`respond_to_user`）才能停，写"三选一"会被 nudge 推着继续；② AUTONOMOUS BEHAVIOR 明令 + 几乎每 turn 必带工具调用；③ `finish_scan` 四段 + closure 全覆盖的高交差门槛。而 dsh 语义相反：**纯文本回复即 turn 结束、控制权交回用户**。删 `tool-ask-user` 行只能去掉弹窗工具，拦不住纯文本提问——这是会话语义问题，不是人设问题。
- **方案**（Strix 方案的 dsh 等价翻译）：方法论 + 三 persona（orchestrator/operator/分派行）统一注入 AUTONOMY 纪律——turn 以纯文本提问/总结收尾=交权停机，所以永远以工具调用收尾；多选项并存时按优先级自主推进（①已发测试账号 → ②范围内低速验证 → ③新基线），被搁置项记 `needs_follow_up` coverage 而非提问；合法停机仅两种（授权缺失/过期、目标不可达，经 `strix_authorization` 声明）。
- **验收**：`methodologySection` 回归单测（关键句存活）；preset 双 healthy；headless 抽查调工具+给下一步（注：headless 单次调用形态天然以回复收尾，真考场是 WebUI 多轮；一次抽查中模型在假设性三选项里选了 B 而非 A——因 A 的前置"已发账号"在 workspace 中并不存在，选择合理）。
- **未竟**：WebUI 长会话实测"连续 N 轮无提问"仍待用户侧观察反馈。
- **真实证据补记（headless 后台任务，真实工作区 51 coverage/18 notes）**：模型面对"测试账号 / 低速 POST / 新基线"三选项，零提问，按优先级推理后自主选 C——A 因 N-001~N-018 无已发账号而不可用，B 被威胁模型约束禁止，C 可做；随后连续工具调用（`strix_threat_model get` + `notes list` + `coverage list` → `strix_recon jxnu.edu.cn` 192 子域 → http 基线 11 面 → `notes create N-019` + `amend` + `strix_report` 62 coverage），以 report 工具收尾而非"你定"。Strix 式自主推进在 dsh 下成立。

### C-2. jxnu 120 站实战复盘五项 ✅（0.11.0 已修）

- **来源**：用户导出 `dsh-session-a6a8664b`（3MB 主会话 + 39 子会话）离线分析 + 自主收敛汇报（120 站全覆盖、181 coverage、零 confirmed）。复盘全文见 `docs/field-report-2026-09-03-jxnu-session-export.md`。
- **问题**：① engagement 混杂（C-002/F-001 旧靶场 RCE 混入 jxnu ledger）；② 无分诊（50+ WebPlus 资讯站反复 GET，clean 里混着深测通过与浅层放过）；③ POST 禁区（7 个 needs_follow_up 全卡在"需 POST/需账号"，无预批链路）；④ blocked 无第二路径（21 条 blocked 停手，无浏览器/换出口定义）；⑤ 子代理开销（嵌套转包 + ask 镜像 + list_agents 轮询 540 次）。
- **方案**：coverage 加 `ruled_out` + 方法论 TRIAGE；POST 三分支（预批/非预批+计数+熔断）；`test_accounts` vault；BLOCKED 第二路径纪律；preset 单层委托（≤6/波、禁轮询）；report 授权摘要 + workspace 路径。
- **验收**：vitest 79 例；headless 冒烟（ruled_out → 掩码摘要报告）；同目标新会话对照验证待用户侧跑。
