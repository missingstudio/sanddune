import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentStreamEvent, LoggingOption } from "../core";
import { openFileRunSession } from "./run-session-file";
import { openStdoutRunSession } from "./run-session-stdout";

export interface IterationLogger {
  iterationStarted(iteration: number): Promise<void>;
  iterationEnded(iteration: number, commitSha: string | null): Promise<void>;
}

/** endOk()/endError() are idempotent and never reject — teardown failures
 *  go to stderr so they don't mask the original run error. */
export interface RunSession {
  /** undefined in terminal mode. */
  readonly logFilePath: string | undefined;
  readonly logger: IterationLogger;
  recordAgentEvent(event: AgentStreamEvent): void;
  endOk(): Promise<void>;
  endError(message: string): Promise<void>;
}

export interface OpenRunSessionInput {
  readonly cwd: string;
  readonly logging?: LoggingOption;
  readonly name?: string;
  /** Used in the default log filename; ignored in stdout mode. */
  readonly branch?: string;
}

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
