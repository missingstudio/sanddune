import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export function runGit(
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
