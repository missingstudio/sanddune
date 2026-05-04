import type { AgentProvider } from "./agent-provider";
import type { SandboxHooks } from "./hooks";
import type { LoggingOption } from "./logging";
import type { OptionalPromptOption, PromptOption } from "./prompt";
import type {
  CreateSandboxProvider,
} from "./sandbox-provider";
import type { Timeouts } from "./timeouts";
import type { RunResult } from "./run";

export interface CreateSandboxOptions<
  S extends CreateSandboxProvider = CreateSandboxProvider,
> {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly branch: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly logging?: LoggingOption;
  readonly copyToWorktree?: readonly string[];
}

/** Equals RunOptions minus fields inherited from createSandbox() (cwd,
 *  branchStrategy, copyToWorktree, hooks, timeouts) and minus resumeSession
 *  — agent session chaining is a fresh-sandbox concern. */
export type SandboxRunOptions = PromptOption & {
  readonly name?: string;
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly idleTimeoutSeconds?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly logging?: LoggingOption;
  readonly signal?: AbortSignal;
  readonly resumeSession?: never;
};

export type SandboxInteractiveOptions = OptionalPromptOption & {
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
};

export interface CloseResult {
  readonly worktreePreserved: boolean;
  /** Set only when the worktree was dirty at close. Always undefined for
   *  sandboxes created via wt.createSandbox() (worktree ownership lives with
   *  the parent Worktree). */
  readonly preservedWorktreePath?: string;
}

export interface Sandbox {
  readonly branch: string;
  readonly worktreePath: string;
  run(options: SandboxRunOptions): Promise<RunResult>;
  interactive(options: SandboxInteractiveOptions): Promise<void>;
  close(): Promise<CloseResult>;
  [Symbol.asyncDispose](): Promise<void>;
}