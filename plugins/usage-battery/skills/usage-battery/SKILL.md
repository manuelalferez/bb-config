---
name: usage-battery
description: Change or troubleshoot the Usage Battery plugin, the battery at the right end of bb's sidebar footer that shows how much Claude subscription limit is left.
---

# Usage Battery

The footer battery shows the Claude usage LEFT (100% minus used). Hovering it
opens a card with every window (5h, 7d, per-model) and its reset time; clicking
pins the card open until it is closed. The gear in the card opens its settings.

The card's first row, **Today**, is what is left of today's share of the weekly
limit ("13% left"). The share splits what is left over the days until the
weekly reset by the **daily plan**: work hours 09–21 count, each weekday weighs
its plan weight (by default a weekday 1, Saturday and Sunday 0.5), and each day
re-plans from the % left at its first reading (one snapshot a day, kept in
plugin storage). A day the plan weighs 0 is a day off: the row says "day off"
and the pill shows the week. The formula lives in `budget.ts`.

## Settings

One set on the bb server, the same on every device. Change them from the
card's gear, bb's Settings page, or the CLI:

- `mode`, what the pill shows:
  - `today` (default): what is left of today's share, with the weekly reset
    time (`● 13% · 6d 11h`)
  - `both`: today's share and the week (`● 13% / 93% · 6d 11h`)
  - `weekly`: the weekly window only
  - `tightest`: whichever of the 5h session or weekly limit has less left
  - `session`: the 5-hour window only
- `plan`: seven weights, Monday first, 0 to 2, as JSON. Presets in the card:
  Even `[1,1,1,1,1,1,1]`, Lighter weekends `[1,1,1,1,1,0.5,0.5]` (default),
  Weekdays only `[1,1,1,1,1,0,0]`; anything else is Custom.
- `warn` (default on) and `warnAt` (50–100, default 70): the pill turns amber
  once `warnAt`% of today's share is used and red when the share is gone. The
  week's own levels (amber at 30% left, red at 10%) still apply.
- `todayRow` (default on): whether the card shows the Today row.

```bash
bb plugin config usage-battery set mode today
bb plugin config usage-battery set plan '[1,1,1,1,1,0,0]'
bb plugin config usage-battery set warnAt 80
```

## Troubleshooting

- `bb plugin rpc call usage-battery state` prints the snapshot the footer reads,
  with the effective settings; `today` is null until the first reading of the
  day, outside 09–21 on the reset day, or when there is no weekly window.
  A `today.budgetPercent` of 0 is a day off.
- Days are local to the host running the bb server.
- The server polls `usageLimits` every 3 minutes and backs off on errors, up to
  30 minutes. Check `bb plugin logs usage-battery` for the cause.
- The battery is placed into bb's footer DOM, which is not a versioned API. If
  a bb update moves the footer, the plain battery icon stays and still opens
  the card.
