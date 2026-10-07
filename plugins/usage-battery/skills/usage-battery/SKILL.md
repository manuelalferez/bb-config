---
name: usage-battery
description: Change or troubleshoot the Usage Battery plugin, the battery at the right end of bb's sidebar footer that shows how much Claude subscription limit is left.
---

# Usage Battery

The footer battery shows the Claude usage LEFT (100% minus used). Clicking it
opens a card with every window (5h, 7d, per-model) and its reset time.

## Setting

`mode` picks the window the battery shows:

- `tightest` (default): whichever of the 5h session or weekly limit has less left
- `session`: the 5-hour window only
- `weekly`: the weekly window only

```bash
bb plugin config usage-battery set mode session
```

## Troubleshooting

- `bb plugin rpc call usage-battery state` prints the snapshot the footer reads.
- The server polls `usageLimits` every 3 minutes and backs off on errors, up to
  30 minutes. Check `bb plugin logs usage-battery` for the cause.
- The battery is placed into bb's footer DOM, which is not a versioned API. If
  a bb update moves the footer, the plain battery icon stays and still opens
  the card.
