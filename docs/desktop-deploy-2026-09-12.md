# dsh 桌面端 Windows 构建与部署实录（2026-09-12）

> 背景：上游 deepseek-harness 0.1.5-rc.2 新增 Electron 桌面端（`apps/desktop`），但**官方未发布任何安装包**（Releases 全空）。本文记录在 Windows 上从源码构建、部署、并装入 strix-dsh-tools 的完整过程，含上游三个 Windows 兼容缺陷的修复。
>
> 构建环境：Windows 10 x64 / Node 24.19 / pnpm 11.7 / VS Build Tools 2022（C++ 工作负载）/ 本地代理 127.0.0.1:7897（Clash）。

## 一、构建命令

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh-upstream
cd dsh-upstream
pnpm install --frozen-lockfile

# 必须走 pnpm run（脚本靠 npm_execpath 定位 pnpm；npx 直跑会把 pnpm 参数喂给 npm）
export DSH_DESKTOP_APP_ID=com.pengcong226.strixdh.desktop   # electron-builder 必填
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=$https_proxy   # 原生模块下载需要
export ELECTRON_GET_USE_PROXY=true GLOBAL_AGENT_HTTPS_PROXY=$https_proxy

pnpm run package:desktop:win:x64:unsigned
# 产物：apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/（~615MB）
```

## 二、上游三个 Windows 兼容缺陷（已修复，补丁在 dsh-upstream 工作区未提交）

| # | 缺陷 | 现象 | 修复（文件） |
|---|---|---|---|
| 1 | GNU tar 把 `C:\...` 路径解析成远程主机（host:file），列 tarball 内容必失败 | `tar -tzf C:\...tgz` 报 "Cannot connect to C: resolve failed" | 三处调用加 `--force-local`：`scripts/release/tarball.ts`、`apps/desktop/scripts/prepare-package-set.ts`、`scripts/publish-npm-baseline.ts` |
| 2 | `prepare-dsh.ts` 启动内置 pnpm 时剥离所有 `npm_*/pnpm_*` 环境变量，代理变量也被剥掉；代理网络下原生模块（sharp/koffi/node-pty/fs-ext）静默下载失败，payload 缺模块 | smoke 报 `Cannot find module 'fs-ext'`（首次误诊为坑3） | `prepare-dsh.ts` 补代理变量白名单透传（https_proxy/HTTPS_PROXY/ALL_PROXY/NO_PROXY 等） |
| 3 | `runtime-payload-smoke.mjs` require `fs-ext`，但 0.1.5-rc.2 的 241 包依赖闭包**无任何包声明它**（已逐 tarball 核实），lockfile 解析结果不含它，payload 必缺 | 代理修好后 smoke 仍报 `Cannot find module 'fs-ext'` | `prepare-dsh.ts` 在 runtime project manifest 里补 `fs-ext: ^2.1.1` 声明 |

另两个环境问题（非上游缺陷）：本机无 C++ 编译器 → winget 装 VS Build Tools 2022（`--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`）；electron-builder 要求 `DSH_DESKTOP_APP_ID` 反向域名 ID。

## 三、插件安装（关键：不能跑 pnpm）

桌面端 profile（`~/.dsh/profiles/desktop`）中 200+ 个 `@deepseek-ai/*` 共享包是**指向应用资源目录的 junction**（`resources/dsh/node_modules/...`）。在 profile 里跑任何 pnpm/npm install（hoisted 模式）会重排 node_modules，把 junction 全部覆盖为普通目录 → 后端启动报 `refusing to replace unowned package @deepseek-ai/cordis`，拒绝启动。

正确安装方式（手动放置 + 元数据登记）：

```bash
# 应用必须先关闭（包事务独占 profile 锁）
taskkill /F /IM "DeepSeek Harness.exe"

# 1. 拷贝插件本体（dist/assets/patch/package.json 四件，不跑 pnpm）
mkdir -p ~/.dsh/profiles/desktop/node_modules/strix-dsh-tools
cp -r packages/strix-tools/{dist,assets,cordis.patch.yml,package.json} \
      ~/.dsh/profiles/desktop/node_modules/strix-dsh-tools/

# 2. 登记：package.json 的 dependencies + dsh.profile.bundles 各加一行
#    "strix-dsh-tools": "0.12.2"
#    bundles: [..., "strix-dsh-tools"]

# 3. 重启应用；验证 junction 未动：
fsutil reparsepoint query %USERPROFILE%\.dsh\profiles\desktop\node_modules\@deepseek-ai\cordis
# → 0xa0000003 (mount point) 即完好
```

若已跑过 pnpm 把 profile 弄坏：删掉整个 `~/.dsh/profiles/desktop`，应用启动时自动重建（junction 恢复正确），再按上述方式装插件。

## 四、验证清单

- 应用进程：4 个 `DeepSeek Harness.exe`（主/渲染/GPU/内置 Node 后端）
- 后端监听：`netstat` 127.0.0.1 上 ~21 个端口
- 插件加载（用应用内置 node 在 profile 目录下）：
  `import('strix-dsh-tools')` → name/inject 五服务正常
- CLI 不能直接访问 desktop profile（`--profile desktop` 被拒，设计行为）；验证组合时复制为 `desktop-verify` 跑 `--dump-config`，确认 `strix-tools` 行在
- 桌面端与 CLI 共享 `~/.dsh` 的会话/凭据/strix-workspace，但 profile/插件/node_modules 完全隔离

## 五、部署位置

- 应用：`C:\Users\20327\AppData\Local\Programs\DeepSeekHarness\`（615MB 便携版）
- 快捷方式：桌面 `DeepSeek Harness.lnk`
- 插件：`~/.dsh/profiles/desktop/node_modules/strix-dsh-tools/`（0.12.2）
- App ID：`com.pengcong226.strixdh.desktop`

## 六、后续

- 上游修复 Windows 打包链后（本文坑 1-3），可改用官方安装包；届时插件安装仍按 §三 手动方式
- 三个上游补丁建议整理成 PR 提交 deepseek-harness（tar --force-local / 代理透传 / fs-ext 声明）
- 插件更新流程：关应用 → 覆盖 `node_modules/strix-dsh-tools/` 的 dist/assets/package.json → 开应用；**永远不要在 desktop profile 里跑 pnpm/npm**
