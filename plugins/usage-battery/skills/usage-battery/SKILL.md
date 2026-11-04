---
name: usage-battery
description: Change or troubleshoot the Usage Battery plugin, the battery at the right end of bb's sidebar footer that shows how much Claude subscription limit is left.
---

# Usage Battery

The footer battery shows the Claude usage LEFT (100% minus used). Hovering it
opens a card with every window (5h, 7d, per-model) and its reset time; clicking
pins the card open until it is closed.

The card's first row, **Today**, is what is left of today's share of the weekly
limit ("13% left"). The share splits what is left over the days until the
weekly reset: work hours 09–21 count, a Saturday or Sunday weighs half a
weekday, and each day re-plans from the % left at its first reading (one
snapshot a day, kept in plugin storage). The formula lives in `budget.ts`.

## Setting

`mode` picks the window the battery shows:

- `today` (default): what is left of today's share of the weekly limit, with
  the weekly reset time (`● 13% · 6d 11h`); the colour follows the weekly window
- `tightest`: whichever of the 5h session or weekly limit has less left
- `session`: the 5-hour window only
- `weekly`: the weekly window only

```bash
bb plugin config usage-battery set mode today
```

## Troubleshooting

- `bb plugin rpc call usage-battery state` prints the snapshot the footer reads;
  `today` is null until the first reading of the day, outside 09–21 on the
  reset day, or when there is no weekly window.
- Days are local to the host running the bb server.
- The server polls `usageLimits` every 3 minutes and backs off on errors, up to
  30 minutes. Check `bb plugin logs usage-battery` for the cause.
- The battery is placed into bb's footer DOM, which is not a versioned API. If
  a bb update moves the footer, the plain battery icon stays and still opens
  the card.
