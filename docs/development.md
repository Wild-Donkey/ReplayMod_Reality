# 安装、开发与排错

## 源码启动

在项目根目录运行，依赖通过锁文件安装：

```bash
npm --prefix source ci
npm --prefix source start
```

需要 Node.js 20.19+ 或 22.12+ 与 npm。Windows PowerShell 执行策略阻止 npm 时使用 `npm.cmd`。根目录三个 `Start-*` 入口共用 `source/scripts/start/launch.cjs`，自动切换目录并在缺少启动依赖时安装；Linux 文件管理器的双击行为取决于本机设置。

macOS 原生背景模块在 Vite 主进程构建时编译，需要 Xcode Command Line Tools 与 Node.js C headers。可用 `REPLAYMOD_NODE_HEADERS` 指定 headers 目录。

已有项目本地工具链时，可在 macOS / Linux 使用：

```bash
bash source/scripts/tools/with-local-tools.sh npm --prefix source ci
bash source/scripts/tools/with-local-tools.sh npm --prefix source start
```

`.tools` 不随仓库分发，包装脚本不会自动下载其中的工具。切换电脑或系统后重新安装依赖，不复制其他平台的 node_modules。

## 检查与打包

以下命令均从项目根目录执行：

```bash
npm --prefix source run check
npm --prefix source run check:annotations
npm --prefix source run package
npm --prefix source run make
```

- `check`：类型、存储、缓存、标签布局与背景检查，不需要个人原始数据。
- `check:annotations`：JSON / KML 往返检查，需要本机 `RawData/annotations/annotations.json`。
- `package`：构建当前平台应用，产物位于根目录 `out/`。
- `make`：通过 Forge 生成当前平台配置的分发产物。打包不等于已经配置签名、公证或跨平台构建环境。

macOS 双击 `Install-MacOS.command` 会打包并安装至 `~/Applications/ReplayMod Reality.app`，更新前退出旧版。打包应用无需目标用户安装 Node.js；媒体工具和识别模型仍需按实际分发方案准备。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 启动脚本提示找不到 Node.js | 安装符合要求的 Node.js / npm，或准备本平台的 `.tools` 工具链 |
| 更新后依赖损坏或启动失败 | 在根目录重新运行 `npm --prefix source ci`，保留终端错误信息 |
| 地图未加载 | 在应用中输入或更新 MapTiler API Key，检查网络和服务访问情况 |
| 视频探测或字幕失败 | 检查 FFmpeg / FFprobe、Whisper 可执行文件和模型，见 [媒体处理](media.md) |
| 修改主进程或原生模块后效果未变 | 完全退出并重新启动应用，网页热更新不会替换原生对象 |
| 想清理缓存 | 从「缓存状态」打开实际缓存目录，退出后删除；见 [存储说明](storage.md) |

仅检查启动环境而不打开应用：`node source/scripts/start/launch.cjs --check`。
