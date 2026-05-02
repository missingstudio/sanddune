import type { AgentProvider } from "./agent-provider";
import type { SandboxHooks } from "./hooks";
import type { LoggingOption } from "./logging";
import type { PromptOption } from "./prompt";
import type {
  AllowedBranchStrategy,
  RunSandboxProvider,
} from "./sandbox-provider";
import type { Timeouts } from "./timeouts";

export interface CopyToWorktree {
  readonly source: string;
  readonly destination?: string;
}

export type CompletionSignal = string;

export interface IterationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens?: number;
  readonly cacheReadTokens?: number;
}

export interface IterationResult {
  readonly iteration: number;
  readonly commitSha?: string;
  readonly sessionFilePath?: string;
  readonly usage?: IterationUsage;
  readonly completionSignal?: CompletionSignal;
}

export interface RunResult {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly worktreePath?: string;
  readonly iterations: readonly IterationResult[];
  readonly commits: readonly string[];
  readonly completionSignal?: CompletionSignal;
  readonly stdout: string;
  readonly logFilePath: string;
}

export type RunOptions<S extends RunSandboxProvider = RunSandboxProvider> =
  PromptOption & {
    readonly agent: AgentProvider;
    readonly sandbox: S;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly branchStrategy?: AllowedBranchStrategy<S>;
    readonly maxIterations?: number;
    readonly completionSignal?: string | readonly string[];
    readonly hooks?: SandboxHooks;
    readonly timeouts?: Timeouts;
    readonly logging?: LoggingOption;
    readonly signal?: AbortSignal;
    readonly resumeSession?: string;
    readonly copyToWorktree?: readonly (string | CopyToWorktree)[];
  };
