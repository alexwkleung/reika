# Install and first run

[← README](../README.md)

Reika is a single CLI that talks to a model over the standard chat-completions API. The model can run
on your laptop, on another machine, or at a hosted provider. It never has to run where Reika runs (see
[Platforms](platforms.md#running-on-a-weak-machine)).

## Requirements

- **Node.js 22 or newer.** Node sets the operating-system floor: macOS 11+, Linux with glibc 2.28+,
  or Windows 10 through WSL. [Platforms](platforms.md) has the details and what differs per platform.
- **A model** behind a `/v1/chat/completions` endpoint: a local server (llama.cpp, MLX, vLLM) or a
  hosted API. llama.cpp is the local engine Reika is developed and measured against. Other engines
  implement different parts of that API, so a bug seen on one may not reproduce on another.
- **A modern terminal** such as iTerm2, Ghostty or Kitty, so the TUI renders properly.

## Install

Any of these installs the same published package:

```sh
npm i -g @alexwkleung/reika          # npm ships with Node
pnpm add -g @alexwkleung/reika       # what Reika's own checkout uses
brew install alexwkleung/tap/reika   # macOS and Linux; pulls in Node if needed
```

The npm package is scoped, but the command it installs is just `reika`. The Homebrew formula wraps the
npm package, so the version is the same either way. It lives in a tap rather than in Homebrew's core
list, which is why the name starts with `alexwkleung/tap/`.

pnpm has to be installed first (`npm i -g pnpm`, or the standalone installer at
[pnpm.io/installation](https://pnpm.io/installation)), and its global bin directory has to be on your
`PATH`. `pnpm setup` puts it there and prints the line to add to your shell config (on macOS that is
`~/Library/pnpm/bin`). npm's global bin is on `PATH` already, so npm is the shorter route if you don't
use pnpm otherwise.

Reika is pre-1.0, so commands, settings and behavior can still change between releases.

## Pick a model

### Local

Any OpenAI-compatible server works. With llama.cpp:

```sh
llama-server -m <model.gguf> -c 24576 --jinja <other-launch-args>
```

`-c` is the context window you give the model, and `--jinja` turns on the model's own chat template,
which is what makes tool calling reliable. How big to make the window is up to the model server, not
Reika; [Models](models.md) lists what Reika has been run against.

For a thinking model, also check whether its template keeps earlier reasoning. Some (LFM2.5 and
Qwen3.6 among them) drop every `<think>` block that comes before the newest user message, and Reika
sends its per-round notes as a user message. Once a long turn starts shedding context, the model sees
none of its own earlier reasoning and tends to redo work it already did. Reika turns on the template's
`preserve_thinking` switch in every request to a local or private address, so a server on this
machine or your network needs nothing extra. For a server Reika reaches at a public address, turn it
on at the server:

```sh
llama-server -m <model.gguf> -c 24576 --jinja --chat-template-kwargs '{"preserve_thinking":true}'
```

### Hosted

Any provider with an OpenAI-compatible endpoint works, whether that's the provider's own API or a
router such as OpenRouter:

```sh
export REIKA_BASE_URL=https://api.example.com/v1   # the provider's endpoint
export REIKA_API_KEY=<your key>
export REIKA_MODEL=<model id>                      # as the provider names it
```

For a hosted endpoint, the context window and output limit come from the models.dev catalog when the
provider is listed there; set `REIKA_CONTEXT_WINDOW` when it isn't. Your code goes to that provider,
since it's the one running the model.

## Point Reika at it

```sh
export REIKA_MODEL=model          # or put it in ~/.config/reika/.env
cd your-project && reika
```

- `REIKA_BASE_URL` defaults to `http://localhost:9931/v1`, llama-server's default since llama.cpp
  v0.7.0. An older llama-server (or its Docker image) listens on 8080, and a hosted API has its own
  (above).
- The context window is read from the server when it reports one, and for hosted endpoints from the
  models.dev catalog; set `REIKA_CONTEXT_WINDOW` when neither has it, and a startup line says so.
- `REIKA_MODEL` is required. It takes a comma-separated list when one endpoint serves several models,
  and `/model <name>` switches between them.
- Reika sends no sampling parameters of its own, so your server's flags are what apply.

Then, in the session: `/` lists the slash commands, `Shift+Tab` cycles modes, and `/help` shows
everything. [Modes and commands](usage.md) covers each mode; [Configuration](configuration.md) is the
full key list.

## From a checkout

For running a version you're changing:

```sh
git clone https://github.com/alexwkleung/reika.git && cd reika
pnpm install                  # npm users: npm i -g pnpm first
pnpm run install:global       # builds and installs the `reika` binary
pnpm run uninstall:global     # removes it again
```

The install is a copy of the checkout as it was when you ran it, so switching branches or rebuilding
afterwards doesn't change the installed `reika`. Run `pnpm run reinstall:global` to pick up new
changes.

To run it without installing anything, `cp .env.example .env`, edit it, and use `pnpm run dev`.
[Contributing](../CONTRIBUTING.md) has the rest of the contributor setup.
