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

/** Raw token counts for one **iteration**, parsed from the **agent session**
 *  JSONL by the **agent provider**'s `parseUsage` capability. Per ADR 0005b
 *  these are deliberately raw — not a percentage of the context window —
 *  because the model's context limit is not available from any data source
 *  sanddune reads. Callers who know the limit can compute percentage
 *  themselves. */
export interface IterationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
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
  /** Absolute path of the **run log**. Populated only in **log-to-file mode**;
   *  `undefined` in **terminal mode**. */
  readonly logFilePath?: string;
}

export type RunOptions<S extends RunSandboxProvider = RunSandboxProvider> =
  PromptOption & {
    readonly agent: AgentProvider;
    readonly sandbox: S;
    readonly cwd?: string;
    /** Display name prefixed in log output for parallel-run readability —
     *  e.g. `[issue-42] tail -f …` and the same prefix in **terminal mode**
     *  status lines. Purely cosmetic; not persisted in the **run log**. */
    readonly name?: string;
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
