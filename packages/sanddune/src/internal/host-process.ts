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
  /** When the signal aborts, the subprocess is killed (SIGTERM) and the
   *  promise rejects with `signal.reason` verbatim. Pre-aborted signals
   *  reject before spawn. */
  readonly signal?: AbortSignal;
}

export interface InteractiveProcessResult {
  readonly exitCode: number;
}

/** Spawn a host subprocess with stdin/stdout/stderr inherited from the
 *  parent — used to launch an **agent**'s TUI for `interactive()` /
 *  `wt.interactive()`. Resolves when the child exits; never reads or
 *  buffers its output (the user is talking to it directly). */
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
  /** When set, stdout is split on newlines and each line is delivered as it
   *  arrives instead of buffered. The captured `stdout` in the result is
   *  then `lines.join("\n")` (no trailing newline). */
  readonly onLine?: (line: string) => void;
  /** When the signal aborts, the subprocess is killed (SIGTERM) and the
   *  promise rejects with `signal.reason` verbatim. Pre-aborted signals
   *  reject before spawn. */
  readonly signal?: AbortSignal;
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
