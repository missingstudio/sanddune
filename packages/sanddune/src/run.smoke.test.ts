import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "bun:test";
import type { AgentProvider } from "./core";
import { run } from "./index";
import { docker } from "./sandboxes/docker";

const E2E_ENABLED = process.env["SANDDUNE_E2E"] === "1";

const SMOKE_IMAGE = process.env["SANDDUNE_E2E_IMAGE"] ?? "alpine/git:latest";

describe.skipIf(!E2E_ENABLED)("run() against real Docker (smoke)", () => {
  test("inline prompt + bind-mount + head strategy lands a commit", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sanddune-smoke-"));
    try {
      runSync("git", ["init", "--initial-branch=main"], repo);
      runSync("git", ["config", "user.email", "test@example.com"], repo);
      runSync("git", ["config", "user.name", "test"], repo);
      runSync("git", ["config", "commit.gpgsign", "false"], repo);
      await writeFile(join(repo, "README.md"), "seed\n");
      runSync("git", ["add", "."], repo);
      runSync("git", ["commit", "-m", "seed"], repo);

      const shellAgent: AgentProvider = {
        name: "shell-stub",
        buildCommand: () =>
          [
            "git config --global --add safe.directory /workspace",
            "echo agent-edit > agent.txt",
            "git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false add agent.txt",
            "git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'agent edit'",
          ].join(" && "),
        parseLine: () => [],
      };

      const result = await run({
        agent: shellAgent,
        sandbox: docker({ image: SMOKE_IMAGE }),
        prompt: "ignored — buildCommand drives the commit",
        cwd: repo,
      });

      expect(result.commits).toHaveLength(1);
      expect(result.iterations[0]?.commitSha).toBe(result.commits[0]);
      const headSha = runSync("git", ["rev-parse", "HEAD"], repo).stdout.trim();
      expect(result.commits[0]).toBe(headSha);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);
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
