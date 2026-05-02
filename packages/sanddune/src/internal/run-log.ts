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
    readonly commitSha?: string;
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
  write(record: RunLogRecord): Promise<void>;
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
  return {
    path,

    write: async (record: RunLogRecord) => {
      if (closed) return;
      await handle.write(JSON.stringify(record) + "\n");
    },

    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
