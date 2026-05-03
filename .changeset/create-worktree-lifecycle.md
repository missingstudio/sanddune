---
"@missingstudio/sanddune": patch
---

Implemented `createWorktree()` — a **worktree** as a first-class lifecycle, separate from any **sandbox**. Returns a `Worktree` handle exposing `run()`, `interactive()`, `createSandbox()`, `close()`, and `[Symbol.asyncDispose]`. Useful for: run a session first and then hand the same worktree to a sandboxed AFK run, or layer multiple sandboxes on a single worktree.

`createWorktree({ branchStrategy, cwd?, copyToWorktree?, timeouts? })` rejects `head` strategy at the type level (`NonHeadBranchStrategy`) and at runtime (defense in depth). `wt.run(options)` requires a `sandbox` and runs an AFK agent in the worktree — each call creates a fresh container, runs the iteration loop, calls `strategy.finalize()` on success (`merge-to-head` ff-merges back to host head; no-op for `branch`), then tears the container down. The worktree persists for subsequent calls. `wt.createSandbox(options)` returns a `Sandbox` whose `close()` tears down only the container — the worktree is owned by the parent `Worktree` and cleaned up by `wt.close()` (per ADR-0010 — layered sandbox creation, split-close).

Top-level `createSandbox()` and `wt.createSandbox()` go through the same internal `createSandboxFromWorktree` helper and return the same `Sandbox` type. Bimodality is encoded in the close behavior — controlled by the `ownsWorktree` flag — not in distinct types (per ADR-0010 "Considered Options" #2 and #3).

`wt.close()` checks `git status --porcelain` — dirty worktrees are preserved on disk and surfaced via `CloseResult.preservedWorktreePath`; clean worktrees are removed.

`wt.interactive()` is wired at the type level (accepts any `InteractiveSandboxProvider` including bind-mount, isolated, and no-sandbox) but throws `NotImplementedError` at runtime — implementation is deferred to the next slice along with `noSandbox()` and the top-level `interactive()`.

Public-type changes: `Worktree.path` renamed to `Worktree.worktreePath` (matches `Sandbox.worktreePath`); `Worktree.close()` now returns `Promise<CloseResult>`; `Worktree.branchStrategy` field now required on `CreateWorktreeOptions`. The previous shape was a stub that always threw — no caller depended on the prior signature.
