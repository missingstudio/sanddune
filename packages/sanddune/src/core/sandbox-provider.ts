import type { BranchStrategy, NonHeadBranchStrategy } from "./branch-strategy";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly sudo?: boolean;
  readonly onLine?: (line: string) => void;
  /** Abort kills with SIGTERM and rejects with signal.reason verbatim. */
  readonly signal?: AbortSignal;
}

export interface ExecInteractiveOptions {
  readonly cwd?: string;
  /** Abort kills with SIGTERM and rejects with signal.reason verbatim. */
  readonly signal?: AbortSignal;
}

export interface ExecInteractiveResult {
  readonly exitCode: number;
}

export type SandboxKind = "bind-mount" | "isolated" | "no-sandbox";

export interface BindMountCreateOptions {
  readonly worktreePath: string;
  readonly hostRepoPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface BindMountSandboxHandle {
  readonly worktreePath: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Inherits host stdio for an agent's TUI. Providers that omit this
   *  cannot be used by interactive(). */
  execInteractive?(
    command: string,
    options?: ExecInteractiveOptions,
  ): Promise<ExecInteractiveResult>;
  close(): Promise<void>;
}

export interface BindMountSandboxProvider {
  readonly kind: "bind-mount";
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

export interface IsolatedSandboxHandle {
  readonly worktreePath: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  copyIn(source: string, destination: string): Promise<void>;
  copyFileOut(source: string, destination: string): Promise<void>;
  extractCommits(branch: string): Promise<readonly string[]>;
  close(): Promise<void>;
}

export interface IsolatedSandboxProvider {
  readonly kind: "isolated";
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface NoSandboxProvider {
  readonly kind: "no-sandbox";
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Discriminated by `kind`. */
export type SandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider
  | NoSandboxProvider;

export type RunSandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider;

export type CreateSandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider;

export type InteractiveSandboxProvider = SandboxProvider;

export type AllowedBranchStrategy<S extends SandboxProvider> = [S] extends [
  IsolatedSandboxProvider,
]
  ? NonHeadBranchStrategy
  : BranchStrategy;
