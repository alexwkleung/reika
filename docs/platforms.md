# Platforms and requirements

[← README](../README.md)

## Requirements

Node.js 22 or newer. Node sets the operating-system floor, not reika:

| OS      | Minimum                                               |
| ------- | ----------------------------------------------------- |
| macOS   | 11 (Big Sur)                                          |
| Linux   | glibc 2.28 or newer — most distributions from 2018 on |
| Windows | 10, through WSL (see [Windows](#windows))             |

reika itself is light. It is a terminal UI that sends requests to a model server, so its own CPU and memory use is small next to the model's. What a machine needs to run a _model_ is the model server's question, not reika's.

## Running on a weak machine

Because reika only talks to an OpenAI-compatible endpoint, the model does not have to run on the machine reika runs on. An old laptop can run reika against:

- a model server on a stronger machine on the same network (llama.cpp, Ollama, vLLM, LM Studio — anything that serves `/v1/chat/completions`)
- a hosted API

Point `REIKA_BASE_URL` at it (see [Configuration](configuration.md)). Everything reika does locally — reading and editing files, running commands, the context bookkeeping — stays on the machine you are sitting at, and only the requests cross the network. Picking and serving a model is covered in [Models](models.md).

## What differs by platform

Everything outside this table works the same on every platform.

| Feature                                      | macOS                       | Linux                                              | Windows (WSL)                                      |
| -------------------------------------------- | --------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Command sandbox (`REIKA_SANDBOX`)            | on by default               | not available — commands run unconfined            | not available — commands run unconfined            |
| Web search through Chrome                    | on when Chrome is found     | off by default, `REIKA_CDP_SEARCH=1`               | off by default, `REIKA_CDP_SEARCH=1`               |
| Pasting an image from the clipboard (ctrl-v) | yes                         | no                                                 | no                                                 |
| Images attached by path (`@shot.png`)        | yes (system OCR by default) | with `REIKA_VISION_MODEL` or `REIKA_VISION=native` | with `REIKA_VISION_MODEL` or `REIKA_VISION=native` |

- **Sandbox.** It uses macOS's own `sandbox-exec`. On Linux the tool that would do the same job cannot let a sandboxed command reach a model server on the same machine, so there is no sandbox there yet. Approval prompts work the same everywhere, so under the default `REIKA_AUTO_APPROVE=safe` a dangerous command still asks first. See `REIKA_SANDBOX` in [Configuration](configuration.md).
- **Chrome search.** Off macOS, starting Chrome opens a visible window that takes focus, so it waits for you to opt in. reika looks for Chrome or Chromium in the usual install paths; `REIKA_CHROME_PATH` points it at another binary.
- **Images.** reika reads the clipboard itself, and only has a reader for macOS and Windows; WSL counts as Linux. An image attached by path works everywhere, as long as something can read it: the built-in OCR ships for macOS only among these, and on Linux the image needs `REIKA_VISION_MODEL` (a vision model describes it as text) or `REIKA_VISION=native` (for a main model that can see images). See [Configuration](configuration.md).

## Windows

Run reika inside WSL. The `bash` tool runs commands through `/bin/sh` and stops a command that hangs by signalling its whole process group, and both are Unix mechanisms, so running reika directly on Windows is not supported.

## Terminals

Any terminal that runs a full-screen program works. A few things to know on older or unusual ones:

- **Colors** step down on their own to what the terminal reports. An ssh session can inherit `COLORTERM` or `TERM_PROGRAM` from the machine you connected from, which makes it claim more colors than it has. `FORCE_COLOR=1` pins it to 16.
- **Flicker.** reika asks the terminal to draw each frame at once. A terminal that does not support that ignores the request. If one misbehaves instead, `REIKA_SYNC_OUTPUT=0` turns it off.
- **No terminal at all.** For scripts, CI and pipes, use headless mode (`reika -p`, see [Usage](usage.md#headless-mode)).
