# RunResult exposes a single `branch` field instead of source/target

## Context

Earlier `RunResult` exposed `sourceBranch` and `targetBranch`:

- `sourceBranch` — the branch the agent worked on (the branch that received commits during the run).
- `targetBranch` — the host's HEAD at `run()` time (the merge destination for `merge-to-head`).

The pair is meaningful only for `merge-to-head`, where the agent commits to a generated temp branch (`sanddune/merge-to-head/<id>`) and sanddune fast-forwards the work back to the host's HEAD. For `head` and `branch` (named), source and target are always the same branch and the split adds noise to the API.

The asymmetry also misled callers. The most common downstream question after a successful `run()` is "where do I `git push` / open a PR / look at the commits?" — and on `merge-to-head` that answer is `targetBranch`, while on `branch` it is `sourceBranch`. Callers had to either branch on the strategy type or pick the wrong field for the strategy they didn't have in mind.

## Decision

Replace the pair with a single `branch: string` field on `RunResult`, defined as **the branch where the run's commits live after completion**:

| strategy        | `RunResult.branch`                                              |
| --------------- | --------------------------------------------------------------- |
| `head`          | `hostBranch`                                                    |
| `merge-to-head` | `hostBranch` (after the fast-forward back from the temp branch) |
| `branch`        | the named branch supplied by the caller                         |

`worktreePath?: string` stays on `RunResult` as the recovery surface for the dirty `merge-to-head` case (per ADR-0003): when the agent leaves uncommitted changes, the worktree is preserved on disk and `worktreePath` points at it. The temp source branch is also preserved on disk so the leftovers are recoverable through `git`, but its name is no longer surfaced on `RunResult` — callers recover by `cd $worktreePath` rather than by branch name.

The domain concepts of **source branch** and **target branch** survive in `CONTEXT.md` and in the `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` built-in prompt arguments. They describe the strategy's mechanics and are needed for prompt construction; they just no longer appear in `RunResult`.

## Considered Options

1. **Keep `sourceBranch` and `targetBranch`** (rejected) — verbose for `head` and `branch`, and the right field to read depends on the strategy.
2. **Per-strategy discriminated `RunResult`** (rejected) — most honest, but forces every caller through a `switch (result.strategy.type)` for a question that has a single pragmatic answer.
3. **Rename `sourceBranch` → `branch`, drop `targetBranch`** (rejected) — leaves `branch` pointing at a deleted temp branch on `merge-to-head` success, which is useless.
4. **Add `branch` alongside the existing pair** (rejected) — three overlapping fields encode the same information; the redundancy invites caller confusion about which to read.

## Consequences

- Breaking change to `RunResult`. Pre-1.0, shipped as a `patch` changeset.
- Callers reading `result.targetBranch` or `result.sourceBranch` migrate to `result.branch`.
- For the dirty `merge-to-head` case the temp branch name is no longer in the result. Callers who need it can `cd` into `worktreePath` and run `git symbolic-ref --short HEAD`.
- The `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` prompt arguments are unaffected — they live in the prompt-substitution layer, not in `RunResult`.
- Existing tests that assert on `result.sourceBranch` / `result.targetBranch` (notably `run.integration.test.ts`'s merge-to-head cases) need to be rewritten against `result.branch`.
