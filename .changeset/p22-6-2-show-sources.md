---
'@lumen/cli': minor
---

Add `lumen permissions show` source attribution. When the policy file declares `imports:`, the output now includes a `(from <path>)` line for every rule, showing which file each rule came from. The JSON output carries a `_sources` map (rule name → source file path) for the audit log. The `allowOverrides` flag is rendered as a one-line note when set.
