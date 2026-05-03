import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpawnHostOptions {
  readonly cwd?: string;
  /** When set, stdout is split on newlines and each line is delivered as it
   *  arrives instead of buffered. The captured `stdout` in the result is
   *  then `lines.join("\n")` (no trailing newline). */
  readonly onLine?: (line: string) => void;
}

/** Never throws on non-zero exit — callers decide what's an error.
 *  Cross-cutting work (abort #12, idle timeouts #11, instrumentation) should
 *  land here as the single sub-process plumbing point. */
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
