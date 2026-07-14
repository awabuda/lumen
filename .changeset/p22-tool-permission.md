---
'@lumen/core': minor
---

Add a static, deterministic tool-permission middleware that layers in front of the existing interrupt middleware. Three outcomes (`allow` / `deny` / `ask`), a Zod-validated policy file, and an audit-log state slice.
