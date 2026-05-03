import { Context, type Effect } from "effect";
import type { AgentStreamEvent } from "./agent-provider";
import type { CompletionSignal } from "./run";

export interface AgentInvokeInput {
  readonly prompt: string;
  readonly iteration: number;
  /** Caller-supplied abort. Forwarded to the underlying subprocess; on abort
   *  the agent is killed (via `spawnHost` SIGTERM) and `invoke()` rejects with
   *  `signal.reason` verbatim (ADR-0004). */
  readonly signal?: AbortSignal;
  /** Per-iteration idle timeout. The invoker arms a watchdog that resets on
   *  every parsed **agent stream event** and, on expiry, synthesizes an abort
   *  with `AgentIdleTimeoutError` as the reason — same contract as a
   *  caller-supplied `signal` (ADR-0011). The composition with the caller's
   *  signal is owned inside the invoker; callers do not see the composite.
   *  A non-positive value disables the watchdog. */
  readonly idleTimeoutSeconds: number;
  /** When set, forwarded to `agentProvider.buildCommand` so the agent can
   *  emit its provider-specific resume args (e.g. Claude Code's
   *  `--resume <id>`). The **iteration loop** sets this only on iteration 1
   *  when `RunOptions.resumeSession` is configured. */
  readonly resumeSessionId?: string;
}

export interface AgentInvokeResult {
  readonly events: readonly AgentStreamEvent[];
  readonly completionSignal?: CompletionSignal;
  /** Captured iff the **agent provider** has a `sessionCapture` capability
   *  AND emitted a session id during streaming (Claude Code does this via
   *  the `system/init` line). The **iteration loop** uses this to drive the
   *  best-effort capture step. */
  readonly sessionId?: string;
}

export interface AgentInvokerService {
  readonly invoke: (
    input: AgentInvokeInput,
  ) => Effect.Effect<AgentInvokeResult, Error>;
}

export class AgentInvoker extends Context.Tag(
  "@missingstudio/sanddune/AgentInvoker",
)<AgentInvoker, AgentInvokerService>() {}
