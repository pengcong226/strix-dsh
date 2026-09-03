# 实战复盘：jxnu 自主渗透会话 session-a6a8664b（2026-09-03 导出分析）

分析对象：`dsh-session-session-a6a8664b-c63e-432e-a2d8-3ae3064afe1e`（session.jsonl 3295 行 + subagents/ 39 个子会话）。
分析方法：纯离线解析导出文件 + 工作区残留文件，未发起任何新测试请求。

## 1. 会话画像

- 预设 `strix`，工作区 `C:\Users\20327\.dsh\strix-workspace`，时长约 3 小时（08:24→11:27 UTC），41 turn / 179 step。
- 人类只输入 6 次：一张 20+ 站点基线表、一个 `3`、三次 `继续`、一次 `启动ai自动化渗透流程，完全由你自主决策目标，严禁询问用户`。
- 主会话工具调用 226 次：`subagent_fork` 39（= 39 个子代理目录，对得上）、`threat_model` 41、`coverage` 29、`notes` 29、`report` 8、`strix_http` 4（主会话只做调度，实测下沉到子代理）、`ask_user_question` 2。
- 子代理侧约 334 次 `strix_http`（39 个子会话均含实测请求），`strix_browser` 19 次；`shell/sast/recon/pybox/depcheck` 在主会话几乎为 0，子代理侧也无实质调用——全程停在 GET 指纹层。
- 工作区残留：`coverage/ledger.jsonl` 181 条（clean 152 / blocked 21 / needs_follow_up 7 / finding 1，其中 finding 是此前本地 ThinkPHP 靶场的 F-001，jxnu 本轮零 confirmed）、`notes/` 51 篇、`report.md` 52KB（8 轮报告）、`authorization.json` 已不存在。

## 2. 跑得好的地方

1. **调度骨架是通的**：39 个 Operator 按站点分组派发，任务 prompt 带授权声明、低噪约束、去重指引（先看 runs/threat-model/notes），回执结构化（URL/状态/标题/技术栈/登录口/下一步），主会话负责合并 coverage + 改 threat-model + 写 report，Strix 方法论闭环真实运转。
2. **安全纪律好**：全程低噪声 GET（`/` + robots/favicon），遇 WAF RST/403 即停不重试、不爆破、不喷 payload、不试密码，blocked 单独记 outcome 而不是硬闯。
3. **可追溯性强**：每站一条 coverage（C-xxx）+ 若干 notes（N-xxx），8 轮报告标题/范围递进（第一轮→…→第六轮→自主流程），ledger 可审计。
4. **结尾 24 分钟真自主**：11:03 那句“严禁询问”之后到 11:27 会话结束，中间零人类输入，自行推进了十几批站点（lkxb/jrxb 同族期刊收敛→第十七批 sis/sxxy/tzb/yar/yyxytw），说明去掉提问后模型能自己找活干。

## 3. 问题（按严重度排序）

1. **跑的是旧构建，ask 工具还在**：主会话 2 次 `ask_user_question`（08:26 授权+主攻二连问；08:33 “下一步四选一：给账号/批准枚举/换一批/结项”），正是之前投诉的“弹窗/你定” stall 现场。本次导出的正是 0.10.2 修复前（移除 ask + AUTONOMY + 交差模板）的行为化石。
2. **人类输入 `3` 把它钉死在浅层循环**：08:33 的四选项中 `3` = “换一批子站继续纯基线”，之后十几轮就是“新一批 5 站×GET→clean→再一批”，同族 WebPlus 资讯站反复出现（siteId/template 逐个记），广度刷到 50+ 面，深度零增长。
3. **Operator 递归派单（委托爆炸）**：子代理会话里出现与父任务 prompt 完全相同的 `subagent_fork`（例 1685d4aa seq=179），说明该构建的 Operator 仍有委托权，自己不干活又转包。子会话文件里还镜像了父历史的 ask（约 65 处同文 ask），token 双重燃烧：主文件 3MB，子会话单个 0.5~3MB。
4. **深度工具零使用**：`shell/sast/recon/pybox/depcheck` 全程挂零（主+子），`browser` 仅 19 次点到为止；7 个 needs_follow_up（oas 用户名回显、e token 越权候选、portal-minio 等）全部停在“需 POST/需账号”而无预批 POST 链路——0.10.2 的 `pre_approved_post_paths` 正是补这个洞。
5. **turn 收尾语义旧**：多次 assistant 以纯文本小结收尾（“正在消化B/C组产出并定下一步”“正在沉淀报告并请你定夺”），dsh 里纯文本即交权，于是必须人类 `继续` 踢一步走一步；0.10.2 的“永远工具调用收尾”就是针对这个。
6. **授权文件无残留**：工作区当前无 authorization.json（符合测后撤销的好习惯，但复盘时无法确认当轮授权、过期时间与预批 POST 路径是否落盘）。

## 4. 总评

- **作为自动化引擎：及格偏上**——能分组、能并行、能记账、能写报告，安全刹车灵敏，结尾已证明可 24 分钟无人干预连续推进。
- **作为渗透测试：浅层**——50+ 面的 GET 指纹，jxnu 零 confirmed 漏洞，7 个候选无一证伪/证实，没有走到 PoC 验证阶梯。drought 主因是旧构建三缺：缺 ask 移除、缺 turn 收尾纪律、缺 POST 预批；次因是目标池大多是无登录口 WebPlus 资讯站 + WAF 对探测 RST，策略从未切换（被动 JS/版本→vulndb/depcheck→单发 POST 证明/排除）。
- **与 0.10.2 的关系**：本会话的问题正是 0.10.2 已修的三件事的“修前证据”，建议用新构建 + 新会话 + 落盘授权（含 pre_approved_post_paths）重跑同目标做对照验证。

## 5. 后续建议（对照验证）

1. 新会话确认 `ask_user_question` 缺席、Operator deny 含 `subagent_fork`（单层委托）。
2. 同一批 jxnu 候选（oas/C-036 等）用预批 POST 做一次“证伪或证实”，终结 needs_follow_up 积压。
3. 加升级策略：单站 2 个 clean GET 后必须转被动（JS/版本→depcheck/vulndb），再无产出则 ruled_out，不开新一批。
4. 限制扇出上限与轮询（`list_agents` 本轮主会话 19 次、子侧 540 次镜像，偏多）。
