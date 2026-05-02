import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentStreamEvent } from "@missingstudio/sanddune-core";

export type RunLogRecord =
  | { readonly type: "run-start"; readonly timestamp: number }
  | {
    readonly type: "iteration-start";
    readonly iteration: number;
    readonly timestamp: number;
  }
  | {
    readonly type: "iteration-end";
    readonly iteration: number;
    readonly timestamp: number;
    readonly commitSha: string | null;
  }
  | {
    readonly type: "agent-event";
    readonly event: AgentStreamEvent;
  }
  | {
    readonly type: "run-end";
    readonly timestamp: number;
    readonly status: "ok" | "error";
    readonly error?: string;
  };

export interface RunLog {
  readonly path: string;
  runStarted(): Promise<void>;
  iterationStarted(iteration: number): Promise<void>;
  iterationEnded(iteration: number, commitSha: string | null): Promise<void>;
  agentEvent(event: AgentStreamEvent): Promise<void>;
  runEnded(status: "ok" | "error", error?: string): Promise<void>;
  close(): Promise<void>;
}

export async function openRunLog(
  cwd: string,
  runId: string,
): Promise<RunLog> {
  const path = join(cwd, ".sanddune", "logs", `${runId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });

  const handle: FileHandle = await open(path, "a");
  let closed = false;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (record: RunLogRecord): Promise<void> => {
    pending = pending.then(async () => {
      if (closed) return;
      await handle.write(JSON.stringify(record) + "\n");
    });
    return pending;
  };

  return {
    path,

    runStarted: () => enqueue({ type: "run-start", timestamp: Date.now() }),

    iterationStarted: (iteration) =>
      enqueue({
        type: "iteration-start",
        iteration,
        timestamp: Date.now(),
      }),

    iterationEnded: (iteration, commitSha) =>
      enqueue({
        type: "iteration-end",
        iteration,
        timestamp: Date.now(),
        commitSha,
      }),

    agentEvent: (event) => enqueue({ type: "agent-event", event }),

    runEnded: (status, error) =>
      enqueue(
        error !== undefined
          ? { type: "run-end", timestamp: Date.now(), status, error }
          : { type: "run-end", timestamp: Date.now(), status },
      ),

    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await pending;
      } finally {
        await handle.close();
      }
    },
  };
}
