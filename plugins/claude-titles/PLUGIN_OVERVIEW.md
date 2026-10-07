Let bb write short thread titles and commit messages with your local Claude
Code CLI (Haiku), using your existing Claude login.

## What you get

- A **Claude Code** service in Settings → AI services for thread titles and
  commit messages.
- A new thread is named once from its full first prompt, not bb's
  80-character cut of it. After that the name never changes on its own.
- Clear a thread's name and save it to get a fresh title from the whole
  conversation (your prompts and the agent's latest reply) instead of the
  "Name cannot be empty." error.
- `bb claude-titles retitle <thread-id>... | --all` does the same from the CLI.
- Settings: the model for bb's quick requests (`haiku`), the model for
  conversation titles (`sonnet`), and an optional path to the `claude` binary.

## How it works

Each request runs `claude -p` once, with no tools, MCP servers, settings or
session file, in an empty temporary directory. Thinking is off so a title
arrives in about 2 seconds, well inside bb's 5-second limit.

## Requirements

Claude Code installed and signed in on the machine that runs the bb server.
