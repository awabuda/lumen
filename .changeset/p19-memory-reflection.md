---
"@lumen/memory": minor
---

P19.2.5 refactors the reflection surface to the helper-function pattern.

- `BaseReflector` is now an interface, not an abstract class.
- Adds `createRuleBasedReflector()` and `createLLMReflector()` helper factories.
- Keeps `RuleBasedReflector` and `LLMReflector` exported as function aliases for the helper factories.
- Adds standalone helper functions: `ruleBasedReflect`, `llmReflect`, `persistExtractedFacts`, `buildReflectionPrompt`, `parseReflectionFacts`, and `hashFactId`.
