# StriX-DH Agent Preset（strix-dsh 模式）

`strix` preset 内含两档分派工具（同一 spawn provider，纯行级配置，零插件代码）：

| 工具 | 人设 | 子代理可见性 |
|---|---|---|
| `subagent` | 无（继承编排者） | 全量：可再规划、再派发 |
| `strix_operator` | Operator（动手执行，不规划/不派发/不改范围） | 叶子：deny 掉再派发、workflow、goal 工具 |

deny 列表（2026-09-03 经 headless `--patch` 双胞胎实测验证；0.12.7 增补 `present`——交付物声明归编排者）：

```yaml
toolFilter:
  deny: [subagent, subagent_fork, strix_operator, workflow, ralph, create_goal, get_goal, update_goal, present]
```

注意：
- 必须是**无前缀注册表名**——`restrict()` 按 `view(scope).restrictableNames` 校验，`default.*` 前缀会抛错。
- 只能写**真实注册的工具**：`subagent_codex` / `subagent_claude_code` 行默认 `disabled`，裸 `goal` 是 `/goal` 斜杠命令而非工具（工具是 `create_goal`/`get_goal`/`update_goal`），写错名派发时抛错。
- `strix_operator` 自我 deny，子代理即真叶子，无法再分派。
- 子代理验证输出：8 项 delegation/workflow/goal 工具全部 ABSENT，仅保留动手工具 + `send_message`（向父汇报）。

操作员人设内联在 `strix_operator` 派发行 config 里（叶子代理：不再委派），无独立执行者 preset——并行执行一律走编排者会话内的自主派发。

## 双形态：目录版（≤0.1.6）与声明行版（0.1.7+）

dsh **0.1.7 起不再读取 `~/.dsh/.agent-presets/` 目录预设**，预设改由组合内的 `@deepseek-ai/dsh-agent-preset` 声明行注册（官方 standard/ptc/minimal/cordis 同款机制）。本仓库因此同时维护两份**内容必须一致**的形态：

| 形态 | 文件 | 服务对象 | 加载方式 |
|---|---|---|---|
| 目录版 | `presets/strix/{preset.yml, agent.cordis.yml}` | dsh ≤0.1.6 | 拷贝到 `~/.dsh/.agent-presets/strix/`，旧注册表惰性挂载（首个会话时） |
| 声明行版 | `packages/strix-tools/cordis.patch.yml` 的 `preset-strix` 行 | dsh 0.1.7+ | 随插件 bundle patch（或 profile patch）应用，`agentPresets` 注册表 eager 挂载 |

声明行版的 `disabled` 守卫用 `createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')` 探测声明包：≤0.1.6 运行时无此包 → 行自动禁用（零错误日志），目录版继续服务；0.1.7+ → 行启用并注册 `strix` 预设。双向求值已实测（0.1.6 真机 boot 干净、0.1.7 roster 含 strix）。

**漂移围栏**：`test/core.test.ts` 的 preset declaration consistency 测试用宿主同款 YAML 方言（`tag:yaml.org,2002:js` on JSON_SCHEMA）解析两份文件并逐字段比对——改一份不改另一份，测试即红。改预设内容时两份都要改。

**部署矩阵**（预设声明行从哪里来）：

- **bundle 安装**（`dsh plugin install` / 插件管理页，插件进 profile bundles）：插件自带的 `cordis.patch.yml` 自动声明预设，无需手工步骤。boot 注册行出现**两次**（宿主行 + 预设 eager 挂载）属预期；代价是宿主层挂载让所有模式会话都看到 16 工具（对非渗透会话是提示词污染，bffa682 修过的同款问题）。
- **桌面隔离布局**（bffa682：插件只进 dependencies 不进 bundles）：插件 patch 不应用，**必须把 `preset-strix` 行手工加入 profile 的 `cordis.patch.yml`**（从插件 patch 文件中原样拷贝该行，守卫保留）。注册行恰好一次。见 docs/desktop-upgrade-0.1.7.md。

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

0.1.7 注册表 eager 挂载预设：boot 日志即出现一次 `registered 16 tool modules + ...` 注册行（隔离布局）；0.1.6 目录版则是惰性挂载，注册行在首个 strix 会话创建时才出现。
