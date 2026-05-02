---
"@missingstudio/sanddune": patch
"@missingstudio/sanddune-core": patch
---

Wire `branchStrategy: { type: "merge-to-head" }` end-to-end through `run()`. `run({ ..., branchStrategy: { type: "merge-to-head" } })` now creates a git worktree under `.sanddune/worktrees/<id>/`, runs the agent against a temporary `sanddune/merge-to-head/<id>` source branch, fast-forwards (or falls back to a true merge) the commits back to the host's active branch, and reports the resulting SHAs in `RunResult.commits`. `RunResult.sourceBranch` carries the temp branch name and `RunResult.targetBranch` carries the host branch the commits landed on.

This release introduces:

- **WorktreeManager** as the only module that calls `git worktree`. Owns worktree creation, dirty detection via `git status --porcelain`, and on-`close()` policy: clean → remove from disk, dirty → preserve and surface the path on `RunResult.worktreePath` (per ADR-0003).
- **Per-worktree file lock** at `.sanddune/locks/<id>.lock` (per ADR-0007). Acquisition is atomic (`open` with `wx`); a held lock with a live owner PID fails fast with no wait/retry; a stale lock (dead PID) is reaped and reacquired. Release is independent of dirty/clean state — locks always come down on `close()`. Locking is uniform but only meaningfully prevents collisions for the (still-pending) `branch` strategy; `merge-to-head` uses unique timestamped names per run, so collisions are already impossible there.
- **`resolveBranchStrategy(strategy, providerKind, hostBranch) → WorktreePlan`** — a pure function exported from `@missingstudio/sanddune-core` that encodes the (strategy × provider kind) compatibility matrix. Throws at runtime when an isolated provider is paired with the `head` strategy (belt-and-suspenders against the existing type-level `AllowedBranchStrategy<S>` rejection). New types: `WorktreePlan`, `ResolveBranchStrategyInput`.
- **Temp branch lifecycle**: when the merge succeeds and the worktree closes clean, the temp source branch is deleted automatically. When the worktree is preserved (dirty), the temp branch is also preserved so the user can recover the leftover work.

Out of scope for this slice (each lands later): `branchStrategy: { type: "branch", branch }` (#6), `createWorktree()` and `wt.*` as public entry points (#17), `interactive()` honoring non-default strategies, isolated-provider runtime, and a user-facing `pruneStale()` command. `run()` continues to accept only bind-mount providers in this release.
