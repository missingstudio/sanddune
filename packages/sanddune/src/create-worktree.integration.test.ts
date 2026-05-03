import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  AgentInvoker,
  NotImplementedError,
  type AgentInvokerService,
  type AgentProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
} from "./core";
import { createWorktreeProgram } from "./internal/create-worktree-program";

describe("createWorktree (integration)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sanddune-cw-"));
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

  test("worktree exposes branch + worktreePath; close() removes a clean worktree", async () => {
    const wt = await createWorktreeProgram({
      branchStrategy: { type: "branch", branch: "agent/clean" },
      cwd: repo,
    });

    expect(wt.branch).toBe("agent/clean");
    expect(wt.worktreePath).toBe(
      join(repo, ".sanddune", "worktrees", "agent-clean"),
    );
    expect(existsSync(wt.worktreePath)).toBe(true);

    const close = await wt.close();
    expect(close.worktreePreserved).toBe(false);
    expect(close.preservedWorktreePath).toBeUndefined();
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  test("rejects head branchStrategy at runtime (defense in depth past the type-level guard)", async () => {
    await expect(
      createWorktreeProgram({
        // Cast through unknown — the type forbids this, but JS callers can.
        branchStrategy: { type: "head" } as unknown as Parameters<
          typeof createWorktreeProgram
        >[0]["branchStrategy"],
        cwd: repo,
      }),
    ).rejects.toThrow(/branchStrategy "head"/);
  });

  test("wt.run() commits land on the worktree's branch and survive close", async () => {
    const closeCalls: number[] = [];
    const provider = makeBindMountProvider({ closeCalls });
    const agent: AgentProvider = {
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    };

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker = scriptedAgent(handleRef, [
      "printf 'one\\n' > a.txt && git add a.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'first'",
    ]);

    const wt = await createWorktreeProgram(
      {
        branchStrategy: { type: "branch", branch: "agent/wtrun" },
        cwd: repo,
      },
      {
        sandboxSeams: {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker),
        },
      },
    );

    const r = await wt.run({
      agent,
      sandbox: capturing(provider, handleRef),
      prompt: "do A",
    });
    expect(r.commits).toHaveLength(1);
    expect(r.branch).toBe("agent/wtrun");
    // wt.run() owns the container only — it must close after the run.
    expect(closeCalls).toEqual([1]);

    const branchLog = runSync(
      "git",
      ["log", "agent/wtrun", "--format=%s"],
      repo,
    ).stdout;
    expect(branchLog).toContain("first");

    // Worktree still exists after wt.run() — only the container was torn
    // down. Caller is responsible for wt.close().
    expect(existsSync(wt.worktreePath)).toBe(true);

    const close = await wt.close();
    expect(close.worktreePreserved).toBe(false);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  test("wt.createSandbox() ownership: sandbox.close keeps worktree, wt.close removes it (ADR-0010)", async () => {
    const closeCalls: number[] = [];
    const createCalls: number[] = [];
    const provider = makeBindMountProvider({ closeCalls, createCalls });
    const agent: AgentProvider = {
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    };

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker = scriptedAgent(handleRef, [
      "printf 'a\\n' > a.txt && git add a.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'a'",
    ]);

    const wt = await createWorktreeProgram(
      {
        branchStrategy: { type: "branch", branch: "agent/owned" },
        cwd: repo,
      },
      {
        sandboxSeams: {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker),
        },
      },
    );

    const sandbox = await wt.createSandbox({
      agent,
      sandbox: capturing(provider, handleRef),
    });
    expect(createCalls).toEqual([1]);

    await sandbox.run({ prompt: "go" });

    const sandboxClose = await sandbox.close();
    // wt-owned worktree → sandbox.close() must NOT report preservation,
    // and the worktree must still exist on disk for the parent Worktree
    // to clean up (ADR-0010 ownership-follows-creation).
    expect(sandboxClose.worktreePreserved).toBe(false);
    expect(sandboxClose.preservedWorktreePath).toBeUndefined();
    expect(closeCalls).toEqual([1]);
    expect(existsSync(wt.worktreePath)).toBe(true);

    const wtClose = await wt.close();
    expect(wtClose.worktreePreserved).toBe(false);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  test("wt.close() preserves a dirty worktree and surfaces preservedWorktreePath", async () => {
    const closeCalls: number[] = [];
    const provider = makeBindMountProvider({ closeCalls });
    const agent: AgentProvider = {
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    };

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const dirtyInvoker = scriptedAgent(handleRef, [
      "printf 'committed\\n' > committed.txt && git add committed.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'committed' && printf 'leftover\\n' > leftover.txt",
    ]);

    const wt = await createWorktreeProgram(
      {
        branchStrategy: { type: "branch", branch: "agent/dirty-wt" },
        cwd: repo,
      },
      {
        sandboxSeams: {
          agentInvokerLayer: Layer.succeed(AgentInvoker, dirtyInvoker.invoker),
        },
      },
    );

    await wt.run({
      agent,
      sandbox: capturing(provider, handleRef),
      prompt: "leave a mess",
    });

    const close = await wt.close();
    expect(close.worktreePreserved).toBe(true);
    expect(close.preservedWorktreePath).toBe(wt.worktreePath);
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(existsSync(join(wt.worktreePath, "leftover.txt"))).toBe(true);
  });

  test("wt.interactive() throws NotImplementedError until #18 lands", async () => {
    const wt = await createWorktreeProgram({
      branchStrategy: { type: "branch", branch: "agent/tui" },
      cwd: repo,
    });
    try {
      const provider = makeBindMountProvider({ closeCalls: [] });
      const agent: AgentProvider = {
        name: "stub",
        buildCommand: () => "true",
        parseLine: () => [],
      };
      await expect(
        wt.interactive({ agent, sandbox: provider, prompt: "x" }),
      ).rejects.toThrow(NotImplementedError);
    } finally {
      await wt.close();
    }
  });

  test("await using auto-disposes the worktree on block exit", async () => {
    const branch = "agent/auto-wt";
    const path = join(repo, ".sanddune", "worktrees", "agent-auto-wt");
    {
      await using wt = await createWorktreeProgram({
        branchStrategy: { type: "branch", branch },
        cwd: repo,
      });
      expect(wt.worktreePath).toBe(path);
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(path)).toBe(false);
  });

  test("wt.close() is idempotent and locks out further operations", async () => {
    const wt = await createWorktreeProgram({
      branchStrategy: { type: "branch", branch: "agent/idem-wt" },
      cwd: repo,
    });
    await wt.close();
    const second = await wt.close();
    expect(second.worktreePreserved).toBe(false);

    const provider = makeBindMountProvider({ closeCalls: [] });
    const agent: AgentProvider = {
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    };
    await expect(
      wt.run({ agent, sandbox: provider, prompt: "x" }),
    ).rejects.toThrow(/closed/);
  });

  test("merge-to-head: wt.run() finalizes the temp branch back into host head", async () => {
    const closeCalls: number[] = [];
    const provider = makeBindMountProvider({ closeCalls });
    const agent: AgentProvider = {
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    };

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker = scriptedAgent(handleRef, [
      "printf 'mth\\n' > mth.txt && git add mth.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'mth-commit'",
    ]);

    const wt = await createWorktreeProgram(
      {
        branchStrategy: { type: "merge-to-head" },
        cwd: repo,
      },
      {
        sandboxSeams: {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker),
        },
      },
    );

    const r = await wt.run({
      agent,
      sandbox: capturing(provider, handleRef),
      prompt: "go",
    });
    expect(r.branch).toBe("main");
    // The host head should now contain the agent's commit (finalize ff-merged).
    const hostLog = runSync(
      "git",
      ["log", "main", "--format=%s"],
      repo,
    ).stdout;
    expect(hostLog).toContain("mth-commit");

    const close = await wt.close();
    expect(close.worktreePreserved).toBe(false);
  });
});

function makeBindMountProvider(input: {
  readonly closeCalls: number[];
  readonly createCalls?: number[];
}): BindMountSandboxProvider {
  const { closeCalls, createCalls } = input;
  return {
    kind: "bind-mount",
    name: "local-process",
    create: async ({ worktreePath }) => {
      createCalls?.push(1);
      return {
        worktreePath,
        exec: async (command, opts) => {
          const result = spawnSync("sh", ["-c", command], {
            cwd: opts?.cwd ?? worktreePath,
            encoding: "utf8",
          });
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.status ?? 0,
          };
        },
        close: async () => {
          closeCalls.push(1);
        },
      };
    },
  };
}

function capturing(
  inner: BindMountSandboxProvider,
  handleRef: { current: BindMountSandboxHandle | undefined },
): BindMountSandboxProvider {
  return {
    kind: "bind-mount",
    name: inner.name,
    create: async (options) => {
      const handle = await inner.create(options);
      handleRef.current = handle;
      return handle;
    },
  };
}

function scriptedAgent(
  handleRef: { current: BindMountSandboxHandle | undefined },
  scripts: readonly string[],
): { invoker: AgentInvokerService } {
  let i = 0;
  return {
    invoker: {
      invoke: ({ iteration }) =>
        Effect.tryPromise({
          try: async () => {
            const handle = handleRef.current;
            if (!handle) throw new Error("handle not yet captured");
            const script = scripts[i];
            i += 1;
            if (script === undefined) {
              throw new Error(
                `no scripted command for invocation ${i} (iteration ${iteration})`,
              );
            }
            await handle.exec(script);
            return {
              events: [
                {
                  type: "text" as const,
                  content: `iteration ${iteration} done\n`,
                  iteration,
                  timestamp: Date.now(),
                },
              ],
            };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    },
  };
}

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
