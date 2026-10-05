# Install and first run

[← README](../README.md)

Reika is one CLI that talks to a model over the standard chat-completions API. The model can run on
your laptop, on another machine, or at a hosted provider — it never has to run where Reika runs (see
[Platforms](platforms.md#running-on-a-weak-machine)).

## Requirements

- **Node.js 22 or newer** — Node sets the operating-system floor: macOS 11+, Linux with glibc 2.28+,
  or Windows 10 through WSL. See [Platforms](platforms.md) for the details and for what differs per
  platform.
- **A model** behind a `/v1/chat/completions` endpoint: a local server (llama.cpp, MLX, vLLM) or a
  hosted API. llama.cpp is the local engine Reika is developed and measured against — other engines implement different amounts of
  that surface, so a bug seen on one may not reproduce on another.
- **A modern terminal** (iTerm2, Ghostty, Kitty, …) for correct TUI rendering.

## Install

Any of these installs the same published package:

```sh
npm i -g @alexwkleung/reika          # npm ships with Node
pnpm add -g @alexwkleung/reika       # what Reika's own checkout uses
brew install alexwkleung/tap/reika   # macOS and Linux; pulls in Node if needed
```

The npm package is scoped, but the command it installs is `reika`. The Homebrew formula wraps the npm package, so the version is the same either way. It lives in a tap
rather than in Homebrew's core list, which is why the name carries `alexwkleung/tap/`.

pnpm needs installing first (`npm i -g pnpm`, or the standalone installer at
[pnpm.io/installation](https://pnpm.io/installation)), and its global bin directory has to be on your
`PATH` — `pnpm setup` puts it there and prints the line to add to your shell config (on macOS that is
`~/Library/pnpm/bin`). npm's global bin is on `PATH` already, so npm is the shorter route if you do
not otherwise use pnpm.

Reika is pre-1.0, so commands, settings and behavior can still change between releases.

## Pick a model

### Local

Any OpenAI-compatible server works. With llama.cpp:

```sh
llama-server -m <model.gguf> -c 24576 --jinja <other-launch-args>
```

`-c` is the context window you are giving the model, and `--jinja` enables the model's own chat
template, which is what makes tool calling reliable. Sizing this is the model server's question, not
Reika's; [Models](models.md) lists what Reika has been run against.

### Hosted

Any provider with an OpenAI-compatible endpoint works — a provider's own API, or a router such as
OpenRouter:

```sh
export REIKA_BASE_URL=https://api.example.com/v1   # the provider's endpoint
export REIKA_API_KEY=<your key>
export REIKA_MODEL=<model id>                      # as the provider names it
```

For a hosted endpoint the context window and output limit come from the models.dev catalog when the
provider is listed there; set `REIKA_CONTEXT_WINDOW` when it is not. Your code goes to that provider,
since it is the one running the model.

## Point Reika at it

```sh
export REIKA_MODEL=model          # or put it in ~/.config/reika/.env
cd your-project && reika
```

- `REIKA_BASE_URL` defaults to `http://localhost:8080/v1`, llama-server's default; a hosted API sets
  its own (above).
- The context window is read from the server when it reports one, and for hosted endpoints from the
  models.dev catalog; set `REIKA_CONTEXT_WINDOW` when neither has it, and a startup line says so.
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
