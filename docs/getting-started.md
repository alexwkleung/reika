# Install and first run

[← README](../README.md)

Reika is one CLI that talks to an OpenAI-compatible model server. That server can be on your laptop or
on another machine — the model never has to run where Reika runs (see
[Platforms](platforms.md#running-on-a-weak-machine)).

## Requirements

- **Node.js 22 or newer** — Node sets the operating-system floor: macOS 11+, Linux with glibc 2.28+,
  or Windows 10 through WSL. See [Platforms](platforms.md) for the details and for what differs per
  platform.
- **A model server** speaking `/v1/chat/completions`: llama.cpp, MLX, vLLM, or a cloud API. llama.cpp
  is the engine Reika is developed and measured against — other engines implement different amounts of
  that surface, so a bug seen on one may not reproduce on another.
- **A modern terminal** (iTerm2, Ghostty, Kitty, …) for correct TUI rendering.

## Install

```sh
npm i -g reika
```

The first npm publish is `0.1.0`, a research and developer release: expect behavior and config to
change between minor versions. Until that release is up, install from a checkout (below).

## Serve a model

Any OpenAI-compatible server works. With llama.cpp:

```sh
llama-server -m <model.gguf> -c 24576 --jinja <other-launch-args>
```

`-c` is the context window you are giving the model, and `--jinja` enables the model's own chat
template, which is what makes tool calling reliable. Sizing this is the model server's question, not
Reika's; [Models](models.md) lists what Reika has been run against.

## Point Reika at it

```sh
export REIKA_MODEL=model          # or put it in ~/.config/reika/.env
cd your-project && reika
```

- `REIKA_BASE_URL` defaults to `http://localhost:8080/v1`, llama-server's default.
- The context window is read from the server when it reports one; set `REIKA_CONTEXT_WINDOW` for
  servers that do not (some inference engines, most cloud APIs).
- `REIKA_MODEL` is required, and takes a comma-separated list for models served by one endpoint —
  `/model <name>` switches between them.
- Reika sends no sampling parameters of its own, so your server's flags are what apply.

Then, in the session: `/` lists the slash commands, `Shift+Tab` cycles modes, and `/help` shows
everything. [Modes and commands](usage.md) covers each mode; [Configuration](configuration.md) is the
full key list.

## From a checkout

For running a version you are changing, or before the first npm release:

```sh
git clone https://github.com/alexwkleung/reika.git && cd reika
pnpm install                  # npm users: npm i -g pnpm first
pnpm run install:global       # builds and installs the `reika` binary
pnpm run uninstall:global     # removes it again
```

To run it without installing anything, `cp .env.example .env`, edit it, and use `pnpm run dev`.
[Contributing](../CONTRIBUTING.md) has the rest of the contributor setup.
