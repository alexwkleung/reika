---
# 本页用于站点；GitHub 会将前言显示为表格。仓库首页是 README。
layout: Landing
sidebar: false
titleTemplate: false

hero:
  name: Reika
  # The line break is the headline's own: Chinese can break between any two characters, so the
  # landing sets this break rather than letting the browser split a word.
  text: "面向本地和托管模型的\n编程智能体 CLI"
  tagline: 优先围绕小型本地模型设计，更谨慎地使用上下文，失败时更从容，卡住时会明确告知。它不会让小模型更聪明，而是减少使用小模型时的挫折。
  actions:
    - theme: brand
      text: 开始使用（英文）
      link: /zh/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/alexwkleung/reika
    - theme: alt
      text: 阅读研究结果（英文）
      link: /zh/findings
    - theme: alt
      text: 博客（英文）
      link: /blog/

install:
  - label: npm
    command: npm i -g @alexwkleung/reika
  - label: pnpm
    command: pnpm add -g @alexwkleung/reika
  - label: brew
    command: brew install alexwkleung/tap/reika

installLabel: 安装
copyLabel: 复制命令
copiedLabel: 已复制

featuresTitle: 功能
features:
  - title: 上下文管理
    details: 较早的工具输出缩减为简短摘要，请求始终只追加新内容，保留较慢本地推理引擎的提示词缓存。
  - title: 打断循环
    details: 检测并停止重复读取和失控的推理，明确说明停止原因，避免长时间陷入循环。
  - title: 检查模型的工作
    details: 没有读取依据的编辑会先退回读取步骤，TypeScript 编辑会接受类型检查，计划进度根据实际发生的操作记录。
  - title: 按任务选择模式
    details: 默认的智能体模式直接完成任务。需要时再切换：先只读地制定计划，让变更经过测试与审查流程，精简小窗口中的上下文，或只是聊天。用 Shift+Tab 切换。
  - title: 默认安全
    details: 危险命令仍需确认；在 macOS 上，shell 命令运行于内核沙箱中。没有遥测。
  - title: 有测量记录
    details: 默认开启的功能保留关闭开关，以便进行 A/B 对比，并公开它们解决了什么、没有解决什么。

docsTitle: 文档
docs:
  - title: 安装（英文）
    details: 运行要求与首次使用
    link: /zh/getting-started
  - title: 使用（英文）
    details: 模式、命令与快捷键
    link: /zh/usage
  - title: 网页界面（英文）
    details: 在浏览器标签页中使用同一个智能体
    link: /zh/web
  - title: 配置（英文）
    details: 所有设置
    link: /zh/configuration
  - title: 工具（英文）
    details: 智能体可以调用什么
    link: /zh/tools
  - title: 指令与技能（英文）
    details: AGENTS.md 与斜杠命令
    link: /zh/skills
  - title: 模型
    details: 实际使用过的模型
    link: /zh/models
  - title: 平台
    details: macOS、Linux 与 Windows
    link: /zh/platforms
  - title: 架构
    details: 一轮交互如何组织
    link: /zh/architecture
  - title: 基于 Reika 构建（英文）
    details: 构建自己的编程智能体框架
    link: /zh/building-on-reika
  - title: 研究结果（英文）
    details: 哪些失效、哪些有效
    link: /zh/findings
  - title: 隐私与数据（英文）
    details: 哪些数据会离开你的电脑
    link: /zh/privacy
  - title: 支持项目（英文）
    details: 资助与其他帮助方式
    link: /zh/support
---

> 本页是[英文页面](../index.md)的简体中文译文。英文为准，译文可能滞后。

目前仅首页、[模型](models.md)、[平台](platforms.md)和[架构](architecture.md)有中文译文。标注“（英文）”的链接会进入英文页面；语言菜单会切换到已有的对应译页，其他页面则回到所选语言的首页。

<DemoToggle
  terminal-label="终端"
  web-label="网页"
  terminal-alt="Reika 使用本地模型修复重试辅助函数及其测试"
  terminal-caption="通过 llama.cpp 运行 Qwen3.6 35B A3B（Unsloth UD-IQ2_M）的一次真实本地运行，播放速度加快 3 倍。模型修正了自己的缩进，为延迟添加了一个测试，第一次运行就全部通过。"
  web-alt="在 reika web 中完成同一任务：Reika 使用本地模型修复重试辅助函数及其测试"
  web-caption="通过 llama.cpp 运行 Qwen3.6 35B A3B（Unsloth UD-IQ2_M）的一次真实本地运行，播放速度加快 3 倍。模型完成修改，为延迟编写了五个测试，第一次运行就全部通过。"
/>
