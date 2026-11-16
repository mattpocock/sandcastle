---
"@ai-hero/sandcastle": patch
---

Declare `@standard-schema/spec` as a dependency. The public types (`Output.object`'s `schema`) import `StandardSchemaV1` from it, so without it installed TypeScript could not resolve those types. Thanks @Vistyy for the report.
