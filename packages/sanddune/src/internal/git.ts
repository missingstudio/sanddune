import { spawnHost, type ProcessResult } from "./host-process";

export type { ProcessResult };

/** Run a `git` invocation in `cwd`. Throws on non-zero exit, with the
 *  command and stderr included in the error. Use `spawnHost` directly when
 *  the exit code itself carries meaning (e.g. `git show-ref --verify`). */
export async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult> {
  const result = await spawnHost("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result;
}

export async function gitCurrentBranch(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.stdout.trim();
}

export async function gitHeadSha(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "HEAD"]);
  return result.stdout.trim();
}

export async function gitNewCommits(
  cwd: string,
  beforeSha: string,
): Promise<readonly string[]> {
  const result = await runGit(cwd, [
    "log",
    `${beforeSha}..HEAD`,
    "--format=%H",
    "--reverse",
  ]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function gitMerge(cwd: string, sourceBranch: string): Promise<void> {
  // Prefer fast-forward — keeps the SHAs from the source branch unchanged on
  // the target branch. If the host moved during the run (rare), fall back to
  // a regular merge commit using the user's existing git identity so the
  // agent's work isn't lost.
  try {
    await runGit(cwd, ["merge", "--ff-only", sourceBranch]);
  } catch {
    await runGit(cwd, ["merge", "--no-ff", "--no-edit", sourceBranch]);
  }
}

export async function gitBranchDelete(
  cwd: string,
  branch: string,
): Promise<void> {
  await runGit(cwd, ["branch", "-D", branch]);
}
