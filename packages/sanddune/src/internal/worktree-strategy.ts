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
  /** Equals targetBranch for head/merge-to-head; sourceBranch for branch. */
  readonly resultBranch: string;
  /** No-op for head/branch; fast-forwards source back to target for
   *  merge-to-head. */
  finalize(): Promise<void>;
  /** Never throws — logs to stderr on internal failure. */
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
  // Branch paths are deterministic so a previous killed run can collide;
  // merge-to-head uses random ids and head has no worktree.
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
