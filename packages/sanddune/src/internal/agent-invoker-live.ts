import { Effect } from "effect";
import type {
  AgentInvokerService,
  AgentProvider,
  AgentStreamEvent,
  BindMountSandboxHandle,
} from "@missingstudio/sanddune-core";

export function makeProductionAgentInvoker(params: {
  readonly agentProvider: AgentProvider;
  readonly handle: BindMountSandboxHandle;
  readonly onEvent: (event: AgentStreamEvent) => void;
}): AgentInvokerService {
  return {
    invoke: ({ prompt, iteration }) =>
      Effect.tryPromise({
        try: async () => {
          const command = params.agentProvider.buildCommand({
            prompt,
            iteration,
          });
          const events: AgentStreamEvent[] = [];
          const result = await params.handle.exec(command, {
            onLine: (line) => {
              const parsed = params.agentProvider.parseLine(line, iteration);
              for (const event of parsed) {
                events.push(event);
                params.onEvent(event);
              }
            },
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `Agent exited with code ${result.exitCode}: ${result.stderr.trim()}`,
            );
          }
          return { events };
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  };
}
