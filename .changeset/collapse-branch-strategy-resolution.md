---
"@missingstudio/sanddune": patch
---

Collapsed the three-step branch-strategy resolution (`BranchStrategy` → `WorktreePlan` → `WorktreeStrategy`) into a single seam. `createWorktreeStrategy` now takes the user's `BranchStrategy` directly along with the **sandbox provider**'s kind, performs the "head + isolated" validation inline, and returns a live `WorktreeStrategy` with a new `resultBranch` field that names where the agent's commits will end up.

The intermediate `WorktreePlan` type and the `resolveBranchStrategy` helper were removed from the public surface — they were a hypothetical seam (one consumer, no second adapter). Validation, branch resolution, and **worktree** creation now live in one module instead of split across two packages.

This is internal-only — `BranchStrategy`, `RunOptions.branchStrategy`, and `RunResult.branch` are unchanged.
