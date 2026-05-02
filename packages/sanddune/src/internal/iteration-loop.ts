import { Effect } from "effect";
import {
  AgentInvoker,
  type IterationResult,
} from "@missingstudio/sanddune-core";
import { gitNewCommits } from "./git";
import type { RunLog } from "./run-log";

export interface IterationLoopInput {
  readonly prompt: string;
  readonly runLog: RunLog;
  readonly cwd: string;
  readonly beforeSha: string;
}

export interface IterationLoopResult {
  readonly iterations: readonly IterationResult[];
  readonly commits: readonly string[];
  readonly stdout: string;
}

const fromPromise = <T>(thunk: () => Promise<T>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

export const runIterationLoop = (
  input: IterationLoopInput,
): Effect.Effect<IterationLoopResult, Error, AgentInvoker> =>
  Effect.gen(function* () {
    const invoker = yield* AgentInvoker;
    const stdoutChunks: string[] = [];
    const iterations: IterationResult[] = [];

    const iteration = 1;
    yield* fromPromise(() => input.runLog.iterationStarted(iteration));

    const result = yield* invoker.invoke({
      prompt: input.prompt,
      iteration,
    });
    for (const event of result.events) {
      if (event.type === "text") stdoutChunks.push(event.content);
    }

    const commits = yield* fromPromise(() =>
      gitNewCommits(input.cwd, input.beforeSha),
    );
    const lastCommit = commits.at(-1) ?? null;

    yield* fromPromise(() =>
      input.runLog.iterationEnded(iteration, lastCommit),
    );

    iterations.push(
      lastCommit !== null
        ? { iteration, commitSha: lastCommit }
        : { iteration },
    );

    return {
      iterations,
      commits,
      stdout: stdoutChunks.join(""),
    };
  });
