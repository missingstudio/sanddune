import type { AgentProvider } from "./agent-provider";
import type { SandboxHooks } from "./hooks";
import type { LoggingOption } from "./logging";
import type { PromptOption } from "./prompt";
import type {
  CreateSandboxProvider,
  ExecResult,
} from "./sandbox-provider";
import type { Timeouts } from "./timeouts";
import type { CopyToWorktree, RunResult } from "./run";

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
  readonly copyToWorktree?: readonly (string | CopyToWorktree)[];
}

export type SandboxRunOptions = PromptOption & {
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly logging?: LoggingOption;
  readonly signal?: AbortSignal;
};

export interface CloseResult {
  readonly worktreePreserved: boolean;
  readonly worktreePath?: string;
}

export interface Sandbox {
  readonly branch: string;
  readonly worktreePath: string;
  run(options: SandboxRunOptions): Promise<RunResult>;
  exec(command: string, options?: { sudo?: boolean }): Promise<ExecResult>;
  close(): Promise<CloseResult>;
}
