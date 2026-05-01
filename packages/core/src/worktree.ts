import type { AgentProvider } from "./agent-provider";
import type { NonHeadBranchStrategy } from "./branch-strategy";
import type { SandboxHooks } from "./hooks";
import type { LoggingOption } from "./logging";
import type { PromptOption } from "./prompt";
import type {
  CreateSandboxProvider,
  InteractiveSandboxProvider,
  RunSandboxProvider,
} from "./sandbox-provider";
import type { Timeouts } from "./timeouts";
import type { CopyToWorktree, RunResult } from "./run";
import type { Sandbox } from "./sandbox";

export interface CreateWorktreeOptions {
  readonly cwd?: string;
  readonly branchStrategy?: NonHeadBranchStrategy;
}

export type WorktreeRunOptions<
  S extends RunSandboxProvider = RunSandboxProvider,
> = PromptOption & {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly logging?: LoggingOption;
  readonly signal?: AbortSignal;
  readonly copyToWorktree?: readonly (string | CopyToWorktree)[];
};

export type WorktreeInteractiveOptions<
  S extends InteractiveSandboxProvider = InteractiveSandboxProvider,
> = PromptOption & {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly copyToWorktree?: readonly (string | CopyToWorktree)[];
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
  readonly copyToWorktree?: readonly (string | CopyToWorktree)[];
}

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly branchStrategy: NonHeadBranchStrategy;
  run(options: WorktreeRunOptions): Promise<RunResult>;
  interactive(options: WorktreeInteractiveOptions): Promise<void>;
  createSandbox(options: WorktreeCreateSandboxOptions): Promise<Sandbox>;
  close(): Promise<void>;
}
