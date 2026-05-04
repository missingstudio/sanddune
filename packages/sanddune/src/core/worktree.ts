import type { AgentProvider } from "./agent-provider";
import type { NonHeadBranchStrategy } from "./branch-strategy";
import type { SandboxHooks } from "./hooks";
import type { LoggingOption } from "./logging";
import type { OptionalPromptOption, PromptOption } from "./prompt";
import type {
  CreateSandboxProvider,
  InteractiveSandboxProvider,
  RunSandboxProvider,
} from "./sandbox-provider";
import type { Timeouts } from "./timeouts";
import type { RunResult } from "./run";
import type { CloseResult, Sandbox } from "./sandbox";

export interface CreateWorktreeOptions {
  readonly branchStrategy: NonHeadBranchStrategy;
  readonly cwd?: string;
  readonly copyToWorktree?: readonly string[];
  readonly timeouts?: Timeouts;
}

export type WorktreeRunOptions<
  S extends RunSandboxProvider = RunSandboxProvider,
> = PromptOption & {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly idleTimeoutSeconds?: number;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly logging?: LoggingOption;
  readonly signal?: AbortSignal;
  readonly copyToWorktree?: readonly string[];
};

export type WorktreeInteractiveOptions<
  S extends InteractiveSandboxProvider = InteractiveSandboxProvider,
> = OptionalPromptOption & {
  readonly agent: AgentProvider;
  /** Defaults to noSandbox() — agent runs directly on the host. */
  readonly sandbox?: S;
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly copyToWorktree?: readonly string[];
  readonly signal?: AbortSignal;
};

export interface WorktreeCreateSandboxOptions<
  S extends CreateSandboxProvider = CreateSandboxProvider,
> {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly logging?: LoggingOption;
  readonly copyToWorktree?: readonly string[];
}

export interface Worktree {
  readonly worktreePath: string;
  readonly branch: string;
  readonly branchStrategy: NonHeadBranchStrategy;
  run(options: WorktreeRunOptions): Promise<RunResult>;
  interactive(options: WorktreeInteractiveOptions): Promise<void>;
  createSandbox(options: WorktreeCreateSandboxOptions): Promise<Sandbox>;
  /** Sandboxes spawned via wt.createSandbox() must be closed by the caller
   *  first. Dirty worktrees are preserved on disk. */
  close(): Promise<CloseResult>;
  [Symbol.asyncDispose](): Promise<void>;
}
