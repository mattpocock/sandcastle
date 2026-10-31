---
"@ai-hero/sandcastle": patch
---

The exported `OutputDefinition` type is now `OutputObjectDefinition<unknown> | OutputStringDefinition` instead of using `any`. Every `Output.object(...)` value is still assignable to it. Code that reads `.schema` off a plain `OutputDefinition` now gets `unknown` output instead of `any`.
