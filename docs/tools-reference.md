# StriX-DH 工具参考手册

> 12 个工具的完整契约：参数、输出、真实运行实例、错误模式与配置交互。
> 所有示例输出均来自本项目的真实验证运行（2026-09-03，dsh 0.1.2-alpha.5）。
>
> ⚠️ 每个工具的 description 本身就是注入给模型的行为规则——修改措辞前先读 `docs/prompt-design.md`。

通用约定：

- **工作区**：所有产物落在共享工作区（默认 `~/.dsh/strix-workspace/`，可配置 `workspaceDir`），主 agent 与子代理共享同一目录——这是跨 agent 协作的物理基础。
- **输出截断**：面向模型返回的文本都有长度上限，超限会显式标注 `[... truncated: showing N of M characters ...]]`；完整产物按各工具说明落盘。
- **授权**：所有工具仅用于你拥有或已获书面许可的目标。

---

## strix_runs — 工作区总览

**Strix 来源**：新增（无上游对应；为"加入 engagement 先看存量"的纪律服务）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| （无参数） | | | |

**输出**：逐行列出 findings 数量与逐条明细（`F-001 [critical] (rce) title — target`，子代理无需二次调用即可看到已登记报告）、coverage 台账行数、notes 数量、threat-model 是否建立、report 路径、recon 已扫域名、pybox 运行数、已保存响应数，以及 budget 账本状态（零记录时提示去 `strix_budget action=record` 记账——空账本是"没记"而非"没花"）。

**真实输出示例**：

```
Engagement workspace: C:\Users\20327\.dsh\strix-workspace
findings: 1 registered (F-001.json)
coverage: empty
notes: 0
threat-model: not established
report: C:\Users\20327\.dsh\strix-workspace\report.md
recon: none
pybox runs: 0
saved responses: 0
```

**使用时机**：加入 engagement 的第一个动作；恢复中断的工作前；判断"哪些面还没人测"之前。

**错误模式**：无（只读）。

---

## strix_http — 原始 HTTP 客户端

**Strix 来源**：Caido 代理重放工作流的 v1 替代（拦截代理在 Phase 2）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 二选一 | 目标 URL（用 `raw_request` 时可省略，前提是请求行是绝对形式或有 Host 头） |
| `method` | string | 否 | HTTP 方法，默认 GET |
| `headers` | object | 否 | 键值对（schema 要求显式 `additionalProperties: true`） |
| `body` | string | 否 | 请求体，原样发送 |
| `raw_request` | string | 否 | **完整原始 HTTP 请求文本**（请求行+头+空行+体）。给出时覆盖以上全部结构化字段 |
| `follow_redirects` | boolean | 否 | 默认 true；false 时 3xx 原样返回 |
| `timeout_ms` | number | 否 | 默认取配置 `httpTimeoutMs`（30s） |
| `save_to` | string | 否 | 完整响应体保存到 `workspace/responses/<save_to>`（输出仍截断；必须是 responses 内的相对路径，`..`/绝对路径拒绝落盘但不影响请求本身） |

**输出格式**：状态行（含耗时与最终 URL，重定向后）→ 全部响应头 → 截断标注（如触发）→ 空行 → 正文。

**真实输出示例**：

```
HTTP 200 OK — 427ms — https://example.com/
content-type: text/html; charset=UTF-8
age: 245897
...

<!doctype html>
<html><head><title>Example Domain</title>...
```

**错误模式**（输出即处置指引，这是刻意设计）：

- 超时 → `"Request failed: timeout after Nms (aborted). The host may be filtered, down, or the port/scheme wrong — fix the target rather than retrying blindly."`
- 连接失败 → 附带 DNS/端口/协议排查提示；**把"连不上"当发现是方法错误**（对应 Strix 对 Caido 错误页的纪律）

**配置交互**：`httpTimeoutMs`、`httpMaxBodyChars`、`httpPostCapPerPath`（默认 5）。

**POST 政策**（0.11.0）：三分支——① 命中 `pre_approved_post_paths`（精确 path+body）→ 直发 + clearance 审计行；② 未命中但存在有效（未过期）授权 → 直发 + `[non-preapproved POST <path> — live authorization, count n/N]` 审计戳，按 path 计入 `workspace/http-post-counts.json`；③ 无授权 → 与旧版一致直发。超 `httpPostCapPerPath` 时 REJECTED，指引记 `needs_follow_up` 并申请预批，不许换词重试。

---

## strix_finding — 证据绑定漏洞登记

**Strix 来源**：`reporting` 模块的 create/update_vulnerability_report + create_dependency_report。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | create / update / list / get / dedupe-check |
| `id` | string | update/get | 如 `F-001`（dedupe-check 传 id 表示"排除自己比对"，避免自查重） |
| `title` | string | create | 简短描述性标题 |
| `vulnerability_type` | string | create | `idor` `sqli` `ssrf` `xss` `xxe` `rce` `csrf` `race_condition` `business_logic` `auth_jwt` `dependency_cve` `other` |
| `severity` | string | create | `info` `low` `medium` `high` `critical` |
| `target` | string | create | 受影响目标（URL/host/代码路径） |
| `evidence` | string | **strict 模式必填** | **具体证明**：完整请求/响应对、PoC 输出、或完整可达的利用链轨迹。这是"成为发现"的资格字段 |
| `cvss_vector` | string | 否 | CVSS v3.1 向量；**每个非 None 指标必须对应 evidence 中已演示的内容** |
| `counterevidence` | string | 否（强烈建议） | 反证陈述：反对这个发现的最强论据及为何不成立 |
| `confidence` | string | 否 | high/medium/low；纯静态轨迹至多 medium |
| `poc_script` | string | 否 | PoC 脚本路径（工作区相对） |
| `remediation` | string | 否 | 修复建议 |
| `code_locations` | array | 白盒 | `[{file, fix_before, fix_after}]`——修复随报告一次性产出 |
| `fix_pr_body` | string | 白盒 | 内联修复的 PR 描述 |
| `update_reason` | string | update | 修订原因（进 update_history） |
| `package_name` / `cve` / `package_ecosystem` / `manifest_path` | string | dedupe-check（dependency_cve） | 判定身份：同 CVE+包名即重复；manifest_path 不同则视为两个发现 |

**真实输出示例**：

```
Registered F-001 [info] Toolchain verification entry — local-verification.
```

**拒绝行为（设计核心）**：

- strict 模式（默认）无 `evidence` → `"REJECTED: no evidence. A finding without a demonstrated PoC ... is at best an open_proof_gap. Record it in strix_coverage with needs_follow_up instead..."`
- 非法 severity/type → 枚举错误
- 去重纪律：同一问题用 `update`（带 `update_reason`）修订，不重复 create；先 `dedupe-check` 再 create——同类型+同端点+目标文本重叠即 `DUPLICATE of F-NNN`（dependency_cve 按 CVE+包名，不同 manifest 算两个），无 LLM 确定性判定。实测：ThinkPHP RCE 复验判 `DUPLICATE of F-001`，无关目标判 `NOT A DUPLICATE`

**存储**：`workspace/findings/F-NNN.json`（含 created_at/updated_at/update_history）。

---

## strix_report — 报告生成

**Strix 来源**：`report/` 模块（writer + sarif + finish_scan 语义）。

| 参数 | 类型 | 必填 |
|---|---|---|
| `action` | string | 否（默认 report；sarif / finish） |
| `engagement_title` | string | 否（默认 Security Assessment Report） |
| `scope_summary` | string | 否（授权与范围摘要段） |
| `sarif_file` | string | sarif（默认 findings.sarif，工作区内 `.sarif` 文件名） |
| `caller_role` | string | finish（`root` 才放行；`operator` 子代理拒绝） |
| `executive_summary` / `methodology` / `technical_analysis` / `recommendations` | string | finish 四段必填 |

**输出**：写 `workspace/report.md`，返回路径与统计。结构：Scope & Authorization（含授权摘要段：targets/granted_by/scope_ref/valid_until/约束/预批 POST 数/测试账号掩码；无授权写 none recorded）→ Executive Summary（按严重度计数）→ Findings（逐个：严重度/CVSS/类型/目标/confidence/描述/证据代码块/PoC 脚本/反证/修复/白盒 diff）→ **Coverage Ledger（含测过没洞的表面；ruled_out 行单独计数注释）** → Methodology。报告头打印 workspace 路径（一目标一工作区，跨 engagement 混用前先看 `strix_runs`）。

- `action=sarif`：写 `workspace/findings.sarif`（SARIF 2.1.0：规则按漏洞类 `strix/<type>` + coverage 区 `strix/coverage/<area>`；severity 折三级、原标签+CVSS 留 `properties.strix`；无源码位置的 DAST 发现锚定 SECURITY.md 合成位置并标记；`code_locations` 出 fixes；coverage 作 pass/open 非失败 result）。实测：`3 rules, 4 results: 1 findings, 3 coverage`，可 `upload-sarif` 进 CI。
- `action=finish`：仅编排者关闭 engagement（`caller_role=operator` 拒绝，指路 `send_message` 向父汇报；缺段逐项点名），四段追加到 report.md 尾 `## Engagement Close (finish)`。

**真实输出示例**：

```
Report written to ...\strix-workspace\report.md (1 findings, 0 coverage entries).
SARIF 2.1.0 sidecar written to ...\strix-workspace\findings.sarif (3 rules, 4 results: 1 findings, 3 coverage). Upload with github/codeql-action/upload-sarif or filter kind == "fail" for alerts only.
REFUSED: finish closes the whole engagement and is root/orchestrator-only. ...
```

---

## strix_coverage — 攻击面台账

**Strix 来源**：`record_coverage` / `update_coverage` / `list_coverage`。

| 参数 | 说明 |
|---|---|
| `action` | record / update / list |
| `id` | update 时必填（`C-NNN`） |
| `surface` | 被评估的表面：URL、端点、host:port、文件、代码区域 |
| `risk_area` | 测试的漏洞类别（SQLi、IDOR、auth bypass…） |
| `outcome` | `clean` / `finding` / `needs_follow_up` / `blocked` / `ruled_out`（0.11.0 新增：分诊关闭，无攻击面表面 1–2 GET 后具名理由关闭，不再开新批） |
| `evidence_note` | 简注：测了什么、观察到什么、为何受阻/关闭 |

**纪律**（写入 description，模型可见）：**每个评估过的表面都要记录，包括干净的**——只列发现的报告无法说明审查过什么；同一表面用 update 移动，不许重复 record；`needs_follow_up` 对应 open_proof_gap。

**真实输出示例**：

```
Recorded C-001: https://example.com — baseline reachability → clean.
```

**存储**：`workspace/coverage/ledger.jsonl`（JSON Lines，追加式，主存储）+ 会话日志镜像（`strix/coverage` 事件，record/update 成功后 best-effort append，含 entry 快照；读路径只读文件）。

---

## strix_notes — 跨 agent 便签

**Strix 来源**：`create_note` 系列。

| 参数 | 说明 |
|---|---|
| `action` | create / list / get / update / delete |
| `id` / `title` / `body` | 按 action |

**定位**：存放"不是发现也不是 coverage"的持久事实——可用凭据、端点清单、租户列表、限流怪癖。开工前先 list，避免重复测绘。

**真实输出示例**：`Saved N-001: verification-note.`

**存储**：`workspace/notes/N-NNN.json`（主存储）+ 会话日志镜像（`strix/note` 事件，create/update/delete 成功后 best-effort append；delete 只带 id 不带正文）。

---

## strix_threat_model — 共享威胁模型

**Strix 来源**：`get/amend/save_threat_model`。

| 参数 | 说明 |
|---|---|
| `action` | get / amend / save |
| `text` | save：完整模型文本；amend：修正内容 |

**纪律**：测试前 get（无则先推导并 save 建立基线）；测试证伪了模型的某部分（"可信"边界实际可达、未列角色/主机）→ 必须 amend。"修正不是客套：没人纠正的威胁模型会把第一个 agent 的猜测变成所有人的假设。" save 是整体替换并清空修订（通常由编排者做基线合并）。

**存储**：`workspace/threat-model.md`（amend 以带时间戳的节追加）。

---

## strix_authorization — 授权证明（attestation）

**Strix 对应**：无直接对应（Strix 假设 CLI 操作者即授权方；dsh 作为多会话 agent 运行时需要把授权事实带在提示词里）。

| 参数 | 说明 |
|---|---|
| `action` | set / get / clear |
| `targets` | 范围内目标数组（set 必填，至少一个） |
| `granted_by` | 授权人/团队/项目（set 必填） |
| `scope_ref` | 项目或工单引用，如补天项目 id |
| `valid_until` | 授权到期（ISO-8601） |
| `notes` | 约束，如"禁止 DoS payload，仅业务时间" |
| `pre_approved_post_paths` | set：`[{path, body}]` POST-only 证明预批（精确 path+body） |
| `test_accounts` | set：`[{label, username, password?, login_url?, notes?}]` 操作员下发的测试账号，workspace 本地秘密，模型用 get 自取登录 |

**语义**：set 写入 `workspace/authorization.json`（保留首次 recorded_at，复写记 updated_at；`pre_approved_post_paths`/`test_accounts` 未传时沿用旧值）；get 读取（含密码原文，供模型自助登录）；clear 撤销（删文件，agent 回到被动模式）。set 缺 targets/granted_by 时 REJECTED。

**秘密纪律**：`test_accounts` 的密码只活在 `authorization.json` 文件与 get 返回里——prompt 注入与 report 摘要一律掩码（label/username/login_url 明文 + `password: ***`）；永不写入 notes/findings/report 正文，不提交、不外发。

**动态注入**：`strix:authorization` section（order 101，provider 函数形式，每次组装求值）三态——无声明时一行被动限制提醒；有未过期声明时事实+ refusal-avoidance 段（范围内验证是已授权安全工作：不自我归类为未授权/有害，不做通用政策警告，拿不准时继续最有用的范围内步骤——上游 REFUSAL AVOIDANCE 的条件版，只在有效授权存续期内出现，永不放宽 stay-inside）；`valid_until` 过期时事实保留+过期警告并退回被动。set 后下一 turn 即生效，无需重启。

**真实输出**（headless 冒烟）：

```
No authorization attestation recorded yet. Use action=set when the operator states permission.
Authorization recorded: 1 target(s), granted by smoke test. Re-injected into the system prompt from now on.
Authorization attestation revoked. The agent is back to passive-only until a new one is recorded.
```

---

## strix_shell — 容器化命令执行

**Strix 来源**：Kali 沙箱 `exec_command`（隔离属性的还原；完整 Kali 工具清单见路线图）。

| 参数 | 说明 |
|---|---|
| `command` | bash -c 内执行的命令 |
| `timeout_ms` | 默认 120s（config）；后台 job 同样受此超时约束 |
| `image` | 覆盖本次容器镜像（如 Kali 工具集）。有人审批时镜像名进审批摘要由人定；无人值守（approvalGate off）时仅限默认 `shellImage` + `shellAllowedImages` 名单 |
| `network` | 覆盖默认网络开关 |
| `workdir` | 容器内工作目录，默认 /workspace |
| `background` | `true` 时以后台 dsh job 运行，立即返回 job id；用 `job_output` 读流式输出、`job_kill` 终止 |

**语义**：一次性容器（`docker run --rm`），workspace 只读挂载为 `/workspace`——**每次调用无状态**，持久状态写 workspace 文件。引擎在容器里跑，天然与宿主隔离。

**后台模式**：`background=true` 时命令经审批门放行后注册为 `strix-shell-N` job（dsh 自带 `job_output`/`job_list`/`job_kill` 管理，无需插件自写）。适合长扫描：调用立即返回，模型可并行干别的，再用 `job_output` 轮询。kill 发 SIGKILL，5 秒后仍未退出则强制 settle 记录（防僵尸条目）。

**真实后台输出**（headless 冒烟，`echo bg-smoke-ok && sleep 2 && echo bg-done` + `background=true`）：

```
Background job started: strix-shell-1. Read streaming output with job_output, list jobs with job_list, stop it with job_kill.
```

随后 `job_output strix-shell-1`：

```
bg-smoke-ok
bg-done
[status: completed, exit code: 0]
```

`sleep 120` 后台启动再 `job_kill`：`requested cancellation of job strix-shell-1`，job 终止。

**真实输出示例**（`uname -a && python3 --version && whoami`）：

```
[exit code: 0]
--- stdout ---
Linux acea1e82ea7f 6.18.33.2-microsoft-standard-WSL2 ... x86_64
Python 3.12.14
root
```

**错误模式**：Docker 不可用 → 返回安装指引；超时 → `[timed out and killed]`。

**审批门（HITL）**：每次调用先经过 dsh ApprovalService 请求操作者批准，只有 `allowed-once` 才会执行；`rejected` / `cancelled` / `unavailable` 一律 fail-closed 拒绝。真实拒绝输出（headless 环境，无应答器）：

```
DENIED: strix_shell was not approved by the operator (outcome: unavailable). Nothing was executed.
If this work should proceed, the operator can approve the pending request in the dsh UI (approval
policy 'ask'), or set the plugin's approvalGate config to 'off' for fully autonomous runs they
accept responsibility for.
```

---

## strix_pybox — Python 漏洞利用沙箱

**Strix 来源**：自定义 exploit 运行时（Python 沙箱）。

| 参数 | 说明 |
|---|---|
| `script` | Python 源码（存为 `workspace/pybox/<run>/main.py`） |
| `files` | 附属文件（字典：文件名→内容；拒绝路径分隔符） |
| `install_packages` | 运行前 pip 安装（需网络） |
| `arguments` | JSON 写入 `args.json` 供脚本读取（避免复杂引号转义） |
| `timeout_ms` / `network` | 默认 60s / 开 |

**方法论绑定**：payload 喷射（SQLi/XSS/SSRF/fuzzing）**必须**用 pybox 脚本批量执行，禁止手动迭代。默认镜像仅 stdlib；第三方库用 `install_packages` 或改配置。与 strix_shell 同样受审批门约束（被拒时脚本**不落盘**，无任何副作用）。

**真实输出示例**（args.json 注入回读验证）：

```
Run dir: ...\pybox\run-1788...
[exit code: 0]
--- stdout ---
pybox-ok sandbox-verification
```

---

## strix_browser — 浏览器自动化

**Strix 来源**：`agent-browser --session`（会话隔离纪律的移植）。

| 参数 | 说明 |
|---|---|
| `action` | navigate / click / fill / evaluate / screenshot / content / close |
| `session` | 会话名（默认 default；仅字母/数字/横线/下划线/点）——**并发 agent 必须各用独立 session**，否则导航互相失效；session 存于插件进程内存，同进程多 engagement 共享，跨 engagement 必须换名 |
| `url` / `selector` / `value` / `wait_until` / `full_page` | 按 action |

**输出**：navigate 返回页面标题；screenshot 保存 `workspace/screenshots/<session>-<ts>.png` 并返回路径（用 dsh 原生 `read_image` 查看）；content 返回截断 HTML。

**真实输出示例**：

```
Navigated https://example.com — title: Example Domain
Screenshot saved: ...\screenshots\verify-1788387776891.png
Session "verify" closed.
```

**依赖**：`playwright` npm 包 + 对应版本 Chromium（`npx playwright install chromium`，版本必须与包内 playwright 匹配）。

---

## strix_recon — 侦察编排

**Strix 来源**：黑盒 Phase 1（recon & mapping first）。

| 参数 | 说明 |
|---|---|
| `domain` | 基础域名（无 scheme，自动归一化） |
| `skip_httpx` | 只枚举子域，跳过存活探测 |
| `timeout_ms` | 每引擎超时（默认 300s） |

**流程**：subfinder 被动枚举 → `recon/<domain>/subs.txt` → httpx（`-title -status-code -tech-detect`）→ `recon/<domain>/live.txt` → 返回汇总。

**真实输出示例**：

```
[subfinder] 24948 subdomain(s) → C:\Users\20327\.dsh\strix-workspace\recon\example.com\subs.txt
```

**依赖**：`~/.dsh/bin` 或 PATH 或 `binariesDir` 配置中有 subfinder/httpx。

---

## strix_sast — 模板扫描与静态分析

**Strix 来源**：nuclei/semgrep 使用纪律。

| 参数 | 说明 |
|---|---|
| `engine` | nuclei / semgrep |
| `target` | nuclei: 目标 URL；semgrep: 本地源码目录（绝对路径可触发容器回退） |
| `severity` | nuclei 严重度过滤（info/low/medium/high/critical/unknown 白名单，默认全部） |
| `extra_args` | 附加参数（空格分割；模板选择/输出格式/代理路由全开放，仅禁三类：重定向目标 `-u -target -l`、限速并发 `-rl -c`、引擎配置 `-config -update`） |

**执行策略**：

- **nuclei 容器优先**（`projectdiscovery/nuclei` 镜像自带模板库；规避沙箱子进程写配置目录的 Access denied 挂起），宿主二进制仅作无 Docker 回退
- **semgrep 容器回退**（Windows 无原生支持时用 `returntocorp/semgrep` 镜像挂载 `/src`）
- 速率限制默认 `nucleiRateLimit: 50`/s——非自有目标不要调高

**真实输出示例**：

```
nuclei scan via container (projectdiscovery/nuclei) (rate limit 50/s):
[exit code: 0]
Remember: these are template matches, not validated findings.
```

**预算门**：执行前查 `workspace/budget.json` 台账；超限且 `budgetAction='block'` 时拒绝执行（`BUDGET EXCEEDED ... Nothing was executed.`），`'warn'` 时输出前置警告后继续。cap 为 0（默认）时不检查。

---

## strix_proxy — mitmproxy 侧车拦截与重放

**Strix 来源**：`proxy` 模块（Caido：list_requests HTTPQL + repeat + Python 绑定）。v1 曾用 `strix_http` raw 重放覆盖核心用例；本工具把拦截→查询→重放闭环补上。

| 参数 | 说明 |
|---|---|
| `action` | start / status / list / get / replay / stop |
| `port` | start：本机监听端口，默认 8080（1024–65535） |
| `filter` / `limit` | list：按 method/url/status 子串过滤；最多显示条数，默认 20 |
| `id` | get/replay：flow id（`F-…`） |

**架构**：`mitmdump` 跑在官方 `mitmproxy/mitmproxy` 容器里（workspace 挂 `/workspace`，addon 挂 `/addon.py:ro`），`assets/mitmproxy/strix_addon.py` 把每个完整 flow 记成 `workspace/proxy/flows.jsonl` 一行摘要 + `flows/<id>.req` / `.rsp` 原始报文。replay 经共享 `sendHttpRequest`（与 strix_http 同一 fetch 路径、同一输出格式）重发。

**诚实限制**：HTTPS 正文需客户端信任侧车 CA（`workspace/proxy/.mitmproxy/mitmproxy-ca-cert.pem`）；不装 CA 时只记 CONNECT 元数据，replay 会明确拒绝（"has no replayable URL"）。同一 workspace 一次只跑一个侧车。stop 双路径：同进程 pid kill + 跨进程 `docker stop`（headless 退出后 pid 失效，靠后者——实测修过）。

**SCOPE（相对上游 Caido scope 的如实差异）**：上游 Caido 有 scope get/list/create/update/delete 做目标过滤；本实现**无 scope 名单**——单 workspace 单侧车，经过代理端口的流量全收。操作者用"只把已授权客户端指向代理端口"来划定范围，这点已写进工具 description，模型每次调用都能看到。

**真实输出**（headless 冒烟：start :18080 → curl 走代理 GET example.com → list/replay → stop）：

```
Sidecar listening on http://localhost:18080 (container mitmdump, addon logging to workspace/proxy/).
F-1788397575-0001 GET 200 http://example.com/ (req 105B / rsp 858B)
Replay of F-1788397575-0001:
HTTP 200 OK — 234ms — http://example.com/
Sidecar stopped. 2 flow(s) remain queryable (list/get/replay).
```

---

## strix_depcheck — 依赖漏洞库（AI 工具漏洞库）

**Strix 对应**：`dependency_cve` 类型的数据源（此前空架子）；调研结论见 `docs/backlog.md` A-0（OSV/KEV/EPSS 免费三件套最优，MCP 此路不通）。

| 参数 | 说明 |
|---|---|
| `action` | check / kev-refresh / status |
| `packages` | check：`[{ecosystem, name, version}]`（ecosystem 如 npm/PyPI/Go/Maven；单次至多 50 个） |

**链路**：OSV `querybatch` 主查（包+版本 → 漏洞 id）→ `vulns/{id}` 明细（summary/CVSS_V3/fixed 版本/CVE 别名）→ KEV 缓存命中（`workspace/vulndb/kev.json`，24h TTL，缺失/过期自动刷）→ EPSS 逐 CVE 取分 → KEV 命中优先、EPSS 降序输出。结果直喂 `strix_finding create vulnerability_type=dependency_cve`（`dedupe-check` 按 CVE+包名排重）。**先证可达再登记**：有洞依赖只是 lead。

**真实输出**（headless，lodash@4.17.20）：

```
5 known vuln(s) in 1 package(s) (KEV-hit first, then EPSS):
- lodash@4.17.20 [npm] GHSA-35jh-r3h4-6jhm: Command Injection in lodash (epss=0.213 CVE-2021-23337 cvss=CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H fixed=4.17.21)
- lodash@4.17.20 [npm] GHSA-29mw-wpgm-hmr9: Regular Expression Denial of Service (ReDoS) in lodash (epss=0.073 CVE-2020-28500 ...)
```

**nuclei 模板库（backlog A-1，同版落地）**：扫描容器挂 `strix-nuclei-templates` 命名卷，模板跨 `--rm` 常驻；刷新：`docker run --rm -v strix-nuclei-templates:/root/nuclei-templates projectdiscovery/nuclei -update-templates`（上游日更）。

---

## strix_budget — LLM 花费台账

**背景**：dsh 的 token-meter 只计量上下文压力、不给美元价，alpha.5 也没有价格 API——所以本台账用操作者配置的每 1K 单价显式记账（代码默认 DeepSeek V3.2 官价：input $0.00027/1K，output $0.0004/1K；本机三个 profile 已覆盖为 muse-spark-1.3-contributor 经 opencodego 的价格：input $0.0001/1K，output $0.0002/1K），累计值存 `workspace/budget.json`。台账的诚实度取决于记录：agent 每 turn 如实 `record` 自己的用量。dsh 将来开放 usage 订阅后可改自动喂数，台账格式已预留。

| 参数 | 说明 |
|---|---|
| `action` | record / status / reset |
| `input_tokens` / `output_tokens` | 本 turn 用量（record，非负） |
| `note` | 花费用途备注（record） |

**真实输出**（headless 冒烟）：

```
Budget: spent $0.0000 — no cap set (budgetLimitUsd=0).
Tokens: 0 in / 0 out across 0 records.
Rates: $0.0003/1K in, $0.0004/1K out (mode: warn).
Recorded +50000 in / +10000 out → total $0.0175 (smoke test).
```

**block 拒止实证**（cap 设 $0.0001 后调 recon）：

```
BUDGET EXCEEDED: strix_recon refused — spent $0.0175 of $0.0001 cap (50000 in / 10000 out tokens across 1 records). Raise budgetLimitUsd, reset the ledger (strix_budget action=reset), or switch budgetAction to warn. Nothing was executed.
```

---

## 配置项速查

| 配置 | 默认 | 影响 |
|---|---|---|
| `workspaceDir` | `''` → `~/.dsh/strix-workspace` | 全部产物根目录 |
| `httpTimeoutMs` / `httpMaxBodyChars` / `httpPostCapPerPath` | 30000 / 20000 / 5 | strix_http（cap：同 path 非预批 POST 上限，存 `workspace/http-post-counts.json`） |
| `shellImage` / `shellNetwork` / `shellTimeoutMs` | python:3.12-slim / true / 120s | strix_shell |
| `pyboxImage` / `pyboxExtraPackages` / `pyboxNetwork` / `pyboxTimeoutMs` | python:3.12-slim / [] / true / 60s | strix_pybox |
| `binariesDir` | `''` | recon/sast 二进制发现（`~/.dsh/bin` 始终在搜索路径） |
| `reconTimeoutMs` / `nucleiRateLimit` | 300s / 50 | strix_recon / strix_sast |
| `browserHeadless` | true | strix_browser |
| `strictEvidence` | true | strix_finding 无证据拒收 |
| `approvalGate` | `'always'` | strix_shell / strix_pybox 每次调用经 ApprovalService 审批；`'off'` 关闭（仅限操作者自担责任的无人值守运行） |
| `budgetLimitUsd` | `0`（不限） | strix_budget 花费上限（USD）；recon/sast 执行前查账，超限按 budgetAction 处理 |
| `budgetInputPer1k` / `budgetOutputPer1k` | `0.00027` / `0.0004` | 记账单价（代码默认 DeepSeek V3.2 官价；本机 profile 已覆盖为 0.0001/0.0002；换模型时改 profile 覆盖层） |
| `budgetAction` | `'warn'` | 超限后重型工具行为：`'warn'` 前置警告继续，`'block'` 拒绝执行 |

---

## 审批门（HITL）与证据台账

strix_shell 和 strix_pybox 是套件中唯二能在容器里执行任意命令/代码的工具，因此绑定 dsh 的
[ApprovalService]（`@deepseek-ai/dsh-user-approval`，alpha.5 起）做逐调用审批：

1. 工具执行前先过 `approvalAutoAllow` 预批（正则数组，默认空=不放宽）：命令摘要命中任一条即自动放行并记 `auto-allowed` 审计；未命中才调用 `ctx.approval.request({ agent, toolName, callId, reason, signal })`，
   `reason` 是给人看的命令摘要（命令前 160 字符 / 脚本首行 + 体积 + pip 包 + 网络开关）。典型预批：只读命令 `^strix_shell: run "(echo|uname|whoami|id|ls|cat|head|tail|grep|jq)`。
2. 结果四种：`allowed-once`（唯一放行）、`rejected`、`cancelled`、`unavailable`。
   **除放行外全部拒绝执行**（与 dsh 对 `unavailable` 的 fail-closed 规则一致）。
3. 服务自动向会话事件日志追加 `approval/asked` + `approval/decided` 审计对；
   插件另写**操作者侧台账** `<workspace>/evidence/log.jsonl`：

```jsonl
{"ts":"...","kind":"decision","tool":"strix_shell","outcome":"unavailable","callId":"call_00_...","command":"strix_shell: run \"echo gate-test\" in python:3.12-slim (network: on)"}
{"ts":"...","kind":"result","tool":"strix_shell","callId":"call_00_...","exitCode":0,"durationMs":3946}
```

各表面的行为差异（dsh 应答器瀑布）：

| 表面 | 审批体验 |
|---|---|
| WebUI（`--profile web`/strix） | 交互式批准对话框（allow-once / reject） |
| ACP 客户端 | `session/request_permission` 往返 |
| headless 一次性模式 | 无应答器 → `unavailable` → fail-closed 拒绝（不阻塞、不执行） |
| 会话策略 `never` | 每个请求确定性地 `rejected` |

关闭方式（仅建议在本地靶场/无人值守且自担责任时）：profile 的 `cordis.patch.yml` 里对插件入口
覆盖配置——注意 **id 是插件入口 id（`strix-tools`），不是包名**：

```yaml
- id: strix-tools
  config:
    approvalGate: 'off'
```

实现位置：`src/lib/approval.ts`（`createApprovalGate` / `logEvidence`）。
