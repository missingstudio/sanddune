import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface BindMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

/** Worktree's `.git` is a pointer file referencing the parent `.git` at a
 *  host path that wouldn't exist inside the sandbox without this mount.
 *  Returns null for regular checkouts (`.git` is a directory). */
export async function resolveParentGitMount(
  worktreePath: string,
): Promise<BindMount | null> {
  const gitPath = join(worktreePath, ".git");
  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null;
  }
  if (!gitStat.isFile()) return null;

  let content: string;
  try {
    content = await readFile(gitPath, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;

  const gitdirPath = match[1];
  if (typeof gitdirPath !== "string") return null;

  // gitdirPath is /repo/.git/worktrees/<id>; walk up to the `.git` segment.
  let dir = gitdirPath;
  while (basename(dir) !== ".git" && dir !== "/" && dir.length > 0) {
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  if (basename(dir) !== ".git") return null;

  return { hostPath: dir, sandboxPath: dir };
}

export function defaultImageName(hostRepoPath: string): string {
  const dirName =
    hostRepoPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sanddune:${sanitized || "local"}`;
}
