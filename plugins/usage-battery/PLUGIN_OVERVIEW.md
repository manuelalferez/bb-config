A battery at the right end of the sidebar footer that shows how much of your
Claude subscription limit is left, like a laptop battery.

## What you get

- The percentage left and a battery icon, always visible. It turns amber at
  30% left and red at 10%.
- Hover for a card with every window (5-hour, weekly, per-model) and resets;
  click to keep it open.

## Settings

**Battery shows**: `tightest` (default) uses whichever of the 5-hour session or
weekly limit has less left; `session` or `weekly` pins one window.

## How it works

The plugin reads the same Claude Code usage bb's built-in Provider usage card
shows, polling once every 3 minutes on the bb server. Nothing leaves the machine.
