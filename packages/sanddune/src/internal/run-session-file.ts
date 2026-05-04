import type { AgentStreamEvent } from "../core";
import { newRunId } from "./run-id";
import { openRunLog, openRunLogAtPath, type RunLog } from "./run-log";
import type { RunSession } from "./run-session";

export interface OpenFileRunSessionInput {
  readonly cwd: string;
  readonly name?: string;
  readonly branch?: string;
  /** Absolute path; defaults to `${cwd}/.sanddune/logs/<...>.jsonl`. */
  readonly path?: string;
  /** Sync, fire-and-forget; errors swallowed so a broken forwarder can't
   *  kill the run. */
  readonly onAgentStreamEvent?: (event: AgentStreamEvent) => void;
}

export async function openFileRunSession(
  input: OpenFileRunSessionInput,
): Promise<RunSession> {
  const log: RunLog =
    input.path !== undefined
      ? await openRunLogAtPath(input.path)
      : await openRunLog(input.cwd, {
          runId: newRunId(),
          ...(input.branch !== undefined && { branch: input.branch }),
          ...(input.name !== undefined && { name: input.name }),
        });

  const prefix = input.name !== undefined ? `[${input.name}] ` : "";
  process.stdout.write(
    `${prefix}sanddune: streaming run log to ${log.path}\n${prefix}  tail -f ${log.path}\n`,
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
        `${prefix}sanddune: failed to write run-end record: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
    try {
      await log.close();
    } catch (e) {
      process.stderr.write(
        `${prefix}sanddune: failed to close run log: ${
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
      if (input.onAgentStreamEvent !== undefined) {
        try {
          input.onAgentStreamEvent(event);
        } catch (e) {
          process.stderr.write(
            `${prefix}sanddune: onAgentStreamEvent threw: ${
              e instanceof Error ? e.message : String(e)
            }\n`,
          );
        }
      }
    },
    endOk: () => end("ok"),
    endError: (message) => end("error", message),
  };
}
