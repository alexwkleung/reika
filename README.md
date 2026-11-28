<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reika-dark.svg">
    <img alt="Reika" src="docs/assets/reika-light.svg" width="262">
  </picture>
</p>

<p align="center">
  A coding agent CLI for local and hosted models,<br>
  designed around small local models first.
</p>

<p align="center">
  <a href="https://reikacode.com">Website</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="docs/models.md">Tested models</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

![Reika fixing a retry helper and its test with a local model](docs/demo.gif)

<sup>A real local run of Qwen3.6 35B A3B (Unsloth UD-IQ2_M) via llama.cpp, sped up 3×. The model fixes its own indentation, adds a test for the delays, and the tests pass on the first run.</sup>

Reika is a coding agent CLI for local and hosted models. It was designed around small local models first (8B–35B, often at Q2–Q4, on a 16–32k context window), so it is careful with context, fails gracefully, and tells you when it's stuck. It doesn't make a small model smarter, but it makes working with one less frustrating.

It gets used and tested on both small local models and large hosted ones. In testing, 14–35B models handled multi-file tasks most reliably, 8–9B models managed simple, well-scoped ones, and 4B-class models rarely got past short tasks. Reika is pre-1.0, so commands, settings and behavior can still change between releases.

## Highlights

- **Context discipline.** Old tool output collapses to one-line summaries, the engine's prompt cache is kept valid, and before older turns are folded away the model writes down what it found.
- **Loop breaking.** Repeated reads and runaway reasoning are caught and answered in escalating steps, ending in an honest stop instead of a 30-minute spiral.
- **Checks on the model's work.** Edits to unread files go back for a read first, TypeScript edits are typechecked, and plan progress is tracked from what actually happened.
- **A mode for the job.** Agent mode does the work by default; plan, grind, minimal and chat are there when a task calls for them (see [Modes](#modes)).
- **Safe by default.** Dangerous commands still prompt, and on macOS shell commands run in a kernel sandbox. No telemetry.
- **Extensible.** Stdio MCP servers add tools, and Markdown skills become slash commands, with `/issue` and `/review` built in.
- **Built for slow local engines.** It waits out long prefills, handles models without a native tool-call template, and shows decode speed, context fill and cache hits in the status bar.

## What the measurements say

Reika's design choices were measured rather than assumed, and the results are published in [docs/findings.md](docs/findings.md). A few of them:

- **The harness's own context management cost more than the model did.** One rewrite mid-context re-processed 8,453 tokens (7.9 minutes of prefill); an append cost 25 tokens and 3.5 seconds.
- **A small model takes tool output literally.** A loop blamed on a 35B at Q2 turned out to be Reika feeding the model its own tool-call markup.
- **Prompt wording is the weakest lever.** On a vague task at Q2 a model spirals about half the time. The harness can't change that rate, only what the failing half costs.

## Requirements

- Node.js 22 or newer (macOS 11+ or glibc 2.28+ Linux — see [Platforms](docs/platforms.md)).
- An OpenAI-compatible model server: llama.cpp, MLX, vLLM, or a cloud API.
- macOS is the primary platform. Linux works, but without the shell sandbox or image-paste OCR (set `REIKA_VISION_MODEL` to read pasted images with a vision model instead). Windows may work under WSL2.
- A modern terminal such as iTerm2, Ghostty or Kitty, so the TUI renders properly.

## Quick start

Install it with any of these (npm and pnpm need Node ≥ 22; Homebrew pulls Node in):

```sh
npm i -g @alexwkleung/reika
pnpm add -g @alexwkleung/reika
brew install alexwkleung/tap/reika
```

Serve a model, for example with llama.cpp, then point Reika at it:

```sh
llama-server -m <model.gguf> -c 24576 --jinja <other-launch-args>
export REIKA_MODEL=model  # or put it in ~/.config/reika/.env
cd your-project && reika
```

[Install and first run](docs/getting-started.md) covers hosted APIs, the default port, the context window and running from a checkout.

Prefer a window to a terminal? `reika web` serves the same agent to a browser tab on this machine, and `reika web --window` opens it in its own app window. It's experimental; [docs/web.md](docs/web.md) covers what it does and what it doesn't do yet.

![Reika's web front end in its own window: the history pane, a diff from an edit, and the input box](docs/web.png)

## Common configuration

Set these in your shell, a project `.env`, or `~/.config/reika/.env` (in that order of precedence). The full list, experimental flags, and multi-model profiles are in [docs/configuration.md](docs/configuration.md).

| Key                    | Default                    | What                                                                                  |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| `REIKA_MODEL`          | _required_                 | Model name, or a comma-separated list served by the same endpoint                     |
| `REIKA_BASE_URL`       | `http://localhost:9931/v1` | OpenAI-compatible endpoint                                                            |
| `REIKA_API_KEY`        | `no-key`                   | API key (any non-empty value for local servers)                                       |
| `REIKA_CONTEXT_WINDOW` | _probed from the server_   | Context window in tokens; drives compaction, the context gauge, and the repo map size |
| `REIKA_MIN_GEN_TOKENS` | _learned_ (from `2048`)    | Room reserved for the reply; learned from the model's rounds, set it to pin           |
| `REIKA_AUTO_APPROVE`   | `safe`                     | `off` confirms every edit and command; `bypass` confirms nothing                      |

## Modes

`Shift+Tab` cycles through the modes, or switch with a slash command. The next session opens in the mode and model you ended the last one in.

| Mode      | What it does                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| `agent`   | The default: the model reads, edits, and runs commands                       |
| `plan`    | Read-only exploration that ends in a written plan; `/implement` runs it      |
| `vibe`    | Plans first, then implements the plan, on every prompt                       |
| `minimal` | Shell only, with no repo map or project context loaded upfront               |
| `grind`   | Agent turns run a fixed, careful procedure: define done, test, review        |
| `chat`    | Plain conversation with a separate history; web tools only                   |
| `shell`   | Your input runs as a shell command, and the output joins the agent's context |

`reika -p "<prompt>"` runs a single turn headless and prints the reply, for scripts and other harnesses. See [docs/usage.md](docs/usage.md) for modes in detail, headless flags, and every slash command.

## Safety and privacy

- **Approvals** default to `safe`: ordinary edits and commands run on their own, but a dangerous command (`rm -rf`, a force push, a package install, `curl`) or a write outside the project still asks you first. `bypass` can only be set at launch, never mid-session.
- **Sandbox** (macOS, on by default): model-chosen shell commands can write only inside the project, temp, and cache directories, and have no network apart from loopback and read-only `git`/`gh`. A command you explicitly approve runs unsandboxed. `REIKA_SANDBOX=0` turns it off.
- **No telemetry.** Your code goes to the model server you configure and nowhere else: with a local server it never leaves your machine, and with a cloud API it goes to that provider. The only other requests are the web tools (when the model uses one or you paste a link), a download of the public models.dev catalog to look up context limits (hosted endpoints only, and never with your data), and whatever the MCP servers you configure do on their own. [Privacy and data](docs/privacy.md) lists every request and every file Reika writes.

Found a way around one of these? Report it privately; see [SECURITY.md](SECURITY.md).

## Documentation

The same pages are on the website, [reikacode.com](https://reikacode.com).

| Doc                                              | Covers                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [Install and first run](docs/getting-started.md) | Requirements, installing, serving a model, and the first run                                |
| [Configuration](docs/configuration.md)           | Every `.env` key, experimental flags, named profiles, last-session state                    |
| [Modes, headless, commands](docs/usage.md)       | Each mode in depth, `reika -p`, slash commands, `/save` transcripts                         |
| [Web front end](docs/web.md)                     | `reika web` and `--window`: the page, history, what is not there yet, how it is locked down |
| [Tools](docs/tools.md)                           | The model's tools, approval prompts, web search setup, MCP servers, `.gitignore`            |
| [Instructions and skills](docs/skills.md)        | `AGENTS.md`, skills as slash commands, plain-English routing, pasted URLs                   |
| [Tested models](docs/models.md)                  | Local quants and APIs Reika has been run against                                            |
| [Findings](docs/findings.md)                     | The measured record: what broke, what held, and how each number was obtained                |
| [Platforms](docs/platforms.md)                   | Requirements, running on a weak machine, what differs on Linux and Windows                  |
| [Architecture and caveats](docs/architecture.md) | How the harness works, and known limitations                                                |
| [Privacy and data](docs/privacy.md)              | Every network request Reika makes, every file it writes, and how to turn each one off       |
| [Contributing](CONTRIBUTING.md)                  | Scripts, design philosophy, a pointer to `AGENTS.md`, and external contributor guidelines   |
| [Changelog](CHANGELOG.md)                        | What changed in each release                                                                |

## Inspired by

Claude Code, Codex, Crush, OpenCode, Pi, Aider, DeepSeek Harness, Qwen Code, Kimi Code CLI, Gemini CLI, Junie, DS4, and Ante.

## Citation

If you use Reika in your work, you can cite it as:

```bibtex
@software{reika2026,
  author = {Leung, Alex},
  title  = {Reika},
  year   = {2026},
  url    = {https://github.com/alexwkleung/reika}
}
```

GitHub's "Cite this repository" button gives the same entry in other formats, from [CITATION.cff](CITATION.cff).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Supporting our work

If Reika is useful to you, consider supporting it via [GitHub Sponsors](https://github.com/sponsors/alexwkleung), [Ko-fi](https://ko-fi.com/alexwkleung), or [Buy Me a Coffee](https://buymeacoffee.com/alexwkleung). See [Support](docs/support.md) for what it funds and other ways to help.

## Contact

Bugs go to [GitHub Issues](https://github.com/alexwkleung/reika/issues), questions and ideas to [Discussions](https://github.com/alexwkleung/reika/discussions), and security reports go through [SECURITY.md](SECURITY.md). For anything else, email [hello@reikacode.com](mailto:hello@reikacode.com).
