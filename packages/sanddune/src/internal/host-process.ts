import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpawnHostOptions {
  /** Working directory for the spawned process. */
  readonly cwd?: string;
  /** Per-stdout-line callback. When provided, stdout is split on newlines and
   *  each line is delivered as it arrives — useful for streaming agent output
   *  without buffering the full process output in memory. */
  readonly onLine?: (line: string) => void;
}

/** Spawn a host-side process, capture its stdout/stderr/exit code, and
 *  resolve once the process exits. Never throws on non-zero exit — callers
 *  decide what's an error.
 *
 *  When `onLine` is set, stdout is delivered line-by-line as it arrives and
 *  the captured `stdout` in the result is `lines.join("\n")` (no trailing
 *  newline). Without `onLine`, stdout is the raw concatenated output.
 *
 *  Single source of truth for sub-process plumbing across the codebase
 *  (git ops, sandbox-provider CLI invocations). Future cross-cutting work
 *  — abort signals (#12), idle timeouts (#11), instrumentation — lands here. */
export function spawnHost(
  cmd: string,
  args: readonly string[],
  options?: SpawnHostOptions,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutLines: string[] = [];

    if (options?.onLine && proc.stdout) {
      const onLine = options.onLine;
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        stdoutLines.push(line);
        onLine(line);
      });
    } else {
      proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }

    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdout = options?.onLine
        ? stdoutLines.join("\n")
        : Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
