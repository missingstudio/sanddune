---
"@missingstudio/sanddune": patch
---

Added **`idleTimeoutSeconds`** to the **iteration loop** (default `600`). If the **agent** produces no **agent stream event** (text or toolCall) for the configured number of seconds, the agent subprocess is killed (via `SIGTERM` plumbed through `spawnHost`) and the iteration aborts. The timer resets on every agent stream event, so long-but-active iterations are not killed.

The mechanism is a synthesized `AbortSignal` per ADR-0011: the rejected promise carries a sanddune-defined `AgentIdleTimeoutError` reason verbatim (now exported from the package root). The `Sandbox` handle remains usable after the timeout — callers can `.run()` again with a fresh signal or `.close()` to tear down.

`AgentInvokerService.invoke` gained two optional inputs to support this: `signal: AbortSignal` (forwarded to the underlying `handle.exec` and on to `spawnHost`) and `onEvent: (event) => void` (fired per parsed agent stream event so the loop can reset its idle timer). The cross-cutting subprocess-kill plumbing now lives in `spawnHost` as the single point per the comment that previously flagged this as work owed to #11.

`Effect.runPromise`'s `FiberFailureImpl` wrapping is now unwrapped at the run boundary so callers see the typed `Error` (e.g. `AgentIdleTimeoutError`) verbatim, matching the contract that a rejected promise carries the abort reason.

Still deferred: caller-supplied `signal` mid-iteration kill (slice #12; this slice's plumbing is reusable), **agent session** capture.
