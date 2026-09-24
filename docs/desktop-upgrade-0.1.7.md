# 桌面端升级 0.1.6-alpha.2 → 0.1.7-alpha.2：插件与预设侧迁移手册

> **执行状态：已完成（2026-09-23）**——实录见文末「附录：升级实录」。
>
> 适用场景：DeepSeek Harness 桌面端（自建）升级到 dsh 0.1.7-alpha.2 运行时之后，strix-dsh-tools 0.13.0 的部署与验证。
> 桌面**构建**本身（补丁、`.env.windows`、强制更新策略第 7 补丁等）不在本文范围——见 `C:/Users/20327/Documents/dsh/DSH-0.1.7-升级交接清单.md`（2026-09-23 内核查，含补丁可打性逐条盘点）；实际落地的 6 处构建补丁已归档为 `docs/desktop-upstream-patches-0.1.7-alpha.2.diff`（0.1.6 时代旧补丁另存 `desktop-upstream-patches-0.1.6-alpha.2.diff`）。
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

## 0.1.7-rc.1 升级实录（2026-09-24 执行，全部通过）

- 构建：checkout `46a7f68b09` → 6 补丁原样重打（锚点零冲突）→ 无新孤儿目录 → 新构建根 `dsh-rc1-desktop-build`（alpha.2 产物保留在 `dsh17-desktop-build` 作回滚件）→ win-unpacked 1.2G 产出（NSIS 同款宏冲突，预期内跳过）。补丁归档 `desktop-upstream-patches-0.1.7-rc.1.diff`。
- 产物验证：version `0.1.7-rc.1`、策略键 ABSENT、appId 沿用、`dshBuildCommit=46a7f68b09`、fs-ext 在列。
- 部署：sessions 备份 → `~/.dsh-sessions-backup-20260924`；程序目录替换；三副本 0.13.1（profile + app.asar.unpacked）。
- 启动验证：**peer 强制校验静默通过**（零 disabling 告警——strix 0.13.1 五版本范围 + OV 0.5.2 天然覆盖，双双合规）；注册行恰好一次；roster 五预设含 strix 无 broken；session/create + prompt 实测整轮闭环（OV splice `kind=plugin:openviking-memory` 入账，模型 8 秒回复，20:44 实录）。

## 0.1.7-rc.1 增补（2026-09-24 核查；同日已执行，见上实录）

- **peer 兼容性强制回归（rc.1 唯一结构性变化）**：app-boot 新增 compatibility-preflight——每个 @deepseek-ai/dsh* peer 用 semver.satisfies(includePrerelease) 对照运行时版本，不满足即把插件行 disabled（profile 行与预设挂载行都查，stderr 打 `disabling profile plugin`）。豁免 = 精确 plugin@version → 精确运行时版本授权（`dsh plugin allow-version` 或插件管理页）。**strix-dsh-tools 已发 0.13.1 加 `|| 0.1.7-rc.1`**；OV memory plugin 0.5.2 的范围（>=0.1.0-rc.6 <0.2.0）天然覆盖。
- 插件面其余零 API 变化（core/jobs/approval/skill src 零 diff，cordis 4.0.4 / schemastery 3.18.4 同版）；预设注册表新增 readDocument（UI 查看预设组合，无影响）。
- **6 处构建补丁锚点全部完好**（desktop-build-paths / electron-builder-config / prepare-dsh 三文件变动在无关区域），重建 rc.1 桌面时原样重打即可；官方仍无桌面安装包（0 assets、feed 404）。
- 重建清单：checkout rc.1 → 重打 6 补丁 → 清孤儿 node_modules 目录（如有）→ `DSH_DESKTOP_BUILD_ROOT` 指工作区外新目录 → `package:desktop:win:x64:unsigned` → win-unpacked 替换 → 三副本同步 0.13.1。

## 附录：升级实录（2026-09-23 执行）

### 构建侧（dsh-upstream @ dsh-v0.1.7-alpha.2，6 处补丁）

交接清单预判的 4 处补丁全部落地，另因两个现场问题新增 2 处：

| # | 文件 | 内容 | 来源 |
|---|---|---|---|
| 1 | `apps/desktop/scripts/prepare-package-set.ts` | tar `--force-local`（1 处） | 清单 §2.3 |
| 2 | `scripts/publish-npm-baseline.ts` | tar `--force-local`（2 处） | 清单 §2.2 |
| 3 | `apps/desktop/scripts/prepare-dsh.ts` | runPnpm 代理透传 + fs-ext 声明（0.1.7 新结构重排） | 清单 §2.4 |
| 4 | `apps/desktop/scripts/electron-builder-config.mjs` | extraMetadata 删 `dshMandatoryUpdatePolicy`（第 7 补丁） | 清单 §3.3 |
| 5 | `apps/desktop/scripts/desktop-build-paths.mjs` | **新增**：`DSH_DESKTOP_BUILD_ROOT` 环境变量覆盖构建根 | 现场问题① |
| 6 | `apps/desktop/scripts/windows-directory-installer.mjs` | **新增**：前置 `!define /ifndef INSTALLER_BUILD_DIR`（走覆盖逻辑） | 现场问题① |

`.env.windows` 追加两行：`DSH_DESKTOP_NPM_REGISTRY=https://registry.npmmirror.com`（替代旧 npmmirror 代码补丁）+ `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG={"allowedAuthOrigins":["https://harness-test.deepseek.com"]}`（**0.1.7 新要求**：test 部署策略校验强制非空 allowedAuthOrigins，缺失在构建早期 throw——交接清单未覆盖此点）。

**现场问题①：`.desktop-build` 被锁**。构建失败排查中发现 asar 文件被本机 ZCode 宿主进程（工作区文件索引器）持锁，clean/删除/改名全部 EBUSY/Permission denied。解法 = 补丁 5+6：把整个构建树重定向到工作区外的 `C:/Users/20327/AppData/Local/dsh17-desktop-build`（放工作区内会被再次索引锁死）。旧 `.desktop-build` 目录留待重启后删除。

**现场问题②：孤儿 node_modules**。0.1.6→0.1.7 上游删除/改名了 12 个包（code-runtime×2、e2b×3、agent-presets、settings-file、tool-present、workflow-worker-thread、code-runtime-python、agent-team-web-profile、ui-settings-unarchive-sessions），`git checkout` 后各剩一个孤儿 `node_modules/` 目录——tsdown 的 workspace 发现按目录 glob 误认其为成员，套用根默认配置后在无 `lib/types` 处抛 `Cannot find entry`。**未来任何一次跨版本 checkout 后都要清一次孤儿目录**（判据：`packages/*/*` 下无 `package.json` 的目录）。

**NSIS 安装包未产出（有意）**：NSIS 自定义脚本链（customCheckAppRunning → installer-ui DLL）在补丁 6 后仍有宏冲突，且部署模型本就是 win-unpacked 目录替换——直接采用 electron-builder 在 NSIS 步骤**之前**已完整产出并通过校验（verifyDesktopRuntime + verifyWindowsAsarUnpack）的 `win-unpacked/`。需要安装包时再补调试。

### 部署与验证结果（全部通过）

1. 备份：sessions 41M → `~/.dsh-sessions-backup-20260923`；程序目录 1.6G → `DeepSeekHarness-016-bak`（另有 rc2 时代旧备份）。
2. 替换：win-unpacked（1.2G）→ `AppData/Local/Programs/DeepSeekHarness`；manifest 实测 `dshMandatoryUpdatePolicy` **ABSENT**、`dshDesktopAppId` 保持 `com.pengcong226.strixdh.desktop`（原地升级身份）。
3. 插件三副本：profile 副本 + runtime 副本（新布局在 `resources/app.asar.unpacked/dsh/node_modules/`——0.1.7 的 JS 包全在 asar 内，unpacked 区只放原生模块，fs-ext 在列=补丁 3 生效）均为 0.13.0。
4. profile patch 预设行：`preset-strix` 声明行（含守卫）已加入 `~/.dsh/profiles/desktop/cordis.patch.yml` 并经 YAML 解析验证（18 行 plugins + 守卫）。
5. 启动验证：**注册行恰好一次**（`registered 16 tool modules + methodology + authorization sections + 75 skills`）；渲染层 `dsh-desktop:mandatory-status` 无 handler 报错=无策略=**无遮罩**（补丁 4 生效）；`settings.yaml` 已改名 `.imported`（一次性导入完成）；用户既有会话自动迁移 **V4** 并可继续对话。
6. roster 实测（web API `agentPresets/list`）：`standard(default) / ptc / minimal / cordis / strix(strix-dsh 模式)` 全部 ok 无 broken。
7. `session/create agentPreset=strix` 在桌面端成功（sessionId 返回，预设真实可组合）。
8. 旧目录预设 `~/.dsh/.agent-presets/strix/` 已删除（0.1.7 不读取；回滚 0.1.6 时从仓库 `presets/strix/` 恢复）。

### 遗留与回滚

- 旧 `.desktop-build`（锁死）与新构建根 `C:/Users/20327/AppData/Local/dsh17-desktop-build`（含 win-unpacked 成品）并存；前者重启后可删。
- 回滚：程序目录换回 `DeepSeekHarness-016-bak`；profile patch 的 `preset-strix` 行留着即可（守卫在 0.1.6 上自动禁用）；目录预设从仓库恢复；插件无需降级（0.13.0 双兼容）。

### 升级后事故（2026-09-23 晚，已修复）：发消息全败 "format v4 message requires a producer-owned source kind"

**根因**：`@openviking/dsh-memory-plugin@0.3.2`（第三方，profile bundles 全局挂载）注入 openviking-context 用户消息用的 `source: { kind: "plugin", ... }` 是 V4 明令拒绝的"退役包装"（V4 校验：source.kind 必须非空且 ≠ 'plugin'，未知 kind 予以保留）。每个会话每轮都注入 → 换会话换模型全部失败。这正是交接清单第 4/5 条"插件需适配"点名 @openviking 插件要查而升级时只核了 strix 侧的原因——strix-dsh-tools 不自产用户消息（approval.request 走宿主管道）故不受影响。

**修复**（就地补丁 profile node_modules 副本，4 处）：`runtime.mjs` 的 `pluginMessage()` 改 `kind: "openviking-memory"`（producer-owned，plugin/form 字段保留）；`runtime.mjs` `isStartupProfile()` 检测同步改；`capture.mjs` 的捕获白名单跳过与 `promptText()` 过滤同步改（防插件自采自建回环）。**注意：该修复只存在于已安装副本——插件源码仓库需同步此改动，否则下次更新/重装即回退。**

**验证**：重启后向 strix 测试会话实发一条消息——prompt 接受 → 插件注入两条 `kind=openviking-memory` 消息成功入账 V4 日志（seq 12/13）→ request 构建 → 模型回复 → turn/end 完整闭环（20:37–20:39 实录）。

**后续（同日晚）**：上游当天已发布 `@openviking/dsh-memory-plugin@0.5.2`（09-23 10:08 UTC，0.4.3→0.5.2 四连发），官方修复与本补丁同思路——kind 改为 `plugin:openviking-memory`（producer-owned），并对旧 `plugin` kind 双兼容。已升级到官方 0.5.2（外科手术式替换 profile node_modules 副本 + manifest 改 `^0.5.2`；**勿在 profile 目录跑全量 install**——manifest 里 strix-dsh-tools 仍写 0.12.11 而 0.13.0 未发 npm，全量安装会用 npm 旧版覆盖本地副本），实测 `kind=plugin:openviking-memory` 入账 + 整轮闭环（20:47 实录）。本地临时补丁已被官方版取代。
