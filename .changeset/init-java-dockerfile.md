---
"@ai-hero/sandcastle": minor
---

`sandcastle init` now detects Java projects (a `pom.xml` or `.sdkmanrc` at the repo root) and adds an sdkman layer to the generated container file that installs Java and Maven for the agent user. The Java version is read from the `.sdkmanrc` `java=` entry and baked in at scaffold time; repos with only a `pom.xml` get a recent LTS default.
