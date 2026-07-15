---
'@lumen/core': minor
'@lumen/cli': minor
---

Add P22.6.1 managed-only lockout. The policy file gains an optional `allowOverrides: boolean` field (default `false`). When `false`, a rule in an imported file whose `name` collides with a root rule is dropped (the root wins — the secure default). When `true`, the imported rule replaces the root rule (last-import-wins; useful for tests). The flag mirrors Claude Code's `allowManagedPermissionRulesOnly`.
