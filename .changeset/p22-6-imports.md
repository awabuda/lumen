---
'@lumen/core': minor
'@lumen/cli': minor
---

Add P22.6.0 cross-policy imports. The policy file gains an optional `imports: string[]` list; the loader walks the imports in order with cycle detection (typed `ConfigError`). Merged fields: `rules` (appended in declaration order, first match wins), `autoMode` (last import wins, but `neverAllowTools` is deduped across all imports; `hardDenyPatterns`/`allowPatterns`/`softDenyPatterns` are concatenated). The root policy's `default` and `version` always win.
