import { Cause, Effect, Exit } from "effect";

/** Unwraps Effect's FiberFailureImpl so the rejected promise carries the
 *  typed Error (e.g. AgentIdleTimeoutError, signal.reason) verbatim. */
export async function runEffect<A>(
  effect: Effect.Effect<A, Error, never>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
}
