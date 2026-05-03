import { resolve as resolvePath } from "node:path";
import {
  type CloseResult,
  type CreateWorktreeOptions,
  type InteractiveSandboxProvider,
  type RunResult,
  type Sandbox,
  type Worktree,
  type WorktreeCreateSandboxOptions,
  type WorktreeInteractiveOptions,
  type WorktreeRunOptions,
} from "../core";
import { noSandbox } from "../sandboxes/no-sandbox";
import {
  createSandboxFromWorktree,
  type CreateSandboxSeams,
} from "./create-sandbox";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch } from "./git";
import { runInteractiveSession } from "./interactive-program";
import { join } from "node:path";
import { createWorktreeStrategy, type WorktreeStrategy } from "./worktree-strategy";

export interface CreateWorktreeSeams {
  readonly sandboxSeams?: CreateSandboxSeams;
}

/** Builds a long-lived `Worktree` handle. The worktree is created here and
 *  torn down only by `wt.close()` (ADR-0010); sandboxes layered via
 *  `wt.createSandbox()` close their containers without touching the worktree. */
export async function createWorktreeProgram(
  options: CreateWorktreeOptions,
  seams: CreateWorktreeSeams = {},
): Promise<Worktree> {
  // Belt-and-braces — `NonHeadBranchStrategy` already excludes `head` at the
  // type level, but JS callers (or `as never` escapes) could still pass it.
  if ((options.branchStrategy as { type: string }).type === "head") {
    throw new Error(
      `createWorktree() does not accept branchStrategy "head" — long-lived worktrees must be either { type: "branch", branch } or { type: "merge-to-head" }.`,
    );
  }

  const cwd = resolvePath(options.cwd ?? process.cwd());
  const hostBranch = await gitCurrentBranch(cwd);

  // `providerKind` is only used by `createWorktreeStrategy` to reject
  // `head + isolated`. Since we've already rejected `head`, the provider
  // kind is irrelevant — pass `bind-mount` as a placeholder that satisfies
  // the strategy's validation.
  const strategy = await createWorktreeStrategy({
    strategy: options.branchStrategy,
    providerKind: "bind-mount",
    cwd,
    hostBranch,
  });

  return makeWorktreeHandle({
    strategy,
    hostRepoPath: cwd,
    branchStrategy: options.branchStrategy,
    creationCopyToWorktree: options.copyToWorktree,
    creationTimeouts: options.timeouts,
    sandboxSeams: seams.sandboxSeams,
  });
}

interface MakeWorktreeHandleInput {
  readonly strategy: WorktreeStrategy;
  readonly hostRepoPath: string;
  readonly branchStrategy: CreateWorktreeOptions["branchStrategy"];
  readonly creationCopyToWorktree: readonly string[] | undefined;
  readonly creationTimeouts: CreateWorktreeOptions["timeouts"];
  readonly sandboxSeams: CreateSandboxSeams | undefined;
}

function makeWorktreeHandle(input: MakeWorktreeHandleInput): Worktree {
  const { strategy, hostRepoPath } = input;
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new Error("worktree is closed");
  };

  const wtRun = async (options: WorktreeRunOptions): Promise<RunResult> => {
    ensureOpen();
    if (options.sandbox.kind !== "bind-mount") {
      throw new Error(
        `wt.run() supports only bind-mount sandbox providers in this release; got ${options.sandbox.kind}.`,
      );
    }
    const provider = options.sandbox;

    const env = await resolveEnv({
      processEnv: process.env,
      sandduneEnvPath: join(hostRepoPath, ".sanddune", ".env"),
      agentEnv: options.agent.env,
      sandboxEnv: provider.env,
      runOptionsEnv: options.env,
    });

    // Each `wt.run()` is a complete AFK run — fire creation hooks, run the
    // iteration loop, finalize on success, then tear down only the container
    // (worktree stays for the next `wt.run()` / `wt.createSandbox()` /
    // `wt.close()`). `ownsWorktree: false` is the ADR-0010 pivot.
    const sandbox = await createSandboxFromWorktree({
      agent: options.agent,
      provider,
      hostRepoPath,
      strategy,
      env,
      hooks: options.hooks,
      copyToWorktree: options.copyToWorktree ?? input.creationCopyToWorktree,
      timeouts: options.timeouts ?? input.creationTimeouts,
      logging: options.logging,
      ownsWorktree: false,
      ...(input.sandboxSeams !== undefined && { seams: input.sandboxSeams }),
    });

    let result: RunResult;
    try {
      result = await sandbox.run({
        ...(options.prompt !== undefined && { prompt: options.prompt }),
        ...(options.promptFile !== undefined && {
          promptFile: options.promptFile,
        }),
        ...(options.promptArgs !== undefined && {
          promptArgs: options.promptArgs,
        }),
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
        ...(options.logging !== undefined && { logging: options.logging }),
      } as Parameters<typeof sandbox.run>[0]);
      // `merge-to-head`: ff-merge the temp branch back into host head; no-op
      // for `branch`. Only runs on a successful iteration loop — matches
      // `runProgram()` semantics.
      await strategy.finalize();
    } finally {
      // Closes the container only — `ownsWorktree: false` keeps the
      // worktree under the parent `Worktree`'s ownership.
      await sandbox.close();
    }
    return result;
  };

  const wtInteractive = async (
    options: WorktreeInteractiveOptions,
  ): Promise<void> => {
    ensureOpen();
    // Per ADR-0010: `wt.interactive()` runs over the worktree this
    // `Worktree` already owns; we never tear it down. The provider
    // defaults to `noSandbox()` (CONTEXT.md / brief).
    const provider: InteractiveSandboxProvider = options.sandbox ?? noSandbox();
    const env = await resolveEnv({
      processEnv: process.env,
      sandduneEnvPath: join(hostRepoPath, ".sanddune", ".env"),
      agentEnv: options.agent.env,
      sandboxEnv: provider.env,
      runOptionsEnv: options.env,
    });

    await runInteractiveSession({
      agent: options.agent,
      provider,
      strategy,
      branchStrategy: input.branchStrategy,
      hostRepoPath,
      env,
      promptInput: extractWorktreePromptInput(options),
      hooks: options.hooks,
      timeouts: options.timeouts ?? input.creationTimeouts,
      copyToWorktree: options.copyToWorktree ?? input.creationCopyToWorktree,
      signal: options.signal,
      ownsWorktree: false,
    });
  };

  const wtCreateSandbox = async (
    options: WorktreeCreateSandboxOptions,
  ): Promise<Sandbox> => {
    ensureOpen();
    if (options.sandbox.kind !== "bind-mount") {
      throw new Error(
        `wt.createSandbox() supports only bind-mount sandbox providers in this release; got ${options.sandbox.kind}.`,
      );
    }
    const provider = options.sandbox;
    const env = await resolveEnv({
      processEnv: process.env,
      sandduneEnvPath: join(hostRepoPath, ".sanddune", ".env"),
      agentEnv: options.agent.env,
      sandboxEnv: provider.env,
      runOptionsEnv: options.env,
    });
    return await createSandboxFromWorktree({
      agent: options.agent,
      provider,
      hostRepoPath,
      strategy,
      env,
      hooks: options.hooks,
      copyToWorktree: options.copyToWorktree ?? input.creationCopyToWorktree,
      timeouts: options.timeouts ?? input.creationTimeouts,
      logging: options.logging,
      ownsWorktree: false,
      ...(input.sandboxSeams !== undefined && { seams: input.sandboxSeams }),
    });
  };

  const close = async (): Promise<CloseResult> => {
    if (closed) return { worktreePreserved: false };
    closed = true;
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

  return {
    worktreePath: strategy.worktreePath,
    branch: strategy.resultBranch,
    branchStrategy: input.branchStrategy,
    run: wtRun,
    interactive: wtInteractive,
    createSandbox: wtCreateSandbox,
    close,
    [Symbol.asyncDispose]: async () => {
      await close();
    },
  };
}

function extractWorktreePromptInput(options: WorktreeInteractiveOptions): {
  prompt?: string;
  promptFile?: string;
  promptArgs?: Readonly<Record<string, string | number>>;
} {
  const result: {
    prompt?: string;
    promptFile?: string;
    promptArgs?: Readonly<Record<string, string | number>>;
  } = {};
  if (typeof options.prompt === "string") result.prompt = options.prompt;
  if (typeof options.promptFile === "string") {
    result.promptFile = options.promptFile;
  }
  if (options.promptArgs !== undefined) result.promptArgs = options.promptArgs;
  return result;
}
