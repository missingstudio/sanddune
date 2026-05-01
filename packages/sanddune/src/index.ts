import { NotImplementedError } from "@missingstudio/sanddune-core";
import type {
  CreateSandboxOptions,
  CreateSandboxProvider,
  CreateWorktreeOptions,
  InteractiveOptions,
  InteractiveSandboxProvider,
  RunOptions,
  RunResult,
  RunSandboxProvider,
  Sandbox,
  Worktree,
} from "@missingstudio/sanddune-core";

export * from "@missingstudio/sanddune-core";

export function run<S extends RunSandboxProvider>(
  _options: RunOptions<S>,
): Promise<RunResult> {
  throw new NotImplementedError("run");
}

export function createSandbox<S extends CreateSandboxProvider>(
  _options: CreateSandboxOptions<S>,
): Promise<Sandbox> {
  throw new NotImplementedError("createSandbox");
}

export function createWorktree(
  _options?: CreateWorktreeOptions,
): Promise<Worktree> {
  throw new NotImplementedError("createWorktree");
}

export function interactive<S extends InteractiveSandboxProvider>(
  _options: InteractiveOptions<S>,
): Promise<void> {
  throw new NotImplementedError("interactive");
}
