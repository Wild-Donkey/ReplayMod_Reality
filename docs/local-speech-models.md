# 本地语音模型

应用提供编辑器、FFmpeg 接入、Python / MLX 推理环境和模型管理，不在发行包内分发模型权重。新安装没有模型，也没有默认模型选择。现有用户已经下载的文件保留，通过刷新列出。

## 来源与文件格式

原模型由 [Qwen](https://github.com/QwenLM/Qwen3-ASR) 发布。当前推理后端使用 Apple Silicon 的 MLX，因此下载的是 `mlx-community` 转换的 MLX 模型，不能直接使用原始 PyTorch 权重。

| 用途 | 下载源 | 全部文件约占空间 |
| --- | --- | --- |
| 较小的 ASR | [Qwen3-ASR-0.6B-8bit](https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-8bit) | 1.01 GB |
| 较大的 ASR | [Qwen3-ASR-1.7B-8bit](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit) | 2.47 GB |
| 词 / 字时间对齐 | [Qwen3-ForcedAligner-0.6B-8bit](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit) | 1.28 GB |

具体版本、逐文件大小和大权重的 SHA-256 保存在 [models.json](../source/resources/speech/models.json)。内置下载使用清单中的固定 commit，不跟随 `main` 自动更新。界面同时显示仓库链接、版本、目标目录和可复制的手动下载命令。以上是内置下载列表；手动添加的兼容量化 MLX Qwen3 ASR / ForcedAligner 文件夹不要求来自这个列表。

## 目录与手动安装

macOS 发行包的默认根目录：

```text
~/Library/Application Support/ReplayMod Reality/local-speech/models/
  Qwen3-ASR-1.7B-8bit/
    config.json
    tokenizer_config.json
    preprocessor_config.json
    vocab.json
    merges.txt
    model.safetensors.index.json
    model.safetensors
    ...其他仓库文件
  Qwen3-ForcedAligner-0.6B-8bit/
    ...同样保留整个模型仓库的文件
```

开发环境的根目录是仓库内 `.tools/qwen/models/`。界面的「打开模型目录」可直接打开实际位置。

下载整个模型仓库的文件并保留文件名。可使用浏览器、`curl` / `wget`、Hugging Face CLI 或自己的下载工具。例如：

```bash
hf download mlx-community/Qwen3-ASR-1.7B-8bit \
  --revision a8379a2e2f9e313c9292cdf1af4055ab56d50d55 \
  --local-dir "$HOME/Library/Application Support/ReplayMod Reality/local-speech/models/Qwen3-ASR-1.7B-8bit"

hf download mlx-community/Qwen3-ForcedAligner-0.6B-8bit \
  --revision 0e1a68e91d815300c7c9754b2a7639378b23db15 \
  --local-dir "$HOME/Library/Application Support/ReplayMod Reality/local-speech/models/Qwen3-ForcedAligner-0.6B-8bit"
```

直接文件链接的形式为 `https://huggingface.co/<repository>/resolve/<revision>/<filename>`，其中各字段均在公开清单中。Git LFS 指针不是权重本体；需要下载真实 `.safetensors` 文件。

放好后点击「刷新本地模型」，在 ASR 和对齐模型的下拉框中分别选择。也可以保留模型在任意目录，用「添加已有模型文件夹」指向包含 `config.json` 的那一级目录。这个操作登记路径，不复制或转换文件；下载完成也不会代替用户选择模型。

## 分层

1. **推理运行环境**：发行包内的 Python 3.11、MLX、mlx-audio 和依赖。打包时由 `bundle-runtime.cjs` 生成独立可迁移目录；不包含模型。开发者的 `npm run setup:speech` 只准备环境，不下载模型。
2. **文件下载**：`download.cjs` 读取公开清单，执行 HTTPS GET，使用 `.part` 暂存、Range 续传、文件大小及权重 SHA-256 校验，最后重命名为正式文件。无需 Python，不加载模型，不转换权重，不写“已安装”回执。
3. **文件发现与选择**：扫描模型目录与登记的外部路径，检查配置、词表、索引、权重头及实际长度。未完成文件、Git LFS 指针、缺失分片不进入可用列表。选择保存在 `local-speech/selection.json`，与下载方式无关。
4. **离线推理**：只接收已选择模型的本地路径，设置 `HF_HUB_OFFLINE=1` 和 `TRANSFORMERS_OFFLINE=1`。ASR 转写文字，再由 ForcedAligner 标出时间；不会在识别过程中联网寻找或下载模型。

切换模型会释放旧工作进程并清空转写缓存；推理进行中不允许切换。替换同一路径下的模型文件也会使缓存失效。空闲三分钟后释放模型内存。ASR 错字和对齐误差仍可通过试听、校对与手动切点处理。

## 开发验证

```bash
cd source
npm run setup:speech       # 仅开发/构建机器安装运行环境
npm run check:local-speech # 文件发现、选择、传输、协议测试
npm run check:audio-editor # token 编辑器及模型管理 UI 测试
npm run package           # 打包钩子带入运行环境，不带入模型
```

模型管理和推理目前面向 Apple Silicon macOS。生成的环境与权重均放在 Git 忽略目录；代码、下载清单及依赖声明随源码提供。
