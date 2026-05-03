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

export interface IterationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens?: number;
  readonly cacheReadTokens?: number;
}

export interface IterationResult {
  readonly iteration: number;
  readonly commitSha?: string;
  /** **Agent session** id, populated when the agent provider has a
   *  `sessionCapture` capability and emitted an id during the iteration.
   *  `undefined` for non-Claude providers and when `captureSessions: false`. */
  readonly sessionId?: string;
  /** Absolute host path to the captured **agent session** JSONL. Populated
   *  only when capture succeeds; capture failure logs a warning and leaves
   *  this `undefined` (run still resolves successfully — see CONTEXT.md
   *  "agent session capture is best-effort"). */
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
    /** Aborts the iteration if the **agent** produces no **agent stream
     *  event** (text or toolCall) for this many seconds. Resets on every
     *  event. Default `600`. Implemented as a synthesized abort — the
     *  rejected promise carries `AgentIdleTimeoutError` as its reason
     *  (ADR-0011). */
    readonly idleTimeoutSeconds?: number;
    readonly hooks?: SandboxHooks;
    readonly timeouts?: Timeouts;
    readonly logging?: LoggingOption;
    readonly signal?: AbortSignal;
    readonly resumeSession?: string;
    readonly copyToWorktree?: readonly string[];
  };
