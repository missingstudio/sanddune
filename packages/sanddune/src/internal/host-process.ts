import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpawnHostInteractiveOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Abort kills with SIGTERM and rejects with signal.reason verbatim. */
  readonly signal?: AbortSignal;
}

export interface InteractiveProcessResult {
  readonly exitCode: number;
}

/** Inherits stdio — used for an agent's TUI. Never buffers output. */
export function spawnHostInteractive(
  cmd: string,
  args: readonly string[],
  options?: SpawnHostInteractiveOptions,
): Promise<InteractiveProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const proc = spawn(cmd, args, {
      cwd: options?.cwd,
      ...(options?.env !== undefined && {
        env: { ...process.env, ...options.env },
      }),
      stdio: "inherit",
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      proc.kill("SIGTERM");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(signal!.reason);
        return;
      }
      resolvePromise({ exitCode: code ?? 0 });
    });
  });
}

export interface SpawnHostOptions {
  readonly cwd?: string;
  /** Streams stdout line-by-line; result.stdout is then lines.join("\n"). */
  readonly onLine?: (line: string) => void;
  /** Abort kills with SIGTERM and rejects with signal.reason verbatim. */
  readonly signal?: AbortSignal;
}

/** Never throws on non-zero exit — callers decide what's an error. The
 *  single subprocess plumbing point for sanddune (abort, timeouts,
 *  instrumentation all hook here). */
export function spawnHost(
  cmd: string,
  args: readonly string[],
  options?: SpawnHostOptions,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

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

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      proc.kill("SIGTERM");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(signal!.reason);
        return;
      }
      const stdout = options?.onLine
        ? stdoutLines.join("\n")
        : Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
