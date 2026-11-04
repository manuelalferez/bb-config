# bb-plugin-usage-battery

A battery in bb's sidebar footer showing how much of your Claude subscription
limit is left. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md).

```
npm install --include=dev
bb plugin install .
bb plugin config usage-battery set mode today              # today | both | weekly | tightest | session
bb plugin config usage-battery set plan '[1,1,1,1,1,0.5,0.5]'  # Mon…Sun weights, 0–2
bb plugin config usage-battery set warnAt 70               # % of today's share used → amber
npm test                                                   # plan, budget and settings (budget.ts, prefs.ts)
npm run typecheck
```
