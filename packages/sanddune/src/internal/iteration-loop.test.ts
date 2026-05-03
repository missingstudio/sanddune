import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  AgentInvoker,
  type AgentInvokerService,
  type AgentStreamEvent,
  type ExecResult,
  type SandboxExec,
} from "../core";
import {
  runIterationLoop,
  type IterationLoopInput,
  type IterationLoopResult,
} from "./iteration-loop";
import type { RunLog } from "./run-log";

function runSync(cmd: string, args: readonly string[], cwd: string) {
  const result = spawnSync(cmd, args as string[], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${result.status}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result;
}

function headSha(cwd: string): string {
  return runSync("git", ["rev-parse", "HEAD"], cwd).stdout.trim();
}

function commitsBetween(cwd: string, beforeSha: string): string[] {
  return runSync(
    "git",
    ["log", `${beforeSha}..HEAD`, "--format=%H", "--reverse"],
    cwd,
  )
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function setupRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "sanddune-iter-loop-"));
  runSync("git", ["init", "--initial-branch=main"], repo);
  runSync("git", ["config", "user.email", "test@example.com"], repo);
  runSync("git", ["config", "user.name", "test"], repo);
  runSync("git", ["config", "commit.gpgsign", "false"], repo);
  await writeFile(join(repo, "README.md"), "seed\n");
  runSync("git", ["add", "."], repo);
  runSync("git", ["commit", "-m", "seed"], repo);
  return repo;
}

async function makeCommit(
  cwd: string,
  fileName: string,
  content: string,
): Promise<string> {
  await writeFile(join(cwd, fileName), content);
  runSync("git", ["add", fileName], cwd);
  runSync("git", ["commit", "-m", `add ${fileName}`], cwd);
  return headSha(cwd);
}

function textEvent(content: string, iteration: number): AgentStreamEvent {
  return { type: "text", content, iteration, timestamp: 0 };
}

interface FakeRunLog {
  readonly log: RunLog;
  readonly started: number[];
  readonly ended: { readonly iteration: number; readonly commitSha: string | null }[];
}

function makeFakeRunLog(): FakeRunLog {
  const started: number[] = [];
  const ended: { iteration: number; commitSha: string | null }[] = [];
  const log: RunLog = {
    path: "/tmp/iteration-loop-test.log",
    runStarted: async () => {},
    iterationStarted: async (iteration) => {
      started.push(iteration);
    },
    iterationEnded: async (iteration, commitSha) => {
      ended.push({ iteration, commitSha });
    },
    agentEvent: async () => {},
    runEnded: async () => {},
    close: async () => {},
  };
  return { log, started, ended };
}

interface InvokerScript {
  readonly events: readonly AgentStreamEvent[];
  readonly onInvoke?: () => Promise<void>;
}

interface ScriptedInvoker {
  readonly invoker: AgentInvokerService;
  readonly calls: { iteration: number; prompt: string }[];
}

function makeScriptedInvoker(scripts: readonly InvokerScript[]): ScriptedInvoker {
  const calls: { iteration: number; prompt: string }[] = [];
  const invoker: AgentInvokerService = {
    invoke: ({ prompt, iteration }) =>
      Effect.tryPromise({
        try: async () => {
          calls.push({ prompt, iteration });
          const script = scripts[iteration - 1];
          if (!script) {
            throw new Error(
              `iteration-loop test: no script for iteration ${iteration}`,
            );
          }
          if (script.onInvoke) await script.onInvoke();
          return { events: script.events };
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
  };
  return { invoker, calls };
}

const EXEC_NEVER: SandboxExec = () => {
  throw new Error("sandboxExec must not be called");
};

async function runLoop(
  input: IterationLoopInput,
  invoker: AgentInvokerService,
): Promise<IterationLoopResult> {
  return Effect.runPromise(
    runIterationLoop(input).pipe(
      Effect.provide(Layer.succeed(AgentInvoker, invoker)),
    ),
  );
}

describe("runIterationLoop", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await setupRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe("completion signal matching", () => {
    test("signal fires on iteration 2 of 3 → 2 entries, signal surfaced, invoker called twice", async () => {
      const SIGNAL = "<promise>COMPLETE</promise>";
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("still working\n", 1)] },
        { events: [textEvent(`finished ${SIGNAL}\n`, 2)] },
        { events: [textEvent("should not run\n", 3)] },
      ]);
      const { log, started, ended } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: "go",
          promptKind: "inline",
          runLog: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [SIGNAL],
          sandboxExec: EXEC_NEVER,
        },
        invoker,
      );

      expect(calls.map((c) => c.iteration)).toEqual([1, 2]);
      expect(result.iterations).toHaveLength(2);
      expect(result.completionSignal).toBe(SIGNAL);
      expect(result.iterations[0]?.completionSignal).toBeUndefined();
      expect(result.iterations[1]?.completionSignal).toBe(SIGNAL);
      expect(started).toEqual([1, 2]);
      expect(ended.map((e) => e.iteration)).toEqual([1, 2]);
    });

    test("loop exhausts to maxIterations without match → completionSignal undefined", async () => {
      const SIGNAL = "<promise>COMPLETE</promise>";
      const scripts: InvokerScript[] = Array.from({ length: 5 }, (_, i) => ({
        events: [textEvent(`iter ${i + 1} progress\n`, i + 1)],
      }));
      const { invoker, calls } = makeScriptedInvoker(scripts);
      const { log } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: "go",
          promptKind: "inline",
          runLog: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 5,
          completionSignals: [SIGNAL],
          sandboxExec: EXEC_NEVER,
        },
        invoker,
      );

      expect(calls).toHaveLength(5);
      expect(result.iterations).toHaveLength(5);
      expect(result.completionSignal).toBeUndefined();
      for (const it of result.iterations) {
        expect(it.completionSignal).toBeUndefined();
      }
    });

    test("string[] first-match-wins by event-stream order, not array order", async () => {
      const FIRST_IN_ARRAY = "ALPHA";
      const SECOND_IN_ARRAY = "BRAVO";
      const { invoker } = makeScriptedInvoker([
        {
          events: [
            textEvent(`got ${SECOND_IN_ARRAY} first\n`, 1),
            textEvent(`then got ${FIRST_IN_ARRAY}\n`, 1),
          ],
        },
      ]);
      const { log } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: "go",
          promptKind: "inline",
          runLog: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 1,
          completionSignals: [FIRST_IN_ARRAY, SECOND_IN_ARRAY],
          sandboxExec: EXEC_NEVER,
        },
        invoker,
      );

      expect(result.completionSignal).toBe(SECOND_IN_ARRAY);
    });

    test("empty completionSignals array disables detection", async () => {
      const DEFAULT_MARKER = "<promise>COMPLETE</promise>";
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent(`done ${DEFAULT_MARKER}\n`, 1)] },
        { events: [textEvent(`done again ${DEFAULT_MARKER}\n`, 2)] },
      ]);
      const { log } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: "go",
          promptKind: "inline",
          runLog: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 2,
          completionSignals: [],
          sandboxExec: EXEC_NEVER,
        },
        invoker,
      );

      expect(calls).toHaveLength(2);
      expect(result.iterations).toHaveLength(2);
      expect(result.completionSignal).toBeUndefined();
    });
  });

  describe("prompt expansion per iteration", () => {
    test("inline prompt: passed byte-identical each iteration, sandboxExec never called", async () => {
      const inlineWithBacktickSyntax = "do !`echo this should be left alone` and report";
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("ok\n", 1)] },
        { events: [textEvent("ok\n", 2)] },
      ]);
      const { log } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: inlineWithBacktickSyntax,
          promptKind: "inline",
          runLog: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 2,
          completionSignals: [],
          sandboxExec: EXEC_NEVER,
        },
        invoker,
      );

      expect(result.iterations).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toBe(inlineWithBacktickSyntax);
      expect(calls[1]?.prompt).toBe(inlineWithBacktickSyntax);
    });

    test("template prompt: sandboxExec runs once per iteration; invoker sees freshly expanded text", async () => {
      const execCalls: string[] = [];
      let counter = 0;
      const exec: SandboxExec = async (command: string): Promise<ExecResult> => {
        execCalls.push(command);
        counter += 1;
        return { stdout: `iter${counter}`, stderr: "", exitCode: 0 };
      };

      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("ok\n", 1)] },
        { events: [textEvent("ok\n", 2)] },
        { events: [textEvent("ok\n", 3)] },
      ]);
      const { log } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: "report !`echo placeholder` now",
          promptKind: "template",
          runLog: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [],
          sandboxExec: exec,
        },
        invoker,
      );

      expect(result.iterations).toHaveLength(3);
      expect(execCalls).toEqual(["echo placeholder", "echo placeholder", "echo placeholder"]);
      expect(calls.map((c) => c.prompt)).toEqual([
        "report iter1 now",
        "report iter2 now",
        "report iter3 now",
      ]);
    });
  });

  describe("commit accumulation", () => {
    test("commits accumulate across iterations in order; commitSha tracks last commit per iteration; absent when none made", async () => {
      const beforeSha = headSha(repo);

      const iter1Sha = { current: "" };
      const iter3SecondSha = { current: "" };

      const { invoker } = makeScriptedInvoker([
        {
          events: [textEvent("iter 1\n", 1)],
          onInvoke: async () => {
            iter1Sha.current = await makeCommit(repo, "a.txt", "a\n");
          },
        },
        {
          events: [textEvent("iter 2 — no commit\n", 2)],
        },
        {
          events: [textEvent("iter 3\n", 3)],
          onInvoke: async () => {
            await makeCommit(repo, "b.txt", "b\n");
            iter3SecondSha.current = await makeCommit(repo, "c.txt", "c\n");
          },
        },
      ]);
      const { log } = makeFakeRunLog();

      const result = await runLoop(
        {
          prompt: "go",
          promptKind: "inline",
          runLog: log,
          cwd: repo,
          beforeSha,
          maxIterations: 3,
          completionSignals: [],
          sandboxExec: EXEC_NEVER,
        },
        invoker,
      );

      expect(result.iterations).toHaveLength(3);
      expect(result.iterations[0]?.commitSha).toBe(iter1Sha.current);
      expect(result.iterations[1]?.commitSha).toBeUndefined();
      expect(result.iterations[2]?.commitSha).toBe(iter3SecondSha.current);

      expect(result.commits).toEqual(commitsBetween(repo, beforeSha));
      expect(result.commits).toHaveLength(3);
      expect(result.commits[0]).toBe(iter1Sha.current);
      expect(result.commits[2]).toBe(iter3SecondSha.current);
    });
  });
});
