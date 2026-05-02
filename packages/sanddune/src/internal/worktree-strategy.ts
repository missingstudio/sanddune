import type { WorktreePlan } from "@missingstudio/sanddune-core";
import { gitBranchDelete, gitMerge } from "./git";
import {
  createMergeToHeadWorktree,
  type ManagedWorktree,
} from "./worktree-manager";

export interface WorktreeStrategy {
  readonly worktreePath: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  /** Run after the iteration loop succeeds and before final commit reconciliation.
   *  No-op for `head`; fast-forwards the temp source branch back to the target
   *  branch for `merge-to-head`. */
  afterIteration(): Promise<void>;
  /** Tears down any worktree, lock, or temp branch this strategy created.
   *  Never throws — logs to stderr and returns `{}` on internal failure. */
  close(): Promise<{ preservedPath?: string }>;
}

export interface CreateWorktreeStrategyOptions {
  readonly plan: WorktreePlan;
  readonly cwd: string;
}

export async function createWorktreeStrategy(
  options: CreateWorktreeStrategyOptions,
): Promise<WorktreeStrategy> {
  switch (options.plan.type) {
    case "head":
      return createHeadStrategy({
        cwd: options.cwd,
        sourceBranch: options.plan.sourceBranch,
        targetBranch: options.plan.targetBranch,
      });
    case "merge-to-head":
      return createMergeToHeadStrategy({
        cwd: options.cwd,
        targetBranch: options.plan.targetBranch,
      });
    case "branch":
      throw new Error(
        `run() does not yet support branchStrategy: { type: "branch" } in this release.`,
      );
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
    async afterIteration() {},
    async close() {
      return {};
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
    async afterIteration() {
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
