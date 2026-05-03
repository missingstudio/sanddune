import { isAbsolute, resolve } from "node:path";
import type { BranchStrategy } from "../core";
import { CopyToWorktreeTimeoutError } from "../core";
import { composeWithTimeout } from "./abort-with-timeout";
import { spawnHost } from "./host-process";

const DEFAULT_COPY_TIMEOUT_MS = 60_000;

/** Copies caller-supplied paths from the host into the worktree before any
 *  hook fires. Items are resolved relative to `cwd` (the target-repo
 *  perspective), not `process.cwd()` — see CONTEXT.md "Path resolution"
 *  for the rationale.
 *
 *  Rejected when `branchStrategy.type === "head"` because the agent works
 *  directly in the host working directory; there is no separate worktree
 *  to copy into. */
export async function runCopyToWorktree(input: {
  readonly items: readonly string[] | undefined;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly branchStrategy: BranchStrategy;
  readonly timeoutMs: number | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  const { items } = input;
  if (!items || items.length === 0) return;

  if (input.branchStrategy.type === "head") {
    throw new Error(
      `copyToWorktree is not supported with branchStrategy "head" — there is no separate worktree to copy into.`,
    );
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS;
  const composed = composeWithTimeout(
    input.signal,
    timeoutMs,
    () => new CopyToWorktreeTimeoutError({ timeoutMs }),
  );
  try {
    for (const item of items) {
      const source = isAbsolute(item) ? item : resolve(input.cwd, item);
      const result = await spawnHost(
        "cp",
        ["-R", source, input.worktreePath],
        { signal: composed.signal },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `copyToWorktree failed (exit ${result.exitCode}): cp -R ${source} ${input.worktreePath}\n${result.stderr}`,
        );
      }
    }
  } finally {
    composed.cleanup();
  }
}
