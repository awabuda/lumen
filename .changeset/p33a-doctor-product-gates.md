---
'@lumen/cli': minor
---

P33.A — `lumen doctor --product` product-gate diagnostic surface.

Adds a new opt-in `--product` flag to `lumen doctor` that runs
G-P1..G-P6 product-completeness gates from
`docs/OPTIMIZATION-PLAN.md` §0.5 after the existing 10 infrastructure
checks. Each gate emits one `[OK] / [WARN] / [FAIL]` row so a CI
gate can grep the output. Product FAIL rows do NOT bump the doctor
exit code (they are informational, mirroring the WARN path); only
infrastructure FAIL rows do.

`apps/cli/src/product-gates.ts` exports 6 pure helpers
(`gateG_P1_openBoxUsability` … `gateG_P6_profileBare`) plus a
`runAllGates` aggregator. Each helper returns
`{ gate, severity: 'OK'|'WARN'|'FAIL', message, hint }` —
severity model follows the L1-AUDIT "honest diagnostic" rule:
FAIL rather than OK when the dependency is shipped but the UX
still needs polish, so the FAIL rows remain visible. Today the
G-P1 / G-P6 gates ship FAIL (the FS workspaceRoot + ToolRisk
dispatch + default-middleware-order work is the P33.B+ sweep, see
`docs/OPTIMIZATION-PLAN.md` §7 Day1-Day5).

`apps/cli/src/commands/doctor.ts` lazy-imports
`product-gates.js` only when `--product` is passed; the existing
`doctor` call sites remain zero-cost.

9 vitest cases in `apps/cli/test/product-gates.test.ts` pin the
severity-membership contract + the `runAllGates` ordering.

Refs: TASKS.md §P33.A; `docs/OPTIMIZATION-PLAN.md` §0.5 / §7.
