# 安装、开发与排错

## 源码启动

在项目根目录运行，依赖通过锁文件安装：

```bash
npm --prefix source ci
npm --prefix source start
```

需要 Node.js 20.19+ 或 22.12+ 与 npm。Windows PowerShell 执行策略阻止 npm 时使用 `npm.cmd`。根目录三个 `Start-*` 入口共用 `source/scripts/start/launch.cjs`，自动切换目录、安装缺少的启动依赖，并验证 Electron 的实际运行文件；若 npm 安装了 Electron 包但跳过了其安装脚本，启动器会下载 Electron 压缩包并用系统解压工具展开运行时。macOS/Linux 需要 `unzip`，Windows 使用系统自带的 `tar.exe`。Linux 文件管理器的双击行为取决于本机设置。

macOS 原生背景模块在 Vite 主进程构建时编译，需要 Xcode Command Line Tools 与 Node.js C headers。可用 `REPLAYMOD_NODE_HEADERS` 指定 headers 目录。

已有项目本地工具链时，可在 macOS / Linux 使用：

```bash
bash source/scripts/tools/with-local-tools.sh npm --prefix source ci
bash source/scripts/tools/with-local-tools.sh npm --prefix source start
```

`.tools` 不随仓库分发，包装脚本不会自动下载其中的工具。切换电脑或系统后重新安装依赖，不复制其他平台的 node_modules。

关闭最后一个窗口会退出应用并结束开发启动命令。也可在启动终端按 Ctrl+C。退出时会取消进行中的导出和语音任务，并等待缓存写入。开发启动日志保存在应用数据目录的 `desktop-start.log`。

## Windows

在项目根目录双击 `Start-Windows.cmd`，或用 PowerShell 执行：

```powershell
.\Start-Windows.cmd --check
.\Start-Windows.cmd
npm.cmd --prefix source run package
npm.cmd --prefix source run make
```

Windows 开启「使用 HDR」后，源码版会根据窗口所在屏幕的 DXGI 峰值亮度和系统 SDR 白亮度计算 HDR 余量。首次构建检测程序需要 PATH 中的 MinGW-w64 `gcc.exe`，启动脚本会自动编译。缺少编译器时应用仍可按 SDR 亮度启动。

`package` 生成可直接运行的应用目录。`make` 在 `source/out/make/` 生成 Squirrel 安装器和便携 ZIP。启动日志位于 `%APPDATA%\ReplayMod Reality\desktop-start.log`。

视频工具可以放进 PATH，也可放进项目根目录或应用 EXE 旁的 `.tools`。在 `.tools/ffmpeg/bin` 或 `.tools/ffmpeg` 中放置 `ffmpeg.exe` 和 `ffprobe.exe`。在 `.tools/exiftool` 中放置 `exiftool.exe` 和随包的 `exiftool_files`。在 `.tools/gpac` 中放置 GPAC 的 `MP4Box.exe` 及其依赖。透明 WebM 导出需要包含 `libvpx-vp9` 的 FFmpeg。本地 Qwen 语音识别依赖 Apple Silicon 上的 MLX 后端。

## 检查与打包

以下命令均从项目根目录执行：

```bash
npm --prefix source run check
npm --prefix source run check:shutdown
npm --prefix source run check:annotations
npm --prefix source run check:export:encoder
npm --prefix source run check:picking:gpu
npm --prefix source run package
npm --prefix source run make
```

- `check`：类型、存储、缓存、标注、时间轴、天文、渲染、地形和飞行检查。标注检查使用下述本地样本。
- `check:shutdown`：验证子进程退出。在 macOS 和 Linux 图形会话中，还会用临时配置启动真实应用，验证关窗、Ctrl+C、超时兜底及进程回收。运行前请退出已有的开发实例。
- `check:annotations`：JSON / KML 往返检查，需要本机 `RawData/annotations/annotations.json`。
- `check:media-alignment`：视频时间字段、时间码、备份与 GPS 运动处理检查。
- `check:audio-edit`：声音 token 编排、时间范围、PCM 拼接与字幕时间检查。
- `check:local-speech`：推理进程协议、模型发现、选择、断点下载和文件完整性检查。
- `check:export:layout`：独立 Electron 窗口检查生产 CSS 下 720p／1080p／4K 导出画布尺寸与清理，需要图形会话。
- `check:export:encoder`：实际编码并解码透明 VP9，检查帧数、帧率、Alpha、分段、取消与文件保护；需要支持 `libvpx-vp9` 的 FFmpeg 和 FFprobe，不启动 Electron。
- `check:picking:gpu`：独立 Electron 窗口验证 18 万点拾取、DPR 1/2/3、可见标注与曲线、背景交接、图层隐藏恢复和离屏尺寸；需要可正常启动 Electron 与 WebGL2 的图形会话，无法由普通类型检查代替。
- `package`：构建当前平台应用，产物位于根目录 `out/`。
- `make`：通过 Forge 生成当前平台配置的分发产物。打包不等于已经配置签名、公证或跨平台构建环境。

macOS 双击 `Install-MacOS.command` 会打包并安装至 `~/Applications/ReplayMod Reality.app`，更新前退出旧版。打包应用无需目标用户安装 Node.js；媒体工具和识别模型仍需按实际分发方案准备。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 启动脚本提示找不到 Node.js | 安装符合要求的 Node.js / npm，或准备本平台的 `.tools` 工具链 |
| 更新后依赖损坏或启动失败 | 重新运行根目录的 `Start-*` 入口；它会检查并补齐 Electron 运行时。若仍失败，再在根目录运行 `npm --prefix source ci` 并保留终端错误信息 |
| 地图未加载 | 在应用中输入或更新 MapTiler API Key，检查网络和服务访问情况 |
| 视频探测或字幕失败 | 检查 FFmpeg / FFprobe、本地语音环境及已选择的 ASR／对齐模型，见 [媒体处理](media.md) |
| 修改主进程或原生模块后效果未变 | 完全退出并重新启动应用，网页热更新不会替换原生对象 |
| 想清理缓存 | 从「设置」打开实际缓存目录，退出后删除；见 [存储说明](storage.md) |

仅检查启动环境而不打开应用：`node source/scripts/start/launch.cjs --check`。
