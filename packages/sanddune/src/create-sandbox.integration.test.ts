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
  type AgentProvider,
  type AgentStreamEvent,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
} from "./core";
import { createSandboxProgram } from "./internal/create-sandbox-program";

describe("createSandbox (integration)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sanddune-cs-"));
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

  test("multiple sandbox.run() calls accumulate commits on the same branch and reuse the same container", async () => {
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
      "printf 'one\\n' > a.txt && git add a.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'first'",
      "printf 'two\\n' > b.txt && git add b.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'second'",
    ]);

    const sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/feat",
        cwd: repo,
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker) },
    );

    expect(sandbox.branch).toBe("agent/feat");
    expect(sandbox.worktreePath).toBe(
      join(repo, ".sanddune", "worktrees", "agent-feat"),
    );

    const r1 = await sandbox.run({ prompt: "do A" });
    expect(r1.commits).toHaveLength(1);
    expect(r1.branch).toBe("agent/feat");

    const r2 = await sandbox.run({ prompt: "do B" });
    expect(r2.commits).toHaveLength(1);
    expect(r2.branch).toBe("agent/feat");

    // Container created exactly once across both runs.
    expect(createCalls).toEqual([1]);
    expect(closeCalls).toEqual([]);

    // Branch tip carries both commits.
    const branchLog = runSync(
      "git",
      ["log", "agent/feat", "--format=%s"],
      repo,
    ).stdout;
    expect(branchLog).toContain("first");
    expect(branchLog).toContain("second");

    const closeResult = await sandbox.close();
    expect(closeResult.worktreePreserved).toBe(false);
    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(closeCalls).toEqual([1]);
  });

  test("await using auto-disposes on block exit (success)", async () => {
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
      "printf 'x\\n' > x.txt && git add x.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'x'",
    ]);

    {
      await using sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/auto",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, fakeInvoker.invoker) },
      );
      const r = await sandbox.run({ prompt: "go" });
      expect(r.commits).toHaveLength(1);
    }

    expect(closeCalls).toEqual([1]);
    // Clean worktree should have been removed by close().
    expect(existsSync(join(repo, ".sanddune", "worktrees", "agent-auto"))).toBe(
      false,
    );
  });

  test("await using auto-disposes even when an exception escapes the block", async () => {
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
    const failingInvoker: AgentInvokerService = {
      invoke: () => Effect.fail(new Error("boom")),
    };

    await expect(
      (async () => {
        await using sandbox = await createSandboxProgram(
          {
            agent,
            sandbox: capturing(provider, handleRef),
            branch: "agent/throw",
            cwd: repo,
          },
          { agentInvokerLayer: Layer.succeed(AgentInvoker, failingInvoker) },
        );
        await sandbox.run({ prompt: "explode" });
      })(),
    ).rejects.toThrow(/boom/);

    expect(closeCalls).toEqual([1]);
  });

  test("dirty worktree is preserved on close; clean worktree is removed", async () => {
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
      // Commit one file, then leave a second uncommitted to dirty the worktree.
      "printf 'committed\\n' > committed.txt && git add committed.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'committed' && printf 'leftover\\n' > leftover.txt",
    ]);

    const sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/dirty",
        cwd: repo,
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, dirtyInvoker.invoker) },
    );
    await sandbox.run({ prompt: "leave a mess" });
    const closeResult = await sandbox.close();

    expect(closeResult.worktreePreserved).toBe(true);
    expect(closeResult.preservedWorktreePath).toBe(
      join(repo, ".sanddune", "worktrees", "agent-dirty"),
    );
    expect(existsSync(closeResult.preservedWorktreePath!)).toBe(true);
    expect(
      existsSync(join(closeResult.preservedWorktreePath!, "leftover.txt")),
    ).toBe(true);
  });

  test("sandbox.run() rejects resumeSession at runtime", async () => {
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
    const noopInvoker: AgentInvokerService = {
      invoke: () => Effect.succeed({ events: [] }),
    };

    await using sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/no-resume",
        cwd: repo,
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
    );

    await expect(
      sandbox.run({
        prompt: "x",
        resumeSession: "abc",
      } as unknown as Parameters<typeof sandbox.run>[0]),
    ).rejects.toThrow(/resumeSession/);
  });

  test("handle remains usable after a per-call abort — sandbox can run again, then close", async () => {
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

    let invocations = 0;
    const invoker: AgentInvokerService = {
      invoke: () =>
        Effect.tryPromise({
          try: async () => {
            invocations += 1;
            return { events: [] };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    };

    const sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/abort-rerun",
        cwd: repo,
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, invoker) },
    );

    // First call: pre-aborted signal — loop bails before invoking the agent.
    const ac = new AbortController();
    ac.abort(new Error("first run cancelled"));
    await expect(
      sandbox.run({ prompt: "first", signal: ac.signal }),
    ).rejects.toThrow(/first run cancelled/);
    expect(invocations).toBe(0);

    // Sandbox handle survives — second call with a fresh signal succeeds.
    const r = await sandbox.run({ prompt: "second" });
    expect(r.iterations).toHaveLength(1);
    expect(invocations).toBe(1);

    // Close still works after the rerun.
    const closeResult = await sandbox.close();
    expect(closeCalls).toEqual([1]);
    // Worktree is clean (no commits landed) — should be removed.
    expect(closeResult.worktreePreserved).toBe(false);
  });

  test("creation hooks run once at construction time, not per sandbox.run()", async () => {
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
    const noopInvoker: AgentInvokerService = {
      invoke: () => Effect.succeed({ events: [] }),
    };

    const hookFile = join(repo, "hook-marker.txt");
    expect(existsSync(hookFile)).toBe(false);

    await using sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/hooks",
        cwd: repo,
        hooks: {
          host: {
            onWorktreeReady: [
              {
                command: `printf 'tick\\n' >> ${hookFile.replace(/'/g, "'\\''")}`,
              },
            ],
          },
        },
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
    );

    await sandbox.run({ prompt: "first" });
    await sandbox.run({ prompt: "second" });

    const ticks = (await Bun.file(hookFile).text()).trim().split("\n");
    expect(ticks).toEqual(["tick"]);
  });

  test("sandbox.run() forwards agent stream events to logging.onAgentStreamEvent", async () => {
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

    // Streaming invoker — invokes onEvent for each event as a real provider
    // would, so we exercise the run-session forwarder, not just the loop.
    const streamingInvoker: AgentInvokerService = {
      invoke: ({ iteration, onEvent }) =>
        Effect.tryPromise({
          try: async () => {
            const events: AgentStreamEvent[] = [
              {
                type: "text",
                content: `iter ${iteration} hello\n`,
                iteration,
                timestamp: Date.now(),
              },
              {
                type: "text",
                content: `iter ${iteration} world\n`,
                iteration,
                timestamp: Date.now(),
              },
            ];
            for (const event of events) onEvent?.(event);
            return { events };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    };

    const seen: AgentStreamEvent[] = [];

    await using sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/events",
        cwd: repo,
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, streamingInvoker) },
    );

    await sandbox.run({
      prompt: "go",
      logging: {
        type: "file",
        onAgentStreamEvent: (event) => {
          seen.push(event);
        },
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.type).toBe("text");
    expect((seen[0] as { content: string }).content).toContain("hello");
    expect((seen[1] as { content: string }).content).toContain("world");
  });

  describe("sandbox.interactive()", () => {
    test("invokes execInteractive with the agent's interactive command and skipPermissions=true", async () => {
      const interactiveCalls: { command: string; cwd: string | undefined }[] = [];
      const closeCalls: number[] = [];
      const provider = makeInteractiveBindMountProvider({
        closeCalls,
        interactiveCalls,
      });
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: ({ prompt, skipPermissions }) =>
          `echo skip=${skipPermissions} prompt=${prompt ?? "<none>"}`,
      };

      const handleRef: { current: BindMountSandboxHandle | undefined } = {
        current: undefined,
      };
      const noopInvoker: AgentInvokerService = {
        invoke: () => Effect.succeed({ events: [] }),
      };

      await using sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/tui",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
      );

      await sandbox.interactive({ prompt: "hi there" });

      expect(interactiveCalls).toHaveLength(1);
      expect(interactiveCalls[0]!.command).toBe("echo skip=true prompt=hi there");
    });

    test("launches without a prompt when none supplied", async () => {
      const interactiveCalls: { command: string; cwd: string | undefined }[] = [];
      const closeCalls: number[] = [];
      const provider = makeInteractiveBindMountProvider({
        closeCalls,
        interactiveCalls,
      });
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: ({ prompt }) =>
          `echo prompt=${prompt ?? "<no-prompt>"}`,
      };

      const handleRef: { current: BindMountSandboxHandle | undefined } = {
        current: undefined,
      };
      const noopInvoker: AgentInvokerService = {
        invoke: () => Effect.succeed({ events: [] }),
      };

      await using sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/tui-empty",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
      );

      await sandbox.interactive({});

      expect(interactiveCalls).toHaveLength(1);
      expect(interactiveCalls[0]!.command).toBe("echo prompt=<no-prompt>");
    });

    test("rejects when the bind-mount handle lacks execInteractive", async () => {
      const closeCalls: number[] = [];
      const provider: BindMountSandboxProvider = {
        kind: "bind-mount",
        name: "no-interactive",
        create: async ({ worktreePath }) => ({
          worktreePath,
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          close: async () => {
            closeCalls.push(1);
          },
        }),
      };
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: () => "true",
      };

      const handleRef: { current: BindMountSandboxHandle | undefined } = {
        current: undefined,
      };
      const noopInvoker: AgentInvokerService = {
        invoke: () => Effect.succeed({ events: [] }),
      };

      await using sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/no-execint",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
      );

      await expect(sandbox.interactive({ prompt: "x" })).rejects.toThrow(
        /does not support interactive sessions/,
      );
    });

    test("rejects when the agent provider lacks buildInteractiveCommand", async () => {
      const closeCalls: number[] = [];
      const provider = makeInteractiveBindMountProvider({
        closeCalls,
        interactiveCalls: [],
      });
      const agent: AgentProvider = {
        name: "afk-only",
        buildCommand: () => "true",
        parseLine: () => [],
      };

      const handleRef: { current: BindMountSandboxHandle | undefined } = {
        current: undefined,
      };
      const noopInvoker: AgentInvokerService = {
        invoke: () => Effect.succeed({ events: [] }),
      };

      await using sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/no-tui",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
      );

      await expect(sandbox.interactive({ prompt: "x" })).rejects.toThrow(
        /does not support interactive/,
      );
    });

    test("rejects after close()", async () => {
      const closeCalls: number[] = [];
      const provider = makeInteractiveBindMountProvider({
        closeCalls,
        interactiveCalls: [],
      });
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: () => "true",
      };

      const handleRef: { current: BindMountSandboxHandle | undefined } = {
        current: undefined,
      };
      const noopInvoker: AgentInvokerService = {
        invoke: () => Effect.succeed({ events: [] }),
      };

      const sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/closed-tui",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
      );

      await sandbox.close();
      await expect(sandbox.interactive({ prompt: "x" })).rejects.toThrow(
        /after close/,
      );
    });

    test("pre-aborted signal rejects with the caller's reason", async () => {
      const interactiveCalls: { command: string; cwd: string | undefined }[] = [];
      const closeCalls: number[] = [];
      const provider = makeInteractiveBindMountProvider({
        closeCalls,
        interactiveCalls,
      });
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: () => "echo should-not-run",
      };

      const handleRef: { current: BindMountSandboxHandle | undefined } = {
        current: undefined,
      };
      const noopInvoker: AgentInvokerService = {
        invoke: () => Effect.succeed({ events: [] }),
      };

      await using sandbox = await createSandboxProgram(
        {
          agent,
          sandbox: capturing(provider, handleRef),
          branch: "agent/abort-tui",
          cwd: repo,
        },
        { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
      );

      const ac = new AbortController();
      ac.abort(new Error("user cancel"));

      await expect(
        sandbox.interactive({ prompt: "x", signal: ac.signal }),
      ).rejects.toThrow(/user cancel/);
      expect(interactiveCalls).toHaveLength(0);
    });
  });

  test("close() is idempotent — second call is a no-op", async () => {
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
    const noopInvoker: AgentInvokerService = {
      invoke: () => Effect.succeed({ events: [] }),
    };

    const sandbox = await createSandboxProgram(
      {
        agent,
        sandbox: capturing(provider, handleRef),
        branch: "agent/idem",
        cwd: repo,
      },
      { agentInvokerLayer: Layer.succeed(AgentInvoker, noopInvoker) },
    );

    await sandbox.close();
    await sandbox.close();
    expect(closeCalls).toEqual([1]);

    // After close, calling run() throws.
    await expect(sandbox.run({ prompt: "x" })).rejects.toThrow(
      /after close/,
    );
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

/** Like `makeBindMountProvider` but also implements `execInteractive`,
 *  recording every call so tests can assert what command the sandbox tried
 *  to launch. Pre-aborted signals throw before recording, mirroring the
 *  real provider contract. */
function makeInteractiveBindMountProvider(input: {
  readonly closeCalls: number[];
  readonly interactiveCalls: { command: string; cwd: string | undefined }[];
}): BindMountSandboxProvider {
  const { closeCalls, interactiveCalls } = input;
  return {
    kind: "bind-mount",
    name: "fake-interactive",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, opts) => {
        const r = spawnSync("sh", ["-c", command], {
          cwd: opts?.cwd ?? worktreePath,
          encoding: "utf8",
        });
        return {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.status ?? 0,
        };
      },
      execInteractive: async (command, opts) => {
        opts?.signal?.throwIfAborted?.();
        interactiveCalls.push({ command, cwd: opts?.cwd });
        const r = spawnSync("sh", ["-c", command], {
          cwd: opts?.cwd ?? worktreePath,
          encoding: "utf8",
        });
        return { exitCode: r.status ?? 0 };
      },
      close: async () => {
        closeCalls.push(1);
      },
    }),
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
