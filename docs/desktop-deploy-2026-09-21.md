# dsh 桌面端 0.1.6-alpha.2 Windows 构建与部署实录（2026-09-21）

> 续篇：rc.2 的构建见 `desktop-deploy-2026-09-12.md`（四个 Windows 补丁、代理环境、VS Build Tools 前置条件均沿用）。本文只记 alpha.2 的**增量**：三个新坑与修复、新运行时架构对插件安装的影响。
> 构建环境同 09-12：Windows 10 x64 / Node 24.19 / pnpm 11.7 / VS Build Tools 2022 / 代理 127.0.0.1:7897。

## 一、alpha.2 新增的三个构建坑（均已修复）

| # | 坑 | 现象 | 修复 |
|---|---|---|---|
| 1 | 打包配置改为**只认 `.env.windows` 文件**（release 设置不再从环境变量回退） | `desktop package: cannot read ...\.env.windows; copy ...example and fill in` | 从 `.env.windows.example` 复制，`DSH_DESKTOP_APP_ID=com.pengcong226.strixdh.desktop`（沿用，保证原地升级），`AUTO_UPDATE_ENV=test` + 两个官方 update origin 默认值，签名字段留空（unsigned） |
| 2 | Node 24 头文件的 `common.gypi` 引用 `enable_thin_lto`/`enable_lto` 但未声明默认值，第三方 addon 编译（fs-ext）直接 gyp 报错 | `gyp: name 'enable_thin_lto' is not defined while evaluating condition ... in binding.gyp` | 给 node-gyp 缓存补默认值：`%LOCALAPPDATA%\node-gyp\Cache\24.18.1\include\node\common.gypi` 的 variables 段加 `'enable_lto%': '0'` 与 `'enable_thin_lto%': '0'`（`enable_pgo_*` 已有声明，这两个漏了）。缓存被清后需重打 |
| 3 | alpha.2 桌面**强制要求 LibreOffice 引擎**（Office 预览功能的依赖，`libreoffice-kit-win32-x64` 340MB optional 依赖）；本地代理下载 340MB 大包失败（curl error 23），pnpm **静默跳过失败的 optional 依赖**，安装"成功"但引擎缺失 | `desktop runtime: missing required LibreOffice engine win32-x64` | `prepare-dsh.ts` 的 payload 安装加 `--registry=https://registry.npmmirror.com`（本地实测 2.2MB/s，lockfile integrity 哈希仍然把关）。此为第 5 个本地构建补丁 |

09-12 的四个补丁（tar `--force-local` ×3、prepare-dsh 代理透传 + fs-ext 声明）在 alpha.2 **全部仍然需要**（上游均未修复），`git apply` 干净重放。

## 二、构建命令（与 09-12 相同 + .env.windows）

```bash
cd dsh-upstream && git checkout dsh-v0.1.6-alpha.2
git apply dsh-win-patches.diff          # 4 个旧补丁
# + 手动给 prepare-dsh.ts 的 payload install 加 --registry=npmmirror（见上表 #3）
pnpm install --frozen-lockfile
cp apps/desktop/.env.windows.example apps/desktop/.env.windows   # 按上表 #1 填写
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=$https_proxy
export ELECTRON_GET_USE_PROXY=true GLOBAL_AGENT_HTTPS_PROXY=$https_proxy
pnpm run package:desktop:win:x64:unsigned
# 产物：apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/（1.2GB，含 LibreOffice）
```

## 三、部署与插件安装（架构变了）

**新运行时架构**：alpha.2 桌面 `resources/` 不再有 `dsh/node_modules`（rc.2 的 241 个 junction 包布局），改为 `resources/runtime` + **运行时 moduleFallback 解析**——插件 bare import 由宿主 BFS 链接到自带副本，**不再有 peer 版本硬校验**（`validateDesktopPluginGraph` 已删除）。旧 profile 里的 junction 会被新启动逻辑清掉，属预期而非损坏。

**CLI 对桌面 profile 关闭**：`dsh plugin --profile desktop add ...` 报 `profile "desktop" is managed exclusively by the Electron application`——桌面 profile 只归应用管，插件安装通道是应用内的**插件管理页**（安装/改配置/实时启停）。

**本次实际安装方式**（管理页是 UI 通道，无法无头驱动，沿用四件套手动放置）：

```bash
taskkill /F /IM "DeepSeek Harness.exe"
cd strix-dsh/packages/strix-tools && npm run build
DST=~/.dsh/profiles/desktop/node_modules/strix-dsh-tools
rm -rf "$DST/dist" "$DST/assets" && cp -r dist assets cordis.patch.yml package.json "$DST/"
# ~/.dsh/profiles/desktop/package.json 的 dependencies 版本号同步改 0.12.10
```

## 四、验证结果

- 新桌面（0.1.6-alpha.2）启动正常（Electron 多进程 + web UI 动态端口）
- **strix-dsh-tools 0.12.10 注册行完整**：`registered 16 tool modules + methodology + authorization sections + 75 skills`
- 旧 rc.2 安装备份在 `AppData\Local\Programs\DeepSeekHarness-rc2-bak`（确认稳定后可删，或改名回来即回滚）
- CLI 宿主验证见 DEVELOPMENT.md 0.12.10 行（`npx dsh@0.1.6-alpha.2 --profile strix web` 同样注册行完整）

## 五、遗留观察

- 插件管理页（UI）装插件/实时启停/运行时卸载的实测留给日常使用验证——release notes 点名插件开发者检查卸载逻辑，本插件模块级零资源持有，风险面为零
- peer 版本门槛从「宿主强制」变为「纯自律」：装错版本的插件不再被拒载而是直接跑，peer 范围的准确性责任转移到插件维护者（我们保留显式枚举）
