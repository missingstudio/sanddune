import { Effect, Layer } from "effect";
import { join, resolve as resolvePath } from "node:path";
import {
  AgentInvoker,
  resolvePrompt,
  substitutePromptArgs,
  type BindMountSandboxHandle,
  type RunOptions,
  type RunResult,
  type RunSandboxProvider,
} from "../core";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch, gitHeadSha } from "./git";
import { openRunLog } from "./run-log";
import { newRunId } from "./run-id";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { runIterationLoop } from "./iteration-loop";
import { createWorktreeStrategy } from "./worktree-strategy";

/** Set to 1 so existing single-iteration callers don't get a cost multiplier
 *  — multi-iteration is opt-in via `maxIterations`. */
const DEFAULT_MAX_ITERATIONS = 1;
/** Per CONTEXT.md. */
const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

export interface RunProgramTestSeams {
  readonly agentInvokerLayer?: Layer.Layer<AgentInvoker, never, never>;
}

export async function runProgram(
  options: RunOptions<RunSandboxProvider>,
  seams: RunProgramTestSeams = {},
): Promise<RunResult> {
  const resolvedPrompt = await resolvePrompt(options);
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

  const strategy = await createWorktreeStrategy({
    strategy: options.branchStrategy ?? { type: "head" },
    providerKind: provider.kind,
    cwd,
    hostBranch: targetBranch,
  });

  let runLog: Awaited<ReturnType<typeof openRunLog>> | undefined;
  let handle: BindMountSandboxHandle | undefined;
  let resultBase: RunResult | undefined;

  try {
    let promptText = resolvedPrompt.text;
    if (resolvedPrompt.kind === "template") {
      const substituted = substitutePromptArgs({
        text: resolvedPrompt.text,
        promptArgs: resolvedPrompt.promptArgs,
        sourceBranch: strategy.sourceBranch,
        targetBranch: strategy.targetBranch,
      });
      promptText = substituted.text;
      for (const key of substituted.unusedKeys) {
        process.stderr.write(
          `sanddune: warning — promptArgs.${key} was not used by the template\n`,
        );
      }
    }

    const runId = newRunId();
    const log = await openRunLog(cwd, runId);
    runLog = log;
    process.stdout.write(
      `sanddune: streaming run log to ${log.path}\n  tail -f ${log.path}\n`,
    );

    await log.runStarted();

    // Anything past this SHA on the worktree's HEAD after the loop is the
    // agent's contribution.
    const beforeSha = await gitHeadSha(strategy.worktreePath);

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
            void log.agentEvent(event);
          },
        }),
      );

    const loopResult = await Effect.runPromise(
      runIterationLoop({
        prompt: promptText,
        promptKind: resolvedPrompt.kind,
        runLog: log,
        cwd: strategy.worktreePath,
        beforeSha,
        maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        completionSignals: normalizeCompletionSignals(options.completionSignal),
        sandboxExec: (cmd) => handle!.exec(cmd),
        signal: options.signal,
      }).pipe(Effect.provide(agentInvokerLayer)),
    );

    await strategy.afterIteration();

    resultBase = {
      branch: strategy.resultBranch,
      iterations: loopResult.iterations,
      commits: loopResult.commits,
      stdout: loopResult.stdout,
      logFilePath: log.path,
      ...(loopResult.completionSignal !== undefined && {
        completionSignal: loopResult.completionSignal,
      }),
    };
  } catch (error) {
    if (runLog) {
      await runLog.runEnded(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
    await closeHandleSafely(handle);
    await strategy.close();

    if (runLog) await runLog.close();
    throw error;
  }

  // The catch arm always rethrows, so reaching here implies both are assigned.
  const finalLog = runLog!;
  const finalResult = resultBase!;

  await closeHandleSafely(handle);
  await finalLog.runEnded("ok");
  const { preservedPath } = await strategy.close();
  await finalLog.close();

  return preservedPath !== undefined
    ? { ...finalResult, worktreePath: preservedPath }
    : finalResult;
}

async function closeHandleSafely(
  handle: BindMountSandboxHandle | undefined,
): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch (closeError) {
    process.stderr.write(
      `sanddune: sandbox teardown failed: ${closeError instanceof Error ? closeError.message : String(closeError)
      }\n`,
    );
  }
}

function normalizeCompletionSignals(
  raw: string | readonly string[] | undefined,
): readonly string[] {
  if (raw === undefined) return [DEFAULT_COMPLETION_SIGNAL];
  if (typeof raw === "string") return [raw];
  return raw;
}
