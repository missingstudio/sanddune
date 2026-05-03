import type { BindMountSandboxHandle, SandboxHooks } from "../core";
import { HookTimeoutError } from "../core";
import { composeWithTimeout } from "./abort-with-timeout";
import { spawnHost } from "./host-process";

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

type HostHook = NonNullable<
  NonNullable<SandboxHooks["host"]>["onWorktreeReady"]
>[number];

type SandboxHook = NonNullable<
  NonNullable<SandboxHooks["sandbox"]>["onSandboxReady"]
>[number];

/** Runs `host.onWorktreeReady` (or any host-hook list) in declared order.
 *  Stops at the first non-zero exit or timeout. */
export async function runHostHooksSequential(
  hooks: ReadonlyArray<HostHook> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!hooks) return;
  for (const hook of hooks) await runHostHook(hook, signal);
}

/** Kicks off `host.onSandboxReady` and `sandbox.onSandboxReady` in parallel.
 *  Within each side the hooks still run sequentially. Per CONTEXT.md the two
 *  sides are not coordinated — setup that needs ordering across host/sandbox
 *  must live entirely on one side.
 *
 *  Both sides see a signal that aborts when EITHER the caller aborts OR the
 *  sibling side rejects. Without that, a fast-failing side would leave the
 *  other running — orphan sandbox work after `run()` has thrown, and an
 *  unhandled rejection if the loser later throws too. */
export async function runOnSandboxReadyParallel(input: {
  readonly hostHooks: ReadonlyArray<HostHook> | undefined;
  readonly sandboxHooks: ReadonlyArray<SandboxHook> | undefined;
  readonly handle: BindMountSandboxHandle;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  const ac = new AbortController();
  const callerSignal = input.signal;
  const onCallerAbort = () => ac.abort(callerSignal!.reason);
  if (callerSignal) {
    if (callerSignal.aborted) ac.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let firstError: { value: unknown } | undefined;
  const recordAndCancel = (e: unknown): never => {
    if (!firstError) firstError = { value: e };
    if (!ac.signal.aborted) ac.abort(e);
    throw e;
  };

  const hostSide = runHostHooksSequential(input.hostHooks, ac.signal).catch(
    recordAndCancel,
  );
  const sandboxSide = input.sandboxHooks
    ? runSandboxHooksSequential(
        input.sandboxHooks,
        input.handle,
        ac.signal,
      ).catch(recordAndCancel)
    : Promise.resolve();

  try {
    await Promise.allSettled([hostSide, sandboxSide]);
    if (firstError) throw firstError.value;
  } finally {
    if (callerSignal)
      callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

async function runSandboxHooksSequential(
  hooks: ReadonlyArray<SandboxHook>,
  handle: BindMountSandboxHandle,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const hook of hooks) await runSandboxHook(hook, handle, signal);
}

async function runHostHook(
  hook: HostHook,
  callerSignal: AbortSignal | undefined,
): Promise<void> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const composed = composeWithTimeout(callerSignal, timeoutMs, () =>
    new HookTimeoutError({ command: hook.command, timeoutMs }),
  );
  try {
    const result = await spawnHost("/bin/sh", ["-c", hook.command], {
      signal: composed.signal,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `hook failed (exit ${result.exitCode}): ${hook.command}`,
      );
    }
  } finally {
    composed.cleanup();
  }
}

async function runSandboxHook(
  hook: SandboxHook,
  handle: BindMountSandboxHandle,
  callerSignal: AbortSignal | undefined,
): Promise<void> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const composed = composeWithTimeout(callerSignal, timeoutMs, () =>
    new HookTimeoutError({ command: hook.command, timeoutMs }),
  );
  try {
    const result = await handle.exec(hook.command, {
      ...(hook.sudo !== undefined && { sudo: hook.sudo }),
      signal: composed.signal,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `hook failed (exit ${result.exitCode}): ${hook.command}`,
      );
    }
  } finally {
    composed.cleanup();
  }
}
