FROM node:22-alpine

RUN apk add --no-cache git bash
RUN npm install -g @anthropic-ai/claude-code

# Claude Code refuses --dangerously-skip-permissions when running as root.
# The node:22-alpine base ships a non-root `node` user (UID 1000) — switch to it.
USER node
WORKDIR /workspace

RUN git config --global --add safe.directory /workspace \
 && git config --global user.email "agent@sanddune.local" \
 && git config --global user.name  "sanddune agent" \
 && git config --global commit.gpgsign false
