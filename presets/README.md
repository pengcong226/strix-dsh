# StriX-DH Agent Preset（strix-dsh 模式）

`strix` preset 内含两档分派工具（同一 spawn provider）：

| 工具 | 人设 | 子代理可见性 |
|---|---|---|
| `subagent` | 无（继承编排者） | 全量：可再规划、再派发 |
| `strix_operator` | Operator（动手执行，不规划/不派发/不改范围） | 叶子：无派发/workflow/goal/present 工具 |

## 0.2.x 语义：deny 列表 → 工具缺席

dsh **0.2.0 删除了 `@deepseek-ai/dsh-tool-subagent` 的 `persona` 与 `toolFilter` 字段**，且是**加载期硬抛错**（不是忽略）：

```
tool-subagent: persona is no longer supported; configure persona and tool
plugins in an Agent Preset and select it with agentPreset (spawn only)
```

后果是灾难性的：**整个 `strix` preset 变 broken**，红色「加载失败」徽章，16 个工具一个都挂不上。0.2.x 的正确写法是人设与工具集都放进 **Agent Preset**，派发行只用 `agentPreset: strix-operator` 选中它。

因此叶子约束从「显式 deny 列表」改成「**预设里根本不声明那些行**」——比 deny 更彻底（deny 写错名字会报错，缺席不会）：

| 运行时 | 叶子机制 | 位置 |
|---|---|---|
| dsh ≤0.1.6（目录版） | `toolFilter.deny: [...]` | `presets/strix/agent.cordis.yml` 的 `tool-strix-operator` 行 |
| dsh 0.2.x（声明行版） | **省略** delegation / workflow / goal / ralph / present 行 | `preset-strix-operator` 的 `plugins` |

两个 runtime 的**语义必须等价**，由 drift fence 断言（见下）。0.1.6 的 deny 列表原文，仅供对照：

```yaml
toolFilter:
  deny: [subagent, subagent_fork, strix_operator, workflow, ralph, create_goal, get_goal, update_goal, present]
```

注意：
- deny 必须是**无前缀注册表名**——`restrict()` 按 `view(scope).restrictableNames` 校验，`default.*` 前缀会抛错。
- 只能写**真实注册的工具**：`subagent_codex` / `subagent_claude_code` 行默认 `disabled`，裸 `goal` 是 `/goal` 斜杠命令而非工具（工具是 `create_goal`/`get_goal`/`update_goal`），写错名派发时抛错。
- `send_message` / `interrupt_agent` / `list_agents` 属于 **control 行**而非 delegation 行，**两条路径都要保留**——砍掉 `send_message` 叶子无法向父汇报。
- `backgroundMode` 在 0.2.x 只是**被忽略**（schema 不拒绝未知键），与 `persona` 的硬抛错不同；保留它是为了 0.1.x 对等。

操作员人设现在有**三份拷贝**（≤0.1.6 目录行 / 0.2.x 预设 / headless overlay），必须逐字一致——drift fence 用空白归一化后的文本比对。

## 双形态：目录版（≤0.1.6）与声明行版（0.1.7+）

dsh **0.1.7 起不再读取 `~/.dsh/.agent-presets/` 目录预设**，预设改由组合内的 `@deepseek-ai/dsh-agent-preset` 声明行注册（官方 standard/ptc/minimal/cordis 同款机制）。本仓库因此同时维护两份形态，服务**互斥的运行时版本**：

| 形态 | 文件 | 服务对象 | 加载方式 |
|---|---|---|---|
| 目录版 | `presets/strix/{preset.yml, agent.cordis.yml}` | dsh ≤0.1.6 | 拷贝到 `~/.dsh/.agent-presets/strix/`，旧注册表惰性挂载（首个会话时） |
| 声明行版 | `packages/strix-tools/cordis.patch.yml` 的 `preset-strix` / `preset-strix-operator` 行 | dsh 0.1.7+ | 随插件 bundle patch（或 profile patch）应用，`agentPresets` 注册表 eager 挂载 |

声明行版的 `disabled` 守卫用 `createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')` 探测声明包：≤0.1.6 运行时无此包 → 行自动禁用（零错误日志），目录版继续服务；0.1.7+ → 行启用并注册预设。双向求值已实测（0.1.6 真机 boot 干净、0.1.7 roster 含 strix）。

**漂移围栏**（`test/core.test.ts` 的 preset declaration consistency 组）：

- `preset row plugins are identical to the 0.1.6 directory form` — 除 `tool-strix-operator` 一行外逐字段比对。该行**无法**再字面一致（两种写法互斥），所以从两侧剔除后比对，其余 14 行漂移仍会红。
- `operator persona and leaf policy agree across form, preset and overlay` — 三份人设文本归一化后必须相等；deny 列表（0.1.6）与缺席列表（0.2.x）必须表达同一套叶子语义。
- 改预设内容时三处都要改。

**部署矩阵**（预设声明行从哪里来）：

- **bundle 安装**（`dsh plugin install` / 插件管理页，插件进 profile bundles）：插件自带的 `cordis.patch.yml` 自动声明预设，无需手工步骤。boot 注册行出现**两次**（宿主行 + 预设 eager 挂载）属预期；代价是宿主层挂载让**所有模式会话**都看到 16 工具（对非渗透会话是提示词污染，bffa682 修过的同款问题）。实测：headless profile（bundles 含 `strix-dsh-tools`）里问 `standard` 会话"你有 strix_http 吗"，模型答 **YES**。
- **桌面隔离布局**（bffa682：插件只进 dependencies 不进 bundles）：插件 patch 不应用，**必须把 `preset-strix` 与 `preset-strix-operator` 两行手工加入 profile 的 `cordis.patch.yml`**（从插件 patch 文件中原样拷贝，守卫保留）。0.13.4 起两个预设各 eager 挂载一次，故注册行**两行**（此前单预设有"恰好一次"的验收信号，现已不适用）。见 docs/desktop-upgrade-0.1.7.md。
  - **漏掉 `preset-strix-operator` 的症状**：预设列表正常、无 broken，但 `strix_operator` 派发时才报 `Unknown agent preset: strix-operator`。
  - **漏掉整个插件的症状**：boot 日志出现 `preset-strix (@deepseek-ai/dsh-agent-preset): pending (waiting for service: agentPresets)`——`dsh-base` 不提供 `agentPresets` 服务，隔离布局下孤儿预设声明永远 pending，roster 里两个 strix 预设都不会出现。**这是"插件漏进 bundles 目录残留"的信号，不是预设配置错。**
  - **两层同时存在**（插件既在 bundles、profile patch 又贴了同样的两行）：预设被声明两次，`Duplicate agent preset` 不触发是因为 patch 层后写覆盖同 id；实测生效的是 **profile patch 那份**（把它的 `order` 改成 77，roster 显示 77）。功能可用但属配置冗余，诊断时易误导。

## headless overlay（`strix-operator.patch.yml`）

`dsh --profile headless --patch ./strix-operator.patch.yml "<task>"` 用于在 headless 组合里测量操作员行。要点：

- `dsh-base`（headless 的唯一 bundle）**不挂载 agent-presets 服务**，所以 overlay **自带** `agent-preset-registry` 行与 `preset-strix-operator` 声明，再挂 `tool-strix-operator` 用 `agentPreset` 选中。
- 判别验证法：把 `agentPreset` 改成不存在的 id，必须报 `Unknown agent preset: ...`——报错才证明注册表**真的挂上了**（而不是整段被跳过）。静默通过意味着 overlay 无效。

## 安装（≤0.1.6 目录版）

```sh
cp -r presets/strix ~/.dsh/.agent-presets/
# WebUI 重启（discovery 每次调用重读，理论无需重启；重启最稳）
```

0.1.7+ 无需此步骤（目录不被读取）；声明行版随插件 patch 或 profile patch 生效。

## 验证（≤0.1.6）

```sh
node -e "
(async () => {
  const m = require('<dsh>/node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js');
  const { pathToFileURL } = require('node:url');
  const presets = await m.discoverPresets(
    [{ path: '<home>/.dsh/.agent-presets', trust: 'user' }],
    pathToFileURL('<home>/.dsh/profiles/web/').href,  // 插件 link 在各 profile 下，base 必须指 profile 子目录
  );
  for (const p of presets) console.log(p.id, '|', p.broken ? ('BROKEN: ' + p.broken) : 'healthy');
})();
"
```

注意：harnessBase 传错目录会把 preset 报 BROKEN（`strix-dsh-tools` 解析不到）——这是验证脚本的 base 问题，不是 preset 的问题。桌面端的预设行按**应用内 runtime base** 解析（`resources/app/dsh/node_modules`），插件需同时存在于该处（见 docs/desktop-deploy-2026-09-21.md 第三节）。

## 验证（0.1.7+）

启动 web 后带 token 换 cookie，查 roster（`agentPresets/list`）：

```sh
curl -s -c c.txt "http://127.0.0.1:PORT/?token=..." -o /dev/null
curl -s -b c.txt -X POST "http://127.0.0.1:PORT/api/agentPresets/list" \
  -H "content-type: application/json" \
  --data-binary '{"type":"client-request","rpcId":"r1","method":"agentPresets/list","payload":{"args":{}}}'
# 期望 presets 数组含 {"id":"strix","name":"strix-dsh 模式","order":10} 且无 broken 字段；
# 再用 session/create（args.request.agentPreset="strix"）验证预设真实可组合。
```

0.1.7 注册表 eager 挂载预设：boot 日志即出现注册行（隔离布局下每个预设一次，0.13.4 起为**两行**）；0.1.6 目录版则是惰性挂载，注册行在首个 strix 会话创建时才出现。
