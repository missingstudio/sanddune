---
"@missingstudio/sanddune": patch
---

Introduced **`RunSession`** as the single owner of the **run log** lifecycle for one call to `run()`: opens the log, writes `runStarted`, exposes an `IterationLogger` to the **iteration loop**, fans **agent stream events** through, and idempotently writes the terminal record + closes the file via `endOk()` / `endError(message)`. The iteration loop's input now takes a narrow `logger: IterationLogger` (just `iterationStarted` + `iterationEnded`) instead of the full `RunLog` — it never had reason to see open/close/runStarted/runEnded.

Restructured `runProgram` around a single `try / catch / finally` so success and error paths share one teardown sequence: `session.endOk` or `session.endError(message)` → close sandbox handle → close worktree strategy. Adding a future managed resource is now one place, not two near-duplicate code blocks.

Internal-only changes; no public-API surface change. Behaviour preserved: prompt-pipeline failures still tear down the worktree; the run log's terminal record still lands before resource teardown begins; the strategy's `preservedPath` still flows into `RunResult.worktreePath` on dirty merge-to-head runs.
