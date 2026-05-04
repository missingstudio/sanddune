import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentStreamEvent, LoggingOption } from "../core";
import { openFileRunSession } from "./run-session-file";
import { openStdoutRunSession } from "./run-session-stdout";

/** The narrow log surface the **iteration loop** calls per-iteration. */
export interface IterationLogger {
  iterationStarted(iteration: number): Promise<void>;
  iterationEnded(iteration: number, commitSha: string | null): Promise<void>;
}

/** Owns the **run session** lifecycle: writes a `runStarted` record on
 *  construction, exposes per-iteration logging to the **iteration loop**,
 *  fans **agent stream events** to the appropriate sink (run log + optional
 *  caller callback in **log-to-file mode**, terminal renderer in **terminal
 *  mode**), and writes the terminal record + closes any underlying file when
 *  `endOk()` / `endError()` is called.
 *
 *  Both `endOk()` and `endError()` are idempotent (a second call is a no-op)
 *  and never reject — teardown failures are swallowed onto stderr so they
 *  don't mask the original run error. */
export interface RunSession {
  /** Absolute path of the **run log** in **log-to-file mode**; `undefined`
   *  in **terminal mode**. Surfaced verbatim onto `RunResult.logFilePath`. */
  readonly logFilePath: string | undefined;
  readonly logger: IterationLogger;
  /** Forward an **agent stream event** to the session's sink. */
  recordAgentEvent(event: AgentStreamEvent): void;
  endOk(): Promise<void>;
  endError(message: string): Promise<void>;
}

export interface OpenRunSessionInput {
  readonly cwd: string;
  readonly logging?: LoggingOption;
  /** Optional display name prefixed in log output for parallel-run
   *  readability — e.g. `[issue-42] tail -f …`. */
  readonly name?: string;
  /** Branch the run targets, when known. Forwarded to the file-mode session
   *  so the default log filename includes it. Ignored in stdout mode. */
  readonly branch?: string;
}

/** Picks the **run session** implementation from `logging.type`. Defaults to
 *  **log-to-file mode** when `logging` is omitted (matches the contract for
 *  programmatic `run()` calls). */
export async function openRunSession(
  input: OpenRunSessionInput,
): Promise<RunSession> {
  const logging = input.logging;
  if (logging?.type === "stdout") {
    return openStdoutRunSession({
      ...(input.name !== undefined && { name: input.name }),
    });
  }
  return openFileRunSession({
    cwd: input.cwd,
    ...(input.name !== undefined && { name: input.name }),
    ...(input.branch !== undefined && { branch: input.branch }),
    ...(logging?.path !== undefined && {
      path: resolveLogPath(logging.path, input.cwd),
    }),
    ...(logging?.onAgentStreamEvent !== undefined && {
      onAgentStreamEvent: logging.onAgentStreamEvent,
    }),
  });
}

function resolveLogPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}
