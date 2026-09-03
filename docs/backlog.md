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

### A-1. Nuclei 模板库常驻更新 🟡

- **背景**：`strix_sast` 跑 nuclei 容器（`projectdiscovery/nuclei` 镜像，`--rm` 一次性），模板版本=拉镜像那天；模板上游（`projectdiscovery/nuclei-templates`）社区每天合新 CVE 检测模板。
- **方案**：命名卷 `nuclei-templates` 挂载进扫描容器（`sast.ts` 加卷参数 + 一次性 `docker volume create`）；文档写 `nuclei -update-templates` 更新流程。
- **验收**：连续两天扫描，新 CVE 模板可被调用；单测覆盖卷参数构造。

### A-2. 依赖 CVE 查询（OSV.dev） 🟡

- **背景**：`dependency_cve` 类型无数据源；自建库维护不起。
- **方案**：新增 `strix_depcheck` 工具（或并入 sast）：调 OSV.dev API（免费、无 key、覆盖 npm/PyPI/Go/Maven，分钟级更新）查 `package+version → CVE`，结果走 `strix_finding dedupe-check`（CVE+包名身份）登记。网络走宿主 fetch（元数据查询，非攻击流量）。
- **验收**：给定 `lodash@4.17.20` 查出 CVE-2021-23337 并登记为 F-NNN；dedupe 复查重包判 DUPLICATE。

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

1. （待补充）
