import { spawnSync } from "node:child_process";
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
    expect(result.sourceBranch).toBe("main");
    expect(result.targetBranch).toBe("main");
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
