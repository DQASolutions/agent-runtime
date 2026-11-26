# FOS OS-runtime — the always-on, non-LLM tier as a container (DoD F).
# kernel-base shape: node + the @dqa/* workspaces built + the demo service
# entrypoint. A real deployment swaps the CMD's composition root for an
# installed app and mounts service sidecars (pg/qdrant) — see os-runtime-design.md §8.
#
# Build context = repo root:
#   docker build -f agent/agent-os/Dockerfile -t fos-os-runtime .
FROM node:24-slim AS build
WORKDIR /app

# node_modules / dist are .dockerignore'd so deps install fresh for linux
# (no host/container native mismatch) and resolve from the public registry.
COPY . .
# npm install (not ci): the agent-os workspace isn't in the committed
# lockfile yet, so reconcile rather than fail on a strict ci check.
RUN npm install && npx turbo build --filter=@dqa-ai-solutions/agent-os

ENV NODE_ENV=production PORT=8080 STATE_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "agent/agent-os/dist/service/main.js"]
