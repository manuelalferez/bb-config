# bb-plugin-claude-titles

bb plugin that registers the `claude-code` AI service: bb's thread titles and
commit messages are written by the local `claude` CLI (Haiku). Its frontend
also turns an empty thread rename into a regenerated title.

```bash
npm install --include=dev
npx tsc -p .
bb plugin build
bb plugin install . --yes
bb settings ai-services set thread-title claude-code
bb settings ai-services test thread-title
```

See [skills/claude-titles/SKILL.md](skills/claude-titles/SKILL.md) for
settings and the 5-second limit.
