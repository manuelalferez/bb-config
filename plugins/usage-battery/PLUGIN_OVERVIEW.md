A battery at the right end of the sidebar footer that shows how much of your
Claude subscription limit is left, like a laptop battery.

## What you get

- A pill with the percentage left and the time until that window resets
  (`● 13% · 6d 11h`), always visible. By default the percentage is what is left
  of today's share of the weekly limit. It turns amber at 30% of the window
  left and red at 10%.
- A **Today** row at the top of the card: today's share of the weekly limit,
  as a bar that empties as you use it and one number ("13% left"). Saturday
  and Sunday get half a weekday's share, and every day re-plans from what is
  actually left.
- Hover for a card with every window (5-hour, weekly, per-model) and resets;
  click to keep it open.

## Settings

**Battery shows**: `today` (default) shows what is left of today's share of
the weekly limit; `tightest` uses whichever of the 5-hour session or weekly
limit has less left; `session` or `weekly` pins one window.

## How it works

The plugin reads the same Claude Code usage bb's built-in Provider usage card
shows, polling once every 3 minutes on the bb server. Nothing leaves the machine.
Once a day it stores the weekly % left at the day's first reading, which sets
that day's share (`budget.ts`).
