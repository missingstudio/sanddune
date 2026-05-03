---
"@missingstudio/sanddune": patch
---

Wire `branchStrategy: { type: "branch", branch: "<name>" }` end-to-end through `run()`. `run({ ..., branchStrategy: { type: "branch", branch: "agent/foo" } })` now creates (or reuses) a git worktree at `.sanddune/worktrees/<sanitized-name>/`, runs the agent against the named branch, and reports the named branch on `RunResult.branch`. There is no merge-back — host HEAD is untouched.

Behavior:

- **New branch** — when the named branch does not exist locally, sanddune creates it from host HEAD via `git worktree add -b <branch> <path> HEAD`.
- **Existing branch, no worktree on disk** — sanddune attaches a fresh worktree onto the existing branch via `git worktree add <path> <branch>`. Commits append to the branch tip.
- **Existing branch, worktree on disk** (typically a re-run after a dirty close) — sanddune reuses the worktree per ADR-0003: a `console.log` line for clean, a stderr warning for dirty. The agent starts with whatever state is on disk.
- **Branch already checked out elsewhere** (e.g. host HEAD is on the named branch) — fails fast with a clear error rather than letting `git worktree add` fail opaquely.

`close()` follows the same dirty-preservation policy as `merge-to-head` (ADR-0003): clean worktree → removed via `git worktree remove --force`; dirty worktree → preserved on disk and surfaced via `RunResult.worktreePath`. The named branch itself is never deleted by sanddune — that's the user's branch to keep.

Worktree path derivation: branch names with `/` (the common `agent/foo` pattern) are sanitized by replacing `/` with `-` to keep the worktree as a single directory under `.sanddune/worktrees/`. Other characters allowed by git ref-name rules are already path-safe.

Known limitation: branches that differ only by `/` vs `-` (e.g. `agent/foo` and `agent-foo`) collide on the same on-disk id and lock file. The collision surfaces as a fail-fast — either the worktree-already-checked-out guard, or a lock-held error naming the other branch — never as silent state sharing. If this bites, rename one of the branches.

Out of scope for this slice: `createWorktree()` and `wt.*` as public entry points (#17), `interactive()` honoring non-default strategies, isolated-provider runtime, and a user-facing `pruneStale()` command for orphaned worktrees and locks.
