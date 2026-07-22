---
name: cost
description: Surface the current run's budget usage (tokens, cost USD, wall time) so the agent can decide whether to continue.
triggers:
  - kind: keyword
    value: /cost
    weight: 0.9
  - kind: keyword
    value: cost so far
  - kind: keyword
    value: budget used
---

# /cost Skill

> P23.11 (fix #71) — `/cost` / `/usage` skill. Reads the
> `Budget` state from the active run, formats a compact usage
> summary, and contributes it as a system-prompt fragment when
> the user asks about cost / usage / budget so far.
>
> The skill is *parameter-aware*: `$ARGUMENTS` accepts an
> optional scope like `tokens`, `usd`, or `time`. Unknown
> scope returns the full breakdown.

## Usage

When the user runs `/cost` (or asks "how much have we spent?"),
read the budget state via the run's `Budget.timeMsConsumed` /
`costUsdConsumed` getters (added in P23.6) and emit a one-line
summary in this format:

```
[cost] tokens=… cost=$… time=…
```

## Notes

- `Budget.costUsdConsumed` is the run's cumulative cost in USD;
  it is only meaningful when the upstream reports `usage.costUsd`.
- `Budget.timeMsConsumed` is wall time; not the model-thinking
  time or the tool-execution time.
- `Budget.used` exposes a single token-rollup counter for
  quick checks.
