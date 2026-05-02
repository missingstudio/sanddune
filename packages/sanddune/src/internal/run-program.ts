import { Effect, Layer } from "effect";
import { resolve as resolvePath } from "node:path";
import {
  AgentInvoker,
  type BindMountSandboxHandle,
  type RunOptions,
  type RunResult,
  type RunSandboxProvider,
} from "@missingstudio/sanddune-core";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch, gitHeadSha } from "./git";
import { openRunLog } from "./run-log";
import { newRunId } from "./run-id";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { runIterationLoop } from "./iteration-loop";

export interface RunProgramTestSeams {
  readonly agentInvokerLayer?: Layer.Layer<AgentInvoker, never, never>;
}

export async function runProgram(
  options: RunOptions<RunSandboxProvider>,
  seams: RunProgramTestSeams = {},
): Promise<RunResult> {
  if (typeof options.prompt !== "string") {
    throw new Error(
      "run() requires an inline `prompt` string in this release. `promptFile` is not yet supported.",
    );
  }
  if (options.sandbox.kind !== "bind-mount") {
    throw new Error(
      `run() supports only bind-mount sandbox providers in this release; got ${options.sandbox.kind}.`,
    );
  }
  const branchStrategy = options.branchStrategy ?? { type: "head" };
  if (branchStrategy.type !== "head") {
    throw new Error(
      `run() supports only the "head" branch strategy in this release; got "${branchStrategy.type}".`,
    );
  }

  const provider = options.sandbox;
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const env = resolveEnv({
    processEnv: process.env,
    agentEnv: options.agent.env,
    sandboxEnv: provider.env,
  });
  const targetBranch = await gitCurrentBranch(cwd);
  const sourceBranch = targetBranch;

  const runId = newRunId();
  const runLog = await openRunLog(cwd, runId);
  process.stdout.write(
    `sanddune: streaming run log to ${runLog.path}\n  tail -f ${runLog.path}\n`,
  );

  await runLog.runStarted();

  const beforeSha = await gitHeadSha(cwd);

  let handle: BindMountSandboxHandle | undefined;
  try {
    handle = await provider.create({ worktreePath: cwd, env });

    const agentInvokerLayer =
      seams.agentInvokerLayer ??
      Layer.succeed(
        AgentInvoker,
        makeProductionAgentInvoker({
          agentProvider: options.agent,
          handle,
          onEvent: (event) => {
            void runLog.agentEvent(event);
          },
        }),
      );

    const loopResult = await Effect.runPromise(
      runIterationLoop({
        prompt: options.prompt,
        runLog,
        cwd,
        beforeSha,
      }).pipe(Effect.provide(agentInvokerLayer)),
    );

    await runLog.runEnded("ok");

    return {
      sourceBranch,
      targetBranch,
      iterations: loopResult.iterations,
      commits: loopResult.commits,
      stdout: loopResult.stdout,
      logFilePath: runLog.path,
    };
  } catch (error) {
    await runLog.runEnded(
      "error",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        process.stderr.write(
          `sanddune: sandbox teardown failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
        );
      }
    }
    await runLog.close();
  }
}
