---
"@ai-hero/sandcastle": patch
---

`docker()` no longer says an image is "not found locally" when Docker itself can't be reached. If Docker Desktop or the docker daemon isn't running, the error now says the Docker engine is not reachable and includes docker's own message; any other `docker image inspect` failure shows docker's message instead of telling you to build an image you already have.
