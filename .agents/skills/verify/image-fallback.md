# Image fallback

When the stock `sandcastle init` image can't build here (the network blocks apt or the Claude installer), a claim that needs no agent CLI can still run on this minimal image. Build it with `sandcastle docker build-image --dockerfile <path>`:

```Dockerfile
FROM node:22-bookworm
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
```

A claim that needs the agent CLI has no fallback: it is UNVERIFIABLE until the stock image builds.
