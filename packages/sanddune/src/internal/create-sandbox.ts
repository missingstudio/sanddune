import { Effect, Layer } from "effect";
import {
  AgentInvoker,
  preparePromptPipeline,
  type AgentProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type CloseResult,
  type RunResult,
  type Sandbox,
  type SandboxHooks,
  type SandboxInteractiveOptions,
  type SandboxRunOptions,
  type Timeouts,
  type LoggingOption,
} from "../core";
import {
  buildAgentInteractiveCommand,
  resolveInteractivePrompt,
} from "./interactive-shared";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { runCopyToWorktree } from "./copy-to-worktree";
import { gitHeadSha } from "./git";
import {
  runHostHooksSequential,
  runOnSandboxReadyParallel,
} from "./hook-runner";
import { runIterationLoop, type IterationLoopResult } from "./iteration-loop";
import { runEffect } from "./run-effect";
import { openRunSession } from "./run-session";
import { makeCaptureSessionFn } from "./session-capture";
import type { WorktreeStrategy } from "./worktree-strategy";

/** Set to 1 so existing single-iteration callers don't get a cost multiplier
 *  — multi-iteration is opt-in via `maxIterations`. Mirrors run-program. */
const DEFAULT_MAX_ITERATIONS = 1;
const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

export interface CreateSandboxFromWorktreeInput {
  readonly agent: AgentProvider;
  readonly provider: BindMountSandboxProvider;
  readonly hostRepoPath: string;
  readonly strategy: WorktreeStrategy;
  /** Resolved env (per ADR-0012); already validated for agent/sandbox
   *  overlap and merged with the caller's `createSandbox({ env })`. */
  readonly env: Readonly<Record<string, string>>;
  readonly hooks: SandboxHooks | undefined;
  readonly copyToWorktree: readonly string[] | undefined;
  readonly timeouts: Timeouts | undefined;
  readonly logging: LoggingOption | undefined;
  /** When `true`, `close()` tears down the worktree alongside the container.
   *  Set by the top-level `createSandbox()` (ownership-follows-creation,
   *  ADR-0010); `wt.createSandbox()` would pass `false` so the parent
   *  `Worktree` retains worktree-teardown responsibility. */
  readonly ownsWorktree: boolean;
  readonly seams?: CreateSandboxSeams;
}

export interface CreateSandboxSeams {
  /** Inject a fake `AgentInvoker` for tests — same seam as `runProgram`. */
  readonly agentInvokerLayer?: Layer.Layer<AgentInvoker, never, never>;
}

/** Layered creator shared by top-level `createSandbox()` and (next slice)
 *  `wt.createSandbox()`. Runs the lifecycle once at creation time:
 *
 *      copyToWorktree → host.onWorktreeReady → sandbox created →
 *      host.onSandboxReady ∥ sandbox.onSandboxReady
 *
 *  After this returns, hooks do **not** re-fire on `sandbox.run()` — those
 *  are inherited at construction per the brief.
 *
 *  Throws on lifecycle failure; on success returns a live `Sandbox` whose
 *  `close()` is responsible for teardown (and, when `ownsWorktree`, the
 *  worktree). */
export async function createSandboxFromWorktree(
  input: CreateSandboxFromWorktreeInput,
): Promise<Sandbox> {
  const { strategy, provider, agent, env } = input;

  let handle: BindMountSandboxHandle | undefined;
  try {
    await runCopyToWorktree({
      items: input.copyToWorktree,
      cwd: input.hostRepoPath,
      worktreePath: strategy.worktreePath,
      branchStrategy: { type: "branch", branch: strategy.sourceBranch },
      timeoutMs: input.timeouts?.copyToWorktreeMs,
      signal: undefined,
    });

    await runHostHooksSequential(
      input.hooks?.host?.onWorktreeReady,
      undefined,
    );

    handle = await provider.create({
      worktreePath: strategy.worktreePath,
      hostRepoPath: input.hostRepoPath,
      env,
    });

    await runOnSandboxReadyParallel({
      hostHooks: input.hooks?.host?.onSandboxReady,
      sandboxHooks: input.hooks?.sandbox?.onSandboxReady,
      handle,
      signal: undefined,
    });
  } catch (err) {
    // Setup failed past worktree creation but possibly before the sandbox
    // was ready — close any partial container, then unwind the worktree
    // strategy if we own it. Each step swallows so the original error
    // surfaces.
    await closeHandleSafely(handle);
    if (input.ownsWorktree) {
      try {
        await strategy.close();
      } catch (closeErr) {
        process.stderr.write(
          `sanddune: worktree teardown failed: ${
            closeErr instanceof Error ? closeErr.message : String(closeErr)
          }\n`,
        );
      }
    }
    throw err;
  }

  return makeSandboxHandle({
    agent,
    handle: handle!,
    strategy,
    hostRepoPath: input.hostRepoPath,
    baseEnv: env,
    ownsWorktree: input.ownsWorktree,
    creationLogging: input.logging,
    seams: input.seams,
  });
}

interface MakeSandboxHandleInput {
  readonly agent: AgentProvider;
  readonly handle: BindMountSandboxHandle;
  readonly strategy: WorktreeStrategy;
  readonly hostRepoPath: string;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly ownsWorktree: boolean;
  /** Default `logging` configuration — per-`run()` `logging` overrides. */
  readonly creationLogging: LoggingOption | undefined;
  readonly seams?: CreateSandboxSeams;
}

function makeSandboxHandle(input: MakeSandboxHandleInput): Sandbox {
  const { agent, handle, strategy } = input;
  let closed = false;

  const runOnce = async (
    options: SandboxRunOptions,
  ): Promise<RunResult> => {
    if (closed) {
      throw new Error("sandbox.run() called after close()");
    }
    // Belt-and-braces — type-level rejection prevents this in TS, but
    // JS callers (or `as never` escapes) could still pass it. Per the
    // brief ("rejected at type level on `SandboxRunOptions` and at runtime
    // on `sandbox.run()`").
    if ((options as { resumeSession?: unknown }).resumeSession !== undefined) {
      throw new Error(
        "sandbox.run() does not accept resumeSession — agent session resume is a fresh-sandbox concern (see CONTEXT.md).",
      );
    }

    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
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

    const logging = options.logging ?? input.creationLogging;
    const session = await openRunSession({
      cwd: input.hostRepoPath,
      branch: strategy.resultBranch,
      ...(logging !== undefined && { logging }),
      ...(options.name !== undefined && { name: options.name }),
    });

    const beforeSha = await gitHeadSha(strategy.worktreePath);

    const agentInvokerLayer =
      input.seams?.agentInvokerLayer ??
      Layer.succeed(
        AgentInvoker,
        makeProductionAgentInvoker({
          agentProvider: agent,
          handle,
        }),
      );

    const captureSession = makeCaptureSessionFn({
      handle,
      agent,
      hostCwd: input.hostRepoPath,
    });

    let runError: Error | undefined;
    let loopResult: IterationLoopResult | undefined;
    try {
      loopResult = await runEffect(
        runIterationLoop({
          getPromptForIteration: () =>
            promptPipeline.getPromptForIteration((cmd) => handle.exec(cmd)),
          logger: session.logger,
          cwd: strategy.worktreePath,
          beforeSha,
          maxIterations,
          completionSignals: normalizeCompletionSignals(
            options.completionSignal,
          ),
          idleTimeoutSeconds:
            options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
          ...(options.signal !== undefined && { signal: options.signal }),
          ...(captureSession !== undefined && { captureSession }),
          onEvent: session.recordAgentEvent,
        }).pipe(Effect.provide(agentInvokerLayer)),
      );
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    } finally {
      await (runError !== undefined
        ? session.endError(runError.message)
        : session.endOk());
    }

    if (runError !== undefined) throw runError;
    const r = loopResult!;

    const result: RunResult = {
      branch: strategy.resultBranch,
      iterations: r.iterations,
      commits: r.commits,
      stdout: r.stdout,
      ...(session.logFilePath !== undefined && {
        logFilePath: session.logFilePath,
      }),
      ...(r.completionSignal !== undefined && {
        completionSignal: r.completionSignal,
      }),
    };
    return result;
  };

  const close = async (): Promise<CloseResult> => {
    if (closed) return { worktreePreserved: false };
    closed = true;

    await closeHandleSafely(handle);

    if (!input.ownsWorktree) {
      // wt.createSandbox provenance: worktree teardown belongs to the
      // parent Worktree, not us (ADR-0010 ownership-follows-creation).
      return { worktreePreserved: false };
    }

    let preservedPath: string | undefined;
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
    return preservedPath !== undefined
      ? { worktreePreserved: true, preservedWorktreePath: preservedPath }
      : { worktreePreserved: false };
  };

  const interactiveOnce = async (
    options: SandboxInteractiveOptions,
  ): Promise<void> => {
    if (closed) {
      throw new Error("sandbox.interactive() called after close()");
    }
    if (handle.execInteractive === undefined) {
      throw new Error(
        `Sandbox provider does not support interactive sessions (no execInteractive). ` +
          `The provider must implement execInteractive on BindMountSandboxHandle.`,
      );
    }

    const prompt = await resolveInteractivePrompt({
      promptInput: {
        ...(options.prompt !== undefined && { prompt: options.prompt }),
        ...(options.promptFile !== undefined && {
          promptFile: options.promptFile,
        }),
        ...(options.promptArgs !== undefined && {
          promptArgs: options.promptArgs,
        }),
      },
      sourceBranch: strategy.sourceBranch,
      targetBranch: strategy.targetBranch,
      execAdapter: (cmd) => handle.exec(cmd),
    });

    const command = buildAgentInteractiveCommand({
      agent,
      prompt,
      // Long-lived sandbox containers are explicitly trusted at construction
      // time — same default the top-level interactive() bind-mount path uses.
      skipPermissions: true,
    });

    await handle.execInteractive(command, {
      ...(options.signal !== undefined && { signal: options.signal }),
    });
  };

  return {
    branch: strategy.resultBranch,
    worktreePath: strategy.worktreePath,
    run: runOnce,
    interactive: interactiveOnce,
    close,
    [Symbol.asyncDispose]: async () => {
      await close();
    },
  };
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
