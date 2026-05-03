import { Effect } from "effect";
import { AgentInvoker, type IterationResult } from "../core";
import { gitNewCommits } from "./git";
import type { IterationLogger } from "./run-session";

export interface IterationLoopInput {
  /** Called once per iteration to obtain the **prompt** text the **agent**
   *  will see. Owned by the **prompt pipeline**; the loop neither inspects
   *  nor caches the result. For inline prompts and shell-expression-free
   *  templates the closure is a no-op string return; for templates with
   *  shell expressions it evaluates them in the live **sandbox**. */
  readonly getPromptForIteration: () => Promise<string>;
  /** Narrow per-iteration log surface — the loop does not own the **run
   *  session** lifecycle; it only emits `iterationStarted` /
   *  `iterationEnded`. Provided by `RunSession.logger`. */
  readonly logger: IterationLogger;
  readonly cwd: string;
  readonly beforeSha: string;
  readonly maxIterations: number;
  /** First match across iterations wins; empty array disables detection. */
  readonly completionSignals: readonly string[];
  /** Per-iteration idle timeout. Forwarded to the **agent invoker**, which
   *  owns the watchdog and synthesizes an `AgentIdleTimeoutError` abort on
   *  expiry (ADR-0011). */
  readonly idleTimeoutSeconds: number;
  /** Caller-supplied abort. Checked at iteration boundaries and forwarded
   *  to the **agent invoker**, which composes it with its internal idle
   *  signal so a mid-iteration abort kills the agent subprocess (via
   *  `spawnHost` SIGTERM) and rejects with `signal.reason` verbatim
   *  (ADR-0004 / ADR-0011). */
  readonly signal?: AbortSignal;
  /** **Agent session** id to resume. Forwarded to the **agent invoker** on
   *  iteration 1 only; subsequent iterations always start fresh per the
   *  brief (slice #14 — long-lived sandboxes don't chain Claude session
   *  state through `--resume`). */
  readonly resumeSessionId?: string;
  /** Best-effort capture closure invoked after each iteration whose invoke
   *  returned a `sessionId`. Returns the absolute host path on success,
   *  `undefined` if capture failed (the closure handles its own logging).
   *  Omitted when the agent provider has no `sessionCapture` capability or
   *  capture is disabled — in that case the loop never asks. */
  readonly captureSession?: (input: {
    readonly iteration: number;
    readonly sessionId: string;
  }) => Promise<string | undefined>;
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
      if (
        input.captureSession !== undefined &&
        result.sessionId !== undefined
      ) {
        sessionFilePath = yield* fromPromise(() =>
          input.captureSession!({
            iteration,
            sessionId: result.sessionId!,
          }),
        );
      }

      yield* fromPromise(() =>
        input.logger.iterationEnded(iteration, lastCommit),
      );

      iterations.push({
        iteration,
        ...(lastCommit !== null && { commitSha: lastCommit }),
        ...(result.sessionId !== undefined && { sessionId: result.sessionId }),
        ...(sessionFilePath !== undefined && { sessionFilePath }),
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

/** Returns the abort reason as an `Error` if the signal has aborted, else
 *  `undefined`. Non-Error reasons are wrapped so the loop can still surface
 *  via `Effect.fail`; identity is preserved for the common Error case. */
function abortReason(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "aborted");
}
