# Security policy

## Supported versions

Only the latest release gets security fixes. Reika is 0.x, so a fix ships in the next minor or patch release, not as a backport.

## Reporting a vulnerability

Please report privately, through GitHub's [private vulnerability reporting](https://github.com/alexwkleung/reika/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**). Don't open a public issue for a bypass: it shows everyone how to do it before there is a fix.

Include the model and inference engine or API provider, your OS, the `REIKA_AUTO_APPROVE` mode, and the smallest reproduction you have: a prompt, a command, or a transcript (`/save`).

Reika is maintained by one person, so reports are handled on a best-effort basis. There is no bug bounty.

## What the protections are for

Reika's protections contain a **confused model**: a small, heavily quantized model that guesses a path, invents a package name or runs the wrong command. They are not a defense against a **determined attacker** who controls the model or its input. Reports are judged against that line.

### In scope

A way around one of these, under the default `safe` approval mode:

- **The sandbox** (macOS, `REIKA_SANDBOX` on): a model-chosen shell command that writes outside the project, temp and cache directories, or reaches the network beyond loopback and the unflagged `git`/`gh` commands it allows.
- **The approval gate:** a command matching a dangerous pattern (destructive commands, installs, pushes, `curl`/`wget`, …), or a `write`/`edit` to a path outside the project, that runs without a prompt.
- **The exfiltration guard:** data leaving through a URL the model built. That covers a `fetch_url` or a `git`/`gh` remote that carries data and appears nowhere in your messages or tool results, and that is fetched or pushed without a prompt.
- **Credential handling:** Reika passing its API keys or your environment to an MCP server, a fetched page or a model request where it isn't meant to. MCP servers inherit only a fixed set of variables such as `HOME` and `PATH`.
- **MCP approval:** a call to a server marked `"approve": "always"` that runs without a prompt.

### Out of scope

- Anything under `REIKA_AUTO_APPROVE=bypass` or `REIKA_SANDBOX=0`. Both turn protections off on purpose.
- Actions you approved at a prompt.
- Platforms without the sandbox. Linux and Windows have none; see [Platforms](docs/platforms.md).
- **Reads.** The sandbox confines writes and network, not reads, and `read` can open files outside the project. At a broad working directory (your home folder), that includes files like `~/.ssh`. This is documented, not a bug.
- **The project-path check is a string comparison.** A symlink inside the project that points outside it is followed. Kernel-level confinement of `write`/`edit` is not implemented.
- **Prompt injection in general.** A fetched page, file or tool result can contain instructions, and a model may follow them. Reika labels fetched pages as untrusted and puts the protections above in the way, but it does not claim to stop injection. A specific bypass of one of the in-scope protections is in scope, whatever the model was told.
- Behavior of MCP servers themselves. They are third-party programs you choose to run, and they run outside the sandbox.
- Scrollback redaction (`REIKA_ANON`). It is display-only and never a security boundary.
