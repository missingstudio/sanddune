import { Context, type Effect } from "effect";
import type { AgentStreamEvent } from "./agent-provider";
import type { CompletionSignal } from "./run";

export interface AgentInvokeInput {
  readonly prompt: string;
  readonly iteration: number;
  readonly signal?: AbortSignal;
  /** Non-positive disables the watchdog. */
  readonly idleTimeoutSeconds: number;
  readonly resumeSessionId?: string;
  /** Called as each event arrives, before invoke() resolves. */
  readonly onEvent?: (event: AgentStreamEvent) => void;
}

export interface AgentInvokeResult {
  readonly events: readonly AgentStreamEvent[];
  readonly completionSignal?: CompletionSignal;
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
