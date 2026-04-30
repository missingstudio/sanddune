# Sandbox handles survive abort and idle timeout

## Context

`sandbox.run()` accepts an `AbortSignal` for cancellation. The orchestrator also enforces an idle timeout (`idleTimeoutSeconds`, default 600s; resets on each agent output event). Both can interrupt an in-flight iteration: the agent subprocess is killed, the call rejects, and control returns to the caller.

The question was what state the `Sandbox` handle is in afterwards. Two coherent answers: (1) the sandbox is poisoned and must be discarded — call `.close()` and start over; (2) the sandbox is reusable and the caller can `.run()` again with a fresh signal.

## Decision

The `Sandbox` handle remains usable after abort or idle timeout. Specifically:

- The agent subprocess is killed, but the container is left running.
- The call rejects with the caller's `signal.reason` verbatim (or a sanddune-defined reason for idle timeout — internally implemented as a synthesized abort, so the contract is identical).
- The caller may invoke `.run()` again with a fresh signal, or `.close()` to tear down.
- The **worktree** is left in whatever state the killed agent produced. sanddune does not roll back partial edits, half-staged files, or partial commits. Callers who need a clean retry must inspect with `git status` and reset themselves.

## Considered Options

1. **Sandbox is poisoned after abort** (rejected) — simpler contract, but throws away a working container the caller already paid to start. Forces every retry to incur container-startup cost.
2. **sanddune cleans up to a known state on abort** (rejected) — would need to define "known state" (discard staged changes? unstaged? completed-but-uncommitted edits to half a file?). The semantics are ambiguous when the agent edits a file then commits half of it. Honest "undefined state" is smaller surface than ambiguous "cleaned up".
3. **Configurable abort behavior** (rejected) — adds a knob with no concrete user need; either reset-on-abort is the right default or it isn't.

## Consequences

- Callers writing retry loops can keep one `Sandbox` handle across multiple aborted attempts, paying container startup once.
- Each `sandbox.run()` call has its own independent **iteration** loop. Iteration counts do not carry across calls — `maxIterations: 5` followed by an abort and then `sandbox.run({ maxIterations: 3 })` is two independent loops, not one resumed loop.
- Abort-during-iteration is non-atomic at the **worktree** level. Writing a defensive retry requires the caller to clean up worktree state before re-running, or accept that the next iteration may inherit half-finished work.
- The `signal.reason` propagation contract is verbatim — wrapping or normalizing the reason would defeat the point of accepting a `reason` in the first place.
