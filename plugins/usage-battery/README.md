# bb-plugin-usage-battery

A battery in bb's sidebar footer showing how much of your Claude subscription
limit is left. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md).

```
npm install --include=dev
bb plugin install .
bb plugin config usage-battery set mode today   # today | tightest | session | weekly
npm test                                        # the daily budget (budget.ts)
```
