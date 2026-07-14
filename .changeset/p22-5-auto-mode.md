---
'@lumen/core': minor
---

Add a heuristic risk-tiered auto-mode classifier and middleware. Three outcomes (`allow` short-circuits the interrupt chain, `ask` falls through, `deny` throws a typed `AbortError`). The risk table is core-shipped (read_file / list_dir / search_files = low, write_file = medium, terminal = high); the operator can opt a tool out via `neverAllowTools` or force-deny via `hardDenyPatterns`. The classifier is deterministic — no LLM in the runtime path.
