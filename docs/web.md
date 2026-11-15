# Web front end

[← README](../README.md)

`reika web` serves the same agent to a browser tab on this machine. It is the same session as the
terminal UI: the same modes, tools, approvals, context handling and auto-save, drawn in a browser
instead of a terminal. It is **experimental**.

## Start it

```sh
cd your-project && reika web
```

Reika prints a link. Open it in a browser on the same machine. The link works once, within ten
minutes, and signs in that one tab. Press Enter in the terminal for a fresh link: for a second tab,
or after the first one expired. ctrl-c stops the server, saving the conversation first.

```sh
reika web --window
```

Opens the page in an app window instead: no tabs and no address bar (on macOS, its own Dock icon). It
uses Chrome, Edge, Brave or Chromium, whichever it finds first (`REIKA_CHROME_PATH` points it at
another). Without any of those it opens a tab in your default browser and says so.

- **Closing the window stops Reika**, the same way ctrl-c does. A reload does not, and a tab you
  opened from the terminal's Enter link keeps Reika running until it closes too.
- **The window has its own browser profile**, under `~/.config/reika/window/`, so it never touches
  your everyday browser's tabs or sign-ins.
- **If the window shows an error** or never signs in, the terminal prints a fresh link after about
  20 seconds.

`--port <n>` picks the port. By default it takes a free one.

## The page

- **The transcript** draws the turn as the terminal does: tool calls and their results, diffs,
  command output, Thinking blocks (the end of the thought in view, the whole of it behind the
  `· N lines` toggle), the plan checklist and the busy line with its spinner.
- **The input box** takes what the terminal's does: `/` for commands and `@` for files, both with
  completion; ↑ and ↓ for the lines you sent; a line ending in `\` continues on the next line instead
  of sending. A large paste is parked behind a marker, as in the terminal. While a turn runs, Enter
  queues the line and Esc in an empty box stops the turn.
- **Two pills under the input** switch the mode and the model. They are off while a prompt runs or
  waits, since a switch then would change what the waiting line was typed for.
- **The status line** shows the approval mode, how full the context is, the token counts, decode
  speed, cache hits, the branch's PR and the project folder.
- **Approvals and questions** open as a card above the input. Number keys pick an option.
- **History** lists this project's saved sessions, newest first, with a filter and a switch for
  your `/save` transcripts. Opening one replaces the conversation in place, as `/resume` does, and
  New conversation is `/new`. Both wait until no prompt is running. On a wide window history is a
  pane beside the chat that you can collapse; on a narrow one it opens over the page.

## Not yet

- **Pasting or dropping images.** The page refuses them for now; use the terminal, or an `@` path
  to the image.
- **More than one session per server.** The page drives one conversation. Opening a saved one
  replaces it rather than opening a second.
- **Joining a terminal session.** A browser tab cannot attach to a `reika` already running in a
  terminal. Each `reika web` is its own session.

## Security

The page can do whatever the agent can, so the server is locked down to this machine and this
link:

- It listens on `127.0.0.1` only, and refuses any request whose `Host` or `Origin` is not that
  address, which stops another site or a DNS-rebinding trick from reaching it.
- The link carries a one-time code in the part of the URL a browser never sends (after the `#`). A
  tab trades it for a token it keeps for that tab alone (session storage), and every request after
  that carries the token. There are no cookies.
- `--window` never puts the link on a command line, where other users on the machine could read it
  from the process list. The browser opens a private redirect file instead, deleted as soon as the
  code is used.
- Everything the page sends goes through the same approval gate and shell sandbox as the terminal.

## Configuration

| Key                   | Default | What                                                                      |
| --------------------- | ------- | ------------------------------------------------------------------------- |
| `REIKA_CHROME_PATH`   | _unset_ | The browser `--window` opens (and web search drives), instead of a search |
| `REIKA_WORKING_WORDS` | `1`     | `0` shows "Working" on the busy line instead of rotating verbs            |

Everything else is shared with the terminal; see [Configuration](configuration.md).
