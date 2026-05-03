import { Context, type Effect } from "effect";
import type { AgentStreamEvent } from "./agent-provider";
import type { CompletionSignal } from "./run";

export interface AgentInvokeInput {
  readonly prompt: string;
  readonly iteration: number;
  /** Aborts the in-flight agent subprocess. Used by the iteration loop to
   *  enforce idle timeouts; the rejection reason is propagated verbatim. */
  readonly signal?: AbortSignal;
  /** Fired as each agent stream event is parsed off the subprocess stdout —
   *  before `invoke()` resolves. The iteration loop uses this to reset its
   *  per-event idle timer. Synchronous; errors thrown by the callback are
   *  not caught. */
  readonly onEvent?: (event: AgentStreamEvent) => void;
}

export interface AgentInvokeResult {
  readonly events: readonly AgentStreamEvent[];
  readonly completionSignal?: CompletionSignal;
}

export interface AgentInvokerService {
  readonly invoke: (
    input: AgentInvokeInput,
  ) => Effect.Effect<AgentInvokeResult, Error>;
}

export class AgentInvoker extends Context.Tag(
  "@missingstudio/sanddune/AgentInvoker",
)<AgentInvoker, AgentInvokerService>() {}
