import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface BindMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

/** When `<worktreePath>/.git` is a pointer file (git worktree, not a regular
 *  checkout), the pointer references the parent `.git` at a host path that
 *  doesn't exist inside the sandbox. Bind-mounting the parent at its host
 *  path makes the pointer resolve. Per ADR-0006. Returns null when the
 *  pointer is absent, malformed, or `.git` is a directory. */
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

  // gitdirPath is e.g. /repo/.git/worktrees/<id>. Walk up until we hit the
  // segment named `.git` — that's the parent .git directory we need to mount.
  let dir = gitdirPath;
  while (basename(dir) !== ".git" && dir !== "/" && dir.length > 0) {
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  if (basename(dir) !== ".git") return null;

  return { hostPath: dir, sandboxPath: dir };
}

/** Lowercased and sanitized to `[a-z0-9_.-]` so any repo dir name produces
 *  a valid tag; falls back to `sanddune:local`. */
export function defaultImageName(hostRepoPath: string): string {
  const dirName =
    hostRepoPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sanddune:${sanitized || "local"}`;
}
