import { Effect, Layer } from "effect";
import { join, resolve as resolvePath } from "node:path";
import {
  AgentInvoker,
  preparePromptPipeline,
  type BindMountSandboxHandle,
  type RunOptions,
  type RunResult,
  type RunSandboxProvider,
} from "../core";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch, gitHeadSha } from "./git";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { runIterationLoop } from "./iteration-loop";
import { runEffect } from "./run-effect";
import { openRunSession, type RunSession } from "./run-session";
import { createWorktreeStrategy } from "./worktree-strategy";

/** Set to 1 so existing single-iteration callers don't get a cost multiplier
 *  — multi-iteration is opt-in via `maxIterations`. */
const DEFAULT_MAX_ITERATIONS = 1;
/** Per CONTEXT.md. */
const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
/** Per ADR-0011 / brief. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

export interface RunProgramTestSeams {
  readonly agentInvokerLayer?: Layer.Layer<AgentInvoker, never, never>;
}

export async function runProgram(
  options: RunOptions<RunSandboxProvider>,
  seams: RunProgramTestSeams = {},
): Promise<RunResult> {
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

  // Single try/finally owns teardown for: prompt-pipeline failures, sandbox
  // handle, run session, and the worktree strategy. Both success and error
  // paths go through the same teardown sequence — adding a new managed
  // resource means one place, not two.
  let runError: Error | undefined;
  let session: RunSession | undefined;
  let handle: BindMountSandboxHandle | undefined;
  let resultBase: RunResult | undefined;
  let preservedPath: string | undefined;

  try {
    // Validates options + reads/substitutes the template on the host before
    // the sandbox is created, so file-not-found / bad placeholders fail fast
    // (and route through the worktree teardown in the finally block).
    const promptPipeline = await preparePromptPipeline({
      prompt: options.prompt,
      promptFile: options.promptFile,
      promptArgs: options.promptArgs,
      sourceBranch: strategy.sourceBranch,
      targetBranch: strategy.targetBranch,
    });
    for (const key of promptPipeline.unusedPromptArgKeys) {
      process.stderr.write(
        `sanddune: warning — promptArgs.${key} was not used by the template\n`,
      );
    }

    session = await openRunSession(cwd);

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
          onEvent: session.recordAgentEvent,
        }),
      );

    const loopResult = await runEffect(
      runIterationLoop({
        getPromptForIteration: () =>
          promptPipeline.getPromptForIteration((cmd) => handle!.exec(cmd)),
        logger: session.logger,
        cwd: strategy.worktreePath,
        beforeSha,
        maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        completionSignals: normalizeCompletionSignals(options.completionSignal),
        idleTimeoutSeconds:
          options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
        ...(options.signal !== undefined && { signal: options.signal }),
      }).pipe(Effect.provide(agentInvokerLayer)),
    );

    await strategy.finalize();

    resultBase = {
      branch: strategy.resultBranch,
      iterations: loopResult.iterations,
      commits: loopResult.commits,
      stdout: loopResult.stdout,
      logFilePath: session.logFilePath,
      ...(loopResult.completionSignal !== undefined && {
        completionSignal: loopResult.completionSignal,
      }),
    };
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Teardown order matches pre-refactor behaviour: write the run-end record
    // first (so the file captures the original error promptly), then close
    // the sandbox handle, then the worktree strategy. Each step swallows its
    // own errors so one failure doesn't mask another.
    if (session !== undefined) {
      await (runError !== undefined
        ? session.endError(runError.message)
        : session.endOk());
    }
    await closeHandleSafely(handle);
    try {
      const r = await strategy.close();
      preservedPath = r.preservedPath;
    } catch (e) {
      process.stderr.write(
        `sanddune: worktree teardown failed: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  if (runError !== undefined) throw runError;

  // Reaching here implies success: resultBase was assigned in the try block.
  const finalResult = resultBase!;
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
      `sanddune: sandbox teardown failed: ${
        closeError instanceof Error ? closeError.message : String(closeError)
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
