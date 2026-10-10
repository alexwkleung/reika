# 平台与要求

> 本页是[英文页面](../platforms.md)的简体中文译文。英文为准，译文可能滞后。

[← README](../../README.md)

## 要求

Node.js 22 或更新版本。操作系统的最低版本要求由 Node 决定，而不是 Reika：

| 操作系统 | 最低要求                                            |
| -------- | --------------------------------------------------- |
| macOS    | 11（Big Sur）                                       |
| Linux    | glibc 2.28 或更新版本，通常适用于 2018 年起的发行版 |
| Windows  | 10，通过 WSL 运行（见 [Windows](#windows)）         |

Reika 本身很轻量：它是一个向模型服务器发送请求的终端界面，因此自身的 CPU 和内存占用远小于模型。机器需要什么配置才能运行**模型**，取决于模型服务器，而不是 Reika。

## 在性能较弱的机器上运行

Reika 只与兼容 OpenAI 的接口通信，因此模型不必在运行 Reika 的机器上运行。旧笔记本也可以运行 Reika，并连接：

- 同一网络中性能更强机器上的模型服务器（llama.cpp、Ollama、vLLM、LM Studio，或任何提供 `/v1/chat/completions` 的服务）
- 托管 API

将 `REIKA_BASE_URL` 指向该服务（见[配置](../configuration.md)）。Reika 在本地进行的所有操作，包括读写文件、运行命令和管理上下文，都留在你正在使用的机器上，只有请求会通过网络传输。

## 平台之间有哪些差异

下表之外的功能在各平台上的行为一致。

| 功能                            | macOS                  | Linux                                                | Windows（WSL）                                       |
| ------------------------------- | ---------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| 命令沙箱（`REIKA_SANDBOX`）     | 默认开启               | 不可用，命令在无沙箱约束的环境中运行                 | 不可用，命令在无沙箱约束的环境中运行                 |
| 通过 Chrome 进行网页搜索        | 检测到 Chrome 时开启   | 默认关闭，使用 `REIKA_CDP_SEARCH=1` 开启             | 默认关闭，使用 `REIKA_CDP_SEARCH=1` 开启             |
| 从剪贴板粘贴图像（ctrl-v）      | 支持                   | 不支持                                               | 不支持                                               |
| 通过路径附加图像（`@shot.png`） | 支持，默认使用系统 OCR | 需设置 `REIKA_VISION_MODEL` 或 `REIKA_VISION=native` | 需设置 `REIKA_VISION_MODEL` 或 `REIKA_VISION=native` |

**沙箱。** 使用 macOS 自带的 `sandbox-exec`。在 Linux 上，承担同样任务的工具无法让沙箱中的命令连接同一机器上的模型服务器，因此目前没有沙箱。审批提示在所有平台上的行为一致：默认 `REIKA_AUTO_APPROVE=safe` 下，危险命令仍会先询问。参见[配置](../configuration.md)中的 `REIKA_SANDBOX`。

**Chrome 搜索。** 在 macOS 以外的平台，启动 Chrome 会打开可见窗口并夺取焦点，因此需要你主动开启。Reika 会在常见安装路径中查找 Chrome 或 Chromium；`REIKA_CHROME_PATH` 可指向其他二进制文件。

**图像。** Reika 自行读取剪贴板，目前仅支持 macOS 和 Windows 的剪贴板读取；WSL 按 Linux 处理。只要有组件能够读取图像，通过路径附加图像就能在各平台工作：在这里列出的平台中，内置 OCR 仅随 macOS 版本提供；Linux 上需要 `REIKA_VISION_MODEL`（由视觉模型将图像描述为文本）或 `REIKA_VISION=native`（主模型本身能看图）。参见[配置](../configuration.md)。

## Windows

在 WSL 内运行 Reika。`bash` 工具通过 `/bin/sh` 运行命令，并通过向整个进程组发送信号来停止卡住的命令。这两种机制都属于 Unix，因此不支持直接在 Windows 上运行 Reika。

## 终端

能运行全屏程序的终端都可使用。较旧或不常见的终端有几项需要注意：

- **颜色**会自动降级到终端声明的支持范围。SSH 会话可能继承连接来源机器的 `COLORTERM` 或 `TERM_PROGRAM`，从而声明比实际支持的更多颜色。`FORCE_COLOR=1` 将颜色数量固定为 16。使用 16 色时，Reika 会切换到由命名颜色组成的调色板，因为其通常使用的浅色几乎都会变成白色。
- **字形。** Linux 控制台的字体缺少 Reika 使用的一些符号（工具调用圆点、盲文字符转圈动画、圆角边框）。在 `TERM=linux` 或 `vt*` 下，它会改用这些字体包含的简单符号。`REIKA_BASIC_GLYPHS=1` 为未被检测出的终端（例如旧 Windows 控制台字体）强制开启此行为，`0` 则关闭（见[配置](../configuration.md)）。
- **闪烁。** Reika 会请求终端一次性绘制完整的一帧。不支持的终端会忽略该请求；如果终端反而表现异常，`REIKA_SYNC_OUTPUT=0` 可关闭此功能。
- **没有终端。** 在脚本、CI 和管道中，使用无界面模式（`reika -p`，见[使用](../usage.md#headless-mode)）。
