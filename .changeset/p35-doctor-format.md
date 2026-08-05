---
"@lumen/cli": minor
---

P35 — `lumen doctor --format json` (Phase C.2 first slice).

`lumen doctor` gains a `--format json` flag that
emits a single JSON array of `DoctorRow` objects.
The human path is unchanged. CI pipelines can grep
a single severity vocabulary (`OK` / `WARN` / `FAIL`)
and `jq` for specific sections.

Shape:

```json
[
  { "severity": "OK", "section": "config", "message": "...", "hint": "" },
  { "severity": "FAIL", "section": "api-key", "message": "...", "hint": "export OPENAI_API_KEY..." }
]
```

Surface:

- `apps/cli/src/commands/doctor-format.ts` (new):
  `buildDoctorRows(options)` — pure async helper that
  walks the same 10 infrastructure checks the human
  path does, plus the 6 G-P* product gates when
  `options.product === true`. Returns a deterministic
  section order so diffs are stable.
- `apps/cli/src/commands/doctor.ts` — `DoctorOptions`
  gains `format?: 'human' | 'json'`. The JSON path
  short-circuits at the top of `doctorCommand`.
- `apps/cli/src/index.ts` — `lumen doctor` registers
  `--format <fmt>` (default `'human'`).
- `apps/cli/test/doctor-format.test.ts` — 6 tests
  (shape, core sections, product gates on/off,
  FAIL hints, deterministic order).

Test counts: cli 395 → 401 (+6); monorepo 1900
tests / 0 fail / biome clean on touched files.