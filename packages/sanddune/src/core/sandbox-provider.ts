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
  /** When the signal aborts, the underlying subprocess is killed (SIGTERM)
   *  and the returned promise rejects with `signal.reason` verbatim. */
  readonly signal?: AbortSignal;
}

export interface ExecInteractiveOptions {
  readonly cwd?: string;
  /** When the signal aborts, the underlying subprocess is killed (SIGTERM)
   *  and the returned promise rejects with `signal.reason` verbatim. */
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
  /** Optional. Run a command with the host's stdin/stdout/stderr inherited
   *  so the user can interact with the **agent**'s TUI. Used by
   *  `interactive()` / `wt.interactive()`. Providers that omit this method
   *  cannot be used by `interactive()`; the orchestrator throws clearly. */
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

/** The umbrella type for everything a sandbox provider can be. Discriminated
 *  by `kind`: narrowing on `kind === "bind-mount"` gives access to `create()`
 *  on the **bind-mount sandbox provider** arm. The variant interfaces stay
 *  exported for adapter authors who want to name the specific shape they
 *  return. */
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
