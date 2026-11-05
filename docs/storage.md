# 本地存储、缓存与恢复


可清理的缓存使用系统缓存目录，右侧「缓存状态 → 本地自动缓存 · 打开目录」可直接查看实际位置：macOS 为 `~/Library/Caches/ReplayMod Reality/`，Windows 为 `%LOCALAPPDATA%/ReplayMod Reality/Cache/`，Linux 为 `$XDG_CACHE_HOME/ReplayMod Reality/`（默认 `~/.cache/ReplayMod Reality/`）。

- `snapshots-v1/`：可重新解析的轨迹快照，按源文件路径、大小和修改时间匹配。
- `maps-v1/`：MapTiler 样式、瓦片、字体和图标，缓存有效期 7 天，网络失败时回退到已有缓存。
- `browser/http/`：Chromium HTTP 缓存，预算为 512 MiB。

需要保留的数据独立存放在应用数据目录（macOS 为 `~/Library/Application Support/ReplayMod Reality/`）：`config.json` 是唯一配置文件，保存 API key；`state-v1/` 保存工作区、最近轨迹及视频信息；`annotations.json` 保存地图标注。所有启动方式共享这些固定路径。界面只通过主进程接口读写，不使用 localStorage、网页来源或构建环境变量保存配置。浏览器自身的临时会话数据位于系统缓存目录的 `browser/session/`。

配置存在时不会回退到旧文件；损坏配置会提示错误并保留原文件。
工作区修改后延迟 500 毫秒写入，正常关闭时立即补存。恢复地图视角、时间线、导出区间、标注与字幕草稿。升级时从旧 `Application Support/ReplayMod Reality/cache/snapshots-v1/` 复制持久状态，旧文件保留。
快照通过临时文件和原子重命名保存，轨迹二进制快照保留缺失海拔的 `NaN`。缺失或损坏的缓存会按未命中处理。视频文件保留在原位置，不复制视频内容；恢复时会检查源文件是否仍存在。运行中的识别和视频编码任务不会在重启后自动继续，但已进入工作区的字幕结果和导出设置会保留。缓存包含位置与字幕等个人数据，仅保存在本机。

可以退出应用后删除系统缓存目录以重置缓存；API key、工作区和标注位于独立应用数据目录，不受影响。
