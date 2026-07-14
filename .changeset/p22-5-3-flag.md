---
'@lumen/cli': minor
---

Add `lumen run --auto-mode` flag. Surfaces a one-line status based on the policy file's `autoMode.enabled` flag. The flag does NOT override the policy file; the file is the source of truth. Requires `--permissions <path>`.
