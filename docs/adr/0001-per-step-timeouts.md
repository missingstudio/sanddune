# Per-step timeouts with dedicated error types

## Context

Only agent idle has a timeout today. Every other lifecycle step (container start, hooks, git operations, etc.) can hang indefinitely.

## Decision

Wrap every lifecycle step in `Effect.timeoutFail` via a `withTimeout` utility used at call sites with `.pipe`. Each step gets its own `Data.TaggedError` with `message`, `timeoutMs`, and step-specific context. Defaults are internal for sanddune-owned steps (container start, git operations, image pulls). User-supplied lifecycle steps — **host hooks**, **sandbox hooks**, and `copyToWorktree` — accept caller-supplied overrides, since their duration is a property of the user's command, not sanddune's plumbing. Rename `TimeoutError` to `AgentIdleTimeoutError`.

## Consequences

- Bounded execution time on every step
- 10 timeout error types in `SandboxError`
- Breaking rename: `TimeoutError` → `AgentIdleTimeoutError`
- Public surface: per-hook `timeoutMs?` on host/sandbox hooks, and `timeouts.copyToWorktreeMs` on `RunOptions` (default 60_000ms each)
