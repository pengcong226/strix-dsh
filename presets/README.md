# StriX-DH Agent Presets（编排者 + 框架级操作员分派）

`strix` preset 内含两档分派工具（同一 spawn provider，纯行级配置，零插件代码）：

| 工具 | 人设 | 子代理可见性 |
|---|---|---|
| `subagent` | 无（继承编排者） | 全量：可再规划、再派发 |
| `strix_operator` | Operator（动手执行，不规划/不派发/不改范围） | 叶子：deny 掉再派发、workflow、goal 工具 |

deny 列表（2026-09-03 经 headless `--patch` 双胞胎实测验证）：

```yaml
toolFilter:
  deny: [subagent, subagent_fork, strix_operator, workflow, ralph, create_goal, get_goal, update_goal]
```

注意：
- 必须是**无前缀注册表名**——`restrict()` 按 `view(scope).restrictableNames` 校验，`default.*` 前缀会抛错。
- 只能写**真实注册的工具**：`subagent_codex` / `subagent_claude_code` 行默认 `disabled`，裸 `goal` 是 `/goal` 斜杠命令而非工具（工具是 `create_goal`/`get_goal`/`update_goal`），写错名派发时抛错。
- `strix_operator` 自我 deny，子代理即真叶子，无法再分派。
- 子代理验证输出：8 项 delegation/workflow/goal 工具全部 ABSENT，仅保留动手工具 + `send_message`（向父汇报）。

`strix-operator` 独立 preset 目录仍保留：用于**手动开的执行者会话**（多目标并行时人开多个会话）。框架级 `strix_operator` 行则让编排者会话内**自主派发操作员子代理**，无需人工开会话。

## 安装

```sh
cp -r presets/strix presets/strix-operator ~/.dsh/.agent-presets/
# WebUI 重启（discovery 每次调用重读，理论无需重启；重启最稳）
```

## 验证

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

注意：harnessBase 传错目录会把两个 preset 都报 BROKEN（`strix-dsh-tools` 解析不到）——这是验证脚本的 base 问题，不是 preset 的问题。
