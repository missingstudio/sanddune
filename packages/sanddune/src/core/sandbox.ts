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

/** Per-call options for `sandbox.run()`. Equals top-level `RunOptions` minus
 *  the fields that are inherited from `createSandbox()` (`cwd`,
 *  `branchStrategy`, `copyToWorktree`, `hooks`, `timeouts`) and minus
 *  `resumeSession` — Claude **agent session** chaining is a fresh-sandbox
 *  concern only (per #14, ADR / CONTEXT). */
export type SandboxRunOptions = PromptOption & {
  readonly name?: string;
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly idleTimeoutSeconds?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly logging?: LoggingOption;
  readonly signal?: AbortSignal;
  /** Rejected at the type level — see SandboxRunOptions docstring. */
  readonly resumeSession?: never;
};

/** Per-call options for `sandbox.interactive()`. Like top-level
 *  `InteractiveOptions` minus the fields inherited from `createSandbox()`
 *  (`cwd`, `branchStrategy`, `copyToWorktree`, `hooks`, `timeouts`). The
 *  prompt is optional — callers may launch a TUI with no seed. */
export type SandboxInteractiveOptions = OptionalPromptOption & {
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
};

export interface CloseResult {
  readonly worktreePreserved: boolean;
  /** Set only when the worktree was dirty at close — per #5, dirty worktrees
   *  are preserved on disk so the user can recover work; clean worktrees are
   *  removed. Always `undefined` when the **sandbox** was created via
   *  `wt.createSandbox()` (worktree ownership lives with the parent
   *  `Worktree`, not the sandbox — ADR-0010). */
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