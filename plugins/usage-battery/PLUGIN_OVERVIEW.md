A battery at the right end of the sidebar footer that shows how much of your
Claude subscription limit is left, like a laptop battery.

## What you get

- A pill with the percentage left and the time until that window resets
  (`● 13% · 6d 11h`), always visible. By default the percentage is what is left
  of today's share of the weekly limit. It turns amber at 30% of the window
  left and red at 10%, and also amber once 70% of today's share is used and
  red when it is gone.
- A **Today** row at the top of the card: today's share of the weekly limit,
  as a bar that empties as you use it and one number ("13% left"). Every day
  re-plans from what is actually left.
- Hover for a card with every window (5-hour, weekly, per-model) and resets;
  click to keep it open.
- A gear in the card opens its settings: your daily plan as seven bars to drag
  (presets Even, Lighter weekends, Weekdays only), when to warn, what the pill
  shows (Today, Week or Both), and whether the Today row appears.

## Settings

Saved on the bb server, so every device shows the same. Editable from the
card, Settings → Installed plugins, or `bb plugin config usage-battery set …`:

- **Battery shows** (`mode`): `today` (default), `both`, `weekly`, `tightest`
  (whichever of the 5-hour session or weekly limit has less left) or `session`.
- **Daily plan** (`plan`): each weekday's weight, Monday first, from 0 (a day
  off) to 2. Default `[1,1,1,1,1,0.5,0.5]`: weekends count half.
- **Warn about today's share** (`warn`, `warnAt`): on, at 70% used.
- **Show the Today row in the card** (`todayRow`): on.

## How it works

The plugin reads the same Claude Code usage bb's built-in Provider usage card
shows, polling once every 3 minutes on the bb server. Nothing leaves the machine.
Once a day it stores the weekly % left at the day's first reading; that and the
plan set the day's share (`budget.ts`).
