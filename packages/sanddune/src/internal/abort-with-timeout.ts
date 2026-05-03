/** Composes a caller's `AbortSignal` with a per-step timeout into a single
 *  signal. Aborts when either fires; the timeout's reason is the typed error
 *  produced by `timeoutErrorFactory` so callers can distinguish a caller
 *  abort from a timeout via `signal.reason instanceof <YourTimeoutError>`.
 *
 *  The returned `cleanup()` must be called in a `finally` to drop the timer
 *  and the listener on the caller signal — otherwise long-lived caller
 *  signals leak listeners across many sequential hooks. */
export interface ComposedSignal {
  readonly signal: AbortSignal;
  cleanup(): void;
}

export function composeWithTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutErrorFactory: () => Error,
): ComposedSignal {
  const controller = new AbortController();
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onCallerAbort = () => {
    controller.abort(callerSignal!.reason);
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(timeoutErrorFactory()),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
