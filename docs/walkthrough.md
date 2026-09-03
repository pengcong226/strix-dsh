# 实战走查：从启动到第一份报告

> 本走查的所有输出都是 2026-09-03 在本机（dsh 0.1.2-alpha.5 + StriX-DH）真实运行采集的，可直接复现。
> 两种操作方式贯穿全文：**CLI**（headless 一次性任务，适合脚本化）与 **WebUI**（人机协作，适合真实 engagement）。
>
> ⚠️ 走查以良性目标（example.com）和本地验证为例。对任何第三方目标执行前，确认授权。

## Part 0 — 启动

```sh
cd packages/strix-tools && npm install && npm run build
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open > dsh-boot.log 2>&1 &
sleep 25 && head -2 dsh-boot.log
```

启动日志前两行是健康检查：

```
[strix-dsh-tools] registered 15 tool modules (15 tools) + methodology + authorization sections + 75 skills; workspace: C:\Users\20327\.dsh\strix-workspace
dsh web: http://127.0.0.1:3080/?token=<每次启动随机>
```

第一行 = 插件加载成功；第二行 = 带一次性 token 的 WebUI 地址（浏览器打开）。模型 key 在 **Settings → Models** 页配置（存入 credential store，热生效）。

Windows 提示：若 3080 被历史残留占用，`netstat -ano | findstr :3080` 找到 PID 后 `taskkill /F /PID <pid>`。

## Part 1 — 认领工作区（strix_runs）

**CLI**：

```sh
npx -y @deepseek-ai/dsh@0.1.2-alpha.5 --profile headless "Call strix_runs once and quote its full output."
```

**真实输出**：

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

**WebUI**：新会话直接对 agent 说"call strix_runs and summarize"。

这一步的意义：加入任何 engagement（或恢复中断的工作）先看存量——findings/coverage/notes 是跨会话共享的。

## Part 2 — 建立威胁模型与授权上下文（strix_threat_model + strix_authorization）

**对 agent 说**："Before testing, save a threat model for this engagement: the target is our own local lab, the attacker profile is an external unauthenticated user, trust boundary is the HTTP endpoint, and critical assets are the workspace files. Also record the authorization: targets=[our lab URL], granted_by=me."

**真实输出**：

```
Threat model saved (88 chars). Amendments cleared — this is now the baseline.
Authorization recorded: 1 target(s), granted by me. Re-injected into the system prompt from now on.
```

授权声明写入 `workspace/authorization.json` 后，`strix:authorization` section（order 101，每次组装动态求值）会把它带进每一 turn 的系统提示——后续 agent 无需翻聊天记录就知道范围；engagement 结束或范围变更时 `action=clear` 撤销。

之后的 agent 若发现威胁模型与事实不符（比如"可信"边界实际可达），用 `action=amend` 追加修正——修正会带时间戳进入文档，所有后续 agent 继承。

## Part 3 — 侦察（strix_recon）

**对 agent 说**："Run strix_recon with domain=example.com, skip_httpx first if you want a quick map."

**真实输出**（节选）：

```
[subfinder] 24948 subdomain(s) → C:\Users\20327\.dsh\strix-workspace\recon\example.com\subs.txt
```

完整跑（不带 skip_httpx）会继续用 httpx 做 `-title -status-code -tech-detect` 存活探测，产出 `recon/<domain>/live.txt`。注意：被动数据源包含大量历史记录，存活探测才是分水岭。

## Part 4 — HTTP 验证（strix_http）

**对 agent 说**："Send a baseline GET to https://example.com via strix_http and report the status."

**真实输出**（节选）：

```
HTTP 200 OK — 427ms — https://example.com/
content-type: text/html; charset=UTF-8
...
```

`raw_request` 参数接受完整原始请求文本（等价 Burp Repeater 的重放）——这是验证阶段的主力：从侦察发现的每个可疑请求都应在此重放确认。

## Part 5 — 浏览器取证（strix_browser）

**对 agent 说**："Use strix_browser: navigate to https://example.com with session=lab, take a screenshot, then close the session."

**真实输出**：

```
Navigated https://example.com — title: Example Domain
Screenshot saved: ...\screenshots\lab-1788387776891.png (view it with the read_image tool)
Session "lab" closed.
```

会话按名字隔离——多 agent 并发时各自用独立 session 名，互不干扰页面状态。

## Part 6 — 容器化利用（strix_shell / strix_pybox）

需要 Docker Desktop 运行中。

**这两个工具每次调用都要操作者批准**（dsh 审批门，见 Part 6.5）：

- **WebUI**：弹出批准对话框（Allow once / Reject）——点 Allow 才执行；
- **headless 一次性模式**：无应答器，一律 fail-closed 拒绝（不阻塞、不执行）；
- 被拒时工具返回 `DENIED: ... (outcome: ...)`，agent 被方法论约束**不得原样重试**。

**shell**（容器内复合命令）：

```
[exit code: 0]
--- stdout ---
Linux acea1e82ea7f 6.18.33.2-microsoft-standard-WSL2 ... x86_64
Python 3.12.14
root
```

**pybox**（payload 喷射的正确姿势——脚本批量执行，不是手动迭代）：

对 agent 说："Write a strix_pybox script that requests https://example.com 5 times, records status codes, and prints a summary."

脚本与参数落在 `workspace/pybox/<run>/`，args.json 机制免去了复杂引号转义。被拒的 pybox 调用**脚本不落盘**。

### Part 6.5 — 审批门与证据台账

- 每次决策 + 每次运行结果都追加到 `<workspace>/evidence/log.jsonl`（ts / tool / outcome /
  callId / 命令摘要 / exitCode / 耗时），独立于会话日志，操作者随时可查。
- 会话事件日志里有 dsh 服务自动写的 `approval/asked` + `approval/decided` 审计对。
- 无人值守运行（自担责任）：profile 的 `cordis.patch.yml` 加
  `- id: strix-tools` + `config: { approvalGate: 'off' }`（注意 id 是插件入口 id，
  不是包名 `strix-dsh-tools`）。详见 tools-reference「审批门（HITL）与证据台账」。

## Part 7 — 扫描器（strix_sast）

**对 agent 说**："Run strix_sast engine=nuclei target=https://example.com severity=high,critical."

**真实输出**（节选）：

```
nuclei scan via container (projectdiscovery/nuclei) (rate limit 50/s):
[exit code: 0]
Remember: these are template matches, not validated findings.
```

首次运行会拉取镜像（nuclei 模板库内置）；速率限制默认 50/s——**扫描结果只是线索**，任何匹配都要回到 strix_http/pybox 做人工级验证后才可能成为 finding。

## Part 8 — 台账与登记（coverage / finding）

**对 agent 说**："Record the baseline fetch in coverage, then register a finding only if you have real evidence."

**真实输出**：

```
Recorded C-001: https://example.com — baseline reachability → clean.
```

登记finding 时（strict 模式）：

```
Registered F-001 [info] Toolchain verification entry — local-verification.
```

没有 `evidence` 字段的 create 会被**直接拒绝**：

```
REJECTED: no evidence. A finding without a demonstrated PoC ... is at best an
open_proof_gap. Record it in strix_coverage with needs_follow_up instead...
```

这个拒绝是特性：它把 Strix 的"没证明就不是发现"纪律固化进了工具层。

## Part 9 — 报告（strix_report）

**对 agent 说**："Generate the engagement report titled 'Lab Baseline Assessment'."

**真实输出**：

```
Report written to C:\Users\20327\.dsh\strix-workspace\report.md (1 findings, 0 coverage entries).
```

报告结构：Scope & Authorization → Executive Summary → Findings（逐个含证据代码块、反证、修复、白盒 diff）→ Coverage Ledger → Methodology。

## 完整 engagement 的推荐节奏

```
strix_runs（认领）→ strix_threat_model（建立基线）→ strix_recon（测绘）
→ 逐表面循环：strix_http/browser/pybox 验证 → strix_coverage 记录（含 clean）
→ 有实锤 → strix_finding 登记 → strix_report 生成 → 人工复核 → 提交平台
```

多 agent 模式（alpha.4+ 双向通信）：主 agent 用 `subagent` 派发专项（一 agent 一任务），子代理继承同一工具与人设，通过共享工作区协同；主 agent 可 `send_message` 中途纠偏。
