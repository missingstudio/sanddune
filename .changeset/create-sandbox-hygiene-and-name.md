---
"@missingstudio/sanddune": patch
---

Three small additions to `createSandbox()`:

- **Stale-worktree pruning.** `createSandbox()` now runs `git worktree prune` before creating its worktree, so admin entries left over from a previous run that crashed before `close()` no longer accumulate. Best-effort — failures are swallowed.
- **SIGINT/SIGTERM preservation message.** When the host process receives `SIGINT` / `SIGTERM` while a `createSandbox()`-owned sandbox is live, sanddune now writes the worktree path and recovery commands (`cd …`, `git worktree remove --force …`) to stderr before exiting, so a Ctrl-C mid-run doesn't leave the user without instructions. Handlers are removed automatically by `close()` / `Symbol.asyncDispose`.
- **`SandboxRunOptions.name`.** Added an optional `name` to `sandbox.run()` so each call can prefix its log output (e.g. `[issue-42] tail -f …`) for parallel-run readability. Mirrors the existing `RunOptions.name` on top-level `run()`.
- **Default log filename now includes branch and name.** When `logging.path` is omitted, the run log is written to `.sanddune/logs/<branch>[-<name>]-<run-id>.jsonl` (was `<run-id>.jsonl`). Custom paths are unaffected. Branch and name are sanitized so `/`, spaces, etc. become `-`.
