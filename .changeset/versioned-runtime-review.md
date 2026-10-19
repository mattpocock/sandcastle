---
"@ai-hero/sandcastle": patch
---

Honor the configured fork registry over npm scope mappings, support npm tags
containing underscores and wildcard ranges, select the highest matching version
regardless of registry metadata order, and replace same-version legacy runtimes
while retaining unrelated dependency pins. Validate
installed metadata, compare source provenance independently of JSON property
order, and identify current runtimes by package and provenance as
well as version and integrity. Reject non-string reviewed revisions before
starting operator install jobs.
