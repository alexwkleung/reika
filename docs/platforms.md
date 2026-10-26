# Platforms and requirements

[← README](../README.md)

## Requirements

Node.js 22 or newer. Node sets the operating-system floor, not Reika:

| OS      | Minimum                                               |
| ------- | ----------------------------------------------------- |
| macOS   | 11 (Big Sur)                                          |
| Linux   | glibc 2.28 or newer — most distributions from 2018 on |
| Windows | 10, through WSL (see [Windows](#windows))             |

Reika itself is light: it is a terminal UI that sends requests to a model server, so its own CPU and
memory use is small next to the model's. What a machine needs to run a _model_ is the model server's
question, not Reika's.

## Running on a weak machine

Because Reika only talks to an OpenAI-compatible endpoint, the model does not have to run on the
machine Reika runs on. An old laptop can run Reika against:

- a model server on a stronger machine on the same network (llama.cpp, Ollama, vLLM, LM Studio —
  anything that serves `/v1/chat/completions`)
- a hosted API

Point `REIKA_BASE_URL` at it (see [Configuration](configuration.md)). Everything Reika does locally —
reading and editing files, running commands, the context bookkeeping — stays on the machine you are
sitting at, and only the requests cross the network.

**Ollama.** It works, but Reika cannot read the context window from it, so set
`REIKA_CONTEXT_WINDOW` to the `num_ctx` the model actually runs with. Without a window Reika does no
compaction and caps nothing, and Ollama's own default context is small and cuts a long prompt
without an error, so a session can lose its earlier turns with nothing on screen saying so. The loop
recovery's logit bias also has no effect there. llama.cpp and vLLM report their window, so neither
needs this.

**Thinking models on Ollama, MLX and some templates.** Once a context window is known, Reika puts its
per-round notes in a short message at the end of each request so the prompt cache stays valid. Many
thinking models' chat templates hide all earlier reasoning behind that message, so the model can't see
its own earlier thinking and keeps working it out again. Reika asks the template to keep it
(`preserve_thinking`). That works on llama.cpp, vLLM and SGLang running on your own machine or
network, with a template that supports it: LFM2.5 and Qwen3.6, for example. It does not help when the
engine ignores the request (mlx-vlm, and very likely Ollama), when the server is at a public address,
or when the template has no such switch (Mellum2.1 Thinking, Ornith 1.5, Gemma 4 E4B, among the
[tested models](models.md)). Setting `REIKA_PREFIX_STABLE=0` moves the notes back into the system
prompt so the reasoning stays visible, but it gives up most prompt-cache reuse: on a slow machine
that can cost minutes of reprocessing per round, which may be worse than the problem. Tracked in
[#827](https://github.com/alexwkleung/reika/issues/827).

## What differs by platform

Everything outside this table works the same everywhere.

| Feature                                      | macOS                       | Linux                                              | Windows (WSL)                                      |
| -------------------------------------------- | --------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Command sandbox (`REIKA_SANDBOX`)            | on by default               | not available — commands run unconfined            | not available — commands run unconfined            |
| Web search through Chrome                    | on when Chrome is found     | off by default, `REIKA_CDP_SEARCH=1`               | off by default, `REIKA_CDP_SEARCH=1`               |
| Pasting an image from the clipboard (ctrl-v) | yes                         | no                                                 | no                                                 |
| Images attached by path (`@shot.png`)        | yes (system OCR by default) | with `REIKA_VISION_MODEL` or `REIKA_VISION=native` | with `REIKA_VISION_MODEL` or `REIKA_VISION=native` |

**Sandbox.** It uses macOS's own `sandbox-exec`. On Linux the tool that would do the same job cannot let
a sandboxed command reach a model server on the same machine, so there is no sandbox there yet.
Approval prompts work the same everywhere, so under the default `REIKA_AUTO_APPROVE=safe` a dangerous
command still asks first. See `REIKA_SANDBOX` in [Configuration](configuration.md).

**Chrome search.** Off macOS, starting Chrome opens a visible window that takes focus, so it waits for
you to opt in. Reika looks for Chrome or Chromium in the usual install paths; `REIKA_CHROME_PATH` points
it at another binary.

**Images.** Reika reads the clipboard itself, and only has a reader for macOS and Windows; WSL counts as
Linux. An image attached by path works everywhere, as long as something can read it: the built-in OCR
ships for macOS only among these, and on Linux the image needs `REIKA_VISION_MODEL` (a vision model
describes it as text) or `REIKA_VISION=native` (for a main model that can see images). See
[Configuration](configuration.md).

## Windows

Run Reika inside WSL. The `bash` tool runs commands through `/bin/sh`, and it stops a command that hangs
by signalling its whole process group — both Unix mechanisms, so running Reika directly on Windows is
not supported.

## Terminals

Any terminal that runs a full-screen program works. A few things to know on older or unusual ones:

- **Colors** step down on their own to what the terminal reports. An ssh session can inherit
  `COLORTERM` or `TERM_PROGRAM` from the machine you connected from, which makes it claim more colors
  than it has. `FORCE_COLOR=1` pins it to 16. At 16 colors Reika switches to a palette of named colors,
  since its usual pastels would nearly all turn white.
- **Glyphs.** The Linux console's fonts lack some of the symbols Reika draws (the tool-call dot, the
  braille spinner, rounded box corners). Under `TERM=linux` or `vt*` it draws simpler ones those fonts
  carry instead. `REIKA_BASIC_GLYPHS=1` forces that for a terminal it doesn't detect, such as an old
  Windows console font, and `0` turns it off (see [Configuration](configuration.md)).
- **Flicker.** Reika asks the terminal to draw each frame at once. A terminal that does not support that
  ignores the request; if one misbehaves instead, `REIKA_SYNC_OUTPUT=0` turns it off.
- **No terminal at all.** For scripts, CI and pipes, use headless mode (`reika -p`, see
  [Usage](usage.md#headless-mode)).
