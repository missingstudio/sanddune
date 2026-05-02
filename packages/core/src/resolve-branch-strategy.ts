import type { BranchStrategy } from "./branch-strategy";
import type { SandboxKind } from "./sandbox-provider";

export type WorktreePlan =
  | {
      readonly type: "head";
      readonly targetBranch: string;
      readonly sourceBranch: string;
    }
  | {
      readonly type: "merge-to-head";
      readonly targetBranch: string;
    }
  | {
      readonly type: "branch";
      readonly targetBranch: string;
      readonly sourceBranch: string;
    };

export interface ResolveBranchStrategyInput {
  readonly strategy: BranchStrategy;
  readonly providerKind: SandboxKind;
  readonly hostBranch: string;
}

export function resolveBranchStrategy(
  input: ResolveBranchStrategyInput,
): WorktreePlan {
  const { strategy, providerKind, hostBranch } = input;

  switch (strategy.type) {
    case "head": {
      if (providerKind === "isolated") {
        throw new Error(
          `Branch strategy "head" is not allowed with an "isolated" sandbox provider — isolated providers cannot write to the host filesystem.`,
        );
      }
      return {
        type: "head",
        targetBranch: hostBranch,
        sourceBranch: hostBranch,
      };
    }
    case "merge-to-head": {
      return {
        type: "merge-to-head",
        targetBranch: hostBranch,
      };
    }
    case "branch": {
      return {
        type: "branch",
        targetBranch: hostBranch,
        sourceBranch: strategy.branch,
      };
    }
  }
}
