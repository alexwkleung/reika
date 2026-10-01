<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reika-dark.svg">
    <img alt="Reika" src="docs/assets/reika-light.svg" width="262">
  </picture>
</p>

<p align="center">
  面向小型本地模型的编码代理 CLI，为低量化场景调优，<br>
  专注于上下文纪律与能力对齐。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档">文档</a> ·
  <a href="docs/models.md">测试过的模型</a> ·
  <a href="README.md">English</a>
</p>

![Reika 用本地模型修复一个重试辅助函数及其测试](docs/demo.gif)

<sup>一次真实的本地运行：Qwen3.6 35B A3B（Unsloth UD-IQ2_M）经 llama.cpp，加速 3×。模型的第一次测试失败，它根据报错修好了。</sup>

大多数编码代理是为主流前沿模型打造的。Reika 首先面向你自己能跑起来的模型：8B–35B，通常处于 Q2–Q4，跑在 16–32k 上下文窗口的笔记本上。目标是让这些模型变得**可用**，而不是更聪明。框架抬不高模型的上限，但可以阻止它浪费窗口、在同一个读取上反复打转，或者悄悄弄丢自己的任务。

8–9B 模型在简单任务上能站得住；14–35B 是小模型做代理编码的甜点区。7B 以下只适合范围明确、边界清晰的窄任务。任何 OpenAI 兼容的服务端都能用，所以需要时同一套配置可以直接放大到云端模型。

## 亮点

- **上下文纪律。** 旧的工具输出折叠成一行摘要；在两次压缩事件之间请求保持只追加，让引擎的 prompt 缓存得以存活；窗口填满时，模型先写下自己的发现笔记，之后较早的轮次才折叠成回顾。
- **循环与打转中断。** 重复读取、反复重推的推理、以及失控的思考块都会被检测到，并用一套逐级升级的手段回应（轻推、固定台账、收回工具、坦诚终止），而不是让它打转半小时。
- **弱模型需要的护栏。** 盲改会被退回，要求先读；TypeScript 编辑会对照编辑前的基线做类型检查；写下的计划按框架观察到的事实逐步追踪，而不是按模型自己声称的进度。
- **计划 → 实现。** 只读的计划模式最终产出一份带编号、落到具体文件的计划 —— 你可以在执行之前用任意多轮来打磨它 —— 而 vibe 模式会在每次提示时把计划和实现串起来。
- **默认安全。** 普通编辑直接执行，危险命令仍会询问；在 macOS 上，由模型选择的 shell 命令运行在内核沙箱里（写入限制在项目内，网络被禁止）。
- **可扩展。** Stdio MCP 服务器可以添加工具，每个工具同时也会变成一个斜杠命令。Markdown 技能同样会变成斜杠命令；`/issue` 和 `/review` 随 Reika 一起发布，只要有 `gh` 和 GitHub 远程仓库就会出现。
- **无遥测。** 你的代码只会发往你自己配置的模型服务器，别处不去：用本地服务器时它从不离开你的机器，用云端 API 时它只发给该提供商。除此之外的请求只有：使用网络工具或粘贴链接时发起的请求；为查询上下文上限而下载公开的 models.dev 目录（仅针对托管端点，且从不携带你的数据）；以及你配置的 MCP 服务器各自的行为。
- **为慢速本地引擎而做。** 容忍长预填充，能处理没有原生模板的模型发出的工具调用方言，并在状态栏显示解码速度、上下文占用和缓存命中率。

## 要求

- Node.js 22 或更新版本（macOS 11+，或 glibc 2.28+ 的 Linux —— 见[平台](docs/platforms.md)）。
- 一个 OpenAI 兼容的模型服务器：llama.cpp、MLX、vLLM 或云端 API。
- macOS 是主要平台。Linux 可用，但没有 shell 沙箱和图片粘贴 OCR（可以设置 `REIKA_VISION_MODEL`，改用视觉模型读取粘贴的图片）。Windows 或许能在 WSL2 下运行。
- 现代终端（iTerm2、Ghostty、Kitty 等）。想要正确的 TUI 渲染，建议使用它们。

## 快速开始

先启动一个模型。下面以 llama.cpp 为例：

```sh
llama-server -m <model.gguf> -c 24576 --jinja <other-launch-args>
```

然后安装 Reika 并把它指向该服务器：

```sh
pnpm install
pnpm run install:global      # 构建并安装 `reika` 可执行文件

export REIKA_MODEL=model  # 或写进 ~/.config/reika/.env
cd your-project && reika
```

`REIKA_BASE_URL` 默认是 `http://localhost:8080/v1`，即 llama-server 的默认地址。上下文窗口在服务器上报时从中读取；对于不上报的服务器（部分推理引擎、多数云端 API），请设置 `REIKA_CONTEXT_WINDOW`。Reika 不发送任何自己的采样参数，所以生效的就是你服务器的启动参数。

想直接从检出目录运行而不安装：`cp .env.example .env`，编辑它，然后 `pnpm run dev`。`pnpm run uninstall:global` 会移除全局可执行文件。

## 常用配置

这些可以设在你的 shell、项目 `.env` 或 `~/.config/reika/.env` 中（优先级即此顺序）。完整列表、实验性开关和多模型 profile 见[配置文档](docs/configuration.md)。

| 键                     | 默认值                      | 说明                                                   |
| ---------------------- | --------------------------- | ------------------------------------------------------ |
| `REIKA_MODEL`          | _必填_                      | 模型名称，或同一端点提供的逗号分隔列表                 |
| `REIKA_BASE_URL`       | `http://localhost:8080/v1`  | OpenAI 兼容端点                                        |
| `REIKA_API_KEY`        | `no-key`                    | API 密钥（本地服务器填任意非空值）                     |
| `REIKA_CONTEXT_WINDOW` | _从服务器探测_              | 上下文窗口 token 数；驱动压缩和上下文占用条            |
| `REIKA_MIN_GEN_TOKENS` | _学习得到_（起始为 `2048`） | 为回复预留的空间；从模型的轮次中学习，设置它即固定该值 |
| `REIKA_AUTO_APPROVE`   | `safe`                      | `off` 让每次编辑和命令都需确认；`bypass` 什么都不确认  |

## 模式

`Shift+Tab` 循环切换模式，也可以用斜杠命令切换。你结束会话时所处的模式和模型，就是下次会话打开时的模式和模型。

| 模式      | 作用                                                     |
| --------- | -------------------------------------------------------- |
| `agent`   | 默认模式：模型读取、编辑并运行命令                       |
| `plan`    | 只读探索，最终产出一份写好的计划；`/implement` 执行它    |
| `vibe`    | 每次提示都先规划，再实现该计划                           |
| `minimal` | 仅 shell，不预先加载仓库地图和项目上下文                 |
| `grind`   | 代理轮次按固定而谨慎的流程运行：定义完成标准、测试、复查 |
| `chat`    | 与主历史分开的纯对话；只有网络工具                       |
| `shell`   | 你的输入作为 shell 命令运行，输出并入代理的上下文        |

`reika -p "<prompt>"` 无头运行单个轮次并打印回复，用于脚本和其他框架。模式细节、无头参数以及全部斜杠命令见[用法文档](docs/usage.md)。

## 安全

- **审批**默认是 `safe`：普通编辑和命令自行执行，但任何匹配危险模式的命令（`rm -rf`、强制推送、安装软件包、`curl`……）以及项目之外的任何写入，仍会先问你。`bypass` 只能在启动时设置，会话中无法切换。
- **沙箱**（macOS，默认开启）：由模型选择的 shell 命令只能写入项目、临时和缓存目录内，且除回环地址和只读的 `git`/`gh` 之外没有网络。你明确批准的命令不做沙箱隔离运行。`REIKA_SANDBOX=0` 可将其关闭。

发现了绕过其中某一道的方式？请私下报告，见 [SECURITY.md](SECURITY.md)。

## 文档

| 文档                                   | 内容                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| [配置](docs/configuration.md)          | 每一个 `.env` 键、实验性开关、具名 profile、上次会话状态         |
| [模式、无头与命令](docs/usage.md)      | 各模式详解、`reika -p`、斜杠命令、`/save` 会话记录               |
| [工具](docs/tools.md)                  | 模型可用的工具、审批提示、网络搜索设置、MCP 服务器、`.gitignore` |
| [指令与技能](docs/skills.md)           | `AGENTS.md`、作为斜杠命令的技能、自然语言路由、粘贴的链接        |
| [测试过的模型](docs/models.md)         | Reika 实际跑过的本地量化版本和 API                               |
| [平台](docs/platforms.md)              | 运行要求、在弱机器上运行、Linux 和 Windows 上的差异              |
| [架构与注意事项](docs/architecture.md) | 框架如何工作，以及已知限制                                       |
| [贡献](CONTRIBUTING.md)                | 脚本、设计理念、`AGENTS.md` 指引，以及外部贡献者指南             |

## 许可

Apache License 2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

## 灵感来自

Claude Code、Codex、Crush、OpenCode、Pi、Aider、DeepSeek Harness、Qwen Code、Kimi Code CLI、Gemini CLI、Junie 和 DS4。
