# Web front end

[← README](../README.md)

`reika web` serves the same agent to a browser tab on this machine. It is the same session as the
terminal UI: the same modes, tools, approvals, context handling and auto-save, drawn in a browser
instead of a terminal. It is **experimental**.

![Reika's web front end in its own window: the history pane, a diff from an edit, and the input box](web.png)

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
  completion; ↑ and ↓ for the lines you sent; Shift+Enter, or a line ending in `\`, continues on
  the next line instead of sending. A large paste is parked behind a marker, as in the terminal. While a turn runs, Enter
  queues the line and Esc in an empty box stops the turn.
- **Images** go in by pasting (⌘V or Ctrl+V) or dropping a PNG, JPEG, WebP or GIF of up to 32 MB
  on the box, up to 8 per message. Each lands as an `[Image N]` marker in the text and a chip under
  it, and is read straight away, the same way the terminal reads a pasted one: described by your
  vision model or system OCR, or sent as it is to a model that can see (see
  [Images](configuration.md#images)). The chip shows how many characters came out, or why the
  image could not be read; click its thumbnail to see the image full size, and × to remove it.
  Enter waits until every image is read. Once sent, a line under your prompt says what was read
  from each image.
- **Two pills in the input box** switch the mode and the model. They are off while a prompt runs or
  waits, since a switch then would change what the waiting line was typed for.
- **The status line** shows the approval mode, how full the context is, the token counts, decode
  speed, cache hits, the branch's PR and the project folder.
- **Approvals and questions** open as a card above the input. A number key moves to that option
  and Enter answers, so a stray key never answers for you; on an approval, `y` and `n` move to Yes
  and No; the arrow keys step through the options, and so does the pointer. An approval takes a
  reason to send with No. A question takes your own answer instead of an option, or a note to send
  with the option you pick. Esc cancels a model or session picker and a question asked before
  sending; on an approval or the model's question it stops the turn, declining or dropping it, as
  the stop button does.
- **History** lists this project's saved sessions, newest first, with a filter and a switch for
  your `/save` transcripts. Opening one replaces the conversation in place, as `/resume` does, and
  New conversation is `/new`. Both wait until no prompt is running. On a wide window history is a
  pane beside the chat that you can collapse; on a narrow one it opens over the page.

## Not yet

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
- An image goes up with the same token, as the image's own bytes, and the server checks that they
  are the image type they claim to be. What was read from it stays on the server; the thumbnail is
  drawn from the browser's own copy of the file.
- Everything the page sends goes through the same approval gate and shell sandbox as the terminal.

## Configuration

| Key                   | Default | What                                                                      |
| --------------------- | ------- | ------------------------------------------------------------------------- |
| `REIKA_CHROME_PATH`   | _unset_ | The browser `--window` opens (and web search drives), instead of a search |
| `REIKA_WORKING_WORDS` | `1`     | `0` shows "Working" on the busy line instead of rotating verbs            |

Everything else is shared with the terminal; see [Configuration](configuration.md).
