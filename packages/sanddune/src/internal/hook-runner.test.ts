import { describe, expect, test } from "bun:test";
import type {
  BindMountSandboxHandle,
  ExecOptions,
  ExecResult,
} from "../core";
import { HookTimeoutError } from "../core";
import {
  runHostHooksSequential,
  runOnSandboxReadyParallel,
} from "./hook-runner";

type ExecCall = {
  readonly command: string;
  readonly options: ExecOptions | undefined;
};

function makeFakeHandle(
  exec: (cmd: string, options?: ExecOptions) => Promise<ExecResult>,
): { handle: BindMountSandboxHandle; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const handle: BindMountSandboxHandle = {
    worktreePath: "/fake",
    exec: async (command, options) => {
      calls.push({ command, options });
      return exec(command, options);
    },
    close: async () => {},
  };
  return { handle, calls };
}

const ok = (): ExecResult => ({ stdout: "", stderr: "", exitCode: 0 });

describe("runHostHooksSequential", () => {
  test("runs hooks in declared order", async () => {
    const tmp = `/tmp/sanddune-hookrunner-${Math.random().toString(36).slice(2)}`;
    await runHostHooksSequential(
      [
        { command: `mkdir -p ${tmp} && echo a >> ${tmp}/log` },
        { command: `echo b >> ${tmp}/log` },
        { command: `echo c >> ${tmp}/log` },
      ],
      undefined,
    );
    const log = await Bun.file(`${tmp}/log`).text();
    expect(log).toBe("a\nb\nc\n");
  });

  test("non-zero exit throws fast with command + exit code", async () => {
    let secondRan = false;
    await expect(
      runHostHooksSequential(
        [
          { command: "exit 7" },
          { command: `echo "should-not-run" && false` },
        ],
        undefined,
      ),
    ).rejects.toThrow(/exit 7.*exit 7/s);
    expect(secondRan).toBe(false);
  });

  test("undefined hook list is a no-op", async () => {
    await expect(
      runHostHooksSequential(undefined, undefined),
    ).resolves.toBeUndefined();
  });

  test("empty hook list is a no-op", async () => {
    await expect(
      runHostHooksSequential([], undefined),
    ).resolves.toBeUndefined();
  });

  test("per-hook timeout throws HookTimeoutError", async () => {
    const start = Date.now();
    await expect(
      runHostHooksSequential(
        [{ command: "sleep 5", timeoutMs: 50 }],
        undefined,
      ),
    ).rejects.toBeInstanceOf(HookTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  test("caller signal mid-hook kills subprocess and surfaces reason", async () => {
    const controller = new AbortController();
    const reason = new Error("user-cancelled");
    const start = Date.now();
    setTimeout(() => controller.abort(reason), 50);
    await expect(
      runHostHooksSequential(
        [{ command: "sleep 5" }],
        controller.signal,
      ),
    ).rejects.toBe(reason);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  test("pre-aborted signal rejects without spawning", async () => {
    const reason = new Error("already-cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      runHostHooksSequential(
        [{ command: "echo should-not-run" }],
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });
});

describe("runOnSandboxReadyParallel", () => {
  test("starts host and sandbox sides in parallel", async () => {
    const events: string[] = [];
    const { handle } = makeFakeHandle(async (cmd) => {
      events.push(`sandbox-start:${cmd}`);
      await sleep(80);
      events.push(`sandbox-end:${cmd}`);
      return ok();
    });

    const tmp = `/tmp/sanddune-hookrunner-${Math.random().toString(36).slice(2)}`;
    await runOnSandboxReadyParallel({
      hostHooks: [
        {
          command: `mkdir -p ${tmp} && sleep 0.08 && echo host-done > ${tmp}/h`,
        },
      ],
      sandboxHooks: [{ command: "sandbox-1" }],
      handle,
      signal: undefined,
    });

    expect(events[0]).toBe("sandbox-start:sandbox-1");
    expect(events).toContain("sandbox-end:sandbox-1");
    const hostFile = await Bun.file(`${tmp}/h`).text();
    expect(hostFile).toBe("host-done\n");
  });

  test("forwards sudo flag to handle.exec", async () => {
    const { handle, calls } = makeFakeHandle(async () => ok());
    await runOnSandboxReadyParallel({
      hostHooks: undefined,
      sandboxHooks: [{ command: "apt-get update", sudo: true }],
      handle,
      signal: undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.sudo).toBe(true);
  });

  test("non-zero sandbox exit throws fast", async () => {
    const { handle } = makeFakeHandle(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 42,
    }));
    await expect(
      runOnSandboxReadyParallel({
        hostHooks: undefined,
        sandboxHooks: [{ command: "doomed" }],
        handle,
        signal: undefined,
      }),
    ).rejects.toThrow(/exit 42.*doomed/);
  });

  test("sandbox hook timeout throws HookTimeoutError", async () => {
    const { handle } = makeFakeHandle(
      async (_cmd, options) =>
        new Promise((resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal!.reason),
          );
          setTimeout(() => resolve(ok()), 5000);
        }),
    );
    await expect(
      runOnSandboxReadyParallel({
        hostHooks: undefined,
        sandboxHooks: [{ command: "slow", timeoutMs: 50 }],
        handle,
        signal: undefined,
      }),
    ).rejects.toBeInstanceOf(HookTimeoutError);
  });

  test("undefined hooks on both sides is a no-op", async () => {
    const { handle, calls } = makeFakeHandle(async () => ok());
    await runOnSandboxReadyParallel({
      hostHooks: undefined,
      sandboxHooks: undefined,
      handle,
      signal: undefined,
    });
    expect(calls).toHaveLength(0);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
