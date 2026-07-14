---
'@lumen/cli': minor
---

Add `lumen run --permissions <path>` and `lumen chat --permissions <path>` flags. The flag loads a YAML tool-permission policy file via a hand-rolled YAML subset parser; a missing or malformed file surfaces a typed `ConfigError` at composition time.
