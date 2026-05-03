import { Effect } from "effect";
import {
  AgentIdleTimeoutError,
  AgentInvoker,
  expandPrompt,
  type IterationResult,
  type ResolvedPrompt,
  type SandboxExec,
} from "../core";
import { gitNewCommits } from "./git";
import type { RunLog } from "./run-log";

export interface IterationLoopInput {
  /** Post-`substitutePromptArgs` text. For templates, the loop runs
   *  `expandPrompt` before each iteration; for inline prompts it is passed
   *  to the agent verbatim. */
  readonly prompt: string;
  readonly promptKind: ResolvedPrompt["kind"];
  readonly runLog: RunLog;
  readonly cwd: string;
  readonly beforeSha: string;
  readonly maxIterations: number;
  /** First match across iterations wins; empty array disables detection. */
  readonly completionSignals: readonly string[];
  /** Per-iteration idle timeout. Resets on every **agent stream event**;
   *  on expiry the loop synthesizes an abort with `AgentIdleTimeoutError`
   *  as the reason and the iteration's call to the agent rejects. */
  readonly idleTimeoutSeconds: number;
  readonly sandboxExec: SandboxExec;
  /** Checked between iterations; mid-iteration kill of the agent subprocess
   *  needs `signal` threaded into `spawnHost` and is a follow-up. */
  readonly signal?: AbortSignal;
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
      throwIfAborted(input.signal);

      let promptForIteration = input.prompt;
      if (input.promptKind === "template") {
        const expanded = yield* fromPromise(() =>
          expandPrompt({ text: input.prompt, exec: input.sandboxExec }),
        );
        promptForIteration = expanded.text;
      }

      yield* fromPromise(() => input.runLog.iterationStarted(iteration));

      const idle = startIdleTimer({
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        iteration,
      });
      const result = yield* invoker
        .invoke({
          prompt: promptForIteration,
          iteration,
          signal: idle.signal,
          onEvent: () => idle.reset(),
        })
        .pipe(Effect.ensuring(Effect.sync(() => idle.dispose())));

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

      yield* fromPromise(() =>
        input.runLog.iterationEnded(iteration, lastCommit),
      );

      iterations.push({
        iteration,
        ...(lastCommit !== null && { commitSha: lastCommit }),
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(typeof reason === "string" ? reason : "aborted");
}

interface IdleTimer {
  readonly signal: AbortSignal;
  reset(): void;
  dispose(): void;
}

function startIdleTimer(params: {
  readonly idleTimeoutSeconds: number;
  readonly iteration: number;
}): IdleTimer {
  const controller = new AbortController();
  const ms = params.idleTimeoutSeconds * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const arm = () => {
    if (disposed) return;
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
      if (disposed) return;
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
