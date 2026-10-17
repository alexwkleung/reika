---
# 本页用于站点；GitHub 会将前言显示为表格。仓库首页是 README。
layout: Landing
sidebar: false
titleTemplate: false

hero:
  name: Reika
  text: 面向本地和托管模型的编程智能体 CLI
  tagline: 优先围绕小型本地模型设计，更谨慎地使用上下文，失败时更从容，卡住时会明确告知。它不会让小模型更聪明，而是减少使用小模型时的挫折。
  actions:
    - theme: brand
      text: 开始使用（英文）
      link: /getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/alexwkleung/reika
    - theme: alt
      text: 阅读研究结果（英文）
      link: /findings

featuresTitle: 功能
features:
  - title: 上下文管理
    details: 较早的工具输出缩减为简短摘要，请求始终只追加新内容，保留较慢本地推理引擎的提示词缓存。
  - title: 打断循环
    details: 检测并停止重复读取和失控的推理，明确说明停止原因，避免长时间陷入循环。
  - title: 检查模型的工作
    details: 没有读取依据的编辑会先退回读取步骤，TypeScript 编辑会接受类型检查，计划进度根据实际发生的操作记录。
  - title: 按任务选择模式
    details: 修改前先制定计划，让较难的变更经过测试与审查流程，精简小窗口中的上下文，或只是聊天。用 Shift+Tab 切换。
  - title: 默认安全
    details: 危险命令仍需确认；在 macOS 上，shell 命令运行于内核沙箱中。没有遥测。
  - title: 有测量记录
    details: 默认开启的功能保留关闭开关，以便进行 A/B 对比，并公开它们解决了什么、没有解决什么。

docsTitle: 文档
docs:
  - title: 安装（英文）
    details: 运行要求与首次使用
    link: /getting-started
  - title: 使用（英文）
    details: 模式、命令与快捷键
    link: /usage
  - title: 配置（英文）
    details: 所有设置
    link: /configuration
  - title: 工具（英文）
    details: 智能体可以调用什么
    link: /tools
  - title: 指令与技能（英文）
    details: AGENTS.md 与斜杠命令
    link: /skills
  - title: 模型
    details: 实际使用过的模型
    link: /zh/models
  - title: 平台
    details: macOS、Linux 与 Windows
    link: /zh/platforms
  - title: 架构
    details: 一轮交互如何组织
    link: /zh/architecture
  - title: 研究结果（英文）
    details: 哪些失效、哪些有效
    link: /findings
  - title: 支持项目（英文）
    details: 资助与其他帮助方式
    link: /support
---

> 本页是[英文页面](../index.md)的简体中文译文。英文为准，译文可能滞后。

![Reika 使用本地模型修复重试辅助函数及其测试](../demo.gif)

<sup>通过 llama.cpp 运行 Qwen3.6 35B A3B（Unsloth UD-IQ2_M）的一次真实本地运行，播放速度加快 3 倍。模型的第一次测试失败后，根据错误进行了修复。</sup>

## 安装

```sh
npm i -g @alexwkleung/reika
pnpm add -g @alexwkleung/reika
brew install alexwkleung/tap/reika
```

然后连接模型服务器，在项目中运行 `reika`。[安装与首次使用](../getting-started.md)介绍运行要求与设置步骤。
