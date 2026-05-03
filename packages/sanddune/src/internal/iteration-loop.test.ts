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
} from "../core";
import {
  runIterationLoop,
  type IterationLoopInput,
  type IterationLoopResult,
} from "./iteration-loop";
import { runEffect } from "./run-effect";
import type { IterationLogger } from "./run-session";

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

interface FakeLogger {
  readonly log: IterationLogger;
  readonly started: number[];
  readonly ended: { readonly iteration: number; readonly commitSha: string | null }[];
}

function makeFakeLogger(): FakeLogger {
  const started: number[] = [];
  const ended: { iteration: number; commitSha: string | null }[] = [];
  const log: IterationLogger = {
    iterationStarted: async (iteration) => {
      started.push(iteration);
    },
    iterationEnded: async (iteration, commitSha) => {
      ended.push({ iteration, commitSha });
    },
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

/** A timeout long enough that the loop must reach its natural end before the
 *  idle timer fires. Existing tests don't exercise the idle path. */
const NEVER_FIRES = 60;

/** A `getPromptForIteration` closure that returns the same string each call
 *  and tracks call count — what the **prompt pipeline** would hand the loop
 *  for an inline prompt or a shell-expression-free template. */
function fixedPrompt(text: string): {
  readonly get: () => Promise<string>;
  readonly callCount: () => number;
} {
  let calls = 0;
  return {
    get: async () => {
      calls += 1;
      return text;
    },
    callCount: () => calls,
  };
}

interface StreamScript {
  /** Each entry: wait `afterMs`, then deliver `event`. After the last entry,
   *  `invoke()` resolves with the full event array. If the inbound `signal`
   *  aborts while waiting, `invoke()` rejects with `signal.reason`. */
  readonly events: readonly { readonly event: AgentStreamEvent; readonly afterMs: number }[];
}

interface StreamingInvoker {
  readonly invoker: AgentInvokerService;
  readonly observed: AgentStreamEvent[];
}

/** Streaming variant of `makeScriptedInvoker`: delivers events one-by-one
 *  with controllable inter-event silence, honoring the inbound `signal` by
 *  rejecting verbatim — the contract the production invoker gets through
 *  `spawnHost`. Used here to exercise the loop's caller-signal handling;
 *  the idle timer is now an invoker concern, not the loop's, so this fake
 *  ignores `idleTimeoutSeconds`. */
function makeStreamingInvoker(
  scripts: readonly StreamScript[],
): StreamingInvoker {
  const observed: AgentStreamEvent[] = [];
  const invoker: AgentInvokerService = {
    invoke: ({ iteration, signal }) =>
      Effect.tryPromise({
        try: async () => {
          const script = scripts[iteration - 1];
          if (!script) {
            throw new Error(
              `streaming invoker: no script for iteration ${iteration}`,
            );
          }
          const delivered: AgentStreamEvent[] = [];
          for (const step of script.events) {
            await waitOrAbort(step.afterMs, signal);
            delivered.push(step.event);
            observed.push(step.event);
          }
          return { events: delivered };
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
  };
  return { invoker, observed };
}

/** Resolve after `ms` unless `signal` aborts first, in which case reject
 *  with `signal.reason` verbatim — matching the kill-and-reject semantics
 *  the live invoker gets through `spawnHost`. */
function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runLoop(
  input: IterationLoopInput,
  invoker: AgentInvokerService,
): Promise<IterationLoopResult> {
  return runEffect(
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
      const { log, started, ended } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [SIGNAL],
          idleTimeoutSeconds: NEVER_FIRES,
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
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 5,
          completionSignals: [SIGNAL],
          idleTimeoutSeconds: NEVER_FIRES,
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
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 1,
          completionSignals: [FIRST_IN_ARRAY, SECOND_IN_ARRAY],
          idleTimeoutSeconds: NEVER_FIRES,
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
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 2,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
        },
        invoker,
      );

      expect(calls).toHaveLength(2);
      expect(result.iterations).toHaveLength(2);
      expect(result.completionSignal).toBeUndefined();
    });
  });

  describe("getPromptForIteration contract", () => {
    test("called once per iteration; return value is forwarded verbatim to the invoker", async () => {
      const fixed = fixedPrompt("inline body !`not expanded by the loop`");
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("ok\n", 1)] },
        { events: [textEvent("ok\n", 2)] },
      ]);
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: fixed.get,
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 2,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
        },
        invoker,
      );

      expect(result.iterations).toHaveLength(2);
      expect(fixed.callCount()).toBe(2);
      expect(calls.map((c) => c.prompt)).toEqual([
        "inline body !`not expanded by the loop`",
        "inline body !`not expanded by the loop`",
      ]);
    });

    test("dynamic per-iteration text: invoker sees whatever the closure returned that turn", async () => {
      let n = 0;
      const get = async (): Promise<string> => {
        n += 1;
        return `iter ${n} prompt`;
      };
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("ok\n", 1)] },
        { events: [textEvent("ok\n", 2)] },
        { events: [textEvent("ok\n", 3)] },
      ]);
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: get,
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
        },
        invoker,
      );

      expect(result.iterations).toHaveLength(3);
      expect(calls.map((c) => c.prompt)).toEqual([
        "iter 1 prompt",
        "iter 2 prompt",
        "iter 3 prompt",
      ]);
    });

    test("getPromptForIteration rejection bubbles out; later iterations do not run", async () => {
      const boom = new Error("pipeline blew up mid-run");
      let n = 0;
      const get = async (): Promise<string> => {
        n += 1;
        if (n === 2) throw boom;
        return "ok";
      };
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("ok\n", 1)] },
        { events: [textEvent("never seen\n", 2)] },
        { events: [textEvent("never seen\n", 3)] },
      ]);
      const { log } = makeFakeLogger();

      await expect(
        runLoop(
          {
            getPromptForIteration: get,
            logger: log,
            cwd: repo,
            beforeSha: headSha(repo),
            maxIterations: 3,
            completionSignals: [],
            idleTimeoutSeconds: NEVER_FIRES,
          },
          invoker,
        ),
      ).rejects.toBe(boom);
      expect(calls.map((c) => c.iteration)).toEqual([1]);
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
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha,
          maxIterations: 3,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
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

  describe("resumeSessionId forwarding", () => {
    test("resumeSessionId reaches invoker only on iteration 1; iteration 2+ get undefined", async () => {
      const seen: { iteration: number; resumeSessionId: string | undefined }[] = [];
      const invoker: AgentInvokerService = {
        invoke: ({ iteration, resumeSessionId }) =>
          Effect.tryPromise({
            try: async () => {
              seen.push({ iteration, resumeSessionId });
              return { events: [textEvent("ok\n", iteration)] };
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
      };
      const { log } = makeFakeLogger();

      await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          resumeSessionId: "session-XYZ",
        },
        invoker,
      );

      expect(seen).toEqual([
        { iteration: 1, resumeSessionId: "session-XYZ" },
        { iteration: 2, resumeSessionId: undefined },
        { iteration: 3, resumeSessionId: undefined },
      ]);
    });
  });

  describe("captureSession integration", () => {
    test("happy path: invoker emits sessionId → captureSession called → IterationResult.sessionId + sessionFilePath populated", async () => {
      const captureCalls: { iteration: number; sessionId: string }[] = [];
      const invoker: AgentInvokerService = {
        invoke: ({ iteration }) =>
          Effect.tryPromise({
            try: async () => ({
              events: [textEvent("ok\n", iteration)],
              sessionId: `sid-${iteration}`,
            }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
      };
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 2,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          captureSession: async ({ iteration, sessionId }) => {
            captureCalls.push({ iteration, sessionId });
            return `/host/sessions/${sessionId}.jsonl`;
          },
        },
        invoker,
      );

      expect(captureCalls).toEqual([
        { iteration: 1, sessionId: "sid-1" },
        { iteration: 2, sessionId: "sid-2" },
      ]);
      expect(result.iterations[0]?.sessionId).toBe("sid-1");
      expect(result.iterations[0]?.sessionFilePath).toBe(
        "/host/sessions/sid-1.jsonl",
      );
      expect(result.iterations[1]?.sessionId).toBe("sid-2");
      expect(result.iterations[1]?.sessionFilePath).toBe(
        "/host/sessions/sid-2.jsonl",
      );
    });

    test("capture failure (closure returns undefined) → sessionId still surfaced; sessionFilePath stays undefined; loop succeeds", async () => {
      const invoker: AgentInvokerService = {
        invoke: ({ iteration }) =>
          Effect.tryPromise({
            try: async () => ({
              events: [textEvent("ok\n", iteration)],
              sessionId: "sid-1",
            }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
      };
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 1,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          captureSession: async () => undefined,
        },
        invoker,
      );

      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0]?.sessionId).toBe("sid-1");
      expect(result.iterations[0]?.sessionFilePath).toBeUndefined();
    });

    test("invoker returns no sessionId → captureSession is never called", async () => {
      let captureInvoked = 0;
      const invoker: AgentInvokerService = {
        invoke: () =>
          Effect.tryPromise({
            try: async () => ({ events: [textEvent("ok\n", 1)] }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
      };
      const { log } = makeFakeLogger();

      const result = await runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 1,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          captureSession: async () => {
            captureInvoked += 1;
            return "/should/not/be/used";
          },
        },
        invoker,
      );

      expect(captureInvoked).toBe(0);
      expect(result.iterations[0]?.sessionId).toBeUndefined();
      expect(result.iterations[0]?.sessionFilePath).toBeUndefined();
    });
  });

  describe("caller-supplied signal", () => {
    test("pre-aborted signal → loop rejects with reason; invoker is never called", async () => {
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("should not run\n", 1)] },
      ]);
      const { log } = makeFakeLogger();
      const controller = new AbortController();
      const reason = new Error("user cancelled");
      controller.abort(reason);

      const promise = runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          signal: controller.signal,
        },
        invoker,
      );

      await expect(promise).rejects.toBe(reason);
      expect(calls).toEqual([]);
    });

    test("signal fires before iteration 1 starts → loop rejects with reason; invoker is never called", async () => {
      const { invoker, calls } = makeScriptedInvoker([
        { events: [textEvent("should not run\n", 1)] },
      ]);
      const { log } = makeFakeLogger();
      const controller = new AbortController();
      const reason = new Error("cancelled before start");

      // Schedule the abort to fire on the next microtask, before the loop's
      // first throwIfAborted check runs synchronously inside the Effect.
      // To make this deterministic, abort synchronously after constructing
      // the input but before running — equivalent semantically to "the
      // signal fired between options-build and loop-start".
      controller.abort(reason);

      const promise = runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 3,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          signal: controller.signal,
        },
        invoker,
      );

      await expect(promise).rejects.toBe(reason);
      expect(calls).toEqual([]);
    });

    test("signal fires mid-iteration → loop rejects with reason; later iterations do not run", async () => {
      const reason = new Error("user aborted mid-iteration");
      const controller = new AbortController();
      // The streaming invoker honors its inbound signal via waitOrAbort —
      // exactly the contract the production invoker gets via spawnHost.
      const { invoker, observed } = makeStreamingInvoker([
        {
          events: [
            { event: textEvent("starting\n", 1), afterMs: 30 },
            // Long wait that the abort will interrupt.
            { event: textEvent("never seen", 1), afterMs: 5_000 },
          ],
        },
        {
          events: [{ event: textEvent("should not run", 2), afterMs: 10 }],
        },
      ]);
      const { log } = makeFakeLogger();

      // Fire the caller's signal once the first event has been observed —
      // confirms the invoker is mid-flight when abort happens.
      setTimeout(() => controller.abort(reason), 100);

      const start = Date.now();
      const promise = runLoop(
        {
          getPromptForIteration: async () => "go",
          logger: log,
          cwd: repo,
          beforeSha: headSha(repo),
          maxIterations: 2,
          completionSignals: [],
          idleTimeoutSeconds: NEVER_FIRES,
          signal: controller.signal,
        },
        invoker,
      );

      await expect(promise).rejects.toBe(reason);
      const elapsed = Date.now() - start;
      // Aborted well before the 5_000ms scripted wait would have completed.
      expect(elapsed).toBeLessThan(2_000);
      // First event was observed; second iteration never started.
      expect(observed).toEqual([textEvent("starting\n", 1)]);
    });

  });
});
