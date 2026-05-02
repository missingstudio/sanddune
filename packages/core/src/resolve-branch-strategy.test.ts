import { describe, expect, test } from "bun:test";
import type { BranchStrategy } from "./branch-strategy";
import type { SandboxKind } from "./sandbox-provider";
import {
  resolveBranchStrategy,
  type WorktreePlan,
} from "./resolve-branch-strategy";

interface Cell {
  readonly name: string;
  readonly strategy: BranchStrategy;
  readonly providerKind: SandboxKind;
  readonly hostBranch: string;
  readonly expected:
    | { readonly kind: "ok"; readonly plan: WorktreePlan }
    | { readonly kind: "throws"; readonly message: RegExp };
}

const HEAD: BranchStrategy = { type: "head" };
const MTH: BranchStrategy = { type: "merge-to-head" };
const BRANCH = (branch: string): BranchStrategy => ({ type: "branch", branch });

const PROVIDERS: readonly SandboxKind[] = [
  "bind-mount",
  "isolated",
  "no-sandbox",
];

const cells: readonly Cell[] = [
  // head — valid for bind-mount and no-sandbox; rejected for isolated.
  {
    name: "head + bind-mount + main",
    strategy: HEAD,
    providerKind: "bind-mount",
    hostBranch: "main",
    expected: {
      kind: "ok",
      plan: {
        type: "head",
        targetBranch: "main",
        sourceBranch: "main",
      },
    },
  },
  {
    name: "head + no-sandbox + feature/x",
    strategy: HEAD,
    providerKind: "no-sandbox",
    hostBranch: "feature/x",
    expected: {
      kind: "ok",
      plan: {
        type: "head",
        targetBranch: "feature/x",
        sourceBranch: "feature/x",
      },
    },
  },
  {
    name: "head + isolated → rejected",
    strategy: HEAD,
    providerKind: "isolated",
    hostBranch: "main",
    expected: {
      kind: "throws",
      message: /"head".*"isolated"/,
    },
  },

  // merge-to-head — valid for every provider kind.
  {
    name: "merge-to-head + bind-mount + main",
    strategy: MTH,
    providerKind: "bind-mount",
    hostBranch: "main",
    expected: {
      kind: "ok",
      plan: {
        type: "merge-to-head",
        targetBranch: "main",
      },
    },
  },
  {
    name: "merge-to-head + isolated + main",
    strategy: MTH,
    providerKind: "isolated",
    hostBranch: "main",
    expected: {
      kind: "ok",
      plan: {
        type: "merge-to-head",
        targetBranch: "main",
      },
    },
  },
  {
    name: "merge-to-head + no-sandbox + dev",
    strategy: MTH,
    providerKind: "no-sandbox",
    hostBranch: "dev",
    expected: {
      kind: "ok",
      plan: {
        type: "merge-to-head",
        targetBranch: "dev",
      },
    },
  },

  // branch — valid for every provider kind; sourceBranch comes from the strategy.
  {
    name: "branch(feat/x) + bind-mount + main",
    strategy: BRANCH("feat/x"),
    providerKind: "bind-mount",
    hostBranch: "main",
    expected: {
      kind: "ok",
      plan: {
        type: "branch",
        targetBranch: "main",
        sourceBranch: "feat/x",
      },
    },
  },
  {
    name: "branch(feat/y) + isolated + main",
    strategy: BRANCH("feat/y"),
    providerKind: "isolated",
    hostBranch: "main",
    expected: {
      kind: "ok",
      plan: {
        type: "branch",
        targetBranch: "main",
        sourceBranch: "feat/y",
      },
    },
  },
  {
    name: "branch(feat/z) + no-sandbox + dev",
    strategy: BRANCH("feat/z"),
    providerKind: "no-sandbox",
    hostBranch: "dev",
    expected: {
      kind: "ok",
      plan: {
        type: "branch",
        targetBranch: "dev",
        sourceBranch: "feat/z",
      },
    },
  },
];

describe("resolveBranchStrategy", () => {
  for (const cell of cells) {
    test(cell.name, () => {
      const call = () =>
        resolveBranchStrategy({
          strategy: cell.strategy,
          providerKind: cell.providerKind,
          hostBranch: cell.hostBranch,
        });

      if (cell.expected.kind === "throws") {
        expect(call).toThrow(cell.expected.message);
      } else {
        expect(call()).toEqual(cell.expected.plan);
      }
    });
  }

  test("matrix coverage: every (strategy × providerKind) cell is exercised", () => {
    const seen = new Set<string>();
    for (const cell of cells) {
      const strategyTag =
        cell.strategy.type === "branch" ? "branch" : cell.strategy.type;
      seen.add(`${strategyTag}|${cell.providerKind}`);
    }
    const strategies = ["head", "merge-to-head", "branch"];
    const expected = new Set<string>();
    for (const s of strategies) {
      for (const p of PROVIDERS) expected.add(`${s}|${p}`);
    }
    expect(seen).toEqual(expected);
  });
});
