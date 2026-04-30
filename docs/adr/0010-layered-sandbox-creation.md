# Layered sandbox creation: top-level vs worktree-backed

## Context

A long-lived **sandbox** is conceptually built on a **worktree**: the worktree is the filesystem the agent edits; the sandbox is the isolation around the agent. We want users to be able to either (a) create a worktree and a sandbox in one call, or (b) create the worktree first, run an interactive session, then hand the same worktree to a sandboxed AFK agent.

This forced a question: is "create worktree" exposed as its own primitive, or hidden inside `createSandbox()`?

## Decision

Both. Two paths to a `Sandbox`:

- **Top-level `createSandbox({ branch, sandbox, ... })`** — convenience. Internally creates a **worktree**, then a **sandbox** on top of it. Owns both.
- **`wt.createSandbox({ sandbox, ... })`** — explicit. The `Worktree` was already created via `createWorktree()`. The sandbox is layered on top of an existing worktree that the user owns.

Both call paths share an internal `createSandboxFromWorktree` helper and return the same `Sandbox` type. The `Sandbox` type is bimodal — its `close()` semantics depend on its provenance:

- `Sandbox` returned by top-level `createSandbox()` → `close()` tears down container **and** worktree (preserving the worktree on disk if dirty).
- `Sandbox` returned by `wt.createSandbox()` → `close()` tears down the container **only**. The worktree is owned by the parent `Worktree`; cleanup happens via `wt.close()`.

The rule is "ownership follows creation": whoever created a resource is responsible for tearing it down.

## Considered Options

1. **Drop top-level `createSandbox()`, force worktree-first** (rejected) — clean ownership at the cost of one extra line of code for the common case. The bundled-convenience parallel with `run()` (which already creates worktree + sandbox + runs + closes) was deemed worth keeping.
2. **Distinct return types** (rejected) — `wt.createSandbox()` returns `ContainerSandbox` (no worktree close), top-level returns `Sandbox` (full close). Compile-time-honest but adds a type to learn, and the methods are otherwise identical.
3. **Symmetric close** (rejected) — `wt.createSandbox()`'s `close()` also disposes the parent `Worktree`. Inverts the ownership rule: closing a child invalidates a parent the user constructed.

## Consequences

- The `Sandbox` type's `close()` contract is documented behavior, not a typed contract. Future readers of `sandbox.close()` need to know which constructor produced the handle to predict what tears down.
- `await using sandbox = await wt.createSandbox(...)` does **not** clean up the worktree on block exit — users must also `await using wt = ...`. This is the most user-visible footgun of the bimodality.
- `CloseResult.preservedWorktreePath` is always `undefined` for sandboxes created via `wt.createSandbox()`, since worktree preservation is the parent `Worktree`'s concern.
- Both call paths share an internal `createSandboxFromWorktree` helper, so the sandbox-on-worktree mechanics live in one place.
