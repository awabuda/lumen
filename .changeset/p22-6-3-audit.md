---
'@lumen/cli': minor
---

Add `lumen permissions audit [--format human|json|csv]`. The audit walks the policy file (and any `imports:`), and emits one row per rule with the rule name, the tools it covers, the decision, the absolute path of the file the rule came from, and the SHA-256 hash of that file. The JSON output is a stable `PermissionsAuditReport` suitable for `git`-pinned audit logs. The CSV output is a flat table for spreadsheet import. The human output is a markdown-style list.
