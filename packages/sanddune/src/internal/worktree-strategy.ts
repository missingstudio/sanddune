import type { BranchStrategy, SandboxKind } from "../core";
import { gitBranchDelete, gitMerge } from "./git";
import {
  createBranchWorktree,
  createMergeToHeadWorktree,
  pruneStaleWorktrees,
  type ManagedWorktree,
} from "./worktree-manager";

export interface WorktreeStrategy {
  readonly worktreePath: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  /** The branch surfaced to the caller as `RunResult.branch` — where the
   *  agent's commits end up. Equals `targetBranch` for `head` and
   *  `merge-to-head` (after fast-forward back), `sourceBranch` for `branch`. */
  readonly resultBranch: string;
  /** Run once after the iteration loop succeeds and before final commit
   *  reconciliation. No-op for `head` and `branch`; fast-forwards the temp
   *  source branch back to the target branch for `merge-to-head`. */
  finalize(): Promise<void>;
  /** Tears down any worktree, lock, or temp branch this strategy created.
   *  Never throws — logs to stderr and returns `{}` on internal failure. */
  close(): Promise<{ preservedPath?: string }>;
}

export interface CreateWorktreeStrategyOptions {
  readonly strategy: BranchStrategy;
  readonly providerKind: SandboxKind;
  readonly cwd: string;
  readonly hostBranch: string;
}

export async function createWorktreeStrategy(
  options: CreateWorktreeStrategyOptions,
): Promise<WorktreeStrategy> {
  const { strategy, providerKind, cwd, hostBranch } = options;

  switch (strategy.type) {
    case "head": {
      if (providerKind === "isolated") {
        throw new Error(
          `Branch strategy "head" is not allowed with an "isolated" sandbox provider — isolated providers cannot write to the host filesystem.`,
        );
      }
      return createHeadStrategy({
        cwd,
        sourceBranch: hostBranch,
        targetBranch: hostBranch,
      });
    }
    case "merge-to-head":
      return createMergeToHeadStrategy({ cwd, targetBranch: hostBranch });
    case "branch":
      return createNamedBranchStrategy({
        cwd,
        branch: strategy.branch,
        targetBranch: hostBranch,
      });
  }
}

function createHeadStrategy(args: {
  cwd: string;
  sourceBranch: string;
  targetBranch: string;
}): WorktreeStrategy {
  return {
    worktreePath: args.cwd,
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
    resultBranch: args.targetBranch,
    async finalize() {},
    async close() {
      return {};
    },
  };
}

async function createNamedBranchStrategy(args: {
  cwd: string;
  branch: string;
  targetBranch: string;
}): Promise<WorktreeStrategy> {
  // Evict admin entries left behind by previous runs killed before close().
  // Only relevant for `branch` (deterministic path → collisions possible);
  // `merge-to-head` uses random ids and `head` doesn't create a worktree.
  await pruneStaleWorktrees(args.cwd);

  const worktree: ManagedWorktree = await createBranchWorktree({
    cwd: args.cwd,
    branch: args.branch,
    targetBranch: args.targetBranch,
  });

  return {
    worktreePath: worktree.path,
    sourceBranch: worktree.sourceBranch,
    targetBranch: args.targetBranch,
    resultBranch: worktree.sourceBranch,
    async finalize() {},
    async close() {
      try {
        const r = await worktree.close();
        return r.preserved && r.path ? { preservedPath: r.path } : {};
      } catch (e) {
        process.stderr.write(
          `sanddune: worktree teardown failed: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
        return {};
      }
    },
  };
}

async function createMergeToHeadStrategy(args: {
  cwd: string;
  targetBranch: string;
}): Promise<WorktreeStrategy> {
  const worktree: ManagedWorktree = await createMergeToHeadWorktree({
    cwd: args.cwd,
    targetBranch: args.targetBranch,
  });
  let mergeOk = false;

  return {
    worktreePath: worktree.path,
    sourceBranch: worktree.sourceBranch,
    targetBranch: args.targetBranch,
    resultBranch: args.targetBranch,
    async finalize() {
      await gitMerge(args.cwd, worktree.sourceBranch);
      mergeOk = true;
    },
    async close() {
      try {
        const r = await worktree.close();
        if (mergeOk && !r.preserved) {
          try {
            await gitBranchDelete(args.cwd, worktree.sourceBranch);
          } catch (e) {
            process.stderr.write(
              `sanddune: failed to delete temp branch ${worktree.sourceBranch}: ${
                e instanceof Error ? e.message : String(e)
              }\n`,
            );
          }
        }
        return r.preserved && r.path ? { preservedPath: r.path } : {};
      } catch (e) {
        process.stderr.write(
          `sanddune: worktree teardown failed: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
        return {};
      }
    },
  };
}
