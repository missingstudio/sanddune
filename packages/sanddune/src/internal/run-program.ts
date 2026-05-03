import { Effect, Layer } from "effect";
import { join, resolve as resolvePath } from "node:path";
import {
  AgentInvoker,
  resolveBranchStrategy,
  type BindMountSandboxHandle,
  type RunOptions,
  type RunResult,
  type RunSandboxProvider,
  type WorktreePlan,
} from "@missingstudio/sanddune-core";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch, gitHeadSha, gitNewCommits } from "./git";
import { openRunLog } from "./run-log";
import { newRunId } from "./run-id";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { runIterationLoop } from "./iteration-loop";
import { createWorktreeStrategy } from "./worktree-strategy";

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

  const provider = options.sandbox;
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const env = await resolveEnv({
    processEnv: process.env,
    sandduneEnvPath: join(cwd, ".sanddune", ".env"),
    agentEnv: options.agent.env,
    sandboxEnv: provider.env,
    runOptionsEnv: options.env,
  });
  const targetBranch = await gitCurrentBranch(cwd);

  const plan = resolveBranchStrategy({
    strategy: options.branchStrategy ?? { type: "head" },
    providerKind: provider.kind,
    hostBranch: targetBranch,
  });

  const strategy = await createWorktreeStrategy({ plan, cwd });

  const runId = newRunId();
  const runLog = await openRunLog(cwd, runId);
  process.stdout.write(
    `sanddune: streaming run log to ${runLog.path}\n  tail -f ${runLog.path}\n`,
  );

  await runLog.runStarted();

  // Capture the pre-run tip of the ref the agent will commit to. For `head`
  // the worktree path *is* the host cwd, so this is the host HEAD. For
  // `merge-to-head` the worktree was just created from host HEAD, so its
  // HEAD matches. For `branch` this is the named branch's tip (or the host
  // HEAD it was just created from). Anything past this SHA on the worktree's
  // HEAD after the run is the agent's contribution.
  const beforeSha = await gitHeadSha(strategy.worktreePath);

  let handle: BindMountSandboxHandle | undefined;
  let resultBase: RunResult | undefined;

  try {
    handle = await provider.create({
      worktreePath: strategy.worktreePath,
      hostRepoPath: cwd,
      env,
    });

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
        cwd: strategy.worktreePath,
        beforeSha,
      }).pipe(Effect.provide(agentInvokerLayer)),
    );

    await strategy.afterIteration();
    // Read commits off the worktree's HEAD — the worktree (whether host cwd
    // for `head`, the temp branch for `merge-to-head`, or the named branch
    // for `branch`) is always where the agent's commits land first.
    const commits = await gitNewCommits(strategy.worktreePath, beforeSha);

    resultBase = {
      branch: resultBranchFor(plan),
      iterations: loopResult.iterations,
      commits,
      stdout: loopResult.stdout,
      logFilePath: runLog.path,
    };
  } catch (error) {
    await runLog.runEnded(
      "error",
      error instanceof Error ? error.message : String(error),
    );
    await closeHandleSafely(handle);
    await strategy.close();
    await runLog.close();
    throw error;
  }

  await closeHandleSafely(handle);
  await runLog.runEnded("ok");
  const { preservedPath } = await strategy.close();
  await runLog.close();

  return preservedPath !== undefined
    ? { ...resultBase, worktreePath: preservedPath }
    : resultBase;
}

function resultBranchFor(plan: WorktreePlan): string {
  switch (plan.type) {
    case "head":
    case "merge-to-head":
      return plan.targetBranch;
    case "branch":
      return plan.sourceBranch;
  }
}

async function closeHandleSafely(
  handle: BindMountSandboxHandle | undefined,
): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch (closeError) {
    process.stderr.write(
      `sanddune: sandbox teardown failed: ${
        closeError instanceof Error ? closeError.message : String(closeError)
      }\n`,
    );
  }
}
