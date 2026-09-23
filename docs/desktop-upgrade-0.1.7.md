# 桌面端升级 0.1.6-alpha.2 → 0.1.7-alpha.2：插件与预设侧迁移手册

> 适用场景：DeepSeek Harness 桌面端（自建）升级到 dsh 0.1.7-alpha.2 运行时之后，strix-dsh-tools 0.13.0 的部署与验证。
> 桌面**构建**本身（8 处补丁、`.env.windows`、强制更新策略第 7 补丁等）不在本文范围——见 `C:/Users/20327/Documents/dsh/DSH-0.1.7-升级交接清单.md`（2026-09-23 内核查，含补丁可打性逐条盘点）。
> 插件侧适配的设计依据见 docs/DEVELOPMENT.md 0.13.0 版本条目；预设双形态机制见 presets/README.md。

## 0. 升级前（一次性，防数据损失）

- **备份 `~/.dsh/sessions/`**。0.1.7 把 Session 日志升级为 V4（官方提供批量迁移工具，兼容部分缺轮次结束记录的 V3，但先备份再升级）。
- `~/.dsh/settings.yaml` 在 0.1.7 首次启动时**一次性导入** Profile 插件配置，之后设置改在 Profile 里改。首次启动后确认 provider（opencodego / tyy / aihub）、模型（deepseek-v4.1-flash）、reasoningEffort 都在。
- 两个桌面版本**不可共存共享 `~/.dsh`**（desktop-runtime-state.json 只记一个运行时身份）——沿用既有流程：备份旧程序目录 → 杀进程 → 整目录替换。

## 1. 插件三副本同步（strix-dsh-tools 0.13.0）

```sh
# 仓库源码构建
cd <repo>/packages/strix-tools && npm run build

# 副本 1：profile 解析安全网
set DST=%USERPROFILE%/.dsh/profiles/desktop/node_modules/strix-dsh-tools
rmdir /S /Q "%DST%/dist" "%DST%/assets" "%DST%/locale"
xcopy /E /I dist "%DST%/dist"
xcopy /E /I assets "%DST%/assets"
xcopy /E /I locale "%DST%/locale"
copy cordis.patch.yml package.json icon.svg "%DST%/"

# 副本 2：应用内 runtime base（预设行解析依赖）
set RT=C:/Users/20327/AppData/Local/Programs/DeepSeekHarness/resources/app/dsh/node_modules/strix-dsh-tools
mkdir "%RT%" 2>nul
xcopy /E /I dist "%RT%/dist"
xcopy /E /I assets "%RT%/assets"
xcopy /E /I locale "%RT%/locale"
copy cordis.patch.yml package.json icon.svg "%RT%/"
```

（副本 3 即仓库构建产物本身。0.13.0 新增 `locale/` 与 `icon.svg`——插件管理页的本地化标题/描述/图标。）

## 2. 关键新步骤：profile patch 加预设声明行

0.1.7 **不再读取 `~/.dsh/.agent-presets/` 目录预设**。桌面是隔离布局（bffa682：插件只进 profile `dependencies`、不进 `bundles`），插件的 `cordis.patch.yml` 因此**不会应用**——预设声明行必须手工加入 profile patch：

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在现有 `strix-tools` 配置覆盖行之后，**原样追加**插件 patch 文件（`packages/strix-tools/cordis.patch.yml`）里的整个 `preset-strix` 行——从 `    # dsh 0.1.7+: one declarative preset row` 注释起、含 `disabled: !!js (...)` 守卫与完整 `config.plugins`（18 行），到文件末尾；顶部再补一行 `- insert:`。守卫保留：它探测 `@deepseek-ai/dsh-agent-preset` 包，0.1.7 运行时存在 → 行启用。

> 也可用脚本从插件 patch 文本切出该行（找 `    # dsh 0.1.7+: one declarative preset row` 标记，取到 EOF，前置 `- insert:`）——0.13.0 真机验证即用此法，字节一致。
>
> 若未来桌面改用 bundle 安装布局（插件进 bundles），则**不需要**本步骤（插件 patch 自动声明），但会回到宿主层全局挂载的提示词污染问题——不建议。

## 3. 旧目录预设处置

`~/.dsh/.agent-presets/strix/` 在 0.1.7 上不再被读取（留着无害但易误导）。**建议升级验证通过后删除**，避免"改了目录预设怎么不生效"类困惑。回滚到 0.1.6 桌面时再从仓库 `presets/strix/` 恢复。

## 4. 验证清单

1. 启动应用：**无强制更新遮罩**（构建侧第 7 补丁生效，见交接清单 §3.3）。
2. 启动日志中 `registered 16 tool modules + methodology + authorization sections + 75 skills` **恰好一次**（0.1.7 注册表 eager 挂载预设，隔离布局下注册行唯一来源是预设行；出现两次 = 插件进了 bundles，提示词污染回归）。
3. WebUI 新建会话的模式选择器里有 **strix-dsh 模式**；或用 roster 查询（presets/README.md「验证（0.1.7+）」节的 curl 两步）确认 `strix` 在列且无 `broken`。
4. 建 strix 会话发一条消息，确认工具调用正常（jobs 双方言自动选择，无需配置）。
5. 跑一条 `pwsh` 后台命令验证 0.1.7 的"持久 PowerShell 完成不再额外等待"修复；连续完成多个后台命令后会话不再卡住等输入。
6. 插件管理页确认 strix-dsh-tools 显示本地化标题/描述与图标（locale 元数据生效）。

## 5. 回滚

- 程序目录：换回 `DeepSeekHarness-016-bak` 备份。
- profile patch：删掉第 2 步追加的 `preset-strix` 行（0.1.6 不认识 `@deepseek-ai/dsh-agent-preset`，但守卫会自动禁用该行——留着也不炸 boot，清理只为干净）。
- 目录预设：从仓库 `presets/strix/` 重新拷贝到 `~/.dsh/.agent-presets/`。
- 插件副本：0.13.0 在 0.1.6 桌面上同样工作（jobs 双方言 + 守卫），无需降级；若要降回 0.12.11，按同一路径覆盖三副本即可。
