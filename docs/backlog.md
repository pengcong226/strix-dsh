# 开发清单（backlog）

> 活文档：已落地的项移入 `DEVELOPMENT.md` 版本史；本文件只保留**待办**。每项含背景、方案、验收标准。
> 状态：🟡 待做 / 🔵 进行中 / ✅ 已落地（移出）。

## A. 漏洞库（当前缺失）

现状：`strix-dsh` 没有漏洞数据库。`skills/vulnerabilities/` 29 包是**方法论**（某类漏洞怎么测），不是可检索的 CVE 库；`strix_finding` 登记的是自己打出的发现；`dependency_cve` 类型是空架子，无数据源。

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
