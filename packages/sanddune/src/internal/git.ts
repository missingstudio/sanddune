import { spawn } from "node:child_process";

export async function gitCurrentBranch(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return result.stdout.trim();
}

export async function gitHeadSha(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], cwd);
  return result.stdout.trim();
}

export async function gitNewCommits(
  cwd: string,
  beforeSha: string,
): Promise<readonly string[]> {
  const result = await runGit(
    ["log", `${beforeSha}..HEAD`, "--format=%H", "--reverse"],
    cwd,
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runGit(args: readonly string[], cwd: string): Promise<ProcessResult> {
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
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
