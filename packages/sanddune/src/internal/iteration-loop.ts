import { Effect } from "effect";
import {
  AgentInvoker,
  type AgentStreamEvent,
  type IterationResult,
  type IterationUsage,
} from "../core";
import { gitNewCommits } from "./git";
import type { IterationLogger } from "./run-session";

export interface IterationLoopInput {
  readonly getPromptForIteration: () => Promise<string>;
  readonly logger: IterationLogger;
  readonly cwd: string;
  readonly beforeSha: string;
  readonly maxIterations: number;
  /** First match wins; empty array disables detection. */
  readonly completionSignals: readonly string[];
  readonly idleTimeoutSeconds: number;
  readonly signal?: AbortSignal;
  /** Forwarded to the agent invoker on iteration 1 only. */
  readonly resumeSessionId?: string;
  /** Resolves to undefined when capture fails (closure logs its own errors). */
  readonly captureSession?: (input: {
    readonly iteration: number;
    readonly sessionId: string;
  }) => Promise<{ readonly hostPath: string; readonly usage?: IterationUsage } | undefined>;
  readonly onEvent?: (event: AgentStreamEvent) => void;
}

export interface IterationLoopResult {
  readonly iterations: readonly IterationResult[];
  readonly commits: readonly string[];
  readonly stdout: string;
  readonly completionSignal?: string;
}

export const runIterationLoop = (
  input: IterationLoopInput,
): Effect.Effect<IterationLoopResult, Error, AgentInvoker> =>
  Effect.gen(function* () {
    const invoker = yield* AgentInvoker;
    const stdoutChunks: string[] = [];
    const iterations: IterationResult[] = [];
    const allCommits: string[] = [];
    let lastSha = input.beforeSha;
    let matchedSignal: string | undefined;

    for (let iteration = 1; iteration <= input.maxIterations; iteration += 1) {
      const aborted = abortReason(input.signal);
      if (aborted !== undefined) {
        return yield* Effect.fail(aborted);
      }

      const promptForIteration = yield* fromPromise(() =>
        input.getPromptForIteration(),
      );

      yield* fromPromise(() => input.logger.iterationStarted(iteration));

      const resumeSessionId =
        iteration === 1 ? input.resumeSessionId : undefined;
      const result = yield* invoker.invoke({
        prompt: promptForIteration,
        iteration,
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        ...(input.signal !== undefined && { signal: input.signal }),
        ...(resumeSessionId !== undefined && { resumeSessionId }),
        ...(input.onEvent !== undefined && { onEvent: input.onEvent }),
      });

      let signalMatched: string | undefined;
      for (const event of result.events) {
        if (event.type !== "text") continue;
        stdoutChunks.push(event.content);
        if (signalMatched !== undefined) continue;
        for (const sig of input.completionSignals) {
          if (sig.length > 0 && event.content.includes(sig)) {
            signalMatched = sig;
            break;
          }
        }
      }
      if (signalMatched === undefined && result.completionSignal !== undefined) {
        signalMatched = result.completionSignal;
      }

      const newCommits = yield* fromPromise(() =>
        gitNewCommits(input.cwd, lastSha),
      );
      allCommits.push(...newCommits);
      const lastCommit = newCommits.at(-1) ?? null;
      if (lastCommit !== null) lastSha = lastCommit;

      let sessionFilePath: string | undefined;
      let usage: IterationUsage | undefined;
      if (
        input.captureSession !== undefined &&
        result.sessionId !== undefined
      ) {
        const captured = yield* fromPromise(() =>
          input.captureSession!({
            iteration,
            sessionId: result.sessionId!,
          }),
        );
        if (captured !== undefined) {
          sessionFilePath = captured.hostPath;
          usage = captured.usage;
        }
      }

      yield* fromPromise(() =>
        input.logger.iterationEnded(iteration, lastCommit),
      );

      iterations.push({
        iteration,
        ...(lastCommit !== null && { commitSha: lastCommit }),
        ...(result.sessionId !== undefined && { sessionId: result.sessionId }),
        ...(sessionFilePath !== undefined && { sessionFilePath }),
        ...(usage !== undefined && { usage }),
        ...(signalMatched !== undefined && { completionSignal: signalMatched }),
      });

      if (signalMatched !== undefined) {
        matchedSignal = signalMatched;
        break;
      }
    }

    return {
      iterations,
      commits: allCommits,
      stdout: stdoutChunks.join(""),
      ...(matchedSignal !== undefined && { completionSignal: matchedSignal }),
    };
  });

const fromPromise = <T>(thunk: () => Promise<T>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

function abortReason(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "aborted");
}
