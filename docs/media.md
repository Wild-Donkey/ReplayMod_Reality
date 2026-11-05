# 媒体处理与外部工具

## 工具准备

| 功能 | 外部依赖 |
| --- | --- |
| MP4 / MOV 探测 | PATH 中可调用的 ffprobe |
| 编码、音频提取与动态变速 | PATH 中可调用的 ffmpeg；硬件编码还依赖本机硬件与驱动 |
| 保留 DJI 私有轨的压缩 | ffmpeg、ffprobe 与 GPAC MP4Box |
| 自动字幕 | ffmpeg、whisper.cpp 的 whisper-cli 和 GGML 识别模型；VAD 模型可选 |

根目录启动流程会优先加入项目本地媒体工具目录，包括 `.tools/ffmpeg-native/bin`、`.tools/ffmpeg` 和现有 `.tools/gpac-package/tmppkg.pkg/Payload/GPAC.app/Contents/MacOS`。也可将对应工具安装到系统 PATH。应用不会自动下载媒体工具或模型。

源码工作区的语音资源按以下目录准备：

```text
.tools/whisper.cpp/
  build/bin/whisper-cli                     macOS / Linux
  build/bin/Release/whisper-cli.exe          Windows
  models/ggml-small.bin                     或 ggml-base.bin
  models/ggml-silero-v6.2.0.bin              可选 VAD
```

程序在工作目录及其上级、应用路径和可执行文件所在目录查找这些相对路径。分发应用时需验证实际放置位置，不会将开发机工具自动视为已随包提供。

## 界面操作

「载入 DJI 视频」读取 MP4 / MOV 并显示视频、音频与 DJI 元数据轨信息。「时间压缩 → 谈话类 · 字幕轨」打开字幕编辑器，可识别人声、修改字幕并保存为 JSON 和 SRT。识别在本地运行；有 VAD 模型时启用人声活动检测。

压缩、骑行姿态分析和动态变速已存在于媒体模块；完整任务配置界面尚未接入。侧栏「输出目标」等占位内容不代表可以直接创建全部任务。

## 压缩与轨道保留

普通 DJI 压缩使用两阶段流程：FFmpeg 只重编码主视频轨，MP4Box 再将新视频轨替换回原容器，逐样本保留 djmd、dbgi 私有遥测轨，以及原始音频、时间码和缩略图轨。不要用普通 FFmpeg 重封装替代该流程并假定所有 DJI 轨都被保留。

模块可探测 VideoToolbox、NVENC、Quick Sync、AMF、VAAPI 与 CPU 编码能力；实际使用取决于 FFmpeg 构建及本机可用编码器。

## 时间压缩

骑行类逻辑对 DJI 逐帧四元数进行多尺度累计旋转分析，生成随时间变化的播放倍率轨。动态变速按倍率积分重映射视频与音频，并以 60 fps 线性混合采样输出。

变速成片不会直接挂载原时长的 DJI 遥测轨。原遥测保留在源数据中，成片旁生成 `.replay.json`，其倍率轨换算到成片时间轴。遥测 sample duration 的同步重写和重新封装尚未完成。

## 透明轨迹叠加

地图工作区的叠加导出独立于上述 DJI 压缩流程，输出 VP9 WebM + Alpha，时间与轨迹保持 1:1。支持 720p / 1080p / 4K、24 / 30 / 60 fps，6 / 12 / 24 / 48 Mbps，按 1 / 5 / 10 / 30 分钟分段。统计信息与小地图可分别关闭；显示小地图时需等待地图就绪。

海拔缺失时无法提供可靠的海拔与坡度，导入字段见 [位置数据格式](data-format.md)。
