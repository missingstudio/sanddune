import { Context, type Effect } from "effect";
import type { AgentStreamEvent } from "./agent-provider";
import type { CompletionSignal } from "./run";

export interface AgentInvokeInput {
  readonly prompt: string;
  readonly iteration: number;
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
