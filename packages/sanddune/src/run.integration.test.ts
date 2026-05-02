import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createAgentProvider,
  createBindMountSandboxProvider,
  type AgentInvokerService,
  type BindMountSandboxHandle,
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
    const buildInvoker = (deps: {
      handle: BindMountSandboxHandle;
    }): AgentInvokerService => ({
      invoke: ({ iteration }) =>
        Effect.tryPromise(async () => {
          invokerCalls.push(iteration);
          await deps.handle.exec(
            "printf 'agent-edit\\n' > agent.txt && git add agent.txt && git -c user.email=agent@example.com -c user.name=agent -c commit.gpgsign=false commit -m 'agent edit'",
          );
          return { events: [] };
        }),
    });

    const options: RunOptions<RunSandboxProvider> = {
      agent,
      sandbox: provider,
      prompt: "do the thing",
      cwd: repo,
    };

    const result = await runProgram(options, buildInvoker);

    expect(invokerCalls).toEqual([1]);
    expect(result.iterations).toHaveLength(1);
    expect(result.commits).toHaveLength(1);
    expect(result.iterations[0]?.commitSha).toBe(result.commits[0]);
    expect(result.sourceBranch).toBe("main");
    expect(result.targetBranch).toBe("main");
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

    const buildInvoker = (): AgentInvokerService => ({
      invoke: () => Effect.fail(new Error("boom")),
    });

    await expect(
      runProgram(
        {
          agent,
          sandbox: provider,
          prompt: "x",
          cwd: repo,
        },
        buildInvoker,
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

    await expect(
      runProgram(
        {
          agent,
          sandbox: provider,
          prompt: "x",
          cwd: repo,
        },
        () => ({
          invoke: () => Effect.succeed({ events: [] }),
        }),
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
