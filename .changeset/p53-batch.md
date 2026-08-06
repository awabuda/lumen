---
"@lumen/cli": minor
---

P53 — `lumen apply-patch <file>`'s `fsApplier.write`
now `mkdirSync` the parent directory before
writing. Pre-P53 the write call required the
parent directory to exist; an `ENOENT` on a
missing parent surfaced as a failure in the
patch result. The V4A spec is fine with
creating new files in new directories; this
is the natural place to mkdir.

The 1-line addition (`fs.mkdir(...).then(fs.writeFile)`
chain in `fsApplier.write`) is the minimal
fix. We do NOT add a recursive=True arg since
`fs.mkdir(path.dirname(abs), { recursive: true })`
is the idiomatic Node.js pattern. The patch
is a no-op for the existing Update / Delete
hunks (only `*** Add File:` writes a fresh
file).

Test counts: cli 460 → 461 (+1); monorepo
1963 → 1964 (+1). 0 regressions introduced
(7 pre-existing failures + 1 tools pre-existing
failure remain FENCE-OFF).
