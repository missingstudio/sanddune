import { join, resolve as resolvePath } from "node:path";
import {
  type AgentProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type BranchStrategy,
  type InteractiveOptions,
  type InteractiveSandboxProvider,
  type SandboxHooks,
  type Timeouts,
} from "../core";
import { runCopyToWorktree } from "./copy-to-worktree";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch } from "./git";
import {
  runHostHooksSequential,
  runOnSandboxReadyParallel,
} from "./hook-runner";
import { spawnHost, spawnHostInteractive } from "./host-process";
import {
  buildAgentInteractiveCommand,
  resolveInteractivePrompt,
  type InteractivePromptInput,
} from "./interactive-shared";
import {
  createWorktreeStrategy,
  type WorktreeStrategy,
} from "./worktree-strategy";

export async function interactiveProgram(
  options: InteractiveOptions<InteractiveSandboxProvider>,
): Promise<void> {
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const provider = options.sandbox;
  const branchStrategy: BranchStrategy = defaultBranchStrategy(provider.kind);

  const env = await resolveEnv({
    processEnv: process.env,
    sandduneEnvPath: join(cwd, ".sanddune", ".env"),
    agentEnv: options.agent.env,
    sandboxEnv: provider.env,
    runOptionsEnv: options.env,
  });

  const targetBranch = await gitCurrentBranch(cwd);
  const strategy = await createWorktreeStrategy({
    strategy: branchStrategy,
    providerKind: provider.kind,
    cwd,
    hostBranch: targetBranch,
  });

  await runInteractiveSession({
    agent: options.agent,
    provider,
    strategy,
    branchStrategy,
    hostRepoPath: cwd,
    env,
    promptInput: extractPromptInput(options),
    hooks: options.hooks,
    timeouts: options.timeouts,
    copyToWorktree: options.copyToWorktree,
    signal: options.signal,
    ownsWorktree: true,
  });
}

export interface RunInteractiveSessionInput {
  readonly agent: AgentProvider;
  readonly provider: InteractiveSandboxProvider;
  readonly strategy: WorktreeStrategy;
  readonly branchStrategy: BranchStrategy;
  readonly hostRepoPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly promptInput: InteractivePromptInput;
  readonly hooks: SandboxHooks | undefined;
  readonly timeouts: Timeouts | undefined;
  readonly copyToWorktree: readonly string[] | undefined;
  readonly signal: AbortSignal | undefined;
  /** When false, the caller owns worktree teardown (`wt.interactive()`). */
  readonly ownsWorktree: boolean;
}

export async function runInteractiveSession(
  input: RunInteractiveSessionInput,
): Promise<void> {
  let handle: BindMountSandboxHandle | undefined;
  let runError: Error | undefined;

  try {
    await runCopyToWorktree({
      items: input.copyToWorktree,
      cwd: input.hostRepoPath,
      worktreePath: input.strategy.worktreePath,
      branchStrategy: input.branchStrategy,
      timeoutMs: input.timeouts?.copyToWorktreeMs,
      signal: input.signal,
    });

    await runHostHooksSequential(
      input.hooks?.host?.onWorktreeReady,
      input.signal,
    );

    if (input.provider.kind === "isolated") {
      throw new Error(
        `interactive() with an isolated sandbox provider is not yet implemented; got "${input.provider.name}".`,
      );
    }

    if (input.provider.kind === "bind-mount") {
      const provider = input.provider as BindMountSandboxProvider;
      handle = await provider.create({
        worktreePath: input.strategy.worktreePath,
        hostRepoPath: input.hostRepoPath,
        env: input.env,
      });
      if (handle.execInteractive === undefined) {
        throw new Error(
          `Sandbox provider "${provider.name}" does not support interactive sessions (no execInteractive).`,
        );
      }

      await runOnSandboxReadyParallel({
        hostHooks: input.hooks?.host?.onSandboxReady,
        sandboxHooks: input.hooks?.sandbox?.onSandboxReady,
        handle,
        signal: input.signal,
      });

      const prompt = await resolveInteractivePrompt({
        promptInput: input.promptInput,
        sourceBranch: input.strategy.sourceBranch,
        targetBranch: input.strategy.targetBranch,
        execAdapter: (cmd) => handle!.exec(cmd),
      });

      const command = buildAgentInteractiveCommand({
        agent: input.agent,
        prompt,
        skipPermissions: true,
      });

      await handle.execInteractive(command, {
        ...(input.signal !== undefined && { signal: input.signal }),
      });
    } else {
      // no-sandbox: agent runs directly on the host. Sandbox-side hooks are
      // silently skipped; host-side onSandboxReady still fires.
      await runHostHooksSequential(
        input.hooks?.host?.onSandboxReady,
        input.signal,
      );

      const worktreePath = input.strategy.worktreePath;
      const prompt = await resolveInteractivePrompt({
        promptInput: input.promptInput,
        sourceBranch: input.strategy.sourceBranch,
        targetBranch: input.strategy.targetBranch,
        execAdapter: async (cmd) => {
          const r = await spawnHost("sh", ["-c", cmd], {
            cwd: worktreePath,
          });
          return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
        },
      });

      const command = buildAgentInteractiveCommand({
        agent: input.agent,
        prompt,
        skipPermissions: false,
      });

      await spawnHostInteractive("sh", ["-c", command], {
        cwd: worktreePath,
        env: input.env,
        ...(input.signal !== undefined && { signal: input.signal }),
      });
    }

    await input.strategy.finalize();
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
  } finally {
    await closeHandleSafely(handle);
    if (input.ownsWorktree) {
      try {
        await input.strategy.close();
      } catch (e) {
        process.stderr.write(
          `sanddune: worktree teardown failed: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
      }
    }
  }

  if (runError !== undefined) throw runError;
}

function defaultBranchStrategy(kind: string): BranchStrategy {
  return kind === "isolated" ? { type: "merge-to-head" } : { type: "head" };
}

function extractPromptInput(
  options: InteractiveOptions<InteractiveSandboxProvider>,
): InteractivePromptInput {
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

async function closeHandleSafely(
  handle: BindMountSandboxHandle | undefined,
): Promise<void> {
  if (handle === undefined) return;
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
