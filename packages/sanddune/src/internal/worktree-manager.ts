import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runGit } from "./git-spawn";
import {
  acquireWorktreeLock,
  type WorktreeLockHandle,
} from "./worktree-lock";

export interface ManagedWorktree {
  readonly id: string;
  readonly path: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  isDirty(): Promise<boolean>;
  close(): Promise<ManagedWorktreeCloseResult>;
}

export interface ManagedWorktreeCloseResult {
  readonly preserved: boolean;
  readonly path?: string;
}

export interface CreateMergeToHeadWorktreeOptions {
  readonly cwd: string;
  readonly targetBranch: string;
}

export async function createMergeToHeadWorktree(
  options: CreateMergeToHeadWorktreeOptions,
): Promise<ManagedWorktree> {
  const cwd = resolve(options.cwd);
  const id = newWorktreeId();
  const sourceBranch = `sanddune/merge-to-head/${id}`;
  const worktreePath = join(cwd, ".sanddune", "worktrees", id);

  await mkdir(dirname(worktreePath), { recursive: true });

  const lock: WorktreeLockHandle = await acquireWorktreeLock({
    cwd,
    id,
    branch: sourceBranch,
  });

  try {
    await runGit(cwd, [
      "worktree",
      "add",
      "-b",
      sourceBranch,
      worktreePath,
      "HEAD",
    ]);
  } catch (err) {
    await lock.release();
    throw err;
  }

  let closed = false;
  return {
    id,
    path: worktreePath,
    sourceBranch,
    targetBranch: options.targetBranch,
    isDirty: () => gitStatusIsDirty(worktreePath),
    close: async () => {
      if (closed) return { preserved: false };
      closed = true;
      try {
        const dirty = await gitStatusIsDirty(worktreePath);
        if (dirty) {
          return { preserved: true, path: worktreePath };
        }
        await runGit(cwd, ["worktree", "remove", "--force", worktreePath]);
        return { preserved: false };
      } finally {
        await lock.release();
      }
    },
  };
}

function newWorktreeId(): string {
  const date = new Date();
  const stamp =
    date.getUTCFullYear().toString().padStart(4, "0") +
    (date.getUTCMonth() + 1).toString().padStart(2, "0") +
    date.getUTCDate().toString().padStart(2, "0") +
    "-" +
    date.getUTCHours().toString().padStart(2, "0") +
    date.getUTCMinutes().toString().padStart(2, "0") +
    date.getUTCSeconds().toString().padStart(2, "0");
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}

async function gitStatusIsDirty(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}
