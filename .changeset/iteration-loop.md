---
"@missingstudio/sanddune": patch
---

Wired the **iteration loop** for real. `run()` now honors:

- **`maxIterations`** (default `1` for backwards compatibility — multi-iteration is opt-in). When `>1`, the loop runs until the bound is hit or a **completion signal** matches.
- **`completionSignal`** — accepts a `string` or `string[]`. Default is `<promise>COMPLETE</promise>`. Substring-matched against the agent's text events; first match across iterations wins. Surfaced as `RunResult.completionSignal` and on the matching `IterationResult`.
- **`signal`** — checked between iterations; rejects with `signal.reason` verbatim. Mid-iteration kill of the agent subprocess is a follow-up (needs `signal` threaded into `spawnHost`).
- **Prompt expansion** for **prompt templates** — `` !`shell expressions` `` are now evaluated once per iteration via the sandbox-side `exec`, then passed to the agent. Inline prompts skip this entirely (per ADR-0008).

`RunResult.commits` and `RunResult.iterations` are now per-iteration aggregates: `commits` is the union across iterations in commit order, and each `IterationResult.commitSha` is the last commit produced on that iteration.

Still deferred: `idleTimeoutSeconds`, **agent session** capture, mid-iteration abort kill.
