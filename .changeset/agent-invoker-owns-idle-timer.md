---
"@missingstudio/sanddune": patch
---

Moved the per-iteration idle-timeout watchdog from the **iteration loop** into the **agent invoker** seam. The loop's interface stops constructing the composite abort signal and the per-event reset callback; the invoker now owns timer construction, reset, composition with the caller's `signal`, and `AgentIdleTimeoutError` synthesis end-to-end.

Public surface change (pre-1.0): `AgentInvokeInput` drops the `onEvent?: (event) => void` field and gains a required `idleTimeoutSeconds: number`. The `signal` field's behavioural contract is unchanged — it is still forwarded to the underlying subprocess via `spawnHost`, and aborts still reject with `signal.reason` verbatim. ADR-0011's contract is preserved verbatim: idle timeout is still a synthesized abort whose reason is `AgentIdleTimeoutError`; the `Sandbox` handle remains usable after timeout fires.

Internal: `IterationLoopInput` keeps `idleTimeoutSeconds` and `signal` (forwards both) but no longer composes them or runs a timer itself. The `startIdleTimer` helper moved from `iteration-loop.ts` into `agent-invoker-live.ts`. A new `agent-invoker-live.test.ts` exercises the production invoker's timer and signal-composition contract directly with a fake `BindMountSandboxHandle`; the equivalent tests were removed from `iteration-loop.test.ts` since the loop no longer owns that behaviour.
