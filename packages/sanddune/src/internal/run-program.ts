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

/** Set to 1 so existing single-iteration callers don't get a cost multiplier
 *  — multi-iteration is opt-in via `maxIterations`. */
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

  // Validates RESUME options on the **host** before any sandbox/worktree
  // side effects: bad combos (resume + maxIterations > 1) and a missing
  // host session file should fail fast, not after a stray container has
  // already been spun up. Non-Claude agents have no `sessionCapture` and
  // are silently ignored here.
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

    session = await openRunSession({
      cwd,
      branch: strategy.resultBranch,
      ...(options.logging !== undefined && { logging: options.logging }),
      ...(options.name !== undefined && { name: options.name }),
    });

    // Lifecycle (CONTEXT.md): copyToWorktree → host.onWorktreeReady →
    // sandbox created → host.onSandboxReady ∥ sandbox.onSandboxReady.
    // All threaded with the caller's signal so abort cancels mid-step.
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

    // Resume must happen after the sandbox exists (we write into it via
    // `exec`) but before any iteration runs (so iteration 1's `--resume`
    // points at a session file that already lives at the in-sandbox path
    // Claude Code expects). Non-Claude agents lack `sessionCapture` and
    // are skipped — the option was already validated above.
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
        `sanddune: worktree teardown failed: ${e instanceof Error ? e.message : String(e)
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
      `sanddune: sandbox teardown failed: ${closeError instanceof Error ? closeError.message : String(closeError)
      }\n`,
    );
  }
}
