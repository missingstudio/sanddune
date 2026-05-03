import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  AgentIdleTimeoutError,
  type AgentProvider,
  type AgentStreamEvent,
  type BindMountSandboxHandle,
  type ExecOptions,
  type ExecResult,
} from "../core";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { runEffect } from "./run-effect";

/** Schedules a sequence of `(line, afterMs)` deliveries. After the last
 *  delivery (or on signal abort), `exec` resolves / rejects. The `signal`
 *  given to `exec` is what production's invoker passes — caller signal
 *  composed with the invoker's own idle timer. */
interface ScriptStep {
  readonly line: string;
  readonly afterMs: number;
}
function makeFakeHandle(steps: readonly ScriptStep[]): BindMountSandboxHandle {
  return {
    worktreePath: "/fake",
    async exec(_command: string, options?: ExecOptions): Promise<ExecResult> {
      const onLine = options?.onLine;
      const signal = options?.signal;

      if (signal?.aborted) {
        throw signal.reason;
      }
      const lines: string[] = [];
      for (const step of steps) {
        await waitOrAbort(step.afterMs, signal);
        lines.push(step.line);
        onLine?.(step.line);
      }
      return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
    },
    async close() {},
  };
}

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

/** A minimal fake agent provider: each line is parsed into one text event. */
function makeFakeAgent(): AgentProvider {
  return {
    name: "fake-agent",
    buildCommand: () => "fake-agent-cmd",
    parseLine: (line, iteration) => [
      { type: "text", content: line, iteration, timestamp: 0 },
    ],
  };
}

function runInvoke(
  invoker: ReturnType<typeof makeProductionAgentInvoker>,
  input: {
    prompt?: string;
    iteration?: number;
    idleTimeoutSeconds: number;
    signal?: AbortSignal;
    resumeSessionId?: string;
  },
) {
  return runEffect(
    invoker.invoke({
      prompt: input.prompt ?? "go",
      iteration: input.iteration ?? 1,
      idleTimeoutSeconds: input.idleTimeoutSeconds,
      ...(input.signal !== undefined && { signal: input.signal }),
      ...(input.resumeSessionId !== undefined && {
        resumeSessionId: input.resumeSessionId,
      }),
    }),
  );
}

describe("makeProductionAgentInvoker — idle timeout", () => {
  test("silent stream → fires after idleTimeoutSeconds, rejects with AgentIdleTimeoutError", async () => {
    const handle = makeFakeHandle([{ line: "never seen", afterMs: 5_000 }]);
    const observed: AgentStreamEvent[] = [];
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: (e) => observed.push(e),
    });

    const start = Date.now();
    await expect(
      runInvoke(invoker, { idleTimeoutSeconds: 0.1 }),
    ).rejects.toMatchObject({
      name: "AgentIdleTimeoutError",
      idleTimeoutSeconds: 0.1,
      iteration: 1,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
    expect(observed).toEqual([]);
  });

  test("active stream → never fires; invoke resolves with all events", async () => {
    const handle = makeFakeHandle([
      { line: "step 1", afterMs: 50 },
      { line: "step 2", afterMs: 50 },
      { line: "step 3", afterMs: 50 },
      { line: "step 4", afterMs: 50 },
      { line: "step 5", afterMs: 50 },
      { line: "done", afterMs: 50 },
    ]);
    const observed: AgentStreamEvent[] = [];
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: (e) => observed.push(e),
    });

    const result = await runInvoke(invoker, { idleTimeoutSeconds: 0.2 });
    expect(result.events).toHaveLength(6);
    expect(observed).toHaveLength(6);
  });

  test("active stream then silence → fires only after the silence period", async () => {
    const handle = makeFakeHandle([
      { line: "burst 1", afterMs: 30 },
      { line: "burst 2", afterMs: 30 },
      { line: "burst 3", afterMs: 30 },
      { line: "never seen", afterMs: 5_000 },
    ]);
    const observed: AgentStreamEvent[] = [];
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: (e) => observed.push(e),
    });

    const start = Date.now();
    await expect(
      runInvoke(invoker, { idleTimeoutSeconds: 0.1 }),
    ).rejects.toMatchObject({
      name: "AgentIdleTimeoutError",
      idleTimeoutSeconds: 0.1,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    expect(observed).toHaveLength(3);
  });

  test("non-positive idleTimeoutSeconds disables the watchdog (0 = off)", async () => {
    // Long-silent stream that would normally trip a low timeout — with 0 it
    // must not fire; the resolution comes from the script's own end.
    const handle = makeFakeHandle([{ line: "lone event", afterMs: 200 }]);
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: () => {},
    });

    const result = await runInvoke(invoker, { idleTimeoutSeconds: 0 });
    expect(result.events).toHaveLength(1);
  });
});

describe("makeProductionAgentInvoker — caller signal composition (ADR-0011)", () => {
  test("caller signal beats idle timer → rejects with caller's reason, not AgentIdleTimeoutError", async () => {
    const reason = new Error("caller wins the race");
    const controller = new AbortController();
    const handle = makeFakeHandle([{ line: "never seen", afterMs: 5_000 }]);
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: () => {},
    });

    setTimeout(() => controller.abort(reason), 50);

    await expect(
      runInvoke(invoker, {
        idleTimeoutSeconds: 0.6,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  test("idle timer beats caller signal → rejects with AgentIdleTimeoutError", async () => {
    const controller = new AbortController(); // never aborted
    const handle = makeFakeHandle([{ line: "never seen", afterMs: 5_000 }]);
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: () => {},
    });

    await expect(
      runInvoke(invoker, {
        idleTimeoutSeconds: 0.1,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AgentIdleTimeoutError);
  });

  test("pre-aborted caller signal → invoke rejects with the caller's reason before any line is read", async () => {
    const reason = new Error("pre-aborted");
    const controller = new AbortController();
    controller.abort(reason);
    const handle = makeFakeHandle([{ line: "never seen", afterMs: 5_000 }]);
    const observed: AgentStreamEvent[] = [];
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: (e) => observed.push(e),
    });

    await expect(
      runInvoke(invoker, {
        idleTimeoutSeconds: 0.1,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(observed).toEqual([]);
  });
});

describe("makeProductionAgentInvoker — session capture", () => {
  test("forwards resumeSessionId to buildCommand", async () => {
    const seen: { resumeSessionId: string | undefined }[] = [];
    const provider: AgentProvider = {
      name: "fake",
      buildCommand: ({ resumeSessionId }) => {
        seen.push({ resumeSessionId });
        return "x";
      },
      parseLine: () => [],
    };
    const handle = makeFakeHandle([{ line: "ignored", afterMs: 1 }]);
    const invoker = makeProductionAgentInvoker({
      agentProvider: provider,
      handle,
      onEvent: () => {},
    });

    await runInvoke(invoker, { idleTimeoutSeconds: 60 });
    await runInvoke(invoker, {
      idleTimeoutSeconds: 60,
      resumeSessionId: "session-XYZ",
    });

    expect(seen[0]?.resumeSessionId).toBeUndefined();
    expect(seen[1]?.resumeSessionId).toBe("session-XYZ");
  });

  test("extracts sessionId from the first matching line; result.sessionId is set", async () => {
    const provider: AgentProvider = {
      name: "fake",
      sessionCapture: {
        parseSessionId: (line) =>
          line.startsWith("INIT:") ? line.slice(5) : undefined,
        hostSessionPath: () => "/host/x.jsonl",
        sandboxSessionPath: () => "/sb/x.jsonl",
        rewriteCwd: (s) => s,
      },
      buildCommand: () => "x",
      parseLine: () => [],
    };
    const handle = makeFakeHandle([
      { line: "noise", afterMs: 1 },
      { line: "INIT:abc-123", afterMs: 1 },
      { line: "INIT:should-not-overwrite", afterMs: 1 },
    ]);
    const invoker = makeProductionAgentInvoker({
      agentProvider: provider,
      handle,
      onEvent: () => {},
    });

    const result = await runInvoke(invoker, { idleTimeoutSeconds: 60 });
    expect(result.sessionId).toBe("abc-123");
  });

  test("agent without sessionCapture → result.sessionId stays undefined", async () => {
    const handle = makeFakeHandle([{ line: "INIT:should-be-ignored", afterMs: 1 }]);
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: () => {},
    });
    const result = await runInvoke(invoker, { idleTimeoutSeconds: 60 });
    expect(result.sessionId).toBeUndefined();
  });
});

describe("makeProductionAgentInvoker — exec failure", () => {
  test("non-zero exit code rejects with the agent's stderr", async () => {
    const handle: BindMountSandboxHandle = {
      worktreePath: "/fake",
      async exec(): Promise<ExecResult> {
        return { stdout: "", stderr: "boom", exitCode: 7 };
      },
      async close() {},
    };
    const invoker = makeProductionAgentInvoker({
      agentProvider: makeFakeAgent(),
      handle,
      onEvent: () => {},
    });

    await expect(
      runInvoke(invoker, { idleTimeoutSeconds: 60 }),
    ).rejects.toThrow(/code 7.*boom/s);
  });
});
