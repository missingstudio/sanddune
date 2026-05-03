import { Effect } from "effect";
import {
  AgentIdleTimeoutError,
  type AgentInvokerService,
  type AgentProvider,
  type AgentStreamEvent,
  type BindMountSandboxHandle,
} from "../core";

export function makeProductionAgentInvoker(params: {
  readonly agentProvider: AgentProvider;
  readonly handle: BindMountSandboxHandle;
  readonly onEvent: (event: AgentStreamEvent) => void;
}): AgentInvokerService {
  return {
    invoke: ({ prompt, iteration, signal, idleTimeoutSeconds }) =>
      Effect.tryPromise({
        try: async () => {
          const command = params.agentProvider.buildCommand({
            prompt,
            iteration,
          });
          const events: AgentStreamEvent[] = [];

          const idle = startIdleTimer({ idleTimeoutSeconds, iteration });
          const composite = composeSignals(signal, idle.signal);

          try {
            const result = await params.handle.exec(command, {
              signal: composite,
              onLine: (line) => {
                const parsed = params.agentProvider.parseLine(line, iteration);
                if (parsed.length > 0) idle.reset();
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
          } finally {
            idle.dispose();
          }
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  };
}

interface IdleTimer {
  readonly signal: AbortSignal;
  reset(): void;
  dispose(): void;
}

/** Synthesizes an abort whose reason is `AgentIdleTimeoutError` after
 *  `idleTimeoutSeconds` of silence. Reset by the invoker on each parsed
 *  **agent stream event**. A non-positive timeout disables the watchdog —
 *  the returned signal never aborts on its own. */
function startIdleTimer(params: {
  readonly idleTimeoutSeconds: number;
  readonly iteration: number;
}): IdleTimer {
  const controller = new AbortController();
  const ms = params.idleTimeoutSeconds * 1000;
  const enabled = ms > 0 && Number.isFinite(ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const arm = () => {
    if (!enabled || disposed) return;
    timer = setTimeout(() => {
      controller.abort(
        new AgentIdleTimeoutError({
          idleTimeoutSeconds: params.idleTimeoutSeconds,
          iteration: params.iteration,
        }),
      );
    }, ms);
  };

  arm();

  return {
    signal: controller.signal,
    reset: () => {
      if (!enabled || disposed) return;
      if (timer !== undefined) clearTimeout(timer);
      arm();
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function composeSignals(
  caller: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  return caller !== undefined
    ? AbortSignal.any([caller, internal])
    : internal;
}
