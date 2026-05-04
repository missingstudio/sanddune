import type { AgentProvider } from "./agent-provider";
import type { SandboxHooks } from "./hooks";
import type { LoggingOption } from "./logging";
import type { PromptOption } from "./prompt";
import type {
  AllowedBranchStrategy,
  RunSandboxProvider,
} from "./sandbox-provider";
import type { Timeouts } from "./timeouts";

export type CompletionSignal = string;

/** Raw token counts — sanddune doesn't know the model's context limit, so
 *  callers compute any percentage themselves. */
export interface IterationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

export interface IterationResult {
  readonly iteration: number;
  readonly commitSha?: string;
  readonly sessionId?: string;
  readonly sessionFilePath?: string;
  readonly usage?: IterationUsage;
  readonly completionSignal?: CompletionSignal;
}

export interface RunResult {
  readonly branch: string;
  readonly worktreePath?: string;
  readonly iterations: readonly IterationResult[];
  readonly commits: readonly string[];
  readonly completionSignal?: CompletionSignal;
  readonly stdout: string;
  readonly logFilePath?: string;
}

export type RunOptions<S extends RunSandboxProvider = RunSandboxProvider> =
  PromptOption & {
    readonly agent: AgentProvider;
    readonly sandbox: S;
    readonly cwd?: string;
    /** Prefixed in log output for parallel-run readability. */
    readonly name?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly branchStrategy?: AllowedBranchStrategy<S>;
    readonly maxIterations?: number;
    readonly completionSignal?: string | readonly string[];
    /** Resets on every agent stream event. Default 600. Aborts with
     *  AgentIdleTimeoutError. */
    readonly idleTimeoutSeconds?: number;
    readonly hooks?: SandboxHooks;
    readonly timeouts?: Timeouts;
    readonly logging?: LoggingOption;
    readonly signal?: AbortSignal;
    readonly resumeSession?: string;
    readonly copyToWorktree?: readonly string[];
  };
