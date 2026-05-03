import { NotImplementedError } from "./core";
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
} from "./core";
import { createSandboxProgram } from "./internal/create-sandbox-program";
import { createWorktreeProgram } from "./internal/create-worktree-program";
import { runProgram } from "./internal/run-program";

export * from "./core";
export { claudeCode, type ClaudeCodeOptions } from "./agents/claude-code";

export function run<S extends RunSandboxProvider>(
  options: RunOptions<S>,
): Promise<RunResult> {
  return runProgram(options as RunOptions<RunSandboxProvider>);
}

export function createSandbox<S extends CreateSandboxProvider>(
  options: CreateSandboxOptions<S>,
): Promise<Sandbox> {
  return createSandboxProgram(
    options as CreateSandboxOptions<CreateSandboxProvider>,
  );
}

export function createWorktree(
  options: CreateWorktreeOptions,
): Promise<Worktree> {
  return createWorktreeProgram(options);
}

export function interactive<S extends InteractiveSandboxProvider>(
  _options: InteractiveOptions<S>,
): Promise<void> {
  throw new NotImplementedError("interactive");
}
