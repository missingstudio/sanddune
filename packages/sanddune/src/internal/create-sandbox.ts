import { Layer } from "effect";
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
import { runCopyToWorktree } from "./copy-to-worktree";
import {
  runHostHooksSequential,
  runOnSandboxReadyParallel,
} from "./hook-runner";
import { runOnHandle } from "./run-on-handle";
import { openRunSession } from "./run-session";
import type { WorktreeStrategy } from "./worktree-strategy";

export interface CreateSandboxFromWorktreeInput {
  readonly agent: AgentProvider;
  readonly provider: BindMountSandboxProvider;
  readonly hostRepoPath: string;
  readonly strategy: WorktreeStrategy;
  readonly env: Readonly<Record<string, string>>;
  readonly hooks: SandboxHooks | undefined;
  readonly copyToWorktree: readonly string[] | undefined;
  readonly timeouts: Timeouts | undefined;
  readonly logging: LoggingOption | undefined;
  /** When true, close() tears down the worktree alongside the container.
   *  When false, the parent Worktree owns teardown. */
  readonly ownsWorktree: boolean;
  readonly seams?: CreateSandboxSeams;
}

export interface CreateSandboxSeams {
  readonly agentInvokerLayer?: Layer.Layer<AgentInvoker, never, never>;
}

/** Hooks fire once here; sandbox.run() does not re-fire them. */
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
    // Each teardown step swallows so the original error surfaces.
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
  /** Per-run() logging overrides this default. */
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
    // Belt-and-braces — TS already rejects this at the type level.
    if ((options as { resumeSession?: unknown }).resumeSession !== undefined) {
      throw new Error(
        "sandbox.run() does not accept resumeSession — agent session resume is a fresh-sandbox concern (see CONTEXT.md).",
      );
    }

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

    let runError: Error | undefined;
    let result: RunResult | undefined;
    try {
      result = await runOnHandle({
        handle,
        strategy,
        agent,
        hostRepoPath: input.hostRepoPath,
        session,
        promptPipeline,
        ...(options.maxIterations !== undefined && {
          maxIterations: options.maxIterations,
        }),
        ...(options.completionSignal !== undefined && {
          completionSignal: options.completionSignal,
        }),
        ...(options.idleTimeoutSeconds !== undefined && {
          idleTimeoutSeconds: options.idleTimeoutSeconds,
        }),
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(input.seams?.agentInvokerLayer !== undefined && {
          agentInvokerLayer: input.seams.agentInvokerLayer,
        }),
      });
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    } finally {
      await (runError !== undefined
        ? session.endError(runError.message)
        : session.endOk());
    }

    if (runError !== undefined) throw runError;
    return result!;
  };

  const close = async (): Promise<CloseResult> => {
    if (closed) return { worktreePreserved: false };
    closed = true;

    await closeHandleSafely(handle);

    if (!input.ownsWorktree) {
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
