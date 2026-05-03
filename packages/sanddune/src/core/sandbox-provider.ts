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
}

export type SandboxKind = "bind-mount" | "isolated" | "no-sandbox";

export interface SandboxProvider<K extends SandboxKind = SandboxKind> {
  readonly kind: K;
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface BindMountCreateOptions {
  readonly worktreePath: string;
  readonly hostRepoPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface BindMountSandboxHandle {
  readonly worktreePath: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface BindMountSandboxProvider extends SandboxProvider<"bind-mount"> {
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

export type IsolatedSandboxProvider = SandboxProvider<"isolated">;
export type NoSandboxProvider = SandboxProvider<"no-sandbox">;

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
