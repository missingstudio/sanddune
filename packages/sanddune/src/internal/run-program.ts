import { Layer } from "effect";
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
import { gitCurrentBranch } from "./git";
import { runCopyToWorktree } from "./copy-to-worktree";
import {
  runHostHooksSequential,
  runOnSandboxReadyParallel,
} from "./hook-runner";
import { runOnHandle } from "./run-on-handle";
import { openRunSession, type RunSession } from "./run-session";
import {
  transferSessionToSandbox,
  validateResumeSession,
} from "./session-capture";
import { createWorktreeStrategy } from "./worktree-strategy";

const DEFAULT_MAX_ITERATIONS = 1;

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
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Validate before any sandbox/worktree side effects so bad combos fail
  // fast rather than after a container is up.
  if (options.resumeSession !== undefined) {
    await validateResumeSession({
      resumeSession: options.resumeSession,
      agent: options.agent,
      hostCwd: cwd,
      maxIterations,
    });
  }

  const env = await resolveEnv({
    processEnv: process.env,
    sandduneEnvPath: join(cwd, ".sanddune", ".env"),
    agentEnv: options.agent.env,
    sandboxEnv: provider.env,
    runOptionsEnv: options.env,
  });
  const targetBranch = await gitCurrentBranch(cwd);
  const branchStrategy = options.branchStrategy ?? { type: "head" };

  const strategy = await createWorktreeStrategy({
    strategy: branchStrategy,
    providerKind: provider.kind,
    cwd,
    hostBranch: targetBranch,
  });

  let runError: Error | undefined;
  let session: RunSession | undefined;
  let handle: BindMountSandboxHandle | undefined;
  let resultBase: RunResult | undefined;
  let preservedPath: string | undefined;

  try {
    // Prepare on the host before any sandbox spins up — a bad template or
    // missing placeholder must fail fast.
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

    session = await openRunSession({
      cwd,
      branch: strategy.resultBranch,
      ...(options.logging !== undefined && { logging: options.logging }),
      ...(options.name !== undefined && { name: options.name }),
    });

    await runCopyToWorktree({
      items: options.copyToWorktree,
      cwd,
      worktreePath: strategy.worktreePath,
      branchStrategy,
      timeoutMs: options.timeouts?.copyToWorktreeMs,
      signal: options.signal,
    });

    await runHostHooksSequential(
      options.hooks?.host?.onWorktreeReady,
      options.signal,
    );

    handle = await provider.create({
      worktreePath: strategy.worktreePath,
      hostRepoPath: cwd,
      env,
    });

    // Must run after sandbox creation (writes via exec) and before the
    // first iteration (so --resume sees the file already in place).
    const willResume =
      options.resumeSession !== undefined &&
      options.agent.sessionCapture !== undefined;
    if (willResume) {
      await transferSessionToSandbox({
        handle,
        capture: options.agent.sessionCapture!,
        hostCwd: cwd,
        sessionId: options.resumeSession!,
      });
    }

    await runOnSandboxReadyParallel({
      hostHooks: options.hooks?.host?.onSandboxReady,
      sandboxHooks: options.hooks?.sandbox?.onSandboxReady,
      handle,
      signal: options.signal,
    });

    resultBase = await runOnHandle({
      handle,
      strategy,
      agent: options.agent,
      hostRepoPath: cwd,
      session,
      promptPipeline,
      maxIterations,
      ...(options.completionSignal !== undefined && {
        completionSignal: options.completionSignal,
      }),
      ...(options.idleTimeoutSeconds !== undefined && {
        idleTimeoutSeconds: options.idleTimeoutSeconds,
      }),
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(willResume && { resumeSessionId: options.resumeSession! }),
      ...(seams.agentInvokerLayer !== undefined && {
        agentInvokerLayer: seams.agentInvokerLayer,
      }),
    });

    await strategy.finalize();
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // run-end first (to capture the original error in the log), then
    // sandbox, then worktree. Each step swallows so one teardown failure
    // doesn't mask another.
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
        `sanddune: worktree teardown failed: ${e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  if (runError !== undefined) throw runError;

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
      `sanddune: sandbox teardown failed: ${closeError instanceof Error ? closeError.message : String(closeError)
      }\n`,
    );
  }
}
