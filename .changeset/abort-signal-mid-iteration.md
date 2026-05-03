---
"@missingstudio/sanddune": patch
---

Threaded caller-supplied `RunOptions.signal` through the **iteration loop** so a mid-**iteration** abort kills the **agent** subprocess immediately (SIGTERM via `spawnHost`) and `run()` rejects with `signal.reason` verbatim — no wrapping, no sanddune-defined error class (ADR-0004 / ADR-0011).

Previously the caller's signal was checked only at iteration boundaries, so an abort mid-iteration was observed only when the next iteration started. The loop now composes the caller's signal with the per-iteration idle signal (via `AbortSignal.any`) and hands the composite to the **agent invoker** — which already forwards `signal` into `handle.exec` → `spawnHost`. Whichever signal fires first wins; rejection reasons remain distinguishable (caller-supplied reason vs. `AgentIdleTimeoutError`).

A pre-aborted caller signal now rejects via `Effect.fail(signal.reason)` rather than a synchronous throw inside `Effect.gen`, so the rejection carries the caller's exact `Error` instance instead of a `Cause.pretty`-stringified wrapper.

Per ADR-0011, the **worktree** is left in whatever state the killed agent produced — sanddune does not roll back partial edits, half-staged files, or partial commits. Callers responsible for retry-from-clean-slate must inspect with `git status` and clean up themselves.

Out of scope (deferred to later slices): `Sandbox.run()` reusability after abort (slice #16); `interactive()` signal wiring (slice #18); hook cancellation (slice #13).
