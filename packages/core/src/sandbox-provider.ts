import type { BranchStrategy, NonHeadBranchStrategy } from "./branch-strategy";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type SandboxKind = "bind-mount" | "isolated" | "no-sandbox";

export interface SandboxProvider<K extends SandboxKind = SandboxKind> {
  readonly kind: K;
  readonly env?: Readonly<Record<string, string>>;
}

export type BindMountSandboxProvider = SandboxProvider<"bind-mount">;
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

export interface BindMountSandboxHandle {
  exec(command: string, options?: { sudo?: boolean }): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface IsolatedSandboxHandle {
  exec(command: string, options?: { sudo?: boolean }): Promise<ExecResult>;
  copyIn(source: string, destination: string): Promise<void>;
  copyFileOut(source: string, destination: string): Promise<void>;
  extractCommits(branch: string): Promise<readonly string[]>;
  close(): Promise<void>;
}
