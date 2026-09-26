<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reika-dark.svg">
    <img alt="Reika" src="docs/assets/reika-light.svg" width="262">
  </picture>
</p>

<p align="center">
  A coding agent CLI for small local models, tuned for low quantization,<br>
  with a focus on context discipline and capability alignment.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="docs/models.md">Tested models</a>
</p>

![Reika fixing a retry helper and its test with a local model](docs/demo.gif)

<sup>A real local run of Qwen3.6 35B A3B (Unsloth UD-IQ2_M) via llama.cpp, sped up 3×. The model's first test fails and it fixes it from the error.</sup>

Most coding agents are built for frontier models. Reika is built for the models you can run yourself: 8B–35B, often at Q2–Q4, on a laptop with a 16–32k context window. The goal is to make them **usable**, not more intelligent. The harness can't raise a model's ceiling, but it can stop it from wasting its window, looping on the same read, or quietly losing its task.

8/9B models hold their own; 14–35B is the sweet spot for agentic coding. Below 7B works only for narrow, well-scoped tasks. Anything OpenAI-compatible works, so the same setup scales up to cloud models when you need them.

## Highlights

- **Context discipline.** Old tool output collapses to one-line summaries, requests stay append-only between shrink events so the engine's prompt cache survives, and when the window fills the model writes its own findings note before older turns fold into a recap.
- **Loop and spiral breaking.** Repeated reads, re-derived reasoning, and runaway thinking blocks are detected and answered with an escalating ladder (nudge, pinned ledger, tool withdrawal, honest stop) rather than a 30-minute spiral.
- **Guard rails a weak model needs.** Blind edits are bounced to a read first, TypeScript edits are typechecked against a pre-edit baseline, and a written plan is tracked step by step from what the harness observes, not what the model claims.
- **Plan → implement.** A read-only plan mode that ends in a numbered, file-specific plan, and a vibe mode that chains plan and implementation on every prompt.
- **Safe by default.** Ordinary edits run, dangerous commands still prompt, and on macOS model-chosen shell commands run under a kernel sandbox (writes confined to the project, network denied).
- **Built for slow local engines.** Tolerates long prefills, handles tool-call dialects from models without a native template, and shows decode speed, context fill, and cache hit rate in the status bar.

## Requirements

- Node.js 22 or newer
- An OpenAI-compatible model server: [llama.cpp](https://github.com/ggml-org/llama.cpp), MLX, vLLM, Ollama, or a cloud API
- macOS is the primary platform. Linux works, but without the shell sandbox or image-paste OCR.

## Quick start

Serve a model. With llama.cpp, `--jinja` enables the model's native tool-calling template, which is what makes tool calls reliable:

```sh
llama-server -m ~/models/your-model.gguf -c 24576 --jinja
```

Then install and point Reika at it:

```sh
npm install
npm run install:global       # builds and installs the `reika` binary

export REIKA_MODEL=your-model  # or put it in ~/.config/reika/.env
cd your-project && reika
```

`REIKA_BASE_URL` defaults to `http://localhost:8080/v1`, llama-server's default. The context window is read from the server when it reports one; set `REIKA_CONTEXT_WINDOW` for servers that don't (Ollama, most cloud APIs). Reika sends no sampling parameters of its own, so your server's flags are what apply.

To run from a checkout without installing: `cp .env.example .env`, edit it, then `npm run dev`. `npm run uninstall:global` removes the global binary.

## Common configuration

Set these in your shell, a project `.env`, or `~/.config/reika/.env` (in that order of precedence). The full list, experimental flags, and multi-model profiles are in [docs/configuration.md](docs/configuration.md).

| Key                    | Default                    | What                                                                 |
| ---------------------- | -------------------------- | -------------------------------------------------------------------- |
| `REIKA_MODEL`          | _required_                 | Model name, or a comma-separated list served by the same endpoint    |
| `REIKA_BASE_URL`       | `http://localhost:8080/v1` | OpenAI-compatible endpoint                                           |
| `REIKA_API_KEY`        | `no-key`                   | API key (any non-empty value for local servers)                      |
| `REIKA_CONTEXT_WINDOW` | _probed from the server_   | Context window in tokens; drives compaction and the context gauge    |
| `REIKA_MIN_GEN_TOKENS` | `2048`                     | Room reserved for the reply; raise to 6144–8192 for reasoning models |
| `REIKA_AUTO_APPROVE`   | `safe`                     | `off` confirms every edit and command; `bypass` confirms nothing     |

## Modes

`Shift+Tab` cycles modes, or switch with a slash command. The mode and model you end a session in are the ones the next session opens in.

| Mode      | What it does                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| `agent`   | The default: the model reads, edits, and runs commands                       |
| `plan`    | Read-only exploration that ends in a written plan; `/implement` runs it      |
| `vibe`    | Plans first, then implements the plan, on every prompt                       |
| `minimal` | Shell only, with no repo map or project context loaded upfront               |
| `chat`    | Plain conversation with a separate history; web tools only                   |
| `shell`   | Your input runs as a shell command, and the output joins the agent's context |

`reika -p "<prompt>"` runs a single turn headless and prints the reply, for scripts and other harnesses. See [docs/usage.md](docs/usage.md) for modes in detail, headless flags, and every slash command.

## Safety

- **Approvals** default to `safe`: ordinary edits and commands run on their own, but anything matching a dangerous pattern (`rm -rf`, force pushes, package installs, `curl`, …) and any write outside the project still asks you first. `bypass` can only be set at launch, never mid-session.
- **Sandbox** (macOS, on by default): model-chosen shell commands can write only inside the project, temp, and cache directories, and have no network apart from loopback and read-only `git`/`gh`. A command you explicitly approve runs unsandboxed. `REIKA_SANDBOX=0` turns it off.

## Documentation

| Doc                                              | Covers                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [Configuration](docs/configuration.md)           | Every `.env` key, experimental flags, named profiles, last-session state                  |
| [Modes, headless, commands](docs/usage.md)       | Each mode in depth, `reika -p`, slash commands, `/save` transcripts                       |
| [Tools](docs/tools.md)                           | The model's tools, approval prompts, web search setup, `.gitignore`                       |
| [Instructions and skills](docs/skills.md)        | `AGENTS.md`, skills as slash commands, plain-English routing, pasted URLs                 |
| [Tested models](docs/models.md)                  | Local quants and APIs Reika has been run against                                          |
| [Architecture and caveats](docs/architecture.md) | How the harness works, and known limitations                                              |
| [Contributing](CONTRIBUTING.md)                  | Scripts, design philosophy, a pointer to `AGENTS.md`, and external contributor guidelines |

## Status

Experimental but stable for daily use. Current testing concentrates on 20–35B models at Q2–Q4 on constrained hardware, alongside cloud models through OpenCode Go and OpenRouter. Output quality in agentic coding will vary more than in plain chat, and more with quantization.

## Inspired by

Claude Code, Codex, Crush, OpenCode, Pi, Aider, DeepSeek Harness, Qwen Code, Kimi Code CLI, Gemini CLI, Junie, and DS4.
