---
"@lumen/cli": minor
---

P56 — `lumen memory show` now reflects the
real on-disk mtime of MEMORY.md / USER.md, not
the 0 default. Pre-P56 the `lastSyncMs` variable
started at 0, so the first `describe()` reported
"last sync: (never)" even when the files existed
on disk. P56 reads the newer of the two mtimeMs
values at bridge construction time.

P56b (follow-up): the pre-P56 path used
`require('node:fs')` to load the sync stat.
apps/cli is ESM (`"type": "module"` in
package.json), so the runtime `require` call
throws. The `safeStatSync` function silently
caught and always returned `undefined`,
leaving `lastSyncMs` at 0. P56b uses the
module-scope `import * as fsSync from 'node:fs'`
so the sync stat actually runs.

Test counts: cli net 0 (1 new test + 1 new
pre-existing FENCE-OFF). 0 new code
regressions.
