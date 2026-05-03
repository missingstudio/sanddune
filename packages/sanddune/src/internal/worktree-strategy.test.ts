import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BranchStrategy } from "../core";
import { createWorktreeStrategy } from "./worktree-strategy";

const HEAD: BranchStrategy = { type: "head" };
const MTH: BranchStrategy = { type: "merge-to-head" };
const BRANCH = (branch: string): BranchStrategy => ({ type: "branch", branch });

describe("createWorktreeStrategy", () => {
  describe("validation", () => {
    test("rejects head + isolated", async () => {
      await expect(
        createWorktreeStrategy({
          strategy: HEAD,
          providerKind: "isolated",
          cwd: "/does/not/matter",
          hostBranch: "main",
        }),
      ).rejects.toThrow(/"head".*"isolated"/);
    });
  });

  describe("with a real git repo", () => {
    let repo: string;

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), "sanddune-wts-"));
      runSync("git", ["init", "--initial-branch=main"], repo);
      runSync("git", ["config", "user.email", "test@example.com"], repo);
      runSync("git", ["config", "user.name", "test"], repo);
      runSync("git", ["config", "commit.gpgsign", "false"], repo);
      await writeFile(join(repo, "README.md"), "seed\n");
      runSync("git", ["add", "."], repo);
      runSync("git", ["commit", "-m", "seed"], repo);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    test("head + bind-mount: worktreePath = cwd, all branches = hostBranch, close is no-op", async () => {
      const strategy = await createWorktreeStrategy({
        strategy: HEAD,
        providerKind: "bind-mount",
        cwd: repo,
        hostBranch: "main",
      });

      expect(strategy.worktreePath).toBe(repo);
      expect(strategy.sourceBranch).toBe("main");
      expect(strategy.targetBranch).toBe("main");
      expect(strategy.resultBranch).toBe("main");

      await strategy.finalize();
      const close = await strategy.close();
      expect(close).toEqual({});
    });

    test("head + no-sandbox: hostBranch propagates to all three branch fields", async () => {
      const strategy = await createWorktreeStrategy({
        strategy: HEAD,
        providerKind: "no-sandbox",
        cwd: repo,
        hostBranch: "feature/x",
      });

      expect(strategy.sourceBranch).toBe("feature/x");
      expect(strategy.targetBranch).toBe("feature/x");
      expect(strategy.resultBranch).toBe("feature/x");

      await strategy.close();
    });

    test("merge-to-head: creates a worktree, resultBranch = targetBranch (host)", async () => {
      const strategy = await createWorktreeStrategy({
        strategy: MTH,
        providerKind: "bind-mount",
        cwd: repo,
        hostBranch: "main",
      });

      expect(strategy.worktreePath).toContain(".sanddune/worktrees");
      expect(existsSync(strategy.worktreePath)).toBe(true);
      expect(strategy.sourceBranch).toMatch(/^sanddune\/merge-to-head\//);
      expect(strategy.targetBranch).toBe("main");
      expect(strategy.resultBranch).toBe("main");

      const close = await strategy.close();
      expect(close).toEqual({});
      expect(existsSync(strategy.worktreePath)).toBe(false);
    });

    test("branch: creates a worktree on the named branch, resultBranch = sourceBranch", async () => {
      const strategy = await createWorktreeStrategy({
        strategy: BRANCH("agent/foo"),
        providerKind: "bind-mount",
        cwd: repo,
        hostBranch: "main",
      });

      expect(existsSync(strategy.worktreePath)).toBe(true);
      expect(strategy.sourceBranch).toBe("agent/foo");
      expect(strategy.targetBranch).toBe("main");
      expect(strategy.resultBranch).toBe("agent/foo");

      const close = await strategy.close();
      expect(close).toEqual({});
      expect(existsSync(strategy.worktreePath)).toBe(false);
    });

    test("merge-to-head + isolated: accepted (validation only rejects head + isolated)", async () => {
      const strategy = await createWorktreeStrategy({
        strategy: MTH,
        providerKind: "isolated",
        cwd: repo,
        hostBranch: "main",
      });
      expect(strategy.resultBranch).toBe("main");
      await strategy.close();
    });

    test("branch + isolated: accepted", async () => {
      const strategy = await createWorktreeStrategy({
        strategy: BRANCH("agent/iso"),
        providerKind: "isolated",
        cwd: repo,
        hostBranch: "main",
      });
      expect(strategy.resultBranch).toBe("agent/iso");
      await strategy.close();
    });
  });
});

function runSync(
  cmd: string,
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${r.stderr ?? ""}${r.stdout ?? ""}`,
    );
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
