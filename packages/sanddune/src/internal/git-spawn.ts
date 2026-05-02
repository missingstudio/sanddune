import { spawnHost, type ProcessResult } from "./host-process";

export type { ProcessResult };

/** Run a `git` invocation in `cwd`. Throws on non-zero exit, with the
 *  command and stderr included in the error. */
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
