import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  AgentInvoker,
  type AgentInvokerService,
  type BindMountSandboxHandle,
  createAgentProvider,
  createBindMountSandboxProvider,
  type RunOptions,
  type RunSandboxProvider,
} from "@missingstudio/sanddune-core";
import { runProgram } from "./internal/run-program";

describe("runProgram (integration)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sanddune-it-"));
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

  test("happy path: scripted invoker creates a commit and run resolves", async () => {
    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const invokerCalls: number[] = [];
    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker: AgentInvokerService = {
      invoke: ({ iteration }) =>
        Effect.tryPromise({
          try: async () => {
            invokerCalls.push(iteration);
            const handle = handleRef.current;
            if (!handle) throw new Error("handle not yet captured");
            await handle.exec(
              "printf 'agent-edit\\n' > agent.txt && git add agent.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'agent edit'",
            );
            return {
              events: [
                {
                  type: "text" as const,
                  content: "did the thing\n",
                  iteration,
                  timestamp: Date.now(),
                },
              ],
            };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    };

    const options: RunOptions<RunSandboxProvider> = {
      agent,
      sandbox: capturingProvider(provider, handleRef),
      prompt: "do the thing",
      cwd: repo,
    };

    const result = await runProgram(options, {
      agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
    });

    expect(invokerCalls).toEqual([1]);
    expect(result.iterations).toHaveLength(1);
    expect(result.commits).toHaveLength(1);
    expect(result.iterations[0]?.commitSha).toBe(result.commits[0]);
    expect(result.branch).toBe("main");
    expect(result.stdout).toBe("did the thing\n");
    expect(result.logFilePath).toMatch(/\.sanddune\/logs\/.+\.jsonl$/);
    expect(closeCalls).toEqual([1]);

    const headSha = runSync("git", ["rev-parse", "HEAD"], repo).stdout.trim();
    expect(result.commits[0]).toBe(headSha);
  });

  test("teardown runs even when the invoker throws", async () => {
    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const fakeInvoker: AgentInvokerService = {
      invoke: () => Effect.fail(new Error("boom")),
    };

    await expect(
      runProgram(
        {
          agent,
          sandbox: provider,
          prompt: "x",
          cwd: repo,
        },
        {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
        },
      ),
    ).rejects.toThrow(/boom/);

    expect(closeCalls).toEqual([1]);
  });

  test("merge-to-head: agent commits land on host HEAD after merge-back", async () => {
    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker: AgentInvokerService = {
      invoke: ({ iteration }) =>
        Effect.tryPromise({
          try: async () => {
            const handle = handleRef.current;
            if (!handle) throw new Error("handle not yet captured");
            await handle.exec(
              "printf 'agent-edit\\n' > agent.txt && git add agent.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'agent edit'",
            );
            return {
              events: [
                {
                  type: "text" as const,
                  content: "did the thing\n",
                  iteration,
                  timestamp: Date.now(),
                },
              ],
            };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    };

    const headBeforeRun = runSync("git", ["rev-parse", "HEAD"], repo).stdout
      .trim();

    const options: RunOptions<RunSandboxProvider> = {
      agent,
      sandbox: capturingProvider(provider, handleRef),
      prompt: "do the thing",
      cwd: repo,
      branchStrategy: { type: "merge-to-head" },
    };

    const result = await runProgram(options, {
      agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
    });

    // Host HEAD now points at the agent's commit, fast-forwarded from the
    // temp source branch.
    expect(result.commits).toHaveLength(1);
    const headAfter = runSync("git", ["rev-parse", "HEAD"], repo).stdout.trim();
    expect(result.commits[0]).toBe(headAfter);
    expect(headAfter).not.toBe(headBeforeRun);

    // For merge-to-head, branch is the host branch the commits ended up on
    // (after fast-forward back from the temp source branch). The temp branch
    // itself is no longer surfaced on RunResult.
    expect(result.branch).toBe("main");

    // Clean worktree was removed; no preservation surface on the result.
    expect(result.worktreePath).toBeUndefined();
    expect(existsSync(join(repo, ".sanddune", "worktrees"))).toBe(true);
    const dirEntries = runSync("ls", [join(repo, ".sanddune", "worktrees")], repo)
      .stdout.trim();
    expect(dirEntries).toBe("");

    // Lock released.
    const lockEntries = runSync("ls", [join(repo, ".sanddune", "locks")], repo)
      .stdout.trim();
    expect(lockEntries).toBe("");

    // Temp source branch was deleted after a successful merge.
    const branchList = runSync("git", ["branch", "--list"], repo).stdout;
    expect(branchList).not.toMatch(/sanddune\/merge-to-head\//);

    // Sandbox close ran exactly once.
    expect(closeCalls).toEqual([1]);
  });

  test("merge-to-head: dirty worktree is preserved and surfaced on RunResult.worktreePath", async () => {
    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker: AgentInvokerService = {
      invoke: ({ iteration }) =>
        Effect.tryPromise({
          try: async () => {
            const handle = handleRef.current;
            if (!handle) throw new Error("handle not yet captured");
            // Commit one file (so the merge has something to fast-forward),
            // then leave a second file uncommitted to make the worktree dirty.
            await handle.exec(
              "printf 'committed\\n' > committed.txt && git add committed.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'committed' && printf 'leftover\\n' > leftover.txt",
            );
            return {
              events: [
                {
                  type: "text" as const,
                  content: "left work behind\n",
                  iteration,
                  timestamp: Date.now(),
                },
              ],
            };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    };

    const options: RunOptions<RunSandboxProvider> = {
      agent,
      sandbox: capturingProvider(provider, handleRef),
      prompt: "leave a mess",
      cwd: repo,
      branchStrategy: { type: "merge-to-head" },
    };

    const result = await runProgram(options, {
      agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
    });

    // The committed change still merged back to host HEAD — branch reports
    // where the commits landed, not the preserved temp source branch.
    expect(result.commits).toHaveLength(1);
    expect(result.branch).toBe("main");

    // Worktree was preserved on disk; result surfaces the path.
    expect(result.worktreePath).toBeDefined();
    expect(existsSync(result.worktreePath!)).toBe(true);
    expect(existsSync(join(result.worktreePath!, "leftover.txt"))).toBe(true);

    // Lock released even though the worktree is preserved.
    const lockEntries = runSync("ls", [join(repo, ".sanddune", "locks")], repo)
      .stdout.trim();
    expect(lockEntries).toBe("");

    // Temp source branch is preserved (not deleted) so the user can recover
    // the leftover work.
    const branchList = runSync("git", ["branch", "--list"], repo).stdout;
    expect(branchList).toMatch(/sanddune\/merge-to-head\//);

    expect(closeCalls).toEqual([1]);
  });

  test("branch (named): new branch is created from HEAD and commits land on it", async () => {
    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker = scriptedAgent(handleRef, [
      "printf 'first\\n' > a.txt && git add a.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'first commit'",
    ]);

    const headBeforeRun = runSync("git", ["rev-parse", "HEAD"], repo).stdout
      .trim();

    const options: RunOptions<RunSandboxProvider> = {
      agent,
      sandbox: capturingProvider(provider, handleRef),
      prompt: "do the thing",
      cwd: repo,
      branchStrategy: { type: "branch", branch: "agent/foo" },
    };

    const result = await runProgram(options, {
      agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker),
    });

    // Branch was created from HEAD and commit lives on it.
    expect(result.commits).toHaveLength(1);
    expect(result.branch).toBe("agent/foo");

    const branchTip = runSync("git", ["rev-parse", "agent/foo"], repo).stdout
      .trim();
    expect(branchTip).toBe(result.commits[0]!);
    expect(branchTip).not.toBe(headBeforeRun);

    // Host HEAD is untouched — no merge-back happened.
    const headAfter = runSync("git", ["rev-parse", "HEAD"], repo).stdout.trim();
    expect(headAfter).toBe(headBeforeRun);

    // Worktree path uses the sanitized branch name (`/` → `-`).
    const expectedWorktree = join(repo, ".sanddune", "worktrees", "agent-foo");
    expect(result.worktreePath).toBeUndefined(); // clean → removed
    expect(existsSync(expectedWorktree)).toBe(false);

    // Lock released.
    const lockEntries = runSync("ls", [join(repo, ".sanddune", "locks")], repo)
      .stdout.trim();
    expect(lockEntries).toBe("");

    // Branch is preserved on disk — it's the user's whole reason for picking
    // this strategy.
    const branchList = runSync("git", ["branch", "--list"], repo).stdout;
    expect(branchList).toMatch(/agent\/foo/);

    expect(closeCalls).toEqual([1]);
  });

  test("branch (named): existing branch is reused and commits append", async () => {
    // Pre-create the named branch with a commit on it so the run starts from
    // an existing tip.
    runSync("git", ["branch", "agent/bar"], repo);
    runSync("git", ["worktree", "add", join(repo, "tmp-seed"), "agent/bar"], repo);
    await writeFile(join(repo, "tmp-seed", "seeded.txt"), "seeded\n");
    runSync("git", ["add", "seeded.txt"], join(repo, "tmp-seed"));
    runSync(
      "git",
      [
        "-c",
        "user.email=seed@example.com",
        "-c",
        "user.name=seed",
        "commit",
        "-m",
        "seed on branch",
      ],
      join(repo, "tmp-seed"),
    );
    const seedTip = runSync("git", ["rev-parse", "agent/bar"], repo).stdout
      .trim();
    runSync("git", ["worktree", "remove", "--force", join(repo, "tmp-seed")], repo);

    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker = scriptedAgent(handleRef, [
      "printf 'appended\\n' > appended.txt && git add appended.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'append'",
    ]);

    const result = await runProgram(
      {
        agent,
        sandbox: capturingProvider(provider, handleRef),
        prompt: "append a commit",
        cwd: repo,
        branchStrategy: { type: "branch", branch: "agent/bar" },
      },
      {
        agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker),
      },
    );

    expect(result.branch).toBe("agent/bar");
    expect(result.commits).toHaveLength(1);

    // The new commit was appended onto the existing branch tip, not built on
    // host HEAD.
    const newTip = runSync("git", ["rev-parse", "agent/bar"], repo).stdout
      .trim();
    expect(newTip).toBe(result.commits[0]!);
    const parent = runSync("git", ["rev-parse", "agent/bar^"], repo).stdout
      .trim();
    expect(parent).toBe(seedTip);

    expect(closeCalls).toEqual([1]);
  });

  test("branch (named): dirty worktree is preserved and reused on the next run", async () => {
    const closeCalls1: number[] = [];
    const provider1 = makeLocalProcessBindMountProvider(closeCalls1);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const handleRef1: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    // First run: commit one file, leave another uncommitted to dirty the worktree.
    const fakeInvoker1 = scriptedAgent(handleRef1, [
      "printf 'committed\\n' > committed.txt && git add committed.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'first' && printf 'leftover\\n' > leftover.txt",
    ]);

    const firstResult = await runProgram(
      {
        agent,
        sandbox: capturingProvider(provider1, handleRef1),
        prompt: "leave a mess",
        cwd: repo,
        branchStrategy: { type: "branch", branch: "agent/baz" },
      },
      {
        agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker1.invoker),
      },
    );

    expect(firstResult.branch).toBe("agent/baz");
    expect(firstResult.commits).toHaveLength(1);
    // Dirty → preserved on disk.
    expect(firstResult.worktreePath).toBeDefined();
    const preserved = firstResult.worktreePath!;
    expect(existsSync(preserved)).toBe(true);
    expect(existsSync(join(preserved, "leftover.txt"))).toBe(true);
    // Lock released even though worktree preserved.
    expect(
      runSync("ls", [join(repo, ".sanddune", "locks")], repo).stdout.trim(),
    ).toBe("");

    // Second run on the same branch: worktree is reused — including the
    // leftover uncommitted file. Agent commits that file this time.
    const closeCalls2: number[] = [];
    const provider2 = makeLocalProcessBindMountProvider(closeCalls2);
    const handleRef2: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    const fakeInvoker2 = scriptedAgent(handleRef2, [
      "test -f leftover.txt && git add leftover.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'cleaned up leftover'",
    ]);

    const secondResult = await runProgram(
      {
        agent,
        sandbox: capturingProvider(provider2, handleRef2),
        prompt: "finish what you started",
        cwd: repo,
        branchStrategy: { type: "branch", branch: "agent/baz" },
      },
      {
        agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker2.invoker),
      },
    );

    expect(secondResult.branch).toBe("agent/baz");
    // The cleanup commit is the only new commit since the second run started.
    expect(secondResult.commits).toHaveLength(1);
    // After a clean close on the second run, the worktree is removed again.
    expect(secondResult.worktreePath).toBeUndefined();
    expect(existsSync(preserved)).toBe(false);

    // Branch tip now has both commits.
    const branchLog = runSync(
      "git",
      ["log", "agent/baz", "--format=%s"],
      repo,
    ).stdout;
    expect(branchLog).toContain("first");
    expect(branchLog).toContain("cleaned up leftover");

    expect(closeCalls1).toEqual([1]);
    expect(closeCalls2).toEqual([1]);
  });

  test("branch (named): rejects when the branch is already checked out elsewhere", async () => {
    // Put the host repo on the named branch — that's a "checked out
    // elsewhere" case from our perspective: our strategy expects a worktree
    // under .sanddune/worktrees/, not the host main worktree.
    runSync("git", ["checkout", "-b", "agent/conflict"], repo);

    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const handleRef: { current: BindMountSandboxHandle | undefined } = {
      current: undefined,
    };
    // Worktree setup fails before the agent is invoked, so this should never
    // be called — fail loudly if the contract slips.
    const fakeInvoker: AgentInvokerService = {
      invoke: () => Effect.fail(new Error("invoker should not be called")),
    };

    await expect(
      runProgram(
        {
          agent,
          sandbox: capturingProvider(provider, handleRef),
          prompt: "x",
          cwd: repo,
          branchStrategy: { type: "branch", branch: "agent/conflict" },
        },
        {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
        },
      ),
    ).rejects.toThrow(/already checked out at/);

    // Lock was released even though setup threw.
    expect(
      runSync("ls", [join(repo, ".sanddune", "locks")], repo).stdout.trim(),
    ).toBe("");

    // Sandbox was never created.
    expect(closeCalls).toEqual([]);
  });

  test("promptFile substitution failure tears down the worktree", async () => {
    const promptFile = join(repo, "prompt.md");
    await writeFile(promptFile, "Work on {{MISSING_KEY}}\n");

    const closeCalls: number[] = [];
    const provider = makeLocalProcessBindMountProvider(closeCalls);
    const agent = createAgentProvider({
      name: "stub",
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const fakeInvoker: AgentInvokerService = {
      invoke: () => {
        throw new Error("invoker should not run when substitution fails");
      },
    };

    await expect(
      runProgram(
        {
          agent,
          sandbox: provider,
          promptFile,
          cwd: repo,
          branchStrategy: { type: "branch", branch: "agent/cleanup-test" },
        },
        {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
        },
      ),
    ).rejects.toThrow(/\{\{MISSING_KEY\}\}/);

    // The worktree was created (it's needed to resolve {{SOURCE_BRANCH}}) but
    // must be cleaned up when substitution throws — otherwise we leak a
    // worktree dir + lock for every bad template.
    const worktreeDir = join(repo, ".sanddune", "worktrees", "agent-cleanup-test");
    expect(existsSync(worktreeDir)).toBe(false);

    const lockEntries = runSync("ls", [join(repo, ".sanddune", "locks")], repo)
      .stdout.trim();
    expect(lockEntries).toBe("");

    // Sandbox was never created, so no close call.
    expect(closeCalls).toEqual([]);
  });

  test("env merging rejects overlapping agent and sandbox keys", async () => {
    const provider = createBindMountSandboxProvider({
      name: "test",
      env: { SHARED_KEY: "from-sandbox" },
      create: async () => {
        throw new Error("create should not be called");
      },
    });
    const agent = createAgentProvider({
      name: "stub",
      env: { SHARED_KEY: "from-agent" },
      buildCommand: () => "true",
      parseLine: () => [],
    });

    const fakeInvoker: AgentInvokerService = {
      invoke: () => Effect.succeed({ events: [] }),
    };

    await expect(
      runProgram(
        {
          agent,
          sandbox: provider,
          prompt: "x",
          cwd: repo,
        },
        {
          agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker),
        },
      ),
    ).rejects.toThrow(/SHARED_KEY/);
  });
});

function makeLocalProcessBindMountProvider(closeCalls: number[]) {
  return createBindMountSandboxProvider({
    name: "local-process",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, opts) => {
        const result = spawnSync("sh", ["-c", command], {
          cwd: opts?.cwd ?? worktreePath,
          encoding: "utf8",
        });
        const stdout = result.stdout ?? "";
        if (opts?.onLine) {
          for (const line of stdout.split("\n")) {
            if (line.length > 0) opts.onLine(line);
          }
        }
        return {
          stdout,
          stderr: result.stderr ?? "",
          exitCode: result.status ?? 0,
        };
      },
      close: async () => {
        closeCalls.push(1);
      },
    }),
  });
}

function capturingProvider(
  inner: ReturnType<typeof createBindMountSandboxProvider>,
  handleRef: { current: BindMountSandboxHandle | undefined },
): ReturnType<typeof createBindMountSandboxProvider> {
  return createBindMountSandboxProvider({
    name: inner.name,
    env: inner.env,
    create: async (options) => {
      const handle = await inner.create(options);
      handleRef.current = handle;
      return handle;
    },
  });
}

function scriptedAgent(
  handleRef: { current: BindMountSandboxHandle | undefined },
  scripts: readonly string[],
): { invoker: AgentInvokerService } {
  return {
    invoker: {
      invoke: ({ iteration }) =>
        Effect.tryPromise({
          try: async () => {
            const handle = handleRef.current;
            if (!handle) throw new Error("handle not yet captured");
            const script = scripts[iteration - 1];
            if (script === undefined) {
              throw new Error(
                `no scripted command for iteration ${iteration}`,
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
