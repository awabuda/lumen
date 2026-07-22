---
name: loop
description: Schedule a periodic prompt via cron. Wraps `IntervalCron` so the user can say `/loop 5m check disk space`.
triggers:
  - kind: keyword
    value: /loop
    weight: 0.9
  - kind: keyword
    value: every minute
  - kind: keyword
    value: hourly reminder
---

# /loop Skill

> P23.11 (fix #69) — `/loop` skill. Reads the cron expression
> (interval or cron string) from `$ARGUMENTS` and registers an
> `IntervalCron` / `OnceCron` (P20.2 baseline already supports
> both). The skill contributes a 2-line instruction: parse the
> expression, attach the cron to the active session, and report
> the next fire time.
>
> The skill is *parameter-aware*: `/loop 5m …`, `/loop hourly …`,
> `/loop "*/5 * * * *" …` all funnel through `expandTemplate`
> on `$ARGUMENTS` + `$CRON` named param.

## Usage

When the user runs `/loop <interval> <prompt>`:

1. Parse `$ARGUMENTS` (or `$INTERVAL` / `$CRON` named) into a
   cron schedule.
2. Register via `new IntervalCron({ id, intervalMs: …, job })`
   or `new OnceCron({ id, at: …, job })` from
   `@lumen/core/src/cron`.
3. Emit a confirmation: `[loop] registered <id>, next fire <ts>`.

## Notes

- The skill does **not** start the cron itself — the
  composition root handles `cron.start()`. The skill only
  *registers* it.
- Multiple registrations accumulate; teardown is via
  `cron.stop()` when the user runs `/loop stop` (empty arg).
