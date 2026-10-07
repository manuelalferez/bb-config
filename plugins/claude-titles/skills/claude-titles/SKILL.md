---
name: claude-titles
description: Use, test, or troubleshoot the Claude Titles plugin, which names bb threads from their whole conversation and writes commit messages with the local claude CLI. Use when the user asks to pick Claude Code for titles or commits, test it, retitle threads, change its model or claude path, or when titles are bad or time out.
---

# Claude Titles

The plugin registers the AI service `claude-code` ("Claude Code"). bb sends it
the prompt for a thread title or a commit message. The plugin runs the local
`claude` CLI once (`claude -p`, no tools, no MCP, no settings, no session file)
and returns its reply. It needs Claude Code installed and signed in
(`claude auth status`) on the machine that runs the bb server.

## Select it

```bash
bb settings ai-services set thread-title claude-code
bb settings ai-services set commit-message claude-code   # optional
bb settings ai-services show
```

Settings → AI services offers the same picker. Automatic also tries it after
bb cloud. Use `automatic` to go back to the default.

## Titles from the whole conversation

bb's own title request only sees the first prompt cut to 80 characters, which
gave titles like "I need the actual task" or "Integrar modelo gratuito en".
So the plugin titles every new thread itself, once:

- bb's request for a thread created in the last minute is declined, so bb
  writes nothing.
- On `thread.created` / `thread.active` the plugin titles an untitled thread
  from its full first prompt, in about 4 s with Sonnet.

After that the title never changes on its own, however the conversation moves
on. It only changes when you retitle it by hand (below), which titles it from
the whole conversation: first prompt, the last 8 user messages and the agent's
latest reply.

The prompt asks for the concrete subject (product, feature, ticket or PR ID)
in 2 to 5 words and at most 30 characters, in the user's language, because
the sidebar row fits only about 37 characters. A conversation title over 34
characters is sent back once to be shortened. Anything still longer is cut at
34 characters on a word boundary without a dangling "en", "de" or "for".
bb's own quick request, which has the 5 s limit, is only cut. Replies that talk to the user ("I need…", "Could you…",
anything ending in "?") are rejected. Only messages typed by the user count:
messages sent from another thread (`bb thread tell` from an agent) are left out.

## Retitle by hand

Saving an empty name (sidebar or thread header, Enter or click away) does not
fail with "Name cannot be empty." The plugin closes the editor, titles the
thread from its whole conversation, once. A
failure shows a toast and keeps the old title. The plugin finds the editor by
its "Thread name" label, so a bb update that renames that label turns the
feature off.

```bash
bb claude-titles retitle <thread-id>...   # one or more threads
bb claude-titles retitle --all            # every non-archived thread
```

Both overwrite the current title, including one the user chose, and print
`old → new` per thread.

## Test it

```bash
bb settings ai-services test thread-title
```

A healthy run takes about 2 s. It has no thread, so it goes through the quick
path with the `model` setting. `show` prints the service status; "not ready"
means the plugin found no `claude` binary.

## Settings

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `model` | `haiku`, `sonnet` | `haiku` | Model for bb's quick requests (commit messages, the test), which must finish in 5 s. |
| `conversationModel` | `sonnet`, `haiku` | `sonnet` | Model for thread titles from the conversation; no 5 s limit, 20 s timeout. |
| `claudePath` | absolute path or empty | `""` | Empty detects the binary automatically. |

```bash
bb plugin config claude-titles set model sonnet
bb plugin config claude-titles set claudePath /path/to/claude
```

Automatic detection checks `PATH`, then `~/.local/bin/claude`,
`~/.claude/local/claude`, `/opt/homebrew/bin/claude` and
`/usr/local/bin/claude`. The bb daemon often lacks the shell `PATH`, so set
`claudePath` if claude lives elsewhere.

## The 5-second limit

bb aborts a title or commit task after 5 seconds, and the plugin then kills
the claude process. The plugin sets `MAX_THINKING_TOKENS=0`; without it Haiku
thinks and takes about 6 s, so every title would time out. claude runs in an
empty temporary directory so it loads no `CLAUDE.md`. `sonnet` is slower and
can hit the limit; keep `model` on `haiku`. Titles the plugin writes itself use
`conversationModel` (`sonnet`) and have a 20 s timeout instead.

On failure the error includes claude's stderr. Check `claude auth status` and
the plugin log (`bb plugin logs claude-titles`).
