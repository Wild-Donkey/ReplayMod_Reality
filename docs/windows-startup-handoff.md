# Windows 启动修复交接

## 本次改动

根目录的 `Start-Windows.cmd` 最终都会调用 `source/scripts/start/launch.cjs`。启动器现在会：

1. 缺少 npm 依赖时执行 `npm ci`。
2. 检查 Electron 的实际可执行文件，而不只是检查 Electron 的 npm 包目录。
3. 如果 npm 安装了 Electron 包但没有运行安装脚本，下载当前 Windows 架构的 Electron 压缩包，并用系统自带的 `tar.exe` 解压运行时。

因此不需要在 Windows 上手动执行 `npm install-scripts approve electron`。

## Windows 验证步骤

在项目根目录打开 PowerShell，执行：

```powershell
.\Start-Windows.cmd --check
.\Start-Windows.cmd
```

首次启动需要网络。正常情况下，终端会先显示：

```text
Electron runtime is missing; downloading it for this computer (network required)...
```

下载完成后应继续出现 Electron Forge 的构建日志并打开应用。再次执行 `--check` 时应显示：

```text
Startup prerequisites found.
```

## 模拟 Electron 运行时缺失

为了验证自动补齐逻辑，可以在确认应用和所有开发进程都已退出后，临时移走：

```text
source\node_modules\electron\dist
```

然后再次执行：

```powershell
.\Start-Windows.cmd
```

启动器应重新下载 Electron，并正常启动。验证结束后不需要手动恢复该目录；下载器会重新生成它。

## 失败时请回传

请保留 PowerShell 中从 `ReplayMod Reality | ...` 开始的完整输出，并附上：

```text
%APPDATA%\ReplayMod Reality\desktop-start.log
```

重点确认错误是否仍然包含 `electron\path.txt`、`electron.exe` 或网络下载失败信息。

## 可直接交给 Windows 环境执行的提示词

> 请在项目根目录验证 ReplayMod Reality 的 Windows 启动流程。先运行 `.\Start-Windows.cmd --check`，再运行 `.\Start-Windows.cmd`。重点验证：当 `source\node_modules\electron\dist\electron.exe` 缺失时，启动器是否自动调用 Electron 的安装脚本下载运行时并成功打开应用；不要手动批准 npm 安装脚本，也不要删除整个 `node_modules`。如果失败，请保留完整 PowerShell 输出和 `%APPDATA%\ReplayMod Reality\desktop-start.log`，并报告失败发生在依赖安装、Electron 下载、Forge 构建还是应用启动阶段。
