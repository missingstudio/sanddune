import type { AgentStreamEvent } from "../core";
import { openRunLog, type RunLog } from "./run-log";
import { newRunId } from "./run-id";

/** The narrow log surface the **iteration loop** calls per-iteration. */
export interface IterationLogger {
  iterationStarted(iteration: number): Promise<void>;
  iterationEnded(iteration: number, commitSha: string | null): Promise<void>;
}

/** Owns the **run log** lifecycle for one **run session**: writes `runStarted`
 *  on construction, exposes per-iteration logging to the **iteration loop**,
 *  fans **agent stream events** into the log, and writes the terminal record
 *  + closes the file when `endOk()` / `endError()` is called.
 *
 *  Both `endOk()` and `endError()` are idempotent (a second call is a no-op)
 *  and never reject — teardown failures are swallowed onto stderr so they
 *  don't mask the original run error. */
export interface RunSession {
  readonly logFilePath: string;
  readonly logger: IterationLogger;
  /** Forward an **agent stream event** into the **run log**; intended to be
   *  passed as `onEvent` to `makeProductionAgentInvoker`. */
  recordAgentEvent(event: AgentStreamEvent): void;
  endOk(): Promise<void>;
  endError(message: string): Promise<void>;
}

/** Opens a new **run session** in `${cwd}/.sanddune/logs/`, prints the
 *  `tail -f` hint, and writes the `run-start` record before returning. */
export async function openRunSession(cwd: string): Promise<RunSession> {
  const runId = newRunId();
  const log: RunLog = await openRunLog(cwd, runId);

  process.stdout.write(
    `sanddune: streaming run log to ${log.path}\n  tail -f ${log.path}\n`,
  );
  await log.runStarted();

  let ended = false;
  const end = async (status: "ok" | "error", message?: string) => {
    if (ended) return;
    ended = true;
    try {
      await log.runEnded(status, message);
    } catch (e) {
      process.stderr.write(
        `sanddune: failed to write run-end record: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
    try {
      await log.close();
    } catch (e) {
      process.stderr.write(
        `sanddune: failed to close run log: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  };

  return {
    logFilePath: log.path,
    logger: {
      iterationStarted: (i) => log.iterationStarted(i),
      iterationEnded: (i, sha) => log.iterationEnded(i, sha),
    },
    recordAgentEvent: (event) => {
      void log.agentEvent(event);
    },
    endOk: () => end("ok"),
    endError: (message) => end("error", message),
  };
}
