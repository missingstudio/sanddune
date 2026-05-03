import { Cause, Effect, Exit } from "effect";

/** Runs an Effect and unwraps the canonical `FiberFailureImpl` wrapper that
 *  `Effect.runPromise` produces on failure, so the rejected promise carries
 *  the typed `Error` (e.g. `AgentIdleTimeoutError` or a caller-supplied
 *  `signal.reason`) verbatim. Required by ADR-0011 and the `idleTimeoutSeconds`
 *  contract: "the abort reason is surfaced in the rejected promise". */
export async function runEffect<A>(
  effect: Effect.Effect<A, Error, never>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
}
