---
"@missingstudio/sanddune": patch
"@missingstudio/sanddune-core": patch
---

Collapse `RunResult.sourceBranch` and `RunResult.targetBranch` into a single `RunResult.branch` field that always answers "where this run's commits live after completion" (per [ADR-0013](docs/adr/0013-run-result-single-branch.md)):

- `head` → `result.branch` is the host's HEAD at `run()` time
- `merge-to-head` → `result.branch` is the host's HEAD at `run()` time (the merge target, after the fast-forward back from the temp branch)
- `branch` (named) → `result.branch` is the named branch supplied by the caller (when wired up by #6)

`RunResult.worktreePath?: string` is unchanged and remains the recovery surface for the dirty `merge-to-head` case (per ADR-0003). The internal `WorktreeStrategy` and `WorktreePlan` types still carry the `sourceBranch`/`targetBranch` distinction — `merge-to-head` mechanics need both — and the `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` built-in prompt arguments are unaffected.

**Breaking:** callers reading `result.sourceBranch` or `result.targetBranch` migrate to `result.branch`. For the dirty `merge-to-head` case, the preserved temp branch name is no longer surfaced on the result; recover it via `cd $result.worktreePath && git symbolic-ref --short HEAD`.
