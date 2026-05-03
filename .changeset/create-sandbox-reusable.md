---
"@missingstudio/sanddune": patch
---

Implement top-level `createSandbox()` — a long-lived reusable **sandbox** on a single branch.

`createSandbox({ agent, sandbox, branch, cwd?, env?, hooks?, copyToWorktree?, timeouts?, logging? })` returns a `Sandbox` handle that owns both **worktree** and container per ADR-0010. Multiple `sandbox.run()` calls accumulate commits on the same **branch**; the container is reused across calls (no restart cost). Lifecycle **hooks** and `copyToWorktree` run once at creation time, not per `sandbox.run()`.

`sandbox.run(options)` accepts `SandboxRunOptions` — `RunOptions` minus the inherited fields (`cwd`, `branchStrategy`, `copyToWorktree`, `hooks`, `timeouts`) and minus `resumeSession`. `resumeSession` is rejected at the type level **and** at runtime — Claude **agent session** chaining is a fresh-sandbox concern only.

`sandbox.close()` returns `CloseResult` with `preservedWorktreePath` set when the worktree was dirty at close. The top-level `createSandbox()`'s `close()` tears down both container AND worktree (ownership-follows-creation).

`Sandbox` now exposes `branch`, `worktreePath`, `run(options)`, `interactive(options)`, `close()`, and `[Symbol.asyncDispose]` — `await using sandbox = await createSandbox(...)` auto-disposes on block exit, even when an exception escapes. `sandbox.exec()` was removed from the public surface (the underlying `BindMountSandboxHandle.exec` is still available to internal code).

`sandbox.run()` survives mid-iteration abort: a per-call `signal` firing during a run leaves the handle usable for a follow-up `.run()` or `.close()` (per ADR-0011).

The lifecycle is shared with the next slice via an internal `createSandboxFromWorktree` helper that `wt.createSandbox()` will reuse.
